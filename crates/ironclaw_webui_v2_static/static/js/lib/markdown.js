let linkHookInstalled = false;

// Open every rendered link in a new tab so clicking a PR / diff / issue link in
// a response never navigates away from the active conversation. In the packaged
// Tauri WKWebView an in-frame navigation replaces the whole app shell with no
// back button, so target=_blank keeps the shell put and rel='noopener
// noreferrer' denies the opened page any handle back to the app. Installed once,
// lazily, because DOMPurify is an async-loaded window global; the addHook type
// guard keeps a stubbed/early DOMPurify (tests, partial loads) from throwing.
function ensureLinkTargetHook() {
  if (linkHookInstalled || !window.DOMPurify) return;
  if (typeof window.DOMPurify.addHook !== "function") return;
  window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.getAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  linkHookInstalled = true;
}

export function renderMarkdown(content) {
  if (!content) return "";
  if (!window.marked || !window.DOMPurify) {
    const div = document.createElement("div");
    div.textContent = content;
    return div.innerHTML;
  }
  ensureLinkTargetHook();
  const raw = window.marked.parse(content, { gfm: true, breaks: true });
  return window.DOMPurify.sanitize(raw, { ADD_ATTR: ["target", "rel"] });
}
