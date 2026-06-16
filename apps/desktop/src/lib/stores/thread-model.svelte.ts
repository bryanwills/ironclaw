// Per-thread LLM provider tracker.
//
// The IronClaw gateway does not (yet) tag each thread with the provider
// that produced its assistant turns — switching profiles or providers mid-
// session leaves the chat surface unable to tell the user "this response
// came from NEAR.AI" vs "from OpenRouter". This store keeps a tiny
// `threadId → providerId` map persisted to localStorage so the chat
// header can render a provider chip without round-tripping to the
// gateway on every render.
//
// What gets recorded:
//   - The chat surface calls `setProvider(threadId, providerId)` after
//     each successful `streamResponse` turn — the provider id is read
//     from the active profile at the moment the stream completes, so a
//     mid-stream profile switch is captured on the next turn rather
//     than silently mis-tagging the current one.
//   - The store is write-last-wins: a thread that switches providers
//     between turns ends up tagged with whichever provider produced the
//     most recent assistant message. That matches the user's mental
//     model ("this conversation is currently on X").
//
// Persistence schema: a single `ironclaw-thread-providers` blob,
// `Record<string, string>`. Defensive load drops non-string keys / values
// so a hand-edited or pre-versioned blob can't put the store in an
// invalid shape (same pattern as `thread-rename.svelte.ts`).
//
// Why a `Map`-backed shape instead of a plain object: the public surface
// uses `Map` semantics (`get`, `set`, `has`) so the chat header's lookup
// reads cleanly. Internally the persisted JSON is a flat object because
// JSON can't round-trip a `Map` without a custom replacer; the in-memory
// `Map` is rebuilt from the object on hydrate.

const LS_KEY = 'ironclaw-thread-providers';

/**
 * Defensively shape an arbitrary JSON blob into a `Map<threadId, providerId>`.
 * Drops empty / non-string keys and values so a stale or hand-edited file
 * can't put the in-memory state in an invalid shape.
 */
function coerceLoaded(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof k !== 'string' || k === '') continue;
    if (typeof v !== 'string' || v === '') continue;
    out.set(k, v);
  }
  return out;
}

class ThreadModelStore {
  /** Map of `threadId → providerId`. The whole `Map` is replaced (not
   *  mutated in place) on every change so Svelte's reactivity picks it
   *  up — the same pattern Svelte 5 uses for collection mutations under
   *  `$state`. */
  providers = $state<Map<string, string>>(new Map());

  /** True once `init()` has run. Subsequent calls are no-ops; lookups
   *  also lazy-hydrate on first read so the store works without an
   *  explicit boot call. */
  private hydrated = false;

  /**
   * Hydrate from localStorage. Idempotent — safe to call multiple
   * times. Called automatically on the first `get` / `set` so callers
   * don't need an explicit boot step, but exposed so a root layout
   * mount can warm the store before the first render.
   */
  init(): void {
    if (this.hydrated || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        this.providers = coerceLoaded(parsed);
      }
    } catch {
      // Corrupt JSON or unavailable storage — fall back to empty state.
    }
    this.hydrated = true;
  }

  /**
   * Record the provider that produced this thread's most recent
   * assistant turn. Trims surrounding whitespace and ignores empty /
   * missing values so a missing `activeProfile.llmProviderId` (legacy
   * profile that pre-dates the field) can be called without poisoning
   * the map.
   */
  setProvider(threadId: string, providerId: string | null | undefined): void {
    if (!threadId || typeof providerId !== 'string') return;
    const trimmed = providerId.trim();
    if (trimmed === '') return;
    this.init();
    if (this.providers.get(threadId) === trimmed) return;
    // Replace the map so Svelte's reactivity picks up the change. A
    // mutation-in-place (`this.providers.set(...)`) doesn't trigger
    // re-renders for $state-backed Maps in every reactive surface.
    const next = new Map(this.providers);
    next.set(threadId, trimmed);
    this.providers = next;
    this.persist();
  }

  /** Return the provider id tagged on a thread, or `undefined`. */
  getProvider(threadId: string): string | undefined {
    if (!threadId) return undefined;
    this.init();
    return this.providers.get(threadId);
  }

  /** True when the thread carries a recorded provider. */
  has(threadId: string): boolean {
    if (!threadId) return false;
    this.init();
    return this.providers.has(threadId);
  }

  /** Persist the current shape to localStorage as a flat object — best-
   *  effort. Quota / private-mode failures are non-fatal (the entry
   *  still works in-memory and the next mutation re-attempts). */
  private persist(): void {
    if (typeof window === 'undefined') return;
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.providers) obj[k] = v;
      window.localStorage.setItem(LS_KEY, JSON.stringify(obj));
    } catch {
      // Storage may be full or disabled — non-fatal.
    }
  }
}

/** Global singleton — import this anywhere a surface renders a thread's
 *  provider chip or wants to tag a thread with its active provider. */
export const threadModel = new ThreadModelStore();
