import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function toolActivitySourceForTest() {
  const source = readFileSync(
    new URL('../components/tool-activity.js', import.meta.url),
    'utf8'
  );
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
    lines.push(
      line
        .replace('export const TOOL_RUN_COLLAPSE_AFTER', 'const TOOL_RUN_COLLAPSE_AFTER')
        .replace('export function ToolActivity', 'function ToolActivity')
        .replace('export function ToolRun', 'function ToolRun')
    );
  }
  return `${lines.join('\n')}\nglobalThis.__testExports = { ToolRun, TOOL_RUN_COLLAPSE_AFTER };`;
}

function createContext() {
  return {
    Icon() {},
    React: {
      useEffect: () => {},
      useId: () => 'tool-detail',
      useMemo: (fn) => fn(),
      useState: (initial) => [initial, () => {}]
    },
    globalThis: {},
    html: (strings, ...values) => ({ strings: Array.from(strings), values }),
    useT: () => (key, vars = {}) => {
      const n = vars.n || 0;
      const map = {
        'tool.runFile': `read ${n} file`,
        'tool.runFiles': `read ${n} files`,
        'tool.runSearch': `searched ${n} time`,
        'tool.runSearches': `searched ${n} times`,
        'tool.runCommand': `ran ${n} command`,
        'tool.runCommands': `ran ${n} commands`,
        'tool.runOther': `used ${n} tool`,
        'tool.runOthers': `used ${n} tools`
      };
      return map[key] || key;
    }
  };
}

test('ToolRun collapses successful tool activity behind a summary by default', () => {
  const context = createContext();
  vm.runInNewContext(toolActivitySourceForTest(), context);

  const tree = context.globalThis.__testExports.ToolRun({
    tools: [{ id: 'read-1', toolName: 'read_file', toolStatus: 'success' }]
  });

  assert.equal(context.globalThis.__testExports.TOOL_RUN_COLLAPSE_AFTER, 0);
  assert.match(flatText(tree), /Read 1 file/);
  assert.equal(countFunctionValue(tree, context.globalThis.__testExports.ToolRun), 0);
  assert.doesNotMatch(flatText(tree), /read_file/);
});

function flatText(node) {
  const out = [];
  const visit = (value) => {
    if (value == null) return;
    if (typeof value === 'string') {
      out.push(value);
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

function countFunctionValue(node, fn) {
  let count = 0;
  const visit = (value) => {
    if (value == null) return;
    if (value === fn) {
      count += 1;
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object' && Array.isArray(value.values)) {
      value.values.forEach(visit);
    }
  };
  visit(node);
  return count;
}
