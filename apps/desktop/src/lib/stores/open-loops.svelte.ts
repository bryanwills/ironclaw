// Open loops — the user's tracked commitments / follow-ups.
//
// Makes the Chief of Staff operating principle #5 ("track open loops")
// a real, persisted primitive rather than just prompt text. Each loop is
// a short free-text commitment the user is carrying ("send the budget
// revision", "follow up with design"); the daily brief (R101) restates
// the active ones, and the CoS persona is told to weave them into the
// day's priorities.
//
// Rune-based singleton (`openLoops`), persisted as a single localStorage
// blob under `ironclaw-open-loops`, rewritten on every mutation. Mirrors
// the defensive load + cap discipline of the pins store: a corrupt or
// hand-edited blob coerces back to a valid shape, and a runaway add can't
// bloat storage unbounded.
//
// This store deliberately knows nothing about threads or the gateway — it
// is a flat, local, user-owned list. The briefing layer reads `activeTexts()`
// to feed `buildBriefingPrompt`; nothing here ever talks to the network.

const LS_KEY = 'ironclaw-open-loops';

/** Hard cap so a stuck key or paste can't grow the blob without bound. */
export const MAX_LOOPS = 100;

/** Trim guard so a single commitment can't be pathologically long. */
const MAX_TEXT_LEN = 280;

export interface OpenLoop {
  /** Stable id (uuid when available). Keyed-each key in the UI. */
  id: string;
  /** The commitment text. Trimmed, non-empty, capped at MAX_TEXT_LEN. */
  text: string;
  /** Whether the user has marked it done (kept for history until cleared). */
  done: boolean;
  /** Epoch ms when added — preserves insertion order across reloads. */
  createdAt: number;
}

/** Best-effort stable id. `crypto.randomUUID` in the app + modern test envs;
 *  a timestamp+random fallback keeps the store usable anywhere. */
function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the manual id
  }
  return `loop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Clamp + trim arbitrary user text into the stored shape, or null if empty. */
function normalizeText(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_TEXT_LEN ? trimmed.slice(0, MAX_TEXT_LEN) : trimmed;
}

/**
 * Defensively shape an arbitrary JSON blob into `OpenLoop[]`. Drops
 * malformed entries, coerces missing flags, dedups ids, and enforces the
 * cap — so a stale or hand-edited file can never put the store in an
 * invalid state.
 */
function coerceLoaded(raw: unknown): OpenLoop[] {
  if (!Array.isArray(raw)) return [];
  const out: OpenLoop[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const text = typeof e.text === 'string' ? normalizeText(e.text) : null;
    if (text === null) continue;
    const id = typeof e.id === 'string' && e.id.length > 0 ? e.id : newId();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      text,
      done: e.done === true,
      createdAt: typeof e.createdAt === 'number' && Number.isFinite(e.createdAt) ? e.createdAt : 0
    });
    if (out.length >= MAX_LOOPS) break;
  }
  return out;
}

export class OpenLoopStore {
  /** The full list, insertion order (oldest first). Mutations always
   *  replace the array reference so Svelte reactivity fires. */
  loops = $state<OpenLoop[]>([]);

  private hydrated = false;

  /** Active (not-done) loops, oldest first. */
  active = $derived(this.loops.filter((l) => !l.done));

  /** Count of active loops — cheap for badges / empty-state checks. */
  activeCount = $derived(this.active.length);

  /**
   * Hydrate from localStorage. Idempotent — safe to call repeatedly.
   * Call once during root-layout mount so the first render sees saved
   * commitments.
   */
  init(): void {
    if (this.hydrated || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (raw) this.loops = coerceLoaded(JSON.parse(raw) as unknown);
    } catch {
      // Corrupt JSON / unavailable storage — start empty.
    }
    this.hydrated = true;
  }

  /**
   * Add a commitment. Trims + caps the text, ignores empty input, and
   * drops the oldest entry when at the cap so the newest always lands.
   * Returns the created loop, or null when the input was empty.
   */
  add(text: string): OpenLoop | null {
    const normalized = normalizeText(text);
    if (normalized === null) return null;
    // Guard against an id collision (the non-crypto fallback in `newId()`
    // could theoretically repeat); a duplicate id breaks keyed rendering and
    // makes toggle/remove hit multiple loops. Regenerate until unique.
    // (Review P2.)
    const existing = new Set(this.loops.map((l) => l.id));
    let id = newId();
    while (existing.has(id)) id = newId();
    const loop: OpenLoop = {
      id,
      text: normalized,
      done: false,
      createdAt: Date.now()
    };
    let next = [...this.loops, loop];
    if (next.length > MAX_LOOPS) next = next.slice(next.length - MAX_LOOPS);
    this.loops = next;
    this.persist();
    return loop;
  }

  /** Remove a loop by id. No-op when absent. */
  remove(id: string): void {
    if (!this.loops.some((l) => l.id === id)) return;
    this.loops = this.loops.filter((l) => l.id !== id);
    this.persist();
  }

  /** Toggle the done flag. No-op when the id is unknown. */
  toggleDone(id: string): void {
    let changed = false;
    const next = this.loops.map((l) => {
      if (l.id !== id) return l;
      changed = true;
      return { ...l, done: !l.done };
    });
    if (!changed) return;
    this.loops = next;
    this.persist();
  }

  /** Replace the text of a loop. Ignores empty input; no-op when unknown. */
  setText(id: string, text: string): void {
    const normalized = normalizeText(text);
    if (normalized === null) return;
    let changed = false;
    const next = this.loops.map((l) => {
      if (l.id !== id) return l;
      changed = true;
      return { ...l, text: normalized };
    });
    if (!changed) return;
    this.loops = next;
    this.persist();
  }

  /** Drop every done loop, keeping the active ones. */
  clearDone(): void {
    if (!this.loops.some((l) => l.done)) return;
    this.loops = this.loops.filter((l) => !l.done);
    this.persist();
  }

  /** Remove everything. */
  clear(): void {
    if (this.loops.length === 0) return;
    this.loops = [];
    this.persist();
  }

  /** Active commitment texts — what the briefing feeds into the prompt. */
  activeTexts(): string[] {
    return this.active.map((l) => l.text);
  }

  /** Persist current state. Best-effort; quota / private-mode failures are
   *  non-fatal (in-memory state still works; the next mutation retries). */
  private persist(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(this.loops));
    } catch {
      // Storage full or disabled — non-fatal.
    }
  }
}

/** Global singleton — import this anywhere. */
export const openLoops = new OpenLoopStore();
