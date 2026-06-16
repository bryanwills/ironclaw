// The single save-to-disk path for every export/download in the app.
//
// Desktop truth: blob-URL anchor downloads are a silent no-op in Tauri v2's
// WKWebView (no download handler is registered) — that is exactly how
// "downloads don't work" shipped. On desktop, every save must round-trip
// through the `save_bytes_dialog` Tauri command (native save dialog + Rust
// fs write). Hosted/Chromium keeps the classic anchor download.
import { isDesktopRuntime, tauriInvoke } from './api.js';

function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function anchorDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return filename;
}

/**
 * Save a Blob to the user's machine.
 *
 * @param {Blob} blob
 * @param {string} filename suggested name shown in the save dialog
 * @returns {Promise<string|null>} the saved path (or suggested filename on
 *   the hosted anchor path), or null when the user cancelled the dialog.
 */
export async function saveBlob(blob, filename) {
  if (isDesktopRuntime()) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return tauriInvoke('save_bytes_dialog', {
      defaultFilename: filename,
      contentsBase64: bytesToBase64(bytes)
    });
  }
  return anchorDownload(blob, filename);
}
