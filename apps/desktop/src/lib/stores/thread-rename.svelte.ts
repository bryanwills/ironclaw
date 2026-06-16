// Local-only thread-rename overlay.
//
// IronClaw v0.29.0 does not expose `PATCH /api/chat/threads/{id}` (R22a
// smoke confirms 404), so the user-visible "rename this chat" affordance
// has to live entirely on the client. This store keeps a single
// `threadId → custom title` map keyed off the same thread ids the server
// hands out, persists it to localStorage so renames survive reloads, and
// fans every mutation across sibling windows via R17a's BroadcastChannel.
//
// Why a separate store rather than monkey-patching `threads.threads`:
// the `threads` store is refreshed from the server on every send / new
// thread / window focus — any title we splice into it gets blown away on
// the next refresh. The override lives here so the next `loadThreads()`
// call from the gateway can drop a fresh server payload in without
// stomping the user's local label. Render-time call sites consult
// `displayTitle(id, serverTitle)` instead of reading `thread.title`
// directly, which yields the override when present and falls back to
// the server's value (or 'Untitled') otherwise.
//
// Cross-window sync: every `set()` / `unset()` emits a `thread-rename`
// message on the shared `ironclaw:state-sync` channel. Receivers update
// their own copy of `renames` in-memory (no localStorage write — the
// sender already persisted, and a peer write would race the original).
// The bus message carries the FULL post-mutation title (or `null` for
// an unset) rather than a diff, so a window that missed earlier events
// still converges to the right state on the first message it sees.
//
// Persistence schema: a single `ironclaw-thread-renames` blob,
// `Record<string, string>`. Defensive load drops any non-string keys
// or values so a hand-edited / pre-versioned blob can't put the store
// in an invalid shape.

import { broadcast } from './broadcast.svelte';

const LS_KEY = 'ironclaw-thread-renames';
const TOOLTIP_KEY = 'ironclaw-rename-tooltip-seen';

/**
 * Defensively shape an arbitrary JSON blob into a `Record<string,string>`.
 * Drops non-string keys and values so a stale or hand-edited file can't
 * put the in-memory state in an invalid shape.
 */
function coerceLoaded(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof k !== 'string' || k === '') continue;
    if (typeof v !== 'string') continue;
    // Empty string would be ambiguous with "no rename"; collapse to absent.
    if (v.trim() === '') continue;
    out[k] = v;
  }
  return out;
}

class ThreadRenameStore {
  /** Map of thread id → custom title. Replaced (not mutated in place) on
   *  every change so Svelte's reactivity picks it up. */
  renames = $state<Record<string, string>>({});

  private hydrated = false;

  /**
   * Hydrate from localStorage. Idempotent — safe to call multiple times.
   * Call once during root-layout mount so the first chat render shows
   * the saved renames without a flash of server titles.
   */
  init(): void {
    if (this.hydrated || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        this.renames = coerceLoaded(parsed);
      }
    } catch {
      // Corrupt JSON or unavailable storage — fall back to empty state.
    }
    this.hydrated = true;
  }

  /**
   * Set a custom title for a thread. Empty / whitespace-only titles are
   * treated as an unset so a user clearing the input doesn't strand the
   * thread with a blank label. Fans the change out to sibling windows
   * via the broadcast bus unless `opts.broadcast` is false (used by the
   * receive path to avoid an echo).
   */
  set(threadId: string, title: string, opts: { broadcast?: boolean } = {}): void {
    if (!threadId) return;
    const trimmed = title.trim();
    if (trimmed === '') {
      this.unset(threadId, opts);
      return;
    }
    if (this.renames[threadId] === trimmed) return;
    this.renames = { ...this.renames, [threadId]: trimmed };
    this.persist();
    if (opts.broadcast !== false) {
      broadcast.send({ kind: 'thread-rename', threadId, title: trimmed });
    }
  }

  /**
   * Drop the custom title for a thread, reverting to the server's title.
   * No-op if the thread has no override. Broadcasts a `null` title so
   * receiving windows clear their own override and converge.
   */
  unset(threadId: string, opts: { broadcast?: boolean } = {}): void {
    if (!threadId) return;
    if (!(threadId in this.renames)) {
      // Still broadcast an unset if the caller explicitly asks, in case
      // a peer window holds an override we don't. Default path skips
      // the broadcast to avoid bus chatter on no-op calls.
      return;
    }
    const next = { ...this.renames };
    delete next[threadId];
    this.renames = next;
    this.persist();
    if (opts.broadcast !== false) {
      broadcast.send({ kind: 'thread-rename', threadId, title: null });
    }
  }

  /** Return the override for a thread, or undefined if none is set. */
  get(threadId: string): string | undefined {
    return this.renames[threadId];
  }

  /** True when the thread carries a local override. */
  has(threadId: string): boolean {
    return threadId in this.renames;
  }

  /**
   * Resolve the title to render. Override wins when present, server
   * title otherwise. Empty server titles collapse to 'Untitled' so the
   * UI never renders a blank row. Centralised here so every surface
   * (chat header, thread rail, switcher, command palette) renders the
   * same string for a given thread.
   */
  displayTitle(threadId: string, serverTitle: string | null | undefined): string {
    const override = this.renames[threadId];
    if (override) return override;
    const server = (serverTitle ?? '').trim();
    return server === '' ? 'Untitled' : server;
  }

  /**
   * Apply a `thread-rename` message received from a sibling window.
   * Internal — invoked by the broadcast handler in `broadcast.svelte.ts`.
   * Does NOT re-emit (belt-and-braces with the senderId loop guard in
   * the broadcast singleton). Persists locally so a reload after the
   * sender window closes still shows the renamed title.
   */
  applyRemote(threadId: string, title: string | null): void {
    if (!threadId) return;
    if (title === null) {
      if (!(threadId in this.renames)) return;
      const next = { ...this.renames };
      delete next[threadId];
      this.renames = next;
      this.persist();
      return;
    }
    const trimmed = title.trim();
    if (trimmed === '') return;
    if (this.renames[threadId] === trimmed) return;
    this.renames = { ...this.renames, [threadId]: trimmed };
    this.persist();
  }

  /** Persist the current shape to localStorage. Best-effort — quota /
   *  private-mode failures are non-fatal (the renames still work
   *  in-memory and the next mutation re-attempts). */
  private persist(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(this.renames));
    } catch {
      // Storage may be full or disabled — non-fatal.
    }
  }

  // -- onboarding tooltip ---------------------------------------------------
  //
  // The first time a user starts to rename a thread, we surface a small
  // (?) tooltip explaining that renames are local-only. The seen flag
  // persists in localStorage so dismissing the tooltip in one window
  // doesn't re-arm it on a sibling window's next rename.

  /** True until the user has dismissed the local-only tooltip once. */
  isTooltipUnseen(): boolean {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(TOOLTIP_KEY) !== 'true';
    } catch {
      return false;
    }
  }

  /** Mark the local-only tooltip as dismissed. */
  markTooltipSeen(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(TOOLTIP_KEY, 'true');
    } catch {
      // Non-fatal — the user will just see the tooltip again next launch.
    }
  }
}

/** Global singleton — import this anywhere a surface renders a thread title. */
export const threadRename = new ThreadRenameStore();
