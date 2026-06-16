// Trigger a browser "save as" for an in-memory Blob.
//
// Canonical home for the object-URL + transient-anchor dance so data-fetching
// layers (e.g. `lib/api.js`) stay free of DOM side effects and call sites do
// not re-implement (and drift on) the revoke/cleanup steps.
//
// On desktop (Tauri WKWebView) anchor-click downloads are a silent no-op —
// no download handler is registered. Desktop routes through the Tauri
// `save_bytes_dialog` command (native save dialog + Rust fs write) instead.
import { isDesktopRuntime, tauriInvoke } from "./api.js";

function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function saveBlob(blob, filename) {
  if (isDesktopRuntime()) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return tauriInvoke("save_bytes_dialog", {
      defaultFilename: filename || "download",
      contentsBase64: bytesToBase64(bytes),
    });
  }
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename || "download";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Defer revocation: revoking synchronously after click() races the
    // browser's async download manager and breaks downloads in Chrome/
    // Firefox/Safari (the URL is freed before the blob is resolved).
    setTimeout(() => URL.revokeObjectURL(url), 100);
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return filename || "download";
}
