// Rune singleton that tracks the global cross-surface Search visibility.
//
// The GlobalSearch modal mounts once at the layout level
// (`src/routes/+layout.svelte`) and reads `globalSearch.open` to render /
// teardown. Three entry points summon it:
//   - Cmd+Shift+F (Ctrl+Shift+F on non-mac) — bound in the root layout.
//   - The Command Palette (Cmd+K) "Search everywhere" action.
//   - Future header buttons or hint links can import this and call show().
//
// Distinct from `palette` (Cmd+K — navigation + actions) and the chat
// surface's Cmd+F (within-thread find). This store only owns visibility;
// the modal itself owns query state, debouncing, and surface fan-out.

class GlobalSearchStore {
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
export const globalSearch = new GlobalSearchStore();
