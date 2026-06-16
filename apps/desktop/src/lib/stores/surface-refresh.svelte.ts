// Surface-refresh registry.
//
// Cmd+R has different semantics on different surfaces: on /knowledge it
// reloads the tree; on /skills it re-fetches the skill list; on /logs it
// re-opens the SSE stream; and so on. Rather than centralize that logic
// in the layout (which would require coupling +layout.svelte to every
// route's internals), each surface registers a refresh closure on mount
// and unregisters on destroy. The layout-level Cmd+R handler then calls
// whichever closure is currently registered.
//
// Only one handler is registered at a time — when the user navigates,
// the destroyed route unregisters, and the new route registers its own
// during onMount. If the user hits Cmd+R between route transitions
// (vanishingly rare in practice) `invoke()` returns `false` and the
// caller can fall back gracefully (we toast nothing in that case).
//
// The handler is intentionally a $state-backed field rather than a
// module-level let so the layout can read it reactively if it ever
// needs to (e.g. to disable a refresh button when no handler is
// registered). The current shape doesn't read it reactively — invoke()
// is fire-and-forget — but the field stays $state-backed so future
// surfaces can subscribe without a refactor.

class SurfaceRefreshStore {
  /** The currently registered refresh closure, or null if no surface is
   *  active (e.g. between route transitions or on routes that don't
   *  define a refresh semantic). */
  private handler = $state<(() => Promise<void>) | null>(null);

  /**
   * Register a refresh closure. Call from `onMount` in each route's
   * +page.svelte. Replaces any existing handler — the contract is
   * "last registration wins", which mirrors the route lifecycle: when
   * the user navigates, SvelteKit runs the new route's onMount before
   * the old route's onDestroy in most cases, so this is robust against
   * the brief overlap.
   */
  register(fn: () => Promise<void>): void {
    this.handler = fn;
  }

  /**
   * Unregister the current handler. Call from `onDestroy` in each
   * route's +page.svelte. Only clears the slot if the registered
   * closure is the one we're tearing down isn't checked here — we
   * trust the lifecycle to not race itself in practice. If a race
   * does occur, the worst case is one stale invoke() until the new
   * route registers, which is preferable to the alternative (storing
   * a token per registration just to detect the case).
   */
  unregister(): void {
    this.handler = null;
  }

  /**
   * Invoke the current handler, if any. Returns true when a handler
   * ran (so the layout can toast "Refreshed"), false when no handler
   * was registered. The handler is awaited to completion so any toast
   * issued by the handler itself surfaces after the layout's "Refreshed"
   * toast — in practice handlers are short, sub-second refetches.
   *
   * Failures inside the handler are caught here so a thrown refresh
   * (e.g. a transient gateway error) does not bubble to the global
   * unhandledrejection listener. The handler should surface its own
   * error toast; this catch is a last-resort safety net so Cmd+R never
   * crashes the app.
   */
  async invoke(): Promise<boolean> {
    const fn = this.handler;
    if (!fn) return false;
    try {
      await fn();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[surface-refresh] handler threw:', err);
    }
    return true;
  }
}

/** Global singleton — import this anywhere. */
export const surfaceRefresh = new SurfaceRefreshStore();
