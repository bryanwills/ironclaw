import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  enhanceRenderedMarkdown,
  ensureHighlightJs,
  ensureMermaidJs,
  renderMermaidDiagram,
  resetMarkdownRendererTestState
} from './markdown-renderer.js';

test('ensureHighlightJs lazy-loads Highlight.js through the static asset loader once', async () => {
  resetMarkdownRendererTestState();
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1:1420/v2/chat' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  const loads = [];
  window.__IRONCLAW_LOAD_SCRIPT__ = async (path) => {
    loads.push(path);
    window.hljs = { highlightElement() {} };
  };

  try {
    assert.equal(window.hljs, undefined);
    const [first, second] = await Promise.all([ensureHighlightJs(), ensureHighlightJs()]);
    assert.equal(first, window.hljs);
    assert.equal(second, window.hljs);
    assert.deepEqual(loads, ['vendor/highlight.min.js']);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test('ensureMermaidJs lazy-loads Mermaid through the static asset loader once', async () => {
  resetMarkdownRendererTestState();
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1:1420/v2/chat' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  const loads = [];
  const initializes = [];
  window.__IRONCLAW_LOAD_SCRIPT__ = async (path) => {
    loads.push(path);
    window.mermaid = {
      initialize: (options) => initializes.push(options),
      render: async () => ({ svg: '<svg><text>ok</text></svg>' })
    };
  };

  try {
    const [first, second] = await Promise.all([ensureMermaidJs(), ensureMermaidJs()]);
    assert.equal(first, window.mermaid);
    assert.equal(second, window.mermaid);
    assert.deepEqual(loads, ['vendor/mermaid.min.js']);
    assert.equal(initializes.length, 1);
    assert.equal(initializes[0].startOnLoad, false);
    assert.equal(initializes[0].securityLevel, 'strict');
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test('configureMermaid themes off live v2 tokens, not hardcoded dark/blue', async () => {
  resetMarkdownRendererTestState();
  const dom = new JSDOM(
    [
      '<!doctype html>',
      '<html data-theme="light">',
      '<head><style>',
      ':root{--v2-surface-soft:#f0f4f8;--v2-text-strong:#101820;',
      '--v2-accent:#0091fd;--v2-text-muted:#5d6b7c;--v2-text:#263241;}',
      '</style></head><body></body></html>'
    ].join(''),
    { url: 'http://127.0.0.1:1420/v2/chat' }
  );
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  const initializes = [];
  window.__IRONCLAW_LOAD_SCRIPT__ = async () => {
    window.mermaid = {
      initialize: (options) => initializes.push(options),
      render: async () => ({ svg: '<svg></svg>' })
    };
  };

  try {
    await ensureMermaidJs();
    assert.equal(initializes.length, 1);
    const cfg = initializes[0];
    // The fix must not force dark or the off-brand Tailwind blue-500.
    assert.notEqual(cfg.theme, 'dark');
    assert.equal(cfg.securityLevel, 'strict');
    assert.equal(cfg.startOnLoad, false);
    assert.equal(cfg.themeVariables.background, 'transparent');
    // Border is the v2 accent token, never #3b82f6.
    assert.equal(cfg.themeVariables.primaryBorderColor, '#0091fd');
    assert.notEqual(cfg.themeVariables.primaryBorderColor, '#3b82f6');
    assert.equal(cfg.themeVariables.primaryColor, '#f0f4f8');
    assert.equal(cfg.themeVariables.primaryTextColor, '#101820');
    assert.equal(cfg.themeVariables.textColor, '#263241');
    assert.equal(cfg.themeVariables.lineColor, '#5d6b7c');
  } finally {
    delete window.mermaid;
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test('configureMermaid re-themes when the in-app theme toggles', async () => {
  resetMarkdownRendererTestState();
  const dom = new JSDOM(
    [
      '<!doctype html>',
      '<html data-theme="light">',
      '<head><style>',
      ':root{--v2-text-strong:#101820;}',
      ':root[data-theme="dark"]{--v2-text-strong:#f4f8ff;}',
      '</style></head><body></body></html>'
    ].join(''),
    { url: 'http://127.0.0.1:1420/v2/chat' }
  );
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  const initializes = [];
  window.__IRONCLAW_LOAD_SCRIPT__ = async () => {
    window.mermaid = {
      initialize: (options) => initializes.push(options),
      render: async () => ({ svg: '<svg></svg>' })
    };
  };

  try {
    await ensureMermaidJs();
    // Same theme: the cached mermaid path must not reconfigure.
    await ensureMermaidJs();
    assert.equal(initializes.length, 1);
    assert.equal(initializes[0].themeVariables.primaryTextColor, '#101820');

    // Toggle to dark — the one-time guard must no longer block re-theming.
    document.documentElement.setAttribute('data-theme', 'dark');
    await ensureMermaidJs();
    assert.equal(initializes.length, 2);
    assert.equal(initializes[1].themeVariables.primaryTextColor, '#f4f8ff');

    // Toggle back to light reconfigures again.
    document.documentElement.setAttribute('data-theme', 'light');
    await ensureMermaidJs();
    assert.equal(initializes.length, 3);
    assert.equal(initializes[2].themeVariables.primaryTextColor, '#101820');
  } finally {
    delete window.mermaid;
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test('renderMermaidDiagram sanitizes rendered SVG output', async () => {
  resetMarkdownRendererTestState();
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1:1420/v2/chat' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  window.mermaid = {
    initialize() {},
    render: async () => ({
      svg: '<svg><script>alert(1)</script><text>Approved flow</text></svg>'
    })
  };
  window.DOMPurify = {
    sanitize: (svg, options) => {
      assert.deepEqual(options, { USE_PROFILES: { svg: true, svgFilters: true } });
      return svg.replace(/<script[\s\S]*?<\/script>/g, '');
    }
  };

  try {
    const svg = await renderMermaidDiagram('graph TD; A-->B');
    assert.match(svg, /<svg>/);
    assert.match(svg, /Approved flow/);
    assert.doesNotMatch(svg, /script/);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test('re-enhancing after a body re-set restores a previously rendered Mermaid SVG', async () => {
  resetMarkdownRendererTestState();
  const dom = new JSDOM('<!doctype html><body><section id="root"></section></body>', {
    url: 'http://127.0.0.1:1420/v2/chat'
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  window.mermaid = {
    initialize() {},
    render: async () => ({ svg: '<svg><text>rendered diagram</text></svg>' })
  };
  window.DOMPurify = { sanitize: (svg) => svg };

  const bodyHtml = '<pre><code class="language-mermaid">graph TD\nA-->B</code></pre>';

  try {
    const root = document.getElementById('root');

    // First enhancement: the user clicks "Render diagram".
    root.innerHTML = bodyHtml;
    enhanceRenderedMarkdown(root);
    const card = root.querySelector('[data-md-renderer="mermaid"]');
    assert.ok(card);
    const renderButton = Array.from(card.querySelectorAll('button')).find(
      (b) => b.textContent === 'Render diagram'
    );
    assert.ok(renderButton);
    renderButton.dispatchEvent(new dom.window.Event('click'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const renderedOutput = card.querySelector('.v2-mermaid-card__output');
    assert.match(renderedOutput.innerHTML, /rendered diagram/);
    assert.equal(card.dataset.rendered, '1');

    // Simulate React re-committing the markdown body innerHTML on a re-render:
    // every imperatively built node (the card + rendered SVG) is wiped.
    root.innerHTML = bodyHtml;
    assert.equal(root.querySelectorAll('[data-md-renderer="mermaid"]').length, 0);

    // Re-enhancement must restore the rendered diagram from cache without a
    // second click and without re-prompting the user.
    enhanceRenderedMarkdown(root);
    const restoredCard = root.querySelector('[data-md-renderer="mermaid"]');
    assert.ok(restoredCard);
    assert.equal(restoredCard.dataset.rendered, '1');
    const restoredOutput = restoredCard.querySelector('.v2-mermaid-card__output');
    assert.equal(restoredOutput.hidden, false);
    assert.match(restoredOutput.innerHTML, /rendered diagram/);
    assert.ok(restoredOutput.querySelector('svg'));
    const restoredButton = Array.from(restoredCard.querySelectorAll('button')).find((b) =>
      ['Rendered', 'Render diagram', 'Retry render'].includes(b.textContent)
    );
    assert.equal(restoredButton.textContent, 'Rendered');
    assert.equal(restoredButton.disabled, true);
  } finally {
    delete window.mermaid;
    delete window.DOMPurify;
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

test('enhanceRenderedMarkdown upgrades already-enhanced Mermaid blocks', () => {
  resetMarkdownRendererTestState();
  const dom = new JSDOM(
    [
      '<!doctype html><body>',
      '<section id="root">',
      '<pre data-enhanced="1"><code class="language-mermaid">graph TD\nA-->B</code></pre>',
      '</section>',
      '</body>'
    ].join(''),
    { url: 'http://127.0.0.1:1420/v2/chat' }
  );
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  try {
    enhanceRenderedMarkdown(document.getElementById('root'));
    assert.ok(document.querySelector('[data-md-renderer="mermaid"]'));
    assert.ok(document.querySelector('.v2-mermaid-card__source pre[data-enhanced="1"]'));
    assert.equal(document.querySelectorAll('[data-md-renderer="mermaid"]').length, 1);

    enhanceRenderedMarkdown(document.getElementById('root'));
    assert.equal(document.querySelectorAll('[data-md-renderer="mermaid"]').length, 1);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});
