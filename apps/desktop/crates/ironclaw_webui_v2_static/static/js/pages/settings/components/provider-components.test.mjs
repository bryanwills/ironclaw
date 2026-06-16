import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { groupProvidersByStatus } from '../lib/llm-providers.js';

const PROVIDER_GROUP_LABELS = ['llm.groupActive', 'llm.groupReady', 'llm.groupSetup'];

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

function findComponentNodes(root, component) {
  const nodes = [];
  visit(root, (node) => {
    if (Array.isArray(node.values) && node.values.includes(component)) nodes.push(node);
  });
  return nodes;
}

function componentProps(node, component) {
  const props = {};
  const start = node.values.indexOf(component);
  for (let index = start + 1; index < node.values.length; index += 1) {
    const templateBeforeValue = node.strings[index] || '';
    const name = templateBeforeValue.match(/([A-Za-z][A-Za-z0-9]*)=\s*$/)?.[1];
    if (
      !name &&
      index > start + 1 &&
      (templateBeforeValue.includes('/>') ||
        templateBeforeValue.includes('<//>') ||
        /<\s*$/.test(templateBeforeValue))
    ) {
      break;
    }
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
    if (!Array.isArray(node.strings)) return;
    text.push(...node.strings);
  });
  return text.join('');
}

function valueAfter(rendered, fragment) {
  const index = rendered.strings.findIndex((part) => part.includes(fragment));
  assert.notEqual(index, -1, `expected template fragment ${fragment}`);
  return rendered.values[index];
}

function valuesAfter(rendered, fragment) {
  return rendered.strings.reduce((values, part, index) => {
    if (part.includes(fragment)) values.push(rendered.values[index]);
    return values;
  }, []);
}

function deepValuesAfter(root, fragment) {
  const values = [];
  visit(root, (node) => {
    if (!Array.isArray(node.strings) || !Array.isArray(node.values)) return;
    node.strings.forEach((part, index) => {
      if (part.includes(fragment)) values.push(node.values[index]);
    });
  });
  return values;
}

function builtinProvider(id, overrides = {}) {
  return {
    id,
    name: id,
    builtin: true,
    adapter: 'open_ai_completions',
    api_key_required: true,
    base_url_required: false,
    has_api_key: true,
    default_model: 'model',
    ...overrides
  };
}

function customProvider(id, overrides = {}) {
  return {
    id,
    name: id,
    builtin: false,
    adapter: 'ollama',
    configured: true,
    default_model: 'llama',
    ...overrides
  };
}

function useProviderManagementActionsStub({ providers, activeProviderId }) {
  return () => ({
    allProviderIds: providers.map((provider) => provider.id),
    closeDialog: () => {},
    dialogProvider: null,
    filteredProviders: providers,
    handleDelete: () => {},
    handleSave: () => {},
    handleUse: () => {},
    isDialogOpen: false,
    message: null,
    openDialog: () => {},
    providerState: {
      activeProviderId,
      builtinOverrides: {},
      error: null,
      isBusy: false,
      isLoading: false,
      listModels: async () => ({ ok: true, models: ['llama', 'auto'] }),
      selectedModel: 'llama'
    }
  });
}

function renderProviderManagement({ providers, activeProviderId = 'nearai', searchQuery = '' }) {
  const ProviderCard = 'ProviderCard';
  const context = {
    Button: 'Button',
    Card: 'Card',
    Icon: 'Icon',
    ActiveModelPicker: 'ActiveModelPicker',
    ProviderCard,
    ProviderDialog: 'ProviderDialog',
    ConfirmDialog: 'ConfirmDialog',
    ProviderLoginStatus: 'ProviderLoginStatus',
    SettingsSearchEmpty: 'SettingsSearchEmpty',
    filterDesktopVisibleLlmProviders: (providers) =>
      Array.isArray(providers) ? providers.filter((provider) => provider.id === 'nearai') : [],
    globalThis: {},
    groupProvidersByStatus,
    html,
    modelDisplayName: (model) =>
      String(model || '')
        .replace(/^z-ai\//, '')
        .replace('glm-4.5', 'GLM 4.5')
        .replace(/anthropic\/claude[^ ]*/i, 'NEAR premium reasoning'),
    React: {
      useCallback: (fn) => fn,
      useEffect: () => {},
      useState: (v) => [v, () => {}],
      useRef: (v) => ({ current: v })
    },
    setActiveLlm: async () => {},
    useQueryClient: () => ({ invalidateQueries: async () => {} }),
    useProviderManagementActions: useProviderManagementActionsStub({
      providers,
      activeProviderId
    }),
    useProviderLogin: () => ({
      nearaiBusy: false,
      startNearai: () => {},
      startNearaiWallet: () => {}
    }),
    useT: () => (key) => key
  };

  vm.runInNewContext(
    sourceForTest('./provider-management.js', ['ProviderManagement', 'ActiveModelPanel']),
    context
  );
  const { ProviderManagement, ActiveModelPanel } = context.globalThis.__testExports;
  const rendered = ProviderManagement({
    settings: {},
    gatewayStatus: {},
    searchQuery
  });
  const cardProps = findComponentNodes(rendered, ProviderCard).map((node) =>
    componentProps(node, ProviderCard)
  );
  const panelProps = findComponentNodes(rendered, ActiveModelPanel).map((node) =>
    componentProps(node, ActiveModelPanel)
  );
  return { rendered, cardProps, ActiveModelPanel, panelProps };
}

function groupLabels(rendered) {
  return collectScalars(rendered).filter((value) => PROVIDER_GROUP_LABELS.includes(value));
}

function depsChanged(previous, next) {
  if (!previous || !next || previous.length !== next.length) return true;
  return next.some((value, index) => value !== previous[index]);
}

function createReactStateStub(state) {
  return {
    useCallback: (fn) => fn,
    useEffect: (fn, deps) => {
      if (depsChanged(state.effectDeps, deps)) {
        state.effectDeps = deps ? Array.from(deps) : deps;
        fn();
      }
    },
    useState: (initial) => {
      if (!Object.hasOwn(state, 'expanded')) {
        state.expanded = typeof initial === 'function' ? initial() : initial;
      }
      return [
        state.expanded,
        (next) => {
          state.expanded = typeof next === 'function' ? next(state.expanded) : next;
        }
      ];
    }
  };
}

function createProviderCardHarness() {
  const state = {};
  const context = {
    ActiveModelPickerStub: null,
    Select: 'Select',
    isDesktopRuntime: () => false,
    Badge: 'Badge',
    Button: 'Button',
    Card: 'Card',
    Icon: 'Icon',
    React: createReactStateStub(state),
    adapterLabel: (adapter) => adapter,
    globalThis: {},
    html,
    isProviderConfigured: (provider) => provider.configured !== false,
    modelDisplayName: (model) =>
      String(model || '')
        .replace(/^z-ai\//, '')
        .replace('glm-4.5', 'GLM 4.5')
        .replace(/anthropic\/claude[^ ]*/i, 'NEAR premium reasoning'),
    providerAcceptsApiKey: (provider) => provider.accepts_api_key !== false,
    providerDisplayModel: (provider) => provider.default_model || 'model',
    providerEffectiveBaseUrl: (provider) => provider.base_url || 'https://example.com/v1',
    providerMissingReason: (provider) => provider.missing || 'api_key',
    useT: () => (key) => key
  };

  vm.runInNewContext(sourceForTest('./provider-card.js', ['ProviderCard']), context);

  return {
    state,
    render: (props) =>
      context.globalThis.__testExports.ProviderCard({
        activeProviderId: 'nearai',
        selectedModel: 'active-model',
        builtinOverrides: {},
        isBusy: false,
        onUse: () => {},
        onConfigure: () => {},
        onDelete: () => {},
        onNearaiLogin: () => {},
        onNearaiWallet: () => {},
        loginBusy: false,
        ...props
      })
  };
}

function firstButtonProps(rendered) {
  return componentProps(findComponentNodes(rendered, 'Button')[0], 'Button');
}

test('ProviderManagement collapses active NEAR into the model panel', () => {
  const { rendered, cardProps, panelProps } = renderProviderManagement({
    providers: [
      builtinProvider('nearai', { adapter: 'nearai' }),
      builtinProvider('openai'),
      builtinProvider('anthropic', {
        adapter: 'anthropic',
        has_api_key: false
      })
    ]
  });

  assert.deepEqual(groupLabels(rendered), []);
  assert.deepEqual(deepValuesAfter(rendered, 'data-provider-status='), []);
  assert.deepEqual(cardProps, []);
  assert.equal(panelProps.length, 1);
  assert.equal(panelProps[0].provider.id, 'nearai');
  assert.equal(panelProps[0].currentModel, 'llama');
  assert.ok(
    !collectScalars(rendered).includes('llm.addProvider'),
    'normal desktop provider management must not expose custom provider creation'
  );
  const bodyText = collectScalars(rendered).join('\n') + collectTemplateText(rendered);
  assert.doesNotMatch(bodyText, /openai|anthropic|OpenRouter|Claude/i);
});

test('ProviderManagement status copy uses v2 status tokens', () => {
  const source = readFileSync(new URL('./provider-management.js', import.meta.url), 'utf8');

  assert.match(source, /--v2-danger-text/);
  assert.match(source, /--v2-positive-text/);
  assert.doesNotMatch(source, /border-mint|bg-mint|text-mint/);
  assert.doesNotMatch(source, /border-red-|bg-red-|text-red-/);
});

test('ProviderManagement exposes active NEAR model selection before provider rows', () => {
  const { ActiveModelPanel, panelProps } = renderProviderManagement({
    providers: [
      builtinProvider('nearai', {
        adapter: 'nearai',
        name: 'NEAR AI Cloud',
        default_model: 'auto',
        has_api_key: true
      }),
      builtinProvider('openai')
    ]
  });

  assert.equal(panelProps.length, 1);
  assert.equal(panelProps[0].provider.id, 'nearai');
  assert.equal(panelProps[0].currentModel, 'llama');

  const renderedPanel = ActiveModelPanel({
    ...panelProps[0],
    t: (key) => key
  });
  const pickerNodes = findComponentNodes(renderedPanel, 'ActiveModelPicker');

  assert.equal(pickerNodes.length, 1);
  assert.ok(collectTemplateText(renderedPanel).includes('data-testid="active-model-panel"'));
  assert.ok(collectTemplateText(renderedPanel).includes('Current model'));
  assert.equal(componentProps(pickerNodes[0], 'ActiveModelPicker').provider.id, 'nearai');
  assert.equal(componentProps(pickerNodes[0], 'ActiveModelPicker').currentModel, 'llama');
});

test('ProviderManagement search does not reveal hidden providers', () => {
  const { rendered, cardProps } = renderProviderManagement({
    providers: [builtinProvider('openai')],
    searchQuery: 'open'
  });

  assert.deepEqual(groupLabels(rendered), []);
  assert.deepEqual(cardProps, []);
  assert.ok(findComponentNodes(rendered, 'SettingsSearchEmpty').length > 0);
});

test('ProviderManagement keeps synthetic offline NEAR fallback out of ready bucket', () => {
  const { rendered, cardProps } = renderProviderManagement({
    activeProviderId: '',
    providers: [
      builtinProvider('nearai', {
        adapter: 'nearai',
        api_key_required: false,
        has_api_key: false,
        synthetic_unavailable: true
      })
    ]
  });

  assert.deepEqual(groupLabels(rendered), ['llm.groupSetup']);
  assert.deepEqual(deepValuesAfter(rendered, 'data-provider-status='), ['setup']);
  assert.deepEqual(
    cardProps.map((props) => props.provider.id),
    ['nearai']
  );
});

test('ProviderCard disclosure responds to row, keyboard, and chevron controls', () => {
  const harness = createProviderCardHarness();
  const renderOpenAi = () =>
    harness.render({
      provider: builtinProvider('openai', { default_model: 'gpt' })
    });

  let rendered = renderOpenAi();
  assert.equal(valueAfter(rendered, 'aria-expanded='), 'false');

  valueAfter(rendered, 'onClick=')();
  assert.equal(harness.state.expanded, true);

  rendered = renderOpenAi();
  assert.equal(valueAfter(rendered, 'aria-expanded='), 'true');

  valueAfter(rendered, 'onClick=')();
  assert.equal(harness.state.expanded, false);

  rendered = renderOpenAi();
  valuesAfter(rendered, 'onClick=')[1]();
  assert.equal(harness.state.expanded, true);
});

test('ProviderCard syncs disclosure state when active provider changes', () => {
  const harness = createProviderCardHarness();
  const provider = builtinProvider('openai', { default_model: 'gpt' });

  let rendered = harness.render({ provider, activeProviderId: 'nearai' });
  assert.equal(valueAfter(rendered, 'aria-expanded='), 'false');

  rendered = harness.render({ provider, activeProviderId: 'openai' });
  rendered = harness.render({ provider, activeProviderId: 'openai' });
  assert.equal(valueAfter(rendered, 'aria-expanded='), 'true');
  assert.equal(harness.state.expanded, true);

  rendered = harness.render({ provider, activeProviderId: 'nearai' });
  rendered = harness.render({ provider, activeProviderId: 'nearai' });
  assert.equal(valueAfter(rendered, 'aria-expanded='), 'false');
  assert.equal(harness.state.expanded, false);
});

test('ProviderCard actions keep existing callbacks without toggling disclosure', () => {
  const calls = [];
  const harness = createProviderCardHarness();

  let rendered = harness.render({
    onUse: (provider) => calls.push(['use', provider.id]),
    provider: builtinProvider('openai', { default_model: 'gpt' })
  });

  firstButtonProps(rendered).onClick();
  assert.deepEqual(calls, [['use', 'openai']]);
  assert.equal(harness.state.expanded, false);

  rendered = harness.render({
    onConfigure: (provider) => calls.push(['configure', provider.id]),
    provider: builtinProvider('anthropic', {
      adapter: 'anthropic',
      configured: false,
      default_model: 'claude',
      missing: 'api_key'
    })
  });
  firstButtonProps(rendered).onClick();
  assert.deepEqual(calls.at(-1), ['configure', 'anthropic']);
  assert.equal(harness.state.expanded, false);

  harness.state.expanded = true;
  rendered = harness.render({
    onDelete: (provider) => calls.push(['delete', provider.id]),
    provider: customProvider('local')
  });
  const deleteButton = findComponentNodes(rendered, 'Button').find((node) =>
    collectScalars(node).includes('common.delete')
  );
  assert.ok(deleteButton, 'expected delete button for expanded custom provider');
  componentProps(deleteButton, 'Button').onClick();
  assert.deepEqual(calls.at(-1), ['delete', 'local']);
  assert.equal(harness.state.expanded, true);
});

test('ProviderCard renders login actions instead of generic use for login providers', () => {
  const calls = [];
  const harness = createProviderCardHarness();

  let rendered = harness.render({
    activeProviderId: 'openai',
    onConfigure: (provider) => calls.push(['configure', provider.id]),
    provider: builtinProvider('nearai', { adapter: 'nearai', has_api_key: false })
  });
  let labels = collectScalars(rendered);
  let templateText = collectTemplateText(rendered);
  assert.ok(labels.includes('onboarding.nearWallet'));
  assert.ok(labels.includes('llm.useNearApiKey'));
  assert.ok(templateText.includes('GitHub'));
  assert.ok(templateText.includes('Google'));
  assert.ok(!labels.includes('llm.use'));
  const addKeyButton = findComponentNodes(rendered, 'Button').find((node) => {
    const scalars = collectScalars(node);
    return scalars.includes('llm.useNearApiKey') && !scalars.includes('onboarding.nearWallet');
  });
  assert.ok(addKeyButton, 'expected NEAR API key action');
  componentProps(addKeyButton, 'Button').onClick();
  assert.deepEqual(calls, [['configure', 'nearai']]);
});

test('ProviderCard renders generic use action for NEAR when an API key is configured', () => {
  const calls = [];
  const harness = createProviderCardHarness();
  harness.state.expanded = true;

  const rendered = harness.render({
    activeProviderId: 'openai',
    onUse: (provider) => calls.push(['use', provider.id]),
    provider: builtinProvider('nearai', {
      adapter: 'nearai',
      has_api_key: true
    })
  });
  const labels = collectScalars(rendered);
  const templateText = collectTemplateText(rendered);

  assert.ok(labels.includes('llm.use'));
  assert.ok(labels.includes('llm.configure'));
  assert.ok(!labels.includes('llm.addApiKey'));
  assert.ok(!labels.includes('onboarding.nearWallet'));
  assert.ok(!templateText.includes('GitHub'));

  firstButtonProps(rendered).onClick();
  assert.deepEqual(calls, [['use', 'nearai']]);
});

test('ProviderCard renders cleaned model labels while preserving provider values', () => {
  const harness = createProviderCardHarness();
  harness.state.expanded = true;

  const rendered = harness.render({
    provider: builtinProvider('nearai', {
      adapter: 'nearai',
      default_model: 'anthropic/claude-sonnet-4.5',
      has_api_key: true
    })
  });
  const bodyText = collectScalars(rendered).join('\n') + collectTemplateText(rendered);

  assert.match(bodyText, /NEAR premium reasoning/);
  assert.doesNotMatch(bodyText, /anthropic\/claude|Claude/i);
});
