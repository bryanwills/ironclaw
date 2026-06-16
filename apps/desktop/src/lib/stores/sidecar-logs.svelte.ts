// Sidecar stdout/stderr ring-buffer store.
//
// Bridges the Rust-side `SidecarLogState` (see `src-tauri/src/sidecar.rs`)
// into the Logs surface. The Rust side keeps the last 2000 lines in
// memory and emits each new line on the `sidecar:log` Tauri channel; this
// store fetches the backfill via the `get_sidecar_logs` IPC on init,
// then attaches a `listen()` for live updates.
//
// Lifecycle:
//   - `init()` is idempotent; the Logs surface calls it on mount.
//   - `teardown()` detaches the listener and clears the in-memory
//     mirror. Currently invoked only on hot-reload paths — the surface
//     itself keeps the store alive across navigations so the user can
//     come back without losing their tail.
//
// Outside the Tauri webview (`vite preview`, vitest's jsdom env) every
// method is a safe no-op: there's nothing to listen to and nothing to
// fetch. `init()` resolves immediately and `entries` stays empty.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * One line of stdout/stderr captured from the bundled IronClaw sidecar
 * child process. Wire shape mirrors `SidecarLogEntry` in
 * `src-tauri/src/sidecar.rs`.
 */
export interface SidecarLogEntry {
  /** Unix epoch milliseconds when the line was captured. */
  timestamp: number;
  /** `"stdout"` for normal output, `"stderr"` for diagnostics and
   *  process-lifecycle events (e.g. `Terminated`). */
  stream: 'stdout' | 'stderr';
  /** The line contents with trailing whitespace stripped. */
  message: string;
}

/**
 * Hard cap on the mirror buffer we keep in JS. The Rust ring is capped at
 * 2000 but we allow a slightly larger UI window so a live tail that lands
 * lines while the user is mid-scroll doesn't immediately start dropping
 * from the visible end. The Logs surface applies its own MAX_ENTRIES (5000)
 * to the merged view, so this is just an upper bound on what the store
 * itself holds.
 */
const MIRROR_CAP = 2500;

/**
 * Detect whether we're running inside the Tauri webview. Mirrors the
 * sniff used in `tray.svelte.ts` — we look for the `__TAURI_INTERNALS__`
 * global rather than the older `__TAURI__` so we work in both the
 * stable v2 builds and the dev webview. SSR and non-Tauri previews fall
 * through to no-op land.
 */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

class SidecarLogStore {
  /** Mirror of the Rust ring buffer, kept in JS for fast filtering by the
   *  Logs surface. Sorted oldest-first; new entries push to the tail. */
  entries = $state<SidecarLogEntry[]>([]);
  /** True once we've successfully attached the `sidecar:log` listener.
   *  Surfaces can read this to render a "listening" affordance. */
  listening = $state(false);

  /** Detach handle returned by `listen()`. Stored so `teardown()` can
   *  call it without racing against another init(). */
  private unlisten: UnlistenFn | null = null;
  /** True once init() has resolved its initial backfill + listener attach,
   *  preventing duplicate work on repeated calls. */
  private inited = false;
  /** Single shared in-flight init promise so concurrent callers (e.g. two
   *  surfaces mounting at once) coalesce into one IPC + listen pair. */
  private initPromise: Promise<void> | null = null;

  /**
   * Backfill from `get_sidecar_logs` and attach the live listener.
   * Idempotent — repeated calls return the same promise the first call
   * created. No-ops outside the Tauri webview.
   */
  async init(): Promise<void> {
    if (this.inited) return;
    if (this.initPromise) return this.initPromise;
    if (!isTauri()) {
      // Vitest / vite preview — nothing to listen to. Mark as inited so
      // the surface doesn't keep retrying on every mount.
      this.inited = true;
      return;
    }
    this.initPromise = (async () => {
      try {
        // Backfill first so the listener-pushed entries land after the
        // history. We default to 500 entries — matches the Rust side's
        // default so the IPC payload stays predictable.
        const history = await invoke<SidecarLogEntry[]>('get_sidecar_logs', { limit: 500 });
        this.entries = history.slice();
      } catch (err) {
        // The IPC can fail before the sidecar has ever been spawned
        // (empty buffer is fine; transport errors are not). We swallow
        // here and try the listener anyway — a future spawn will start
        // populating the live feed.
        // eslint-disable-next-line no-console
        console.warn('[sidecar-logs] backfill failed:', err);
      }
      try {
        this.unlisten = await listen<SidecarLogEntry>('sidecar:log', (event) => {
          const entry = event.payload;
          if (!entry || typeof entry !== 'object') return;
          // Append + prune. Slice to keep reactivity shallow rather than
          // mutating in place (Svelte 5 picks up the reassignment).
          const next =
            this.entries.length >= MIRROR_CAP ? this.entries.slice(1) : this.entries.slice();
          next.push(entry);
          this.entries = next;
        });
        this.listening = true;
      } catch (err) {
        // Listener attach failure means no live updates — degraded but
        // not fatal. The backfill (if it landed) still shows on screen.
        // eslint-disable-next-line no-console
        console.warn('[sidecar-logs] listener attach failed:', err);
      }
      this.inited = true;
    })();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  /**
   * Empty the buffer on both ends — local mirror and the Rust ring. The
   * Logs surface wires this to its Clear button when the Sidecar source
   * is selected. No-op outside the Tauri webview, but still clears the
   * local mirror so the test env stays consistent.
   */
  async clear(): Promise<void> {
    this.entries = [];
    if (!isTauri()) return;
    try {
      await invoke('clear_sidecar_logs');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[sidecar-logs] clear failed:', err);
    }
  }

  /**
   * Detach the listener and reset state. Mainly for symmetry with other
   * stores (`tray.svelte.ts`, `window-focus.svelte.ts`); the default app
   * shape never tears the store down.
   */
  teardown(): void {
    if (this.unlisten) {
      try {
        this.unlisten();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[sidecar-logs] unlisten failed:', err);
      }
      this.unlisten = null;
    }
    this.listening = false;
    this.inited = false;
  }
}

/** Global singleton — import this anywhere. */
export const sidecarLogs = new SidecarLogStore();
