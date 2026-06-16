import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { summarizeActivity } from './activity-summary.js';

function activityRunSourceForTest() {
  const source = readFileSync(new URL('../components/activity-run.js', import.meta.url), 'utf8');
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
    lines.push(line.replace('export function ActivityRun', 'function ActivityRun'));
  }
  return `${lines.join('\n')}\nglobalThis.__testExports = { ActivityRun, ActivityReceiptCard, receiptTitleForActivity, receiptRowsForActivity, receiptLinkForActivity };`;
}

function createContext() {
  return {
    Icon() {},
    MarkdownRenderer() {},
    React: {
      useState: (initial) => [initial, () => {}]
    },
    ToolActivity() {},
    globalThis: {},
    html: (strings, ...values) => ({ strings: Array.from(strings), values }),
    summarizeActivity
  };
}

test('completed activity runs render as gold receipt cards by default', () => {
  const context = createContext();
  vm.runInNewContext(activityRunSourceForTest(), context);
  const { ActivityRun, ActivityReceiptCard, receiptRowsForActivity, receiptLinkForActivity } =
    context.globalThis.__testExports;
  const activity = [
    {
      id: 'tool-save-draft',
      role: 'tool_activity',
      toolName: 'Saved services agreement',
      toolStatus: 'success',
      toolResultPreview: 'DOCX ready to review',
      resultRef: 'https://example.com/work/services-agreement.docx'
    }
  ];

  const tree = ActivityRun({ activity });
  const receipt = findComponentByName(tree, 'ActivityReceiptCard');
  assert.ok(receipt, 'completed activity should mount the receipt component');

  const card = ActivityReceiptCard(componentPropsByName(receipt, 'ActivityReceiptCard'));
  const flat = flatStrings(card);

  assert.match(flat, /activity-receipt-card/);
  assert.match(flat, /Agent action completed/);
  assert.match(flat, /Saved services agreement/);
  assert.match(flat, /Outcome/);
  assert.match(flat, /DOCX ready to review/);
  assert.match(flat, /Steps/);
  assert.match(flat, /1 tool step/);
  assert.match(flat, /Open result/);
  assert.match(flat, /v2-gold/);
  assert.doesNotMatch(flat, /tool-detail/);
  assert.deepEqual(
    JSON.parse(JSON.stringify(receiptRowsForActivity(activity, summarizeActivity(activity)))),
    [
      { label: 'Outcome', value: 'DOCX ready to review' },
      { label: 'Steps', value: '1 tool step' },
      { label: 'Result', value: 'https://example.com/work/services-agreement.docx' }
    ]
  );
  assert.deepEqual(JSON.parse(JSON.stringify(receiptLinkForActivity(activity))), {
    href: 'https://example.com/work/services-agreement.docx',
    label: 'Open result'
  });
});

test('running and failed activity keeps the plain expandable summary row', () => {
  const context = createContext();
  vm.runInNewContext(activityRunSourceForTest(), context);
  const { ActivityRun } = context.globalThis.__testExports;

  const runningTree = ActivityRun({
    activity: [
      { id: 'tool-running', role: 'tool_activity', toolName: 'read_file', toolStatus: 'running' }
    ]
  });
  const failedTree = ActivityRun({
    activity: [
      { id: 'tool-failed', role: 'tool_activity', toolName: 'read_file', toolStatus: 'error' }
    ]
  });

  assert.equal(findComponentByName(runningTree, 'ActivityReceiptCard'), null);
  assert.equal(findComponentByName(failedTree, 'ActivityReceiptCard'), null);
  assert.match(flatStrings(runningTree), /activity-summary-row/);
  assert.match(flatStrings(failedTree), /activity-summary-row/);
});

function findComponentByName(node, name) {
  if (!node || typeof node !== 'object' || !Array.isArray(node.values)) return null;
  if (node.values.some((value) => typeof value === 'function' && value.name === name)) {
    return node;
  }
  for (const value of node.values) {
    const found = findComponentByName(value, name);
    if (found) return found;
  }
  return null;
}

function componentPropsByName(node, name) {
  const props = {};
  const start = node.values.findIndex(
    (value) => typeof value === 'function' && value.name === name
  );
  for (let index = start + 1; index < node.values.length; index += 1) {
    const propName = node.strings[index]?.match(/([A-Za-z][A-Za-z0-9]*)=\s*$/)?.[1];
    if (propName) props[propName] = node.values[index];
  }
  return props;
}

function flatStrings(node) {
  const out = [];
  const visit = (value) => {
    if (value == null) return;
    if (typeof value === 'string' || typeof value === 'number') {
      out.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object' && Array.isArray(value.strings)) {
      out.push(value.strings.join(' '));
      value.values.forEach(visit);
    }
  };
  visit(node);
  return out.join('\n');
}
