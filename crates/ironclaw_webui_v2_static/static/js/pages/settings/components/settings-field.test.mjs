import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function sourceForTest() {
  const source = readFileSync(new URL('./settings-field.js', import.meta.url), 'utf8');
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
  return `${lines.join('\n')}\nglobalThis.__testExports = { SettingsField, SettingsGroup };`;
}

function html(strings, ...values) {
  return { strings: Array.from(strings), values };
}

function templateText(rendered) {
  const text = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.strings)) text.push(...node.strings);
    if (Array.isArray(node.values)) node.values.forEach(visit);
  };
  visit(rendered);
  return text.join('');
}

function deepValuesAfter(rendered, fragment) {
  const values = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.strings) && Array.isArray(node.values)) {
      node.strings.forEach((part, index) => {
        if (part.includes(fragment)) values.push(node.values[index]);
      });
      node.values.forEach(visit);
    }
  };
  visit(rendered);
  return values;
}

function renderSettingsField({ field, value = '', onSave = () => {} }) {
  const effects = [];
  const context = {
    Card: 'Card',
    React: {
      useCallback: (fn) => fn,
      useEffect: (fn) => effects.push(fn),
      useRef: (value) => ({ current: value }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    globalThis: {},
    html,
    useT: () => (key) => key
  };
  vm.runInNewContext(sourceForTest(), context);
  const rendered = context.globalThis.__testExports.SettingsField({
    field,
    value,
    onSave,
    isSaved: false
  });
  return { rendered, effects };
}

test('SettingsField locks and persists fixed single-option selects', () => {
  const saves = [];
  const field = {
    key: 'embeddings.provider',
    label: 'Provider',
    type: 'select',
    options: ['nearai'],
    optionLabels: { nearai: 'NEAR AI Cloud' },
    allowDefault: false
  };

  const { rendered, effects } = renderSettingsField({
    field,
    value: 'openai',
    onSave: (key, value) => saves.push([key, value])
  });

  effects.forEach((effect) => effect());

  assert.equal(deepValuesAfter(rendered, 'value=')[0], 'nearai');
  assert.equal(deepValuesAfter(rendered, 'disabled=')[0], true);
  assert.ok(templateText(rendered).includes('disabled:opacity-100'));
  assert.deepEqual(saves, [['embeddings.provider', 'nearai']]);
});
