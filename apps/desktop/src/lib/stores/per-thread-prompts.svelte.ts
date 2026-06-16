// Per-thread system-prompt override store.
//
// The IronClaw gateway runs every thread under the same global admin
// SYSTEM.md (or the built-in fallback when no admin prompt is set).
// This store lets a user attach a custom system prompt to ONE specific
// thread — e.g. "you are a Spanish tutor" — without touching the
// admin-level prompt or any sibling thread. The override is layered on
// top of the gateway's existing system message via the Responses API
// `instructions` field at request time (see
// `IronClawClient.streamResponse` for the wire details).
//
// Storage shape: a single `ironclaw-per-thread-prompts` blob,
// `Record<string, string>` keyed by thread id. The map lives in
// `$state` so any surface that reads it re-renders when an override is
// added / cleared (the chat header chip + the kebab modal both rely on
// this).
//
// Defensive load: anything that isn't a plain `(string, string)`
// entry is dropped. `__proto__` / `constructor` / `prototype` keys are
// filtered explicitly so a hand-edited blob can't pollute the
// prototype chain — Object.entries() already skips inherited names but
// a literal `{__proto__: ...}` in JSON parses into the own-property
// slot on some engines, hence the belt-and-braces filter.
//
// Length contract: prompts longer than `MAX_PROMPT_CHARS` are still
// accepted (the modal lets the user save them and surfaces a warning)
// — the gateway truncates if it needs to, but the local store never
// silently drops content. If we truncated here a user who paste-bombed
// a 20K-char prompt would think they saved a 20K prompt and only
// discover the truncation when the model started hallucinating away
// from their persona.

/** localStorage blob key. */
const LS_KEY = 'ironclaw-per-thread-prompts';

/** Max characters before the modal surfaces a warning. The store still
 *  persists longer prompts; the warning lives in the UI. */
export const MAX_PROMPT_CHARS = 16000;

/** Keys we refuse to write into the override map. Defensive — JSON
 *  parsing of a literal `{"__proto__": {...}}` lands in own-property
 *  slot on V8/Hermes, which we don't want anywhere near our map. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Defensively shape an arbitrary JSON blob into a `Record<string,string>`.
 * Drops non-string keys/values, blank values, and the forbidden keys
 * listed above.
 */
function coerceLoaded(raw: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof k !== 'string' || k === '') continue;
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (typeof v !== 'string') continue;
    // Empty/whitespace-only prompts would be ambiguous with "no
    // override"; collapse to absent on load so a malformed blob can't
    // leave a thread stranded with a meaningless empty override.
    if (v.trim() === '') continue;
    out[k] = v;
  }
  return out;
}

class PerThreadPromptStore {
  /** Map of thread id → custom system prompt. Replaced (not mutated in
   *  place) on every change so `$state` reactivity propagates. */
  prompts = $state<Record<string, string>>({});

  private hydrated = false;

  /**
   * Lazy hydrate from localStorage. Called automatically from every
   * read/write entry point; safe to call repeatedly.
   */
  private ensureHydrated(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        this.prompts = coerceLoaded(parsed);
      }
    } catch {
      // Corrupt JSON or unavailable storage — fall back to empty.
    }
  }

  /**
   * Return the override for a thread, or `null` if none is set.
   * Returning `null` (not `undefined`) keeps the public surface stable
   * for the wire-side caller that ternaries on the result.
   */
  get(threadId: string): string | null {
    this.ensureHydrated();
    if (!threadId) return null;
    if (FORBIDDEN_KEYS.has(threadId)) return null;
    const v = this.prompts[threadId];
    return typeof v === 'string' && v !== '' ? v : null;
  }

  /**
   * Set a custom system prompt for a thread. Blank/whitespace-only
   * input collapses to a `clear()` so the user can wipe an override
   * by saving an empty textarea. The store does NOT truncate long
   * prompts — see the file header for why.
   */
  set(threadId: string, prompt: string): void {
    this.ensureHydrated();
    if (!threadId) return;
    if (FORBIDDEN_KEYS.has(threadId)) return;
    const trimmed = prompt.trim();
    if (trimmed === '') {
      this.clear(threadId);
      return;
    }
    if (this.prompts[threadId] === trimmed) return;
    this.prompts = { ...this.prompts, [threadId]: trimmed };
    this.persist();
  }

  /**
   * Drop the override for a thread, reverting to the gateway's
   * admin-level system prompt. No-op when no override is present.
   */
  clear(threadId: string): void {
    this.ensureHydrated();
    if (!threadId) return;
    if (!(threadId in this.prompts)) return;
    const next = { ...this.prompts };
    delete next[threadId];
    this.prompts = next;
    this.persist();
  }

  /** True when the thread carries a per-thread override. */
  hasOverride(threadId: string): boolean {
    this.ensureHydrated();
    if (!threadId) return false;
    if (FORBIDDEN_KEYS.has(threadId)) return false;
    const v = this.prompts[threadId];
    return typeof v === 'string' && v !== '';
  }

  /** Persist the current map to localStorage. Best-effort — quota or
   *  private-mode failures are non-fatal (the override still works
   *  in-memory and the next mutation re-attempts). */
  private persist(): void {
    if (typeof window === 'undefined') return;
    try {
      // Materialize via Object.assign so a `Object.create(null)`-shaped
      // input still serializes cleanly via JSON.stringify (no `[object
      // Object]` surprise on engines that special-case the proto).
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(this.prompts)) {
        if (FORBIDDEN_KEYS.has(k)) continue;
        if (typeof v !== 'string' || v === '') continue;
        flat[k] = v;
      }
      window.localStorage.setItem(LS_KEY, JSON.stringify(flat));
    } catch {
      // Storage may be full or disabled — non-fatal.
    }
  }
}

/** Global singleton — import this anywhere a surface needs the
 *  per-thread override (chat header chip, kebab modal, streamResponse
 *  call site). */
export const perThreadPrompts = new PerThreadPromptStore();
