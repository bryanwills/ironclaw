import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// ── Shared template helpers (mirrors inference-tab.test.mjs) ──────────────────
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

function includesComponent(root, component) {
  let found = false;
  visit(root, (node) => {
    if (Array.isArray(node.values) && node.values.includes(component)) found = true;
  });
  return found;
}

function collectTemplateText(root) {
  const text = [];
  visit(root, (node) => {
    if (Array.isArray(node.strings)) text.push(...node.strings);
  });
  return text.join('');
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

// ── Render the banner against an injected hook result ────────────────────────
function bannerSourceForTest() {
  const source = readFileSync(new URL('./restart-banner.js', import.meta.url), 'utf8');
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
  return `${lines.join('\n')}\nglobalThis.__testExports = { RestartBanner };`;
}

function renderBanner(hookResult, { visible = true } = {}) {
  const context = {
    Button: 'Button',
    Icon: 'Icon',
    Modal: 'Modal',
    ModalBody: 'ModalBody',
    ModalFooter: 'ModalFooter',
    html,
    globalThis: {},
    useGatewayRestart: () => hookResult,
    useT: () => (key) => key
  };
  vm.runInNewContext(bannerSourceForTest(), context);
  return context.globalThis.__testExports.RestartBanner({
    visible,
    gatewayStatus: {},
    gatewayStatusQuery: {}
  });
}

const HOOK_DEFAULTS = {
  canRestart: false,
  unavailableReason: 'restart.description',
  confirmOpen: false,
  openConfirm: () => {},
  closeConfirm: () => {},
  confirmRestart: () => {},
  restart: () => {},
  isRestarting: false,
  progress: null,
  error: null
};

// ── Contract: the banner must read the hook's real fields only ───────────────
test('RestartBanner reads the hook contract and references no phantom fields', () => {
  const source = readFileSync(new URL('./restart-banner.js', import.meta.url), 'utf8');

  // Real fields the hook returns are consumed.
  for (const field of [
    'restart.canRestart',
    'restart.unavailableReason',
    'restart.confirmOpen',
    'restart.openConfirm',
    'restart.closeConfirm',
    'restart.confirmRestart',
    'restart.isRestarting',
    'restart.progress',
    'restart.error'
  ]) {
    assert.ok(source.includes(field), `banner should read ${field}`);
  }

  // Phantom fields from the old, mismatched contract must be gone.
  for (const phantom of ['restart.restartEnabled', 'restart.progressLabel', 'restart.message']) {
    assert.ok(!source.includes(phantom), `banner must not reference ${phantom}`);
  }
});

test('RestartBanner returns null when not visible', () => {
  assert.equal(renderBanner(HOOK_DEFAULTS, { visible: false }), null);
});

// ── Idle + unavailable (today's honest reality: no v2 restart endpoint) ──────
test('RestartBanner shows no restart affordance when canRestart is false', () => {
  const rendered = renderBanner({ ...HOOK_DEFAULTS, canRestart: false });
  const text = collectTemplateText(rendered);
  const scalars = collectScalars(rendered);

  // Always states the requirement.
  assert.ok(scalars.includes('settings.restartRequired'));
  // Honest muted explanation instead of a teasing disabled button.
  assert.ok(scalars.includes('restart.description'));
  // No restart button, no confirm modal, no in-flight overlay.
  assert.equal(includesComponent(rendered, 'Modal'), false);
  assert.ok(!scalars.includes('settings.restartNow'));
  assert.ok(!text.includes('role="status"'));
});

// ── Idle + available ─────────────────────────────────────────────────────────
test('RestartBanner shows the restart button and confirm modal when canRestart', () => {
  const rendered = renderBanner({ ...HOOK_DEFAULTS, canRestart: true });
  const scalars = collectScalars(rendered);

  assert.equal(includesComponent(rendered, 'Button'), true);
  assert.equal(includesComponent(rendered, 'Modal'), true);
  assert.ok(scalars.includes('settings.restartNow'));
  assert.ok(scalars.includes('restart.confirm'));
  // Not in-flight yet.
  assert.ok(!scalars.includes('restart.progressTitle'));
});

// ── In-flight ────────────────────────────────────────────────────────────────
test('RestartBanner renders the progress overlay while restarting', () => {
  const rendered = renderBanner({
    ...HOOK_DEFAULTS,
    canRestart: true,
    isRestarting: true,
    progress: 'settings.restartStarting'
  });
  const text = collectTemplateText(rendered);
  const scalars = collectScalars(rendered);

  assert.ok(text.includes('role="status"'));
  assert.ok(text.includes('aria-live="polite"'));
  assert.ok(scalars.includes('restart.progressTitle'));
  assert.ok(scalars.includes('settings.restartStarting'));
});

// ── Error ────────────────────────────────────────────────────────────────────
test('RestartBanner renders an error block when the hook reports an error', () => {
  const rendered = renderBanner({
    ...HOOK_DEFAULTS,
    canRestart: true,
    error: 'restart.description'
  });
  const text = collectTemplateText(rendered);

  assert.ok(text.includes('var(--v2-danger-text)'));
  assert.ok(text.includes('var(--v2-danger-soft)'));
});

// ── Hook honesty: availability is derived from restart_enabled AND a real
//    endpoint. No endpoint exists yet, so canRestart is always false. ─────────
function hookSourceForTest() {
  const source = readFileSync(new URL('../hooks/useGatewayRestart.js', import.meta.url), 'utf8');
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
  return `${lines.join('\n')}\nglobalThis.__testExports = { useGatewayRestart };`;
}

function runHook({ gatewayStatus } = {}) {
  // Minimal React stub: useState returns its initial value, useCallback is
  // identity. Enough to read the hook's pure derived contract.
  const React = {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial })
  };
  const context = { React, globalThis: {} };
  vm.runInNewContext(hookSourceForTest(), context);
  return context.globalThis.__testExports.useGatewayRestart({ gatewayStatus });
}

test('useGatewayRestart keeps canRestart false even when the host reports restart_enabled', () => {
  // No v2 restart endpoint exists, so even a restart-capable host stays gated.
  const enabled = runHook({ gatewayStatus: { restart_enabled: true } });
  assert.equal(enabled.canRestart, false);
  assert.equal(enabled.unavailableReason, 'restart.description');

  const disabled = runHook({ gatewayStatus: { restart_enabled: false } });
  assert.equal(disabled.canRestart, false);

  const missing = runHook({ gatewayStatus: undefined });
  assert.equal(missing.canRestart, false);
});

test('useGatewayRestart starts idle with no error or in-flight state', () => {
  const result = runHook({ gatewayStatus: { restart_enabled: true } });
  assert.equal(result.isRestarting, false);
  assert.equal(result.error, null);
  assert.equal(result.confirmOpen, false);
  assert.equal(typeof result.restart, 'function');
  assert.equal(typeof result.openConfirm, 'function');
  assert.equal(typeof result.confirmRestart, 'function');
});
