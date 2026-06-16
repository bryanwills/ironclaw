// Tauri runtime probes.
//
// Two distinct checks, both centralised here so call sites don't
// re-roll the property sniff. R25-1 dogfood showed that a partial
// dev-only IPC shim (see `src/app.html`) can satisfy the "are we in
// Tauri?" question while still missing the plugin-IPC plumbing —
// `inTauriFully()` is the gate plugin callers (updater, notification,
// shell, tray) must use to avoid console-spamming when the shim is
// active.

/**
 * True iff the page is loaded inside the Tauri webview (or a dev-mode
 * shim that pretends to be Tauri for design / dogfood runs).
 *
 * Use this for IPC commands implemented directly in `src-tauri/src/lib.rs`
 * (`get_settings`, `start_sidecar`, `update_tray_status`, ...) — the
 * dev shim in `src/app.html` mocks all of those so they round-trip
 * cleanly in browser preview.
 */
export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * True iff Tauri has finished initializing its IPC dispatcher.
 *
 * The DEV-only shim in `src/app.html` sets `__TAURI_INTERNALS__` so
 * `inTauri()` returns true for design work, but does NOT implement the
 * full IPC surface (`transformCallback`, `ipc.postMessage`, ...).
 * Those only appear once the real Tauri webview has booted.
 *
 * Use this for Tauri plugin calls (`@tauri-apps/plugin-updater`,
 * `@tauri-apps/plugin-notification`, `@tauri-apps/plugin-shell`) that
 * dispatch through the real runtime — calling them against the partial
 * shim fails with `TypeError: window.__TAURI_INTERNALS__.transformCallback
 * is not a function` and spams the console.
 */
export function inTauriFully(): boolean {
  if (!inTauri()) return false;
  // @ts-expect-error — runtime probe of the actual IPC dispatcher
  const internals = window.__TAURI_INTERNALS__;
  return typeof internals?.transformCallback === 'function';
}

/**
 * True iff diagnostic logging (the `ironclaw_diag` Rust target) is
 * currently armed.
 *
 * Used by `ironclaw.ts` and the connection store to gate side-channel
 * `invoke('diag_log', ...)` calls. The scaffold is load-bearing for
 * production debugging (no devtools on the public DMG), so we keep it
 * in the binary — but firing on every request adds noise to the
 * release log AND surfaces request URLs to anyone reading stderr.
 *
 * Sources, in priority order:
 *   1. Vite dev mode (`import.meta.env.DEV`) — always on, so the
 *      `bash scripts/dev-up.sh` flow remains trivially visible.
 *   2. `localStorage['ironclaw-diag']` set to `'1'` — opt-in per
 *      install, persists across launches. Toggled by a "Debug
 *      mode" switch in Settings (added in this round) or by hand
 *      via right-click → Inspect → Application → Local Storage.
 *
 * The `localStorage` check is wrapped in try/catch — quota /
 * private mode / disabled storage cannot brick logging.
 */
export function diagEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (import.meta.env.DEV) return true;
  } catch {
    /* import.meta.env may not exist in some test runners */
  }
  try {
    return window.localStorage?.getItem('ironclaw-diag') === '1';
  } catch {
    return false;
  }
}
