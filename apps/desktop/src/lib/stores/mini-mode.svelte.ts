// LANE B7 (R64) — Mini-mode floating panel.
//
// 320×400 always-on-top child window that strips IronClaw down to a model
// banner, the last 5 messages of the current thread, and a one-line
// composer. Summoned via Cmd+Shift+M from anywhere in the main window
// (see the chord branch in `src/routes/+layout.svelte`).
//
// The store is intentionally thin: it owns the open/closed bit and the
// Tauri IPC that asks Rust to spin up (or re-focus) the child window.
// Rendering lives in `src/routes/mini/+page.svelte` →
// `src/lib/components/MiniPanel.svelte`; that window has its own
// SvelteKit lifecycle and reads `messages` / `threads` / `connection`
// directly, so the store doesn't need to broker any state.
//
// Outside the Tauri webview the toggle is a no-op — browser preview and
// vitest runs don't have the `open_mini_window` command available.

import { invoke } from '@tauri-apps/api/core';
import { inTauri } from '$lib/utils/runtime';

class MiniModeStore {
  /** True after a successful `open_mini_window` IPC. The child window
   *  doesn't push state back into the main window's store today — the
   *  flag is best-effort UI state for the main window's own surfaces
   *  (e.g. a future menu toggle showing a check when mini-mode is up). */
  open = $state<boolean>(false);

  /**
   * Open (or re-focus) the mini-mode window. Returns once the IPC
   * resolves; the Rust side either creates a fresh `mini`-labelled
   * window or shows + focuses the existing one. Failures are logged but
   * not toasted — the chord shouldn't surface noisy errors if the user
   * presses it twice in quick succession.
   */
  async toggle(): Promise<void> {
    if (!inTauri()) return;
    try {
      await invoke('open_mini_window');
      this.open = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[mini-mode] open failed', err);
    }
  }

  /** Reset the flag — called from the mini window itself on close, and
   *  exposed so tests can rewind without mocking the IPC round-trip. */
  reset(): void {
    this.open = false;
  }
}

/** Global singleton — import this anywhere. */
export const miniMode = new MiniModeStore();
