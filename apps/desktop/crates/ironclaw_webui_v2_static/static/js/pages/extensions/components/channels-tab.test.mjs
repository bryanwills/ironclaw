import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function channelsTabSourceForTest() {
  const source = readFileSync(new URL('./channels-tab.js', import.meta.url), 'utf8');
  const lines = [];
  for (const line of source.split('\n')) {
    if (line.startsWith('import ')) continue;
    lines.push(line.replace(/^export function /, 'function '));
  }
  return `${lines.join('\n')}\nglobalThis.__testExports = { isSlackChannelEnabled, deriveSlackMessagingState, deriveDesktopChatState };`;
}

test('isSlackChannelEnabled covers all Slack channel ids', () => {
  const context = { globalThis: {} };
  vm.runInNewContext(channelsTabSourceForTest(), context);
  const { isSlackChannelEnabled } = context.globalThis.__testExports;

  assert.equal(isSlackChannelEnabled(['slack']), true);
  assert.equal(isSlackChannelEnabled(['slack_v2']), true);
  assert.equal(isSlackChannelEnabled(['slack-v2']), true);
  assert.equal(isSlackChannelEnabled([]), false);
  assert.equal(isSlackChannelEnabled(['other']), false);
});

test('deriveSlackMessagingState treats gateway offline as unavailable', () => {
  const context = { globalThis: {} };
  vm.runInNewContext(channelsTabSourceForTest(), context);
  const { deriveSlackMessagingState } = context.globalThis.__testExports;

  const result = deriveSlackMessagingState({
    gatewayOffline: true,
    enabledChannels: ['slack'],
    connectableChannels: [{ channel: 'slack', action: { type: 'oauth' } }]
  });

  assert.equal(result.enabled, false);
  assert.equal(result.connectAction, null);
  assert.equal(result.statusLabel, 'unavailable');
  assert.equal(result.statusTone, 'warning');
});

test('deriveSlackMessagingState only offers connect when gateway exposes Slack setup', () => {
  const context = { globalThis: {} };
  vm.runInNewContext(channelsTabSourceForTest(), context);
  const { deriveSlackMessagingState } = context.globalThis.__testExports;

  const result = deriveSlackMessagingState({
    gatewayOffline: false,
    enabledChannels: [],
    connectableChannels: [{ channel: 'slack', action: { type: 'oauth' } }]
  });

  assert.equal(result.enabled, false);
  assert.equal(result.statusLabel, 'connect');
  assert.equal(result.statusTone, 'info');
});

test('deriveDesktopChatState reports unavailable when gateway offline', () => {
  const context = { globalThis: {} };
  vm.runInNewContext(channelsTabSourceForTest(), context);
  const { deriveDesktopChatState } = context.globalThis.__testExports;

  const result = deriveDesktopChatState({
    gatewayOffline: true,
    sseConnections: 3,
    wsConnections: 2
  });

  assert.equal(result.enabled, false);
  assert.equal(result.statusLabel, 'unavailable');
  assert.equal(result.statusTone, 'warning');
});

test('deriveDesktopChatState stays honest-neutral when reachable but no live transport', () => {
  const context = { globalThis: {} };
  vm.runInNewContext(channelsTabSourceForTest(), context);
  const { deriveDesktopChatState } = context.globalThis.__testExports;

  const result = deriveDesktopChatState({
    gatewayOffline: false,
    sseConnections: 0,
    wsConnections: 0
  });

  assert.equal(result.enabled, false, 'no live SSE/WS means not enabled');
  assert.equal(result.statusLabel, 'idle');
  assert.equal(result.statusTone, 'muted', 'must not show success with SSE: 0 · WS: 0');
});

test('deriveDesktopChatState is on only with a proven live connection', () => {
  const context = { globalThis: {} };
  vm.runInNewContext(channelsTabSourceForTest(), context);
  const { deriveDesktopChatState } = context.globalThis.__testExports;

  const sseOnly = deriveDesktopChatState({
    gatewayOffline: false,
    sseConnections: 1,
    wsConnections: 0
  });
  assert.equal(sseOnly.enabled, true);
  assert.equal(sseOnly.statusLabel, 'on');
  assert.equal(sseOnly.statusTone, 'success');

  const wsOnly = deriveDesktopChatState({
    gatewayOffline: false,
    sseConnections: 0,
    wsConnections: 2
  });
  assert.equal(wsOnly.enabled, true);
  assert.equal(wsOnly.statusTone, 'success');

  const undefinedCounts = deriveDesktopChatState({ gatewayOffline: false });
  assert.equal(undefinedCounts.enabled, false, 'missing counts must not imply live');
  assert.equal(undefinedCounts.statusTone, 'muted');
});
