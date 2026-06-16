// Rune singleton that tracks the Cmd+Shift+N Quick-capture mini-chat
// visibility.
//
// The Quick-capture overlay mounts once at the layout level
// (`src/routes/+layout.svelte`) and reads `quickCapture.open` to render /
// teardown. Distinct from the four other modal toggles:
//   - `palette`         (Cmd+K)        — navigation + actions
//   - `globalSearch`    (Cmd+Shift+F)  — cross-surface data search
//   - `threadSwitcher`  (Cmd+T)        — jump-to-thread
//   - `aboutStore`      (no chord)     — About dialog
//   - `quickCapture`    (Cmd+Shift+N)  — drop a thought into a dedicated
//     "Quick captures" thread without leaving the current surface.
//
// Same shape as the other modal toggles so consumers (layout shortcut,
// CommandPalette action) can wire it identically.

class QuickCaptureStore {
  open = $state<boolean>(false);

  show(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }

  toggle(): void {
    this.open = !this.open;
  }
}

/** Global singleton — import this anywhere. */
export const quickCapture = new QuickCaptureStore();
