import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function sourceForTest(path, exportNames) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
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
  return `${lines.join('\n')}\nglobalThis.__testExports = { ${exportNames.join(', ')} };`;
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

function collectTemplateText(root) {
  const text = [];
  visit(root, (node) => {
    if (!Array.isArray(node.strings)) return;
    text.push(...node.strings);
  });
  return text.join('');
}

function findComponentNodes(root, component) {
  const nodes = [];
  visit(root, (node) => {
    if (Array.isArray(node.values) && node.values.includes(component)) nodes.push(node);
  });
  return nodes;
}

function createConfigureModalHarness() {
  const context = {
    Button: 'Button',
    Icon: 'Icon',
    Input: 'Input',
    globalThis: {},
    html,
    isDesktopRuntime: () => true,
    React: {
      useCallback: (fn) => fn,
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useRef: (value) => ({ current: value ?? null }),
      useState: (value) => [value, () => {}]
    },
    setupReadyForActivation: () => false,
    useExtensionSetup: () => ({
      secrets: [
        {
          name: 'token',
          prompt: 'Google OAuth token',
          optional: false,
          provided: false,
          setup: { kind: 'manual_token', provider: 'gmail' }
        }
      ],
      fields: [
        {
          name: 'account_label',
          prompt: 'Account label',
          optional: true,
          placeholder: 'gmail account'
        }
      ],
      onboarding: {
        credential_instructions: 'Use the Product Auth token returned by Google sign-in.',
        credential_next_step: 'Save the token; this smoke keeps the runtime blocked.'
      },
      isLoading: false,
      error: null
    }),
    useOauthSetup: () => ({ isPending: false, mutate: () => {}, error: null }),
    useSetupSubmit: () => ({ isPending: false, mutate: () => {}, error: null })
  };

  vm.runInNewContext(
    sourceForTest('./configure-modal.js', ['ConfigureModal', 'ModalShell']),
    context
  );
  return context.globalThis.__testExports;
}

test('ConfigureModal uses v2 tokenized setup styling and shared inputs', () => {
  const { ConfigureModal, ModalShell } = createConfigureModalHarness();
  const rendered = ConfigureModal({
    extension: {
      displayName: 'Gmail',
      packageRef: { kind: 'extension', id: 'tools/gmail' }
    },
    onActivate: () => {},
    onClose: () => {},
    onSaved: () => {}
  });
  const shell = ModalShell({
    onClose: () => {},
    title: 'Configure Gmail',
    children: html`<div />`
  });
  const templateText = collectTemplateText([rendered, shell]);

  assert.ok(templateText.includes('data-testid="connector-setup-modal"'));
  assert.ok(templateText.includes('aria-label="Close setup"'));
  assert.equal(findComponentNodes(rendered, 'Input').length, 2);
  assert.equal(templateText.includes('text-white'), false);
  assert.equal(templateText.includes('text-iron-'), false);
  assert.equal(templateText.includes('border-white'), false);
  assert.equal(templateText.includes('bg-white/'), false);
  assert.equal(templateText.includes('bg-white['), false);
});
