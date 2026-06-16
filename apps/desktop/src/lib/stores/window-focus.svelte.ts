// Reactive window-focus tracker.
//
// A rune singleton that mirrors the current focus state of the browser
// window. Notification triggers consume this so we only fire OS-level
// alerts when the user isn't already looking at the app.
//
// Lifecycle: `init()` wires up the focus/blur listeners and seeds the
// initial value from `document.hasFocus()`. It's idempotent so the layout
// can call it on mount without worrying about duplicate listeners; the
// returned `dispose` function detaches the listeners on layout teardown
// (mainly useful for HMR — in production the listeners live for the
// lifetime of the app).

class WindowFocusStore {
  /** True when the OS window currently has keyboard focus. */
  focused = $state<boolean>(true);

  private installed = false;
  private onFocus: (() => void) | null = null;
  private onBlur: (() => void) | null = null;
  private onVisibility: (() => void) | null = null;

  /**
   * Attach focus/blur listeners on the browser window. Safe to call
   * repeatedly — only the first call wires up listeners.
   *
   * Returns a dispose function for HMR / test teardown. The production
   * code path treats focus tracking as app-lifetime state, so the layout
   * doesn't currently bother to dispose.
   */
  init(): () => void {
    if (typeof window === 'undefined') {
      // SSR / prerender — nothing to do.
      return () => {};
    }
    if (this.installed) {
      return () => this.dispose();
    }
    this.installed = true;
    // Seed from the live state — the page may have been backgrounded
    // before this code runs (e.g. user clicked another window during
    // app launch).
    this.focused = document.hasFocus();

    this.onFocus = () => {
      this.focused = true;
    };
    this.onBlur = () => {
      this.focused = false;
    };
    // visibilitychange catches Cmd-Tab on macOS where the window stays
    // "focused" by some definitions but isn't actually visible. We treat
    // hidden documents as unfocused for notification purposes.
    this.onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        this.focused = false;
      } else if (document.hasFocus()) {
        this.focused = true;
      }
    };

    window.addEventListener('focus', this.onFocus);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);

    return () => this.dispose();
  }

  private dispose() {
    if (!this.installed) return;
    if (this.onFocus) window.removeEventListener('focus', this.onFocus);
    if (this.onBlur) window.removeEventListener('blur', this.onBlur);
    if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility);
    this.installed = false;
    this.onFocus = null;
    this.onBlur = null;
    this.onVisibility = null;
  }
}

/** Global singleton — import this anywhere. */
export const windowFocus = new WindowFocusStore();
