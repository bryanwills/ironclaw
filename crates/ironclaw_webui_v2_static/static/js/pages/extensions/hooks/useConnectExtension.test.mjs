import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function useExtensionsSourceForTest() {
  const source = readFileSync(new URL('./useExtensions.js', import.meta.url), 'utf8');
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
  return `${lines.join('\n')}\nglobalThis.__testExports = { activationProvedConnected, useConnectExtension };`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setupContext(overrides = {}) {
  let state = {};
  const stateSnapshots = [];
  const calls = [];
  const invalidations = [];
  const ref = overrides.ref || { id: 'notion' };

  const context = {
    Date: {
      now: overrides.now || (() => 0)
    },
    Promise,
    React: {
      useCallback: (fn) => fn,
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useState: (initial) => {
        state = clone(initial);
        return [
          state,
          (updater) => {
            state = typeof updater === 'function' ? updater(state) : updater;
            stateSnapshots.push(clone(state));
          }
        ];
      }
    },
    activateExtension: async (packageRef) => {
      calls.push(['activate', packageRef]);
      return overrides.activateResult || { success: true, phase: 'active', authenticated: true };
    },
    approvePairingCode: () => {},
    fetchExtensionRegistry: () => {},
    fetchExtensionSetup: async (packageRef) => {
      calls.push(['fetchSetup', packageRef]);
      const next = overrides.setupQueue?.length
        ? overrides.setupQueue.shift()
        : overrides.setupResult;
      if (next instanceof Error) throw next;
      return next || { secrets: [] };
    },
    fetchExtensions: () => {},
    fetchPairingRequests: () => {},
    gatewayStatus: () => {},
    globalThis: {},
    installExtension: async (packageRef) => {
      calls.push(['install', packageRef]);
      if (overrides.installError) throw overrides.installError;
      return overrides.installResult || { success: true };
    },
    isDesktopRuntime: () => true,
    isGoogleConnector:
      overrides.isGoogleConnector ||
      ((entry) => {
        const id = String(entry?.package_ref?.id || entry?.id || '');
        return ['tools/gmail', 'tools/google_calendar', 'gmail', 'google-calendar'].includes(id);
      }),
    listConnectableChannels: () => {},
    openExternalUrl: async (url) => {
      calls.push(['openExternalUrl', url]);
      if (overrides.openError) throw overrides.openError;
      return true;
    },
    removeExtension: () => {},
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    startExtensionOauth: async (packageRef, secret) => {
      calls.push(['startOauth', packageRef, secret?.name]);
      return overrides.oauthResult || { authorization_url: 'https://auth.example/notion' };
    },
    submitExtensionSetup: () => {},
    useMutation: () => ({}),
    useQuery: () => ({}),
    useQueryClient: () => ({
      invalidateQueries: (query) => invalidations.push(clone(query))
    }),
    window: {
      clearInterval: () => {},
      setInterval: () => 1
    }
  };

  vm.runInNewContext(useExtensionsSourceForTest(), context);
  return {
    calls,
    context,
    invalidations,
    ref,
    stateSnapshots
  };
}

function phasesFor(snapshots, id = 'notion') {
  return snapshots.map((snapshot) => snapshot[id]?.phase);
}

test('useConnectExtension chains OAuth install, browser consent, polling, activation, and connected state', async () => {
  const pendingOauth = {
    name: 'notion_oauth',
    provided: false,
    setup: { kind: 'oauth' }
  };
  const { calls, context, invalidations, ref, stateSnapshots } = setupContext({
    setupQueue: [{ secrets: [pendingOauth] }, { secrets: [{ ...pendingOauth, provided: true }] }]
  });

  const hook = context.globalThis.__testExports.useConnectExtension();
  await hook.connect({ package_ref: ref });

  assert.deepEqual(phasesFor(stateSnapshots), [
    'installing',
    'authorizing',
    'waiting',
    'activating',
    'connected'
  ]);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['install', 'fetchSetup', 'startOauth', 'openExternalUrl', 'fetchSetup', 'activate']
  );
  assert.equal(
    calls.find((call) => call[0] === 'openExternalUrl')?.[1],
    'https://auth.example/notion'
  );
  assert.deepEqual(invalidations, [
    { queryKey: ['extensions'] },
    { queryKey: ['extension-registry'] }
  ]);
});

test('activationProvedConnected rejects weak lifecycle success without credential proof', () => {
  const { context } = setupContext();
  const { activationProvedConnected } = context.globalThis.__testExports;

  assert.equal(activationProvedConnected({ success: true }), false);
  assert.equal(
    activationProvedConnected({
      success: true,
      active: true,
      message: 'Extension lifecycle action completed'
    }),
    false
  );
  assert.equal(
    activationProvedConnected({
      success: true,
      phase: 'active',
      blockers: ['oauth_missing']
    }),
    false
  );
  assert.equal(
    activationProvedConnected({
      success: true,
      active: true,
      authenticated: true
    }),
    true
  );
  assert.equal(activationProvedConnected({ phase: 'connected' }), true);
});

test('useConnectExtension refuses weak activation success without credential proof', async () => {
  const pendingOauth = {
    name: 'notion_oauth',
    provided: false,
    setup: { kind: 'oauth' }
  };
  const { calls, context, ref, stateSnapshots } = setupContext({
    activateResult: {
      success: true,
      message: 'Extension lifecycle action completed'
    },
    setupQueue: [{ secrets: [pendingOauth] }, { secrets: [{ ...pendingOauth, provided: true }] }]
  });

  const hook = context.globalThis.__testExports.useConnectExtension();
  await hook.connect({ package_ref: ref });

  assert.deepEqual(phasesFor(stateSnapshots), [
    'installing',
    'authorizing',
    'waiting',
    'activating',
    'error'
  ]);
  assert.equal(
    stateSnapshots.at(-1).notion.message,
    'Extension lifecycle action completed'
  );
  assert.ok(calls.some((call) => call[0] === 'activate'));
});

test('useConnectExtension stops honestly when OAuth setup returns no authorization URL', async () => {
  const { calls, context, ref, stateSnapshots } = setupContext({
    setupQueue: [
      {
        secrets: [{ name: 'oauth', provided: false, setup: { kind: 'oauth' } }]
      }
    ],
    oauthResult: { success: false, message: 'No hosted OAuth client is configured.' }
  });

  const hook = context.globalThis.__testExports.useConnectExtension();
  await hook.connect({ package_ref: ref });

  assert.deepEqual(phasesFor(stateSnapshots), ['installing', 'authorizing', 'error']);
  assert.equal(stateSnapshots.at(-1).notion.message, 'No hosted OAuth client is configured.');
  assert.ok(!calls.some((call) => call[0] === 'activate'));
  assert.ok(!calls.some((call) => call[0] === 'openExternalUrl'));
});

test('useConnectExtension marks Google no-auth-url as blocked by client-id setup', async () => {
  const { calls, context, ref, stateSnapshots } = setupContext({
    ref: { id: 'tools/gmail' },
    setupQueue: [
      {
        secrets: [{ name: 'oauth', provided: false, setup: { kind: 'oauth' } }]
      }
    ],
    oauthResult: { success: false, message: 'No hosted Google OAuth client is configured.' }
  });

  const hook = context.globalThis.__testExports.useConnectExtension();
  await hook.connect({ package_ref: ref });

  assert.deepEqual(phasesFor(stateSnapshots, 'tools/gmail'), [
    'installing',
    'authorizing',
    'blocked-google-client-id'
  ]);
  assert.equal(
    stateSnapshots.at(-1)['tools/gmail'].message,
    'No hosted Google OAuth client is configured.'
  );
  assert.ok(!calls.some((call) => call[0] === 'activate'));
  assert.ok(!calls.some((call) => call[0] === 'openExternalUrl'));
});

test('useConnectExtension stops at needs-token for manual setup instead of pretending connect worked', async () => {
  const { calls, context, ref, stateSnapshots } = setupContext({
    setupQueue: [
      {
        secrets: [{ name: 'api_key', provided: false, setup: { kind: 'manual_token' } }]
      }
    ]
  });

  const hook = context.globalThis.__testExports.useConnectExtension();
  await hook.connect({ package_ref: ref });

  assert.deepEqual(phasesFor(stateSnapshots), ['installing', 'needs-token']);
  assert.ok(!calls.some((call) => call[0] === 'activate'));
  assert.ok(!calls.some((call) => call[0] === 'startOauth'));
});

test('useConnectExtension routes Google manual setup to client-id blocked state', async () => {
  const { calls, context, ref, stateSnapshots } = setupContext({
    ref: { id: 'tools/google_calendar' },
    setupQueue: [
      {
        secrets: [{ name: 'client_id', provided: false, setup: { kind: 'manual_token' } }]
      }
    ]
  });

  const hook = context.globalThis.__testExports.useConnectExtension();
  await hook.connect({ package_ref: ref });

  assert.deepEqual(phasesFor(stateSnapshots, 'tools/google_calendar'), [
    'installing',
    'blocked-google-client-id'
  ]);
  assert.match(stateSnapshots.at(-1)['tools/google_calendar'].message, /client ID/);
  assert.ok(!calls.some((call) => call[0] === 'activate'));
  assert.ok(!calls.some((call) => call[0] === 'startOauth'));
});

test('useConnectExtension times out OAuth polling without activating', async () => {
  let nowCall = 0;
  const { calls, context, ref, stateSnapshots } = setupContext({
    now: () => {
      nowCall += 1;
      return nowCall <= 2 ? 0 : 600_001;
    },
    setupQueue: [
      {
        secrets: [{ name: 'oauth', provided: false, setup: { kind: 'oauth' } }]
      },
      {
        secrets: [{ name: 'oauth', provided: false, setup: { kind: 'oauth' } }]
      }
    ]
  });

  const hook = context.globalThis.__testExports.useConnectExtension();
  await hook.connect({ package_ref: ref });

  assert.deepEqual(phasesFor(stateSnapshots), ['installing', 'authorizing', 'waiting', 'error']);
  assert.match(stateSnapshots.at(-1).notion.message, /Authorization timed out/);
  assert.ok(!calls.some((call) => call[0] === 'activate'));
});

test('useConnectExtension does not show connected when activation is rejected', async () => {
  const pendingOauth = {
    name: 'notion_oauth',
    provided: false,
    setup: { kind: 'oauth' }
  };
  const { calls, context, ref, stateSnapshots } = setupContext({
    activateResult: {
      success: false,
      message: 'Connector runtime is not wired in this build yet.'
    },
    setupQueue: [{ secrets: [pendingOauth] }, { secrets: [{ ...pendingOauth, provided: true }] }]
  });

  const hook = context.globalThis.__testExports.useConnectExtension();
  await hook.connect({ package_ref: ref });

  assert.deepEqual(phasesFor(stateSnapshots), [
    'installing',
    'authorizing',
    'waiting',
    'activating',
    'error'
  ]);
  assert.equal(
    stateSnapshots.at(-1).notion.message,
    'Connector runtime is not wired in this build yet.'
  );
  assert.ok(calls.some((call) => call[0] === 'activate'));
});

test('useConnectExtension surfaces thrown connector errors in the connect phase state', async () => {
  const { calls, context, ref, stateSnapshots } = setupContext({
    installError: new Error('gateway offline')
  });

  const hook = context.globalThis.__testExports.useConnectExtension();
  await hook.connect({ package_ref: ref });

  assert.deepEqual(phasesFor(stateSnapshots), ['installing', 'error']);
  assert.equal(stateSnapshots.at(-1).notion.message, 'gateway offline');
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['install']
  );
});
