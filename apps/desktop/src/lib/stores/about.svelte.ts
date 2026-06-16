// Rune singleton that tracks the global About-dialog visibility.
//
// The About dialog mounts once at the layout level
// (`src/routes/+layout.svelte`) and reads `aboutStore.open` to render /
// teardown. Anywhere that wants to summon the dialog — the command
// palette, the Settings page "show full About" link, future Help menu —
// imports this store and calls `show()`.

class AboutStore {
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
export const aboutStore = new AboutStore();
