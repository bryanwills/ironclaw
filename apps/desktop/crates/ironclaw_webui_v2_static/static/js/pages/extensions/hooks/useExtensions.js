import { React } from '../../../lib/html.js';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { gatewayStatus, isDesktopRuntime, openExternalUrl } from '../../../lib/api.js';
import { listConnectableChannels } from '../../../lib/channel-connect.js';
import {
  fetchExtensions,
  fetchExtensionRegistry,
  installExtension,
  installCustomMcpServer,
  activateExtension,
  removeExtension,
  fetchExtensionSetup,
  submitExtensionSetup,
  startExtensionOauth,
  fetchPairingRequests,
  approvePairingCode
} from '../lib/extensions-api.js';
import { isGoogleConnector } from '../lib/extension-actions.js';

const OAUTH_SETUP_REFRESH_MS = 2000;
const OAUTH_SETUP_TIMEOUT_MS = 10 * 60 * 1000;

function activationProvedConnected(res) {
  if (!res || typeof res !== 'object') return false;
  if (res.success === false) return false;
  const blockers = Array.isArray(res.blockers) ? res.blockers : [];
  if (
    blockers.length > 0 ||
    res.authenticated === false ||
    res.credential_ready === false ||
    res.account_ready === false ||
    res.ready === false
  ) {
    return false;
  }
  const phase = String(res.phase || res.activation_status || res.status || '').toLowerCase();
  if (['active', 'ready', 'connected'].includes(phase)) return true;
  const readiness = String(res.readiness || res.model_readiness || '').toLowerCase();
  if (['active', 'ready', 'connected'].includes(readiness)) return true;
  const hasCredentialProof =
    res.authenticated === true ||
    res.credential_ready === true ||
    res.account_ready === true ||
    res.ready === true;
  const hasActivationProof =
    res.active === true || res.activated === true || res.success === true || res.ok === true;
  return hasCredentialProof && hasActivationProof;
}

function activationFailureMessage(res) {
  return (
    res?.message ||
    res?.instructions ||
    res?.error ||
    'Activation did not complete; the gateway did not confirm this connector is connected.'
  );
}

export function useExtensions() {
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: ['gateway-status-extensions'],
    queryFn: gatewayStatus,
    staleTime: 10_000,
    retry: 1,
    retryDelay: 600
  });

  const extensionsQuery = useQuery({
    queryKey: ['extensions'],
    queryFn: fetchExtensions,
    retry: 1,
    retryDelay: 600
  });

  const registryQuery = useQuery({
    queryKey: ['extension-registry'],
    queryFn: fetchExtensionRegistry,
    retry: 1,
    retryDelay: 600
  });

  const connectableChannelsQuery = useQuery({
    queryKey: ['connectable-channels'],
    queryFn: listConnectableChannels,
    retry: 1,
    retryDelay: 600
  });

  const invalidate = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['extensions'] });
    queryClient.invalidateQueries({ queryKey: ['extension-registry'] });
    queryClient.invalidateQueries({ queryKey: ['gateway-status-extensions'] });
    queryClient.invalidateQueries({ queryKey: ['connectable-channels'] });
  }, [queryClient]);

  const [actionResult, setActionResult] = React.useState(null);

  const clearResult = React.useCallback(() => setActionResult(null), []);

  const installMutation = useMutation({
    mutationFn: ({ packageRef }) => installExtension(packageRef),
    onSuccess: (res, { displayName }) => {
      if (res.success) {
        setActionResult({
          type: 'success',
          message: res.message || res.instructions || `${displayName || 'Extension'} installed`
        });
        if (res.auth_url) {
          openExternalUrl(res.auth_url);
        }
      } else {
        setActionResult({ type: 'error', message: res.message || 'Install failed' });
      }
      invalidate();
    },
    onError: (err) => {
      setActionResult({ type: 'error', message: err.message });
      invalidate();
    }
  });

  const addCustomMcpMutation = useMutation({
    mutationFn: ({ name, url }) => installCustomMcpServer({ name, url }),
    onSuccess: (res, { name }) => {
      if (res.success !== false) {
        setActionResult({
          type: 'success',
          message: res.message || res.instructions || `${name || 'MCP server'} installed`
        });
      } else {
        setActionResult({ type: 'error', message: res.message || 'MCP server install failed' });
      }
      invalidate();
    },
    onError: (err) => {
      setActionResult({ type: 'error', message: err.message });
      invalidate();
    }
  });

  const activateMutation = useMutation({
    mutationFn: ({ packageRef }) => activateExtension(packageRef),
    onSuccess: (res, { displayName }) => {
      if (activationProvedConnected(res)) {
        setActionResult({
          type: 'success',
          message: res.message || res.instructions || `${displayName || 'Extension'} activated`
        });
        if (res.auth_url) {
          openExternalUrl(res.auth_url);
        }
      } else if (res.auth_url) {
        openExternalUrl(res.auth_url);
        setActionResult({ type: 'info', message: 'Opening authentication…' });
      } else if (res.awaiting_token) {
        setActionResult({ type: 'info', message: 'Configuration required' });
      } else {
        setActionResult({ type: 'error', message: res.message || 'Activation failed' });
      }
      invalidate();
    },
    onError: (err) => {
      setActionResult({ type: 'error', message: err.message });
    }
  });

  const removeMutation = useMutation({
    mutationFn: ({ packageRef }) => removeExtension(packageRef),
    onSuccess: (res, { displayName }) => {
      if (res.success) {
        setActionResult({ type: 'success', message: `${displayName || 'Extension'} removed` });
      } else {
        setActionResult({ type: 'error', message: res.message || 'Remove failed' });
      }
      invalidate();
    },
    onError: (err) => {
      setActionResult({ type: 'error', message: err.message });
    }
  });

  const status = statusQuery.data || {};
  const extensions = extensionsQuery.data?.extensions || [];
  const registry = registryQuery.data?.entries || [];
  const connectableChannels = connectableChannelsQuery.data?.channels || [];

  const channels = extensions.filter((e) => e.kind === 'wasm_channel');
  const mcpServers = extensions.filter((e) => e.kind === 'mcp_server');
  const tools = extensions.filter((e) => e.kind !== 'wasm_channel' && e.kind !== 'mcp_server');

  const channelRegistry = registry.filter(
    (e) => (e.kind === 'wasm_channel' || e.kind === 'channel') && !e.installed
  );
  const mcpRegistry = registry.filter((e) => e.kind === 'mcp_server' && !e.installed);
  const toolRegistry = registry.filter(
    (e) =>
      e.kind !== 'mcp_server' && e.kind !== 'wasm_channel' && e.kind !== 'channel' && !e.installed
  );

  const loadError =
    extensionsQuery.error ||
    registryQuery.error ||
    connectableChannelsQuery.error ||
    statusQuery.error ||
    null;
  const isLoading = (extensionsQuery.isLoading || registryQuery.isLoading) && !loadError;
  const isBusy =
    installMutation.isPending ||
    addCustomMcpMutation.isPending ||
    activateMutation.isPending ||
    removeMutation.isPending;

  return {
    status,
    extensions,
    channels,
    mcpServers,
    tools,
    channelRegistry,
    mcpRegistry,
    toolRegistry,
    registry,
    loadError,
    connectableChannels,
    isLoading,
    isBusy,
    actionResult,
    clearResult,
    install: installMutation.mutate,
    addCustomMcp: addCustomMcpMutation.mutate,
    activate: activateMutation.mutate,
    remove: removeMutation.mutate,
    invalidate
  };
}

export function useExtensionSetup(packageRef) {
  const query = useQuery({
    queryKey: ['extension-setup', packageRef?.id || packageRef],
    queryFn: () => fetchExtensionSetup(packageRef),
    enabled: Boolean(packageRef)
  });

  return {
    secrets: query.data?.secrets || [],
    fields: query.data?.fields || [],
    onboarding: query.data?.onboarding || null,
    isLoading: query.isLoading,
    error: query.error
  };
}

export function useSetupSubmit(packageRef, onSuccess) {
  const queryClient = useQueryClient();
  const packageKey = packageRef?.id || packageRef;

  return useMutation({
    mutationFn: ({ secrets, fields }) => submitExtensionSetup(packageRef, secrets, fields),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['extensions'] });
      queryClient.invalidateQueries({ queryKey: ['extension-setup', packageKey] });
      if (onSuccess) onSuccess(res);
    }
  });
}

export function useOauthSetup(packageRef) {
  const queryClient = useQueryClient();
  const packageKey = packageRef?.id || packageRef;
  const watcherRef = React.useRef(null);

  const clearWatcher = React.useCallback(() => {
    if (watcherRef.current) {
      window.clearInterval(watcherRef.current);
      watcherRef.current = null;
    }
  }, []);

  const refreshSetupState = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['extensions'] });
    queryClient.invalidateQueries({ queryKey: ['extension-registry'] });
    queryClient.invalidateQueries({ queryKey: ['extension-setup', packageKey] });
  }, [packageKey, queryClient]);

  const setupIsConfigured = React.useCallback(() => {
    const setup = queryClient.getQueryData(['extension-setup', packageKey]);
    if (setup?.secrets?.length > 0 && setup.secrets.every((secret) => secret.provided)) {
      return true;
    }
    const extensions = queryClient.getQueryData(['extensions'])?.extensions || [];
    const extension = extensions.find((item) => item.package_ref?.id === packageKey);
    const state =
      extension?.onboarding_state ||
      extension?.activation_status ||
      (extension?.active ? 'active' : null);
    return state === 'active' || state === 'ready';
  }, [packageKey, queryClient]);

  const watchOauthProgress = React.useCallback(
    (popup) => {
      clearWatcher();
      const startedAt = Date.now();
      watcherRef.current = window.setInterval(() => {
        refreshSetupState();
        const configured = setupIsConfigured();
        if (
          configured ||
          (popup && popup.closed) ||
          Date.now() - startedAt > OAUTH_SETUP_TIMEOUT_MS
        ) {
          clearWatcher();
          // Once browser consent lands, finish the job by activating so the
          // tools publish without a manual third step.
          if (configured) {
            Promise.resolve(activateExtension(packageRef)).catch(() => {});
          }
          refreshSetupState();
        }
      }, OAUTH_SETUP_REFRESH_MS);
    },
    [clearWatcher, refreshSetupState, setupIsConfigured]
  );

  React.useEffect(() => clearWatcher, [clearWatcher]);

  return useMutation({
    mutationFn: ({ secret, popup }) =>
      startExtensionOauth(packageRef, secret).then((res) => ({ res, popup })),
    onSuccess: ({ res, popup }) => {
      // Provider OAuth pages (Google especially) refuse embedded webviews,
      // and in the packaged desktop a popup IS a Tauri child webview with
      // none of the user's cookies. Route the URL to the system browser
      // there; the placeholder popup only ever serves the hosted build.
      let authPopup = popup;
      if (res.authorization_url && isDesktopRuntime()) {
        if (popup && !popup.closed) popup.close();
        authPopup = null;
        openExternalUrl(res.authorization_url);
      } else if (res.authorization_url && popup && !popup.closed) {
        popup.location.href = res.authorization_url;
      } else if (res.authorization_url) {
        authPopup = window.open(res.authorization_url, '_blank', 'noopener,noreferrer');
      } else if (popup && !popup.closed) {
        popup.close();
      }
      refreshSetupState();
      // With the system browser we have no window handle — poll backend
      // state alone; watchOauthProgress already treats the popup as
      // optional input for its closed-check.
      if (res.authorization_url) watchOauthProgress(authPopup);
    },
    onError: (_err, variables) => {
      clearWatcher();
      const popup = variables?.popup;
      if (popup && !popup.closed) popup.close();
    }
  });
}

export function usePairing(channel, options = {}) {
  const query = useQuery({
    queryKey: ['pairing', channel],
    queryFn: () => fetchPairingRequests(channel),
    enabled: Boolean(channel) && options.enabled !== false,
    refetchInterval: 5000
  });

  const queryClient = useQueryClient();

  const approveMutation = useMutation({
    mutationFn: ({ code }) => approvePairingCode(channel, code),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pairing', channel] });
      queryClient.invalidateQueries({ queryKey: ['extensions'] });
    }
  });

  return {
    requests: query.data?.requests || [],
    isLoading: query.isLoading,
    approve: approveMutation.mutate,
    isApproving: approveMutation.isPending,
    result: approveMutation.isSuccess ? approveMutation.data : null,
    error: approveMutation.isError ? approveMutation.error : null
  };
}

// One-click connect: install -> read setup -> (DCR/OAuth: system-browser
// consent + poll) -> activate. Manual-token connectors stop at 'needs-token'
// so the caller can open the token form instead, never a fake Connect.
export function useConnectExtension() {
  const queryClient = useQueryClient();
  const [connectState, setConnectState] = React.useState({});

  const setPhase = React.useCallback((key, phase, extra = {}) => {
    setConnectState((prev) => ({ ...prev, [key]: { phase, ...extra } }));
  }, []);

  const connect = React.useCallback(
    async (entry) => {
      const ref = entry?.package_ref;
      const key = ref?.id || String(ref || '');
      if (!key) return;
      try {
        setPhase(key, 'installing');
        await installExtension(ref);

        const setup = await fetchExtensionSetup(ref).catch(() => null);
        const secrets = setup?.secrets || [];
        const pendingOauth = secrets.find(
          (secret) => (secret.setup?.kind || '') === 'oauth' && !secret.provided
        );
        const pendingManual = secrets.find(
          (secret) => (secret.setup?.kind || 'manual_token') !== 'oauth' && !secret.provided
        );

        if (pendingOauth) {
          setPhase(key, 'authorizing');
          const res = await startExtensionOauth(ref, pendingOauth);
          if (!res?.authorization_url) {
            if (isGoogleConnector(entry)) {
              setPhase(key, 'blocked-google-client-id', {
                message:
                  res?.message ||
                  'Google sign-in needs a Desktop app client ID before browser authorization can start.'
              });
            } else {
              setPhase(key, 'error', {
                message: res?.message || 'Authorization is unavailable — use a token instead.'
              });
            }
            return;
          }
          await openExternalUrl(res.authorization_url);
          setPhase(key, 'waiting');
          const deadline = Date.now() + OAUTH_SETUP_TIMEOUT_MS;
          let provided = false;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, OAUTH_SETUP_REFRESH_MS));
            const current = await fetchExtensionSetup(ref).catch(() => null);
            const currentSecrets = current?.secrets || [];
            if (currentSecrets.length > 0 && currentSecrets.every((s) => s.provided)) {
              provided = true;
              break;
            }
          }
          if (!provided) {
            setPhase(key, 'error', { message: 'Authorization timed out — try again.' });
            return;
          }
        } else if (pendingManual) {
          if (isGoogleConnector(entry)) {
            setPhase(key, 'blocked-google-client-id', {
              message:
                'Google sign-in needs a Desktop app client ID in Settings before Gmail or Calendar can connect.'
            });
            return;
          }
          // Honest stop: this connector only takes a pasted token.
          setPhase(key, 'needs-token');
          return;
        }

        setPhase(key, 'activating');
        const activation = await activateExtension(ref);
        if (!activationProvedConnected(activation)) {
          setPhase(key, 'error', { message: activationFailureMessage(activation) });
          return;
        }
        queryClient.invalidateQueries({ queryKey: ['extensions'] });
        queryClient.invalidateQueries({ queryKey: ['extension-registry'] });
        setPhase(key, 'connected');
      } catch (err) {
        setPhase(key, 'error', { message: String(err?.message || err) });
      }
    },
    [queryClient, setPhase]
  );

  return { connect, connectState };
}
