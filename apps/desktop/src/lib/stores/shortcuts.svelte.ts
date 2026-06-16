// Rune singleton that tracks the global command-palette visibility.
//
// The palette mounts once at the layout level (`src/routes/+layout.svelte`)
// and reads `palette.open` to render/teardown. Keyboard shortcuts wired in
// the same layout call into this store; per-surface buttons (none yet, but
// e.g. a "press ⌘K" hint in the header) would also import it.

import { telemetry } from './telemetry.svelte';

class PaletteStore {
  open = $state<boolean>(false);

  openPalette(): void {
    if (!this.open) {
      // Opt-in telemetry — gated inside the store, no-op when disabled.
      telemetry.recordEvent('palette:opened');
    }
    this.open = true;
  }

  closePalette(): void {
    this.open = false;
  }

  togglePalette(): void {
    if (!this.open) {
      // Fire on the false→true edge so a toggle that closes the palette
      // doesn't get counted as an open.
      telemetry.recordEvent('palette:opened');
    }
    this.open = !this.open;
  }
}

/** Global singleton — import this anywhere. */
export const palette = new PaletteStore();
