import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activateExtension,
  canonicalExtensionName,
  fetchExtensionSetup,
  installCustomMcpServer,
  installExtension,
  removeExtension,
  startExtensionOauth,
  submitExtensionSetup
} from './extensions-api.js';

function installFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  const originalSessionStorage = globalThis.sessionStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.sessionStorage = originalSessionStorage;
  });

  globalThis.sessionStorage = {
    getItem: () => 'token-1',
    setItem: () => {},
    removeItem: () => {}
  };
  globalThis.fetch = handler;
}

function okJson(body = { success: true }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

test('canonicalExtensionName treats slash catalog refs as bare lifecycle names', () => {
  assert.equal(canonicalExtensionName({ kind: 'extension', id: 'tools/gmail' }), 'gmail');
  assert.equal(
    canonicalExtensionName({ kind: 'extension', id: 'tools/google_calendar' }),
    'google-calendar'
  );
  assert.equal(canonicalExtensionName({ kind: 'extension', id: 'mcp-servers/notion' }), 'notion');
  assert.equal(canonicalExtensionName({ kind: 'extension', id: 'channels/slack' }), 'slack');
  assert.equal(canonicalExtensionName({ kind: 'extension', id: 'tools/slack_tool' }), 'slack');
});

test('installExtension keeps catalog refs in the install payload only', async (t) => {
  const calls = [];
  installFetch(t, async (path, options) => {
    calls.push({ path, options });
    return okJson();
  });

  const packageRef = { kind: 'extension', id: 'tools/gmail' };
  await installExtension(packageRef);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/webchat/v2/extensions/install');
  assert.deepEqual(JSON.parse(calls[0].options.body), { package_ref: packageRef });
});

test('installCustomMcpServer posts the Reborn custom MCP install payload', async (t) => {
  const calls = [];
  installFetch(t, async (path, options) => {
    calls.push({ path, options });
    return okJson();
  });

  await installCustomMcpServer({
    name: 'Team Docs',
    url: 'https://docs.example.com/mcp'
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/webchat/v2/extensions/install');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    name: 'team-docs',
    url: 'https://docs.example.com/mcp',
    kind: 'mcp_server'
  });
});

test('lifecycle extension calls use canonical bare names in route paths', async (t) => {
  const calls = [];
  installFetch(t, async (path, options) => {
    calls.push({ path, options });
    return okJson();
  });

  await fetchExtensionSetup({ kind: 'extension', id: 'tools/gmail' });
  await submitExtensionSetup(
    { kind: 'extension', id: 'tools/google_calendar' },
    { token: 'ya29.smoke-token' },
    { account_label: 'Smoke Google' }
  );
  await activateExtension({ kind: 'extension', id: 'mcp-servers/notion' });
  await removeExtension({ kind: 'extension', id: 'channels/slack' });
  await startExtensionOauth(
    { kind: 'extension', id: 'tools/slack_tool' },
    {
      provider: 'slack',
      setup: {
        account_label: 'Slack workspace',
        scopes: ['channels:read'],
        invocation_id: 'invoke-1'
      }
    }
  );

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/webchat/v2/extensions/gmail/setup',
      '/api/webchat/v2/extensions/google-calendar/setup',
      '/api/webchat/v2/extensions/notion/activate',
      '/api/webchat/v2/extensions/slack/remove',
      '/api/webchat/v2/extensions/slack/setup/oauth/start'
    ]
  );
  assert.equal(
    calls.some((call) => call.path.includes('%2F')),
    false
  );
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    action: 'configure',
    payload: {
      secrets: { token: 'ya29.smoke-token' },
      fields: { account_label: 'Smoke Google' }
    }
  });
  assert.deepEqual(JSON.parse(calls[4].options.body), {
    provider: 'slack',
    account_label: 'Slack workspace',
    scopes: ['channels:read'],
    expires_at: JSON.parse(calls[4].options.body).expires_at,
    invocation_id: 'invoke-1'
  });
});
