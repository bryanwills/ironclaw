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
  return `${lines.join('\n')}\nglobalThis.__testExports = { useExtensions };`;
}

function buildContext() {
  const invalidations = [];
  const mutationConfigs = [];
  let actionResult = null;

  const context = {
    React: {
      useCallback: (fn) => fn,
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useState: (initial) => [
        actionResult || initial,
        (next) => {
          actionResult = typeof next === 'function' ? next(actionResult) : next;
        }
      ]
    },
    activateExtension: () => {},
    approvePairingCode: () => {},
    fetchExtensionRegistry: () => {},
    fetchExtensionSetup: () => {},
    fetchExtensions: () => {},
    fetchPairingRequests: () => {},
    gatewayStatus: () => {},
    globalThis: {},
    installExtension: () => {},
    isDesktopRuntime: () => true,
    isGoogleConnector: () => false,
    listConnectableChannels: () => {},
    openExternalUrl: () => {},
    removeExtension: () => {},
    startExtensionOauth: () => {},
    submitExtensionSetup: () => {},
    useMutation: (config) => {
      mutationConfigs.push(config);
      return { mutate: () => {}, isPending: false };
    },
    useQuery: (config) => {
      const dataByKey = {
        'gateway-status-extensions': {},
        extensions: { extensions: [] },
        'extension-registry': { entries: [] },
        'connectable-channels': { channels: [] }
      };
      return { data: dataByKey[config.queryKey[0]], isLoading: false, error: null };
    },
    useQueryClient: () => ({
      invalidateQueries: (query) => invalidations.push(query)
    })
  };

  vm.runInNewContext(useExtensionsSourceForTest(), context);
  context.globalThis.__testExports.useExtensions();

  return {
    get actionResult() {
      return actionResult;
    },
    invalidations,
    mutationConfigs
  };
}

test('activate mutation reports error for weak lifecycle success', () => {
  const context = buildContext();
  const activateMutation = activationMutation(context);

  activateMutation.onSuccess(
    { success: true, active: true, message: 'Extension lifecycle action completed' },
    { displayName: 'Gmail' }
  );

  assert.equal(context.actionResult.type, 'error');
  assert.equal(context.actionResult.message, 'Extension lifecycle action completed');
});

test('activate mutation accepts activation with credential proof', () => {
  const context = buildContext();
  const activateMutation = activationMutation(context);

  activateMutation.onSuccess(
    {
      success: true,
      active: true,
      authenticated: true,
      message: 'Gmail connected'
    },
    { displayName: 'Gmail' }
  );

  assert.equal(context.actionResult.type, 'success');
  assert.equal(context.actionResult.message, 'Gmail connected');
});

function activationMutation(context) {
  const config = context.mutationConfigs.find((entry) =>
    String(entry.mutationFn).includes('activateExtension')
  );
  assert.ok(config, 'expected activation mutation to be registered');
  return config;
}
