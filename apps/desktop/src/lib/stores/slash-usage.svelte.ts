// Usage-frequency store for the slash-command autocomplete.
//
// Rune-based singleton (`slashUsage`) tracking per-skill invocation
// counts and last-used timestamps. The SlashAutocomplete dropdown
// consumes `score(name)` to add a "recently used" bonus to its
// subsequence-match ranking so skills the user runs often float to
// the top. The parent chat composer calls `record(name)` whenever a
// message that starts with `/<skillname>` is sent.
//
// The store is deliberately decoupled from the skill catalog — it
// keys by raw skill name strings, never asserts they exist. A name
// for a skill the user has since uninstalled stays in the map
// harmlessly; the dropdown only ever looks them up by name, so the
// stale entry contributes nothing to the visible UI.
//
// Persistence: a single localStorage blob under `ironclaw-slash-usage`,
// rewritten on every mutation. We cap the map at MAX_ENTRIES (50)
// and drop entries older than ENTRY_TTL_DAYS (30) on hydrate via
// `cleanup()`, so a runaway scratch session can't bloat the blob
// unbounded.
//
// Scoring math (see `score()`): count × recency, where recency is a
// linear ramp 1.0 → 0.0 over RECENCY_HALF_LIFE_DAYS × 2 (so 1.0 today,
// 0.5 at 7 days, 0.0 at 14+). Returns a raw score (NOT 0..1 clamped) —
// the caller multiplies it into its existing rank metric. The
// SlashAutocomplete uses a 0.5 weight so usage nudges ties but doesn't
// override a tight subsequence match.

/** One per-skill record. */
export interface UsageEntry {
  /** Raw skill name (the part after the leading `/`). */
  skillName: string;
  /** Total invocations counted across the lifetime of the entry. */
  count: number;
  /** ISO timestamp of the most recent invocation. */
  lastUsedAt: string;
}

/** localStorage blob key. */
const LS_KEY = 'ironclaw-slash-usage';

/** Hard cap on the number of entries retained. Bounds the persisted
 *  blob size — entries beyond the cap are dropped on `cleanup()` in
 *  least-recently-used order. */
export const MAX_ENTRIES = 50;

/** Entries older than this many days are dropped on `cleanup()` so
 *  one-off invocations don't accrete forever. */
export const ENTRY_TTL_DAYS = 30;

/** Recency decay: scores ramp linearly 1.0 → 0.0 over twice this
 *  many days. At RECENCY_HALF_LIFE_DAYS the multiplier is 0.5. */
export const RECENCY_HALF_LIFE_DAYS = 7;

/** Past this many days the recency multiplier is pinned to 0.0. */
const RECENCY_ZERO_DAYS = RECENCY_HALF_LIFE_DAYS * 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Defensively shape an arbitrary JSON blob into a UsageEntry map.
 * Drops non-string keys, missing or malformed counts/timestamps so
 * a stale or hand-edited file can't put the in-memory state in an
 * invalid shape.
 */
function coerceLoaded(raw: unknown): Map<string, UsageEntry> {
  const out = new Map<string, UsageEntry>();
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw)) return out;
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    const name = typeof r.skillName === 'string' ? r.skillName : null;
    const count = typeof r.count === 'number' && Number.isFinite(r.count) ? r.count : null;
    const lastUsedAt = typeof r.lastUsedAt === 'string' ? r.lastUsedAt : null;
    if (!name || count === null || count <= 0 || !lastUsedAt) continue;
    // Reject timestamps we can't parse — Date.parse returns NaN.
    if (Number.isNaN(Date.parse(lastUsedAt))) continue;
    out.set(name, { skillName: name, count, lastUsedAt });
  }
  return out;
}

class SlashUsageStore {
  /** Per-skill usage records keyed by raw skill name. Mutations
   *  always replace the Map reference so Svelte's reactivity fires. */
  entries = $state<Map<string, UsageEntry>>(new Map());

  private hydrated = false;

  /**
   * Hydrate from localStorage, then run `cleanup()` to drop stale
   * and over-cap entries. Idempotent — safe to call multiple times.
   * Wire from the root layout's `onMount` so the first dropdown
   * render across the app sees the saved scores without a flash.
   */
  init(): void {
    if (this.hydrated || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        this.entries = coerceLoaded(parsed);
      }
    } catch {
      // Corrupt JSON or unavailable storage — fall back to empty state.
    }
    this.hydrated = true;
    // Trim on hydrate so a long-stale localStorage blob can't bloat
    // the in-memory map for the rest of the session.
    this.cleanup();
  }

  /**
   * Increment the count and bump the timestamp for `skillName`.
   * Creates a fresh entry if none exists. No-op for empty names so
   * a stray `/ ` send can't pollute the store.
   */
  record(skillName: string): void {
    if (!skillName) return;
    const now = new Date().toISOString();
    const existing = this.entries.get(skillName);
    const next: UsageEntry = existing
      ? { skillName, count: existing.count + 1, lastUsedAt: now }
      : { skillName, count: 1, lastUsedAt: now };
    // Replace the Map reference so any reactive consumer rebinds. A
    // mutate-in-place would skip Svelte's reactivity for the rune.
    const m = new Map(this.entries);
    m.set(skillName, next);
    this.entries = m;
    this.persist();
  }

  /**
   * Compute the usage-bonus score for `skillName`. Returns 0 when no
   * entry exists or when the recency multiplier has fully decayed.
   * Math: `count × recencyFactor`, where recencyFactor is a linear
   * ramp 1.0 today → 0.5 at RECENCY_HALF_LIFE_DAYS → 0.0 past
   * RECENCY_ZERO_DAYS. Caller picks a weight that fits its overall
   * ranking metric.
   */
  score(skillName: string): number {
    if (!skillName) return 0;
    const e = this.entries.get(skillName);
    if (!e) return 0;
    const last = Date.parse(e.lastUsedAt);
    if (Number.isNaN(last)) return 0;
    const ageMs = Date.now() - last;
    if (ageMs < 0) return e.count; // clock skew — treat as fresh.
    const ageDays = ageMs / MS_PER_DAY;
    if (ageDays >= RECENCY_ZERO_DAYS) return 0;
    const recency = 1 - ageDays / RECENCY_ZERO_DAYS;
    return e.count * recency;
  }

  /**
   * Drop entries older than ENTRY_TTL_DAYS, then keep at most
   * MAX_ENTRIES (most-recent first). Persists the trimmed map back
   * to localStorage. Called once on hydrate; safe to call manually.
   */
  cleanup(): void {
    const now = Date.now();
    const ttlCutoff = now - ENTRY_TTL_DAYS * MS_PER_DAY;
    const kept: UsageEntry[] = [];
    for (const e of this.entries.values()) {
      const last = Date.parse(e.lastUsedAt);
      if (Number.isNaN(last)) continue;
      if (last < ttlCutoff) continue;
      kept.push(e);
    }
    // Sort by lastUsedAt descending so the freshest entries stay
    // when the cap kicks in.
    kept.sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
    const capped = kept.slice(0, MAX_ENTRIES);
    const next = new Map<string, UsageEntry>();
    for (const e of capped) next.set(e.skillName, e);
    // Only rewrite state + persistence when the cleanup actually
    // changed something — saves a needless rerender on every init.
    if (next.size !== this.entries.size) {
      this.entries = next;
      this.persist();
    }
  }

  /**
   * Persist the current map to localStorage as a JSON array of
   * UsageEntry. Best-effort — quota / private-mode failures are
   * non-fatal (the in-memory map keeps working and the next mutation
   * re-attempts).
   */
  private persist(): void {
    if (typeof window === 'undefined') return;
    try {
      const arr = Array.from(this.entries.values());
      window.localStorage.setItem(LS_KEY, JSON.stringify(arr));
    } catch {
      // Storage may be full or disabled — non-fatal.
    }
  }
}

/** Global singleton — import this anywhere. */
export const slashUsage = new SlashUsageStore();
