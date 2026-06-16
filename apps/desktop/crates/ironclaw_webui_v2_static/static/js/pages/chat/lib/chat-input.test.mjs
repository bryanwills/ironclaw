import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function chatInputSourceForTest() {
  const source = readFileSync(new URL('../components/chat-input.js', import.meta.url), 'utf8');
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
    lines.push(line.replace('export function ChatInput', 'function ChatInput'));
  }
  return `${lines.join('\n')}\nglobalThis.__testExports = { ChatInput, attachmentStatusLabel, formatProviderLabel, normalizeModelEntries, modelForProvider, visibleLlmSnapshot };`;
}

function findComponent(node, component) {
  if (!node || typeof node !== 'object') return null;
  if (!Array.isArray(node.values)) return null;
  const componentIndex = node.values.indexOf(component);
  if (componentIndex >= 0) {
    return node;
  }
  for (const value of node.values) {
    const found = findComponent(value, component);
    if (found) return found;
  }
  return null;
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

function collectScalars(node) {
  const scalars = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        scalars.push(value);
      }
      return;
    }
    if (Array.isArray(value.values)) {
      for (const child of value.values) visit(child);
    }
  };
  visit(node);
  return scalars;
}

function renderChatInput({
  onCancel,
  onSend = async () => {},
  setCalls = [],
  disabled = true,
  canCancel = true,
  queryResult = { data: null, isLoading: false },
  runtimeContext = {}
} = {}) {
  const components = {
    Button() {},
    Icon() {},
    Popover() {},
    AttachmentPreviewModal() {}
  };
  let stateIndex = 0;
  const context = {
    ...components,
    React: {
      useCallback: (fn) => fn,
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useState: (initial) => {
        const index = stateIndex++;
        let value = typeof initial === 'function' ? initial() : initial;
        return [
          value,
          (next) => {
            value = typeof next === 'function' ? next(value) : next;
            setCalls.push({ index, value });
          }
        ];
      }
    },
    addFiles: () => {},
    clearAttachments: () => {},
    formatSize: (size) => String(size),
    globalThis: {},
    html: (strings, ...values) => ({ strings: Array.from(strings), values }),
    removeAttachment: () => {},
    removeImage: () => {},
    useComposerAttachments: () => ({
      images: [],
      attachments: [],
      rejections: [],
      addFiles: () => {},
      removeImage: () => {},
      removeAttachment: () => {},
      dismissRejections: () => {},
      clearAttachments: () => {}
    }),
    useT: () => (key) => key,
    // ModelPopover dependencies — inert here; popover stays closed in
    // these cancel-button scenarios.
    useQuery: () => queryResult,
    useQueryClient: () => ({ invalidateQueries: () => {} }),
    listLlmProviderModels: async () => ({ models: [] }),
    fetchLlmProviders: async () => ({ providers: [], active: null }),
    filterDesktopVisibleLlmProviders: (providers) =>
      Array.isArray(providers) ? providers.filter((provider) => provider.id === 'nearai') : [],
    modelDisplayName: (model) =>
      String(model || '')
        .replace(/^z-ai\//, '')
        .replace('glm-4.5', 'GLM 4.5'),
    setActiveLlm: async () => ({}),
    gatewayStatus: () => ({}),
    window: { requestAnimationFrame: (fn) => fn() }
  };

  vm.runInNewContext(chatInputSourceForTest(), context);
  const tree = context.globalThis.__testExports.ChatInput({
    onSend,
    onCancel,
    disabled,
    canCancel,
    context: runtimeContext
  });
  return { tree, components };
}

test('ChatInput cancel button invokes onCancel and resets cancelling state', async () => {
  const setCalls = [];
  let cancelCalls = 0;
  let resolveCancel;
  const { tree, components } = renderChatInput({
    setCalls,
    onCancel: async () =>
      new Promise((resolve) => {
        cancelCalls += 1;
        resolveCancel = resolve;
      })
  });

  const cancelButton = findComponent(tree, components.Button);
  const props = componentProps(cancelButton, components.Button);
  const cancelPromise = props.onClick();

  assert.equal(cancelCalls, 1);
  assert.deepEqual(setCalls.slice(0, 1), [{ index: 2, value: true }]);

  resolveCancel();
  await cancelPromise;

  assert.deepEqual(setCalls.slice(-1), [{ index: 2, value: false }]);
});

test('ChatInput cancel button resets cancelling state after rejection', async () => {
  const setCalls = [];
  const { tree, components } = renderChatInput({
    setCalls,
    onCancel: async () => {
      throw new Error('cancel failed');
    }
  });

  const cancelButton = findComponent(tree, components.Button);
  const props = componentProps(cancelButton, components.Button);
  await assert.rejects(props.onClick(), /cancel failed/);

  assert.deepEqual(setCalls, [
    { index: 2, value: true },
    { index: 2, value: false }
  ]);
});

test('formatProviderLabel maps known provider ids to readable names', () => {
  const vmContext = {
    React: {},
    globalThis: {}
  };
  vm.runInNewContext(chatInputSourceForTest(), vmContext);
  const { formatProviderLabel } = vmContext.globalThis.__testExports;
  assert.equal(formatProviderLabel('nearai'), 'NEAR AI Cloud');
  assert.equal(formatProviderLabel('nearai', 'NEAR.AI'), 'NEAR AI Cloud');
  assert.equal(formatProviderLabel('legacy-router'), 'External provider');
  assert.equal(formatProviderLabel('legacy-provider'), 'External provider');
});

test('ChatInput blocks send when NEAR AI Cloud is not active', async () => {
  const sendCalls = [];
  const { tree, components } = renderChatInput({
    disabled: false,
    canCancel: false,
    onSend: async () => {
      sendCalls.push('send');
    },
    queryResult: {
      data: {
        providers: [{ id: 'nearai', name: 'NEAR AI Cloud', default_model: 'z-ai/glm-4.5' }],
        active: null
      },
      isLoading: false
    }
  });

  const sendButton = findComponent(tree, components.Button);
  const props = componentProps(sendButton, components.Button);
  const scalars = collectScalars(tree);

  assert.equal(props.disabled, true);
  assert.ok(scalars.includes('NEAR AI Cloud · Not connected'));
  assert.ok(scalars.includes('Connect NEAR AI Cloud before sending your first message.'));

  await props.onClick();
  assert.deepEqual(sendCalls, []);
});

test('ChatInput renders attachment behind a keyboard-focusable plus sheet', () => {
  const { tree } = renderChatInput({
    disabled: false,
    canCancel: false,
    queryResult: {
      data: {
        providers: [{ id: 'nearai', name: 'NEAR AI Cloud', default_model: 'auto' }],
        active: { provider_id: 'nearai', model: 'auto' }
      },
      isLoading: false
    }
  });
  const scalars = collectScalars(tree);
  const source = JSON.stringify(tree);

  assert.ok(scalars.includes('chat.addToMessage'));
  assert.ok(scalars.includes('chat.addMenuTitle'));
  assert.ok(scalars.includes('chat.attachFiles'));
  assert.ok(scalars.includes('chat.attachFilesDesc'));
  assert.ok(scalars.includes('chat.attachFilesHint'));
  assert.match(source, /type=\\?"button\\?"/);
  assert.match(source, /composer-add-menu/);
  assert.match(source, /aria-label=/);
  assert.match(source, /focus-visible:ring/);
});

test('ChatInput model chip renders NEAR model labels instead of raw ids', () => {
  const { tree } = renderChatInput({
    disabled: false,
    canCancel: false,
    queryResult: {
      data: {
        providers: [{ id: 'nearai', name: 'NEAR AI Cloud', default_model: 'z-ai/glm-4.5' }],
        active: { provider_id: 'nearai', model: 'z-ai/glm-4.5' }
      },
      isLoading: false
    }
  });
  const scalars = collectScalars(tree);

  assert.ok(scalars.includes('NEAR AI Cloud · GLM 4.5'));
  assert.ok(!scalars.includes('NEAR AI Cloud · z-ai/glm-4.5'));
});

test('formatProviderLabel keeps custom names and neutralizes unknown ids', () => {
  const vmContext = {
    React: {},
    globalThis: {}
  };
  vm.runInNewContext(chatInputSourceForTest(), vmContext);
  const { formatProviderLabel } = vmContext.globalThis.__testExports;
  assert.equal(formatProviderLabel('custom_adapter', 'My Custom Provider'), 'My Custom Provider');
  assert.equal(formatProviderLabel('my_custom-provider'), 'External provider');
});

test('normalizeModelEntries accepts string and object model snapshots', () => {
  const vmContext = {
    React: {},
    globalThis: {}
  };
  vm.runInNewContext(chatInputSourceForTest(), vmContext);
  const { normalizeModelEntries } = vmContext.globalThis.__testExports;
  assert.deepEqual(
    normalizeModelEntries([
      'glm-4.5',
      { id: 'gpt-4.1' },
      { model: 'claude-sonnet' },
      { name: 'qwen' },
      {}
    ]),
    ['glm-4.5', 'gpt-4.1', 'claude-sonnet', 'qwen']
  );
});

test('modelForProvider prefers active snapshot over provider defaults', () => {
  const vmContext = {
    React: {},
    globalThis: {}
  };
  vm.runInNewContext(chatInputSourceForTest(), vmContext);
  const { modelForProvider } = vmContext.globalThis.__testExports;
  assert.equal(
    modelForProvider(
      { id: 'nearai', default_model: 'auto' },
      { provider_id: 'nearai', model: 'glm-4.5' }
    ),
    'glm-4.5'
  );
  assert.equal(
    modelForProvider(
      { id: 'openai', default_model: 'gpt-4.1' },
      { provider_id: 'nearai', model: 'glm-4.5' }
    ),
    'gpt-4.1'
  );
});

test('visibleLlmSnapshot keeps chat model UI on NEAR AI Cloud', () => {
  const vmContext = {
    React: {},
    filterDesktopVisibleLlmProviders: (providers) =>
      Array.isArray(providers) ? providers.filter((provider) => provider.id === 'nearai') : [],
    globalThis: {}
  };
  vm.runInNewContext(chatInputSourceForTest(), vmContext);
  const { visibleLlmSnapshot } = vmContext.globalThis.__testExports;

  const snapshot = visibleLlmSnapshot({
    providers: [
      { id: 'nearai', name: 'NEAR AI Cloud' },
      { id: 'openrouter', name: 'OpenRouter' }
    ],
    active: { provider_id: 'openrouter', model: 'z-ai/glm-4.5' }
  });

  assert.deepEqual(
    snapshot.providers.map((provider) => provider.id),
    ['nearai']
  );
  assert.equal(snapshot.active, null);
});

test('attachmentStatusLabel describes what the model can actually read', () => {
  const vmContext = {
    React: {},
    globalThis: {}
  };
  vm.runInNewContext(chatInputSourceForTest(), vmContext);
  const { attachmentStatusLabel } = vmContext.globalThis.__testExports;
  const t = (key, vars = {}) => `${key}${vars.chars ? `:${vars.chars}` : ''}`;

  assert.equal(
    attachmentStatusLabel({ extraction: 'extracted', extractedChars: 2400 }, t),
    'chat.attachmentExtracted:2.4k'
  );
  assert.equal(
    attachmentStatusLabel({ extraction: 'raw', modelReadable: true }, t),
    'Model can read this file'
  );
  assert.equal(
    attachmentStatusLabel({ extraction: 'raw', modelReadable: false }, t),
    'chat.attachmentMetadataOnly'
  );
  assert.equal(attachmentStatusLabel({ extraction: 'no-text' }, t), 'chat.attachmentNoText');
});
