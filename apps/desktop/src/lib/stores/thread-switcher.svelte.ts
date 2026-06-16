// Rune singleton that tracks the Cmd+T thread switcher visibility.
//
// The switcher mounts once at the layout level (`src/routes/+layout.svelte`)
// and reads `threadSwitcher.open` to render/teardown. Distinct from:
//   - `palette` (Cmd+K) — navigation + actions
//   - `globalSearch` (Cmd+Shift+F) — cross-surface data search
//   - `threadSwitcher` (Cmd+T) — jump-to-thread, laser focused
//
// Same shape as the other modal toggles so consumers (layout shortcut,
// CommandPalette action) can wire it identically.

class ThreadSwitcherStore {
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
export const threadSwitcher = new ThreadSwitcherStore();
