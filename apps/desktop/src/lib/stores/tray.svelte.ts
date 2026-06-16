// Tray menu event listeners.
//
// The Rust tray module (`src-tauri/src/tray.rs`) emits Tauri events when
// the user clicks an item in the menu-bar context menu:
//
//   - `tray:show-window`           → main window was just shown via the
//                                    tray (left-click toggle or a menu
//                                    item that focuses the app). Useful
//                                    for surfaces that want to refresh
//                                    on re-entry.
//   - `tray:show-settings`         → user picked "Open Settings".
//   - `tray:restart-sidecar`       → user picked "Restart sidecar".
//   - `tray:open-notification`     → user picked a "Recent
//                                    notifications" submenu entry. The
//                                    event payload is the notification
//                                    id; we look it up in the history
//                                    ring and route by its category
//                                    (chat → `/`, routine →
//                                    `/routines`, sidecar →
//                                    `/settings`).
//   - `tray:clear-notifications`   → user picked the submenu's "Clear
//                                    all" item. Just flushes the
//                                    history ring; Rust will receive
//                                    the empty list and re-render the
//                                    submenu to the empty-state
//                                    placeholder.
//
// This store mounts the listeners on first `init()` call from the root
// layout. Listeners are torn down on hot-reload (and on programmatic
// `destroy()`) so dev mode doesn't accumulate duplicates.
//
// Navigation + sidecar restart are delegated to the existing surfaces
// (`$app/navigation` + the connection store), so the tray stays a thin
// dispatcher. Anything heavier belongs in those callers.

import { goto } from '$app/navigation';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { connection } from './connection.svelte';
import { notifications, type NotifyCategory } from './notifications.svelte';
import { toasts } from './toasts.svelte';
import { inTauri, inTauriFully } from '$lib/utils/runtime';

/**
 * Route a notification category to the surface it logically lives on.
 * Centralised here so future categories (or per-entry `link` overrides)
 * have one place to land. Returns `undefined` for unknown categories so
 * the caller can no-op without throwing — the menu item still focuses
 * the main window via the Rust side's `focus_main_window` call.
 */
function routeForCategory(category: NotifyCategory | undefined): string | undefined {
  switch (category) {
    case 'chat':
      return '/';
    case 'routine':
      return '/routines';
    case 'sidecar':
      // Settings page has the sidecar status section; we land at the
      // top and let the user scroll to it. A future per-section
      // anchor (e.g. `/settings#sidecar`) could be plumbed through
      // the entry's `link` override.
      return '/settings';
    case 'error':
    default:
      return undefined;
  }
}

class TrayStore {
  private mounted = false;
  private unlisteners: UnlistenFn[] = [];
  /** One-shot guard so the "no real Tauri runtime" warn doesn't fire on
   *  every layout remount (the R25-1 dogfood saw it spammed 8x in
   *  browser dev mode behind the partial app.html shim). */
  private loggedOnce = false;

  /**
   * Wire up the three tray-event listeners. Idempotent — safe to call
   * from any onMount path; subsequent calls are no-ops.
   *
   * Returns void on purpose so callers can `void tray.init()` without
   * awaiting; the underlying `listen` setup is fire-and-forget.
   *
   * The real `listen()` plugin call dispatches through
   * `__TAURI_INTERNALS__.transformCallback`, which the DEV-only shim
   * in `app.html` does NOT implement — so we gate on `inTauriFully()`
   * (full runtime, not just the shim) and degrade silently otherwise.
   */
  init(): void {
    if (this.mounted) return;
    if (!inTauri()) {
      // Outside Tauri entirely (e.g. `vite preview` with no shim) —
      // there's no tray, nothing to listen for. Mark as mounted so we
      // don't keep retrying on every layout remount.
      this.mounted = true;
      return;
    }
    if (!inTauriFully()) {
      // The dev shim is active but lacks the plugin-IPC dispatcher.
      // Skip listener setup so `listen()` doesn't throw with the
      // `transformCallback is not a function` message — log once so
      // it's visible in dev console without spamming the layout
      // remount path.
      this.mounted = true;
      if (!this.loggedOnce) {
        this.loggedOnce = true;
        console.warn('tray: skipping listener setup — running outside the full Tauri runtime');
      }
      return;
    }
    this.mounted = true;
    void this.attach();
  }

  /** Detach all listeners. Mainly for symmetry / future tests; the
   *  default app shape never tears the layout down. */
  destroy(): void {
    for (const unlisten of this.unlisteners) {
      try {
        unlisten();
      } catch (err) {
        console.warn('tray: unlisten failed', err);
      }
    }
    this.unlisteners = [];
    this.mounted = false;
  }

  private async attach(): Promise<void> {
    try {
      const u1 = await listen('tray:show-settings', () => {
        void goto('/settings');
      });
      const u2 = await listen('tray:restart-sidecar', () => {
        void this.restartSidecar();
      });
      const u3 = await listen('tray:show-window', () => {
        // Rust already raised + focused the window; the layout's
        // focus effect will mark unseen notifications as seen too,
        // but we also fire it from here so the badge clears the
        // instant the user acts on the tray click (focusing the
        // window can lag the click on macOS by a frame or two on
        // cold paths). Idempotent.
        notifications.markAllSeen();
        void notifications.pushBadge();
      });
      // Recent-notifications submenu: route by the matching history
      // entry's category. We look the entry up by id (echoed back from
      // Rust) so a future per-entry `link` override has somewhere to
      // attach without changing the event contract.
      const u4 = await listen<string>('tray:open-notification', (event) => {
        const id = event.payload;
        if (typeof id !== 'string' || !id) return;
        const entry = notifications.history.find((e) => e.id === id);
        if (!entry) {
          // The entry has aged out of the ring (e.g. user clicked an
          // old submenu after several new notifications dropped it).
          // The main window is already focused by the Rust side; just
          // no-op the navigation.
          return;
        }
        const route = routeForCategory(entry.category);
        if (route) {
          void goto(route);
        }
      });
      const u5 = await listen('tray:clear-notifications', () => {
        // `clearHistory` will re-push an empty list to the Rust side,
        // which rebuilds the submenu with the "No recent notifications"
        // placeholder.
        notifications.clearHistory();
      });
      this.unlisteners.push(u1, u2, u3, u4, u5);
    } catch (err) {
      // A failure here means tray events won't fire on the JS side —
      // degraded but not fatal. Surface once so it's visible during
      // dev without spamming on every reattach attempt.
      console.warn('tray: listener setup failed', err);
    }
  }

  private async restartSidecar(): Promise<void> {
    // Only meaningful in local mode — remote profiles don't have a
    // sidecar to restart. Toast feedback either way so the user sees
    // their menu click did something.
    if (connection.activeProfile.mode !== 'local') {
      toasts.show('Active profile is remote — nothing to restart', 'info');
      return;
    }
    try {
      await connection.stopSidecar();
      const ok = await connection.startSidecar();
      toasts.show(
        ok
          ? 'Sidecar restarted'
          : `Sidecar restart failed: ${connection.sidecarError ?? 'unknown'}`,
        ok ? 'success' : 'error'
      );
    } catch (err) {
      toasts.show(`Sidecar restart failed: ${(err as Error).message}`, 'error');
    }
  }
}

/** Global singleton — import this anywhere. */
export const tray = new TrayStore();
