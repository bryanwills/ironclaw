let linkHardeningInstalled = false;

// Force every sanitized link to open out-of-document, never in-frame. In the
// packaged Tauri WKWebView an in-frame navigation replaces the whole app shell
// with no back button — a hostile or accidental markdown link could strand the
// user outside IronClaw. target=_blank keeps the shell put; rel='noopener
// noreferrer' denies the opened page any handle back to the app. Installed once,
// lazily, because DOMPurify is an async-loaded window global.
function ensureLinkHardening() {
  if (linkHardeningInstalled || !window.DOMPurify) return;
  if (typeof window.DOMPurify.addHook !== 'function') return;
  window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  linkHardeningInstalled = true;
}

export function renderMarkdown(content) {
  if (!content) return '';
  if (!window.marked || !window.DOMPurify) {
    const div = document.createElement('div');
    div.textContent = content;
    return div.innerHTML;
  }
  ensureLinkHardening();
  const raw = window.marked.parse(content, { gfm: true, breaks: true });
  return window.DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel'] });
}
