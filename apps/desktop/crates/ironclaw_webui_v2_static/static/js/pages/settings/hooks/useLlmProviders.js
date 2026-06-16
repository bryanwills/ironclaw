import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteLlmProvider,
  fetchLlmProviders,
  listLlmProviderModels,
  setActiveLlm,
  testLlmProviderConnection,
  upsertLlmProvider
} from '../lib/settings-api.js';
import {
  filterDesktopVisibleLlmProviders,
  isProviderConfigured,
  providerDefaultModel,
  providerMissingReason
} from '../lib/llm-providers.js';

function fallbackNearaiSnapshot() {
  return {
    providers: [
      {
        id: 'nearai',
        name: 'NEAR AI Cloud',
        description: 'Model access through NEAR AI Cloud.',
        adapter: 'nearai',
        default_model: 'auto',
        builtin: true,
        synthetic_unavailable: true,
        api_key_required: false,
        accepts_api_key: true,
        base_url_required: false,
        api_key_set: false
      }
    ],
    active: null
  };
}

// The v2 `/llm/providers` snapshot is the single source of truth: a unified
// provider list (built-in + operator-defined) already annotated with the active
// selection, `builtin`, and `api_key_set`. Overrides are no longer a separate
// client-side merge — the backend resolves them — so `builtinOverrides` is kept
// as an empty object purely for the shared helper signatures.
export function useLlmProviders({ settings: _settings, gatewayStatus }) {
  const queryClient = useQueryClient();
  const providersQuery = useQuery({
    queryKey: ['llm-providers'],
    queryFn: fetchLlmProviders,
    staleTime: 60_000,
    // Ride out local sidecar boot (HTTP bind can lag the WebView by a few
    // seconds): connection-refused fails in milliseconds and the layout's
    // onboarding gate must not see a settled error for a booting backend.
    retry: 1,
    retryDelay: 600
  });

  const snapshot = providersQuery.data || fallbackNearaiSnapshot();
  const providerSnapshot = deriveProviderSnapshot(snapshot);
  const {
    allProviders,
    activeProviderId,
    selectedModel,
    builtinProviders,
    customProviders,
    hasActiveProvider
  } = providerSnapshot;
  const builtinOverrides = providerSnapshot.builtinOverrides;
  const providers = [...allProviders].sort((a, b) => {
    if (a.id === activeProviderId) return -1;
    if (b.id === activeProviderId) return 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['llm-providers'] });
  };

  const setActiveMutation = useMutation({
    mutationFn: async (provider) => {
      if (!isProviderConfigured(provider, builtinOverrides)) {
        const reason = providerMissingReason(provider, builtinOverrides);
        throw new Error(reason === 'base_url' ? 'base_url' : 'api_key');
      }
      const model = providerDefaultModel(provider, builtinOverrides);
      if (!model) throw new Error('model');
      await setActiveLlm({ provider_id: provider.id, model });
      return provider;
    },
    onSuccess: refresh
  });

  // Both custom and built-in saves go through one upsert endpoint. A built-in
  // "override" is just an overlay entry that shadows the compiled-in provider
  // by id; the backend resolves later entries last.
  const saveProviderMutation = useMutation({
    mutationFn: async ({ provider, form, apiKey, editingProvider }) => {
      const isBuiltin = Boolean(provider?.builtin);
      const id = (isBuiltin ? provider.id : form.id.trim()).trim();
      const payload = {
        id,
        name: isBuiltin ? provider.name || provider.id : form.name.trim(),
        adapter: isBuiltin ? provider.adapter : form.adapter,
        base_url: form.baseUrl.trim() || provider?.base_url || '',
        default_model: form.model.trim() || undefined
      };
      // Only send a key when a new value was typed; otherwise leave the stored
      // one untouched (omitting the field is "unchanged" on the backend).
      if (apiKey.trim()) {
        payload.api_key = apiKey.trim();
      }
      if ((editingProvider || provider)?.id === activeProviderId && payload.default_model) {
        payload.set_active = true;
        payload.model = payload.default_model;
      }
      await upsertLlmProvider(payload);
      return payload;
    },
    onSuccess: refresh
  });

  const deleteCustomMutation = useMutation({
    mutationFn: async (provider) => {
      await deleteLlmProvider(provider.id);
      return provider;
    },
    onSuccess: refresh
  });

  return {
    providers,
    builtinProviders,
    customProviders,
    builtinOverrides,
    activeProviderId,
    selectedModel,
    hasActiveProvider,
    isLoading: providersQuery.isLoading && !providers.length,
    isChecking: providersQuery.isLoading,
    error: providersQuery.error,
    setActiveProvider: (provider) => setActiveMutation.mutateAsync(provider),
    saveCustomProvider: (payload) => saveProviderMutation.mutateAsync(payload),
    saveBuiltinProvider: (payload) => saveProviderMutation.mutateAsync(payload),
    deleteCustomProvider: (provider) => deleteCustomMutation.mutateAsync(provider),
    testConnection: testLlmProviderConnection,
    listModels: listLlmProviderModels,
    refresh,
    isBusy:
      setActiveMutation.isPending ||
      saveProviderMutation.isPending ||
      deleteCustomMutation.isPending
  };
}

export function deriveProviderSnapshot(snapshot = {}) {
  const builtinOverrides = {};
  // Map the wire view onto the field names the components/helpers expect.
  const rawProviders = (Array.isArray(snapshot.providers) ? snapshot.providers : []).map(
    (provider) => ({
      ...provider,
      name: provider.name || provider.description || provider.id,
      has_api_key: provider.api_key_set === true
    })
  );
  const allProviders = filterDesktopVisibleLlmProviders(rawProviders);
  // Provider activation must come from the Reborn LLM provider snapshot. The
  // gateway status route always exposes a default backend/model for diagnostics;
  // treating that as an activated provider skips onboarding and lets first-run
  // users send messages into a guaranteed credential failure. Desktop also
  // presents NEAR AI Cloud as the normal model path, so stale/non-NEAR active
  // snapshots from generic Reborn provider support are hidden until an
  // advanced-provider mode exists.
  const rawActiveProviderId = snapshot.active?.provider_id || '';
  const activeProvider = allProviders.find((provider) => provider.id === rawActiveProviderId);
  const hasActiveProvider = Boolean(activeProvider);
  const activeProviderId = hasActiveProvider ? rawActiveProviderId : '';
  const selectedModel = hasActiveProvider ? snapshot.active?.model || '' : '';
  return {
    allProviders,
    builtinProviders: allProviders.filter((provider) => provider.builtin),
    customProviders: allProviders.filter((provider) => !provider.builtin),
    builtinOverrides,
    hasActiveProvider,
    activeProviderId,
    selectedModel
  };
}
