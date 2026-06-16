import { isDesktopRuntime, tauriInvoke } from './api.js';

// Browser-style zoom for the desktop app: Cmd/Ctrl + (= or +) zooms in,
// (- or _) zooms out, 0 resets. Uses the native webview zoom via the
// set_webview_zoom command — a uniform page scale, so the layout never
// reflow-breaks — and persists the factor in localStorage so it survives
// relaunch (the OS-native zoom hotkeys don't persist).

const STORAGE_KEY = 'ironclaw:webview-zoom';
const MIN = 0.5;
const MAX = 3.0;
const STEP = 0.1;
const DEFAULT = 1.0;

function clampZoom(value) {
  if (!Number.isFinite(value)) return DEFAULT;
  return Math.min(MAX, Math.max(MIN, Math.round(value * 100) / 100));
}

function readZoom() {
  let stored = NaN;
  try {
    stored = parseFloat(window.localStorage?.getItem(STORAGE_KEY) ?? '');
  } catch (_) {
    stored = NaN;
  }
  return Number.isFinite(stored) ? clampZoom(stored) : DEFAULT;
}

function writeZoom(value) {
  try {
    window.localStorage?.setItem(STORAGE_KEY, String(value));
  } catch (_) {
    // Private mode / quota — the zoom still applies for this session.
  }
}

async function applyZoom(factor) {
  // Best-effort: silently ignore failures (e.g. a runtime where the command
  // isn't registered). Zoom is non-critical and must never surface a console
  // error — the packaged-webview smoke fails the build on any console error.
  try {
    await tauriInvoke('set_webview_zoom', { factor });
  } catch (_) {
    // no-op
  }
}

/**
 * Wire Cmd/Ctrl +/-/0 zoom and restore the persisted factor. No-op outside the
 * desktop runtime (the browser already has its own zoom).
 * @returns {void}
 */
export function installZoomControls() {
  if (!isDesktopRuntime()) return;

  // Restore the persisted zoom on launch — but skip the invoke when it's the
  // default (1.0), since the webview already boots at 1.0 and a no-op call would
  // just be noise (and trip command-less test runtimes).
  const initial = readZoom();
  if (initial !== DEFAULT) applyZoom(initial);

  window.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    let next = null;
    if (event.key === '=' || event.key === '+') next = readZoom() + STEP;
    else if (event.key === '-' || event.key === '_') next = readZoom() - STEP;
    else if (event.key === '0' || event.key === ')') next = DEFAULT;
    if (next === null) return;
    event.preventDefault();
    const applied = clampZoom(next);
    writeZoom(applied);
    applyZoom(applied);
  });
}
