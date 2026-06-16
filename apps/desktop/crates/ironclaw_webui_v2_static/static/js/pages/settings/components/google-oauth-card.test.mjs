import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function sourceForTest() {
  const source = readFileSync(new URL('./google-oauth-card.js', import.meta.url), 'utf8');
  const lines = [];
  let skippingImport = false;
  for (const line of source.split('\n')) {
    if (!skippingImport && line.startsWith('import ')) {
      skippingImport = !line.trimEnd().endsWith(';');
      continue;
    }
    if (skippingImport) {
      skippingImport = !line.trimEnd().endsWith(';');
      continue;
    }
    lines.push(line.replace(/^export function /, 'function '));
  }
  return `${lines.join('\n')}\nglobalThis.__testExports = { GoogleOauthCard };`;
}

function html(strings, ...values) {
  return { strings: Array.from(strings), values };
}

function visit(node, fn) {
  if (Array.isArray(node)) {
    for (const item of node) visit(item, fn);
    return;
  }
  if (!node || typeof node !== 'object') return;
  fn(node);
  if (Array.isArray(node.values)) {
    for (const value of node.values) visit(value, fn);
  }
}

function findComponentNode(root, component) {
  let found = null;
  visit(root, (node) => {
    if (!found && Array.isArray(node.values) && node.values.includes(component)) found = node;
  });
  return found;
}

function componentProps(node, component) {
  const props = {};
  const start = node.values.indexOf(component);
  for (let index = start + 1; index < node.values.length; index += 1) {
    const name = node.strings[index]?.match(/([A-Za-z][A-Za-z0-9]*)=\s*$/)?.[1];
    if (name) props[name] = node.values[index];
  }
  return props;
}

function collectScalars(root) {
  const scalars = [];
  visit(root, (node) => {
    if (!Array.isArray(node.values)) return;
    for (const value of node.values) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        scalars.push(value);
      }
    }
  });
  return scalars;
}

function collectTemplateText(root) {
  const text = [];
  visit(root, (node) => {
    if (Array.isArray(node.strings)) text.push(...node.strings);
  });
  return text.join('');
}

function renderGoogleOauthCard({ savedId = '', clientId = savedId } = {}) {
  const stateValues = [clientId, savedId, false, '', ''];
  let stateIndex = 0;
  const context = {
    Button: 'Button',
    Card: 'Card',
    globalThis: {},
    html,
    isDesktopRuntime: () => true,
    openExternalUrl: () => {},
    React: {
      useEffect: () => {},
      useState: (initial) => {
        const index = stateIndex;
        stateIndex += 1;
        return [
          stateValues[index] ?? initial,
          (next) => {
            stateValues[index] = typeof next === 'function' ? next(stateValues[index]) : next;
          }
        ];
      }
    },
    tauriInvoke: async () => ({}),
    useT: () => (key) => key
  };

  vm.runInNewContext(sourceForTest(), context);
  return context.globalThis.__testExports.GoogleOauthCard();
}

test('GoogleOauthCard exposes a stable deep-link target and blocked setup state', () => {
  const rendered = renderGoogleOauthCard();
  const scalars = collectScalars(rendered);
  const cardProps = componentProps(findComponentNode(rendered, 'Card'), 'Card');

  assert.equal(cardProps.id, 'google-oauth');
  assert.ok(scalars.includes('needs client ID'));
  assert.ok(
    scalars.includes(
      'Google connectors are blocked until a Desktop app client ID is saved here. Hosted Google OAuth is not available from this gateway yet.'
    )
  );
});

test('GoogleOauthCard uses product typography for setup labels', () => {
  const rendered = renderGoogleOauthCard();
  const templateText = collectTemplateText(rendered);

  assert.doesNotMatch(templateText, /font-mono text-\[11px\] uppercase/);
  assert.doesNotMatch(templateText, /font-mono text-\[10px\] uppercase/);
});

test('GoogleOauthCard renders ready copy when a client id is saved', () => {
  const rendered = renderGoogleOauthCard({
    savedId: 'desktop-client.apps.googleusercontent.com'
  });
  const scalars = collectScalars(rendered);

  assert.ok(scalars.includes('ready'));
  assert.ok(
    scalars.includes('Gmail and Calendar can now open browser sign-in from the Extensions registry.')
  );
});
