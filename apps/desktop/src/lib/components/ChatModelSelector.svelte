<script lang="ts">
  import type { GatewayStatus, LlmModel, LlmProvider } from '$lib/api/types';
  import {
    effectiveDefaultModelForProvider,
    fallbackModelForProvider
  } from '$lib/data/llm-defaults';
  import { connection } from '$lib/stores/connection.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { updateProfile, type LlmBackend } from '$lib/stores/settings.svelte';
  import { modelExecutionReadiness } from '$lib/util/model-readiness';

  const LOCAL_SIDECAR_PROVIDERS = new Set(['nearai']);

  let providers = $state<LlmProvider[]>([]);
  let models = $state<LlmModel[]>([]);
  let providersLoading = $state(false);
  let modelsLoading = $state(false);
  let providersError = $state<string | null>(null);
  let modelsError = $state<string | null>(null);
  let gatewayStatus = $state<GatewayStatus | null>(null);
  let selectedProviderId = $state('nearai');
  let selectedModelId = $state('auto');
  let applying = $state(false);
  let restarting = $state(false);
  let needsRunnerRestart = $state(false);
  let lastSyncedProfileKey = '';
  let pickerOpen = $state(false);

  const activeProfile = $derived(connection.activeProfile);
  const activeProviderId = $derived(
    activeProfile.mode === 'local'
      ? 'nearai'
      : (activeProfile.llmProviderId ?? activeProfile.llmBackend ?? 'nearai')
  );

  const providerOptions = $derived.by<LlmProvider[]>(() => {
    const availableProviders =
      activeProfile.mode === 'local'
        ? providers.filter((provider) => LOCAL_SIDECAR_PROVIDERS.has(provider.id))
        : providers;
    if (availableProviders.length > 0) return availableProviders;
    return [
      {
        id: activeProviderId,
        name: providerDisplayName(activeProviderId),
        configured: true,
        builtin: true,
        default_model: fallbackModelForProvider(activeProviderId)
      }
    ];
  });

  const selectedProvider = $derived(
    providerOptions.find((provider) => provider.id === selectedProviderId)
  );

  const selectedProviderSupportsLocal = $derived(
    selectedProvider ? LOCAL_SIDECAR_PROVIDERS.has(selectedProvider.id) : true
  );

  const selectedModelDefault = $derived(
    effectiveDefaultModelForProvider(selectedProviderId, selectedProvider?.default_model)
  );

  const savedModelComparable = $derived(
    activeProfile.llmModelId ?? modelDefaultFor(activeProviderId)
  );

  const hasSelectionChange = $derived(
    selectedProviderId !== activeProviderId || selectedModelId.trim() !== savedModelComparable
  );

  const runningProviderLabel = $derived(
    providerDisplayName(gatewayStatus?.llm_backend ?? activeProviderId)
  );

  const runningModelLabel = $derived(
    gatewayStatus?.llm_model ?? activeProfile.llmModelId ?? selectedModelDefault
  );

  const modelReadiness = $derived(modelExecutionReadiness(gatewayStatus));

  const applyDisabled = $derived(
    applying ||
      !hasSelectionChange ||
      (activeProfile.mode === 'local' && !selectedProviderSupportsLocal)
  );

  function providerDisplayName(id: string): string {
    if (id === 'nearai') return 'NEAR.AI';
    if (id === 'openrouter') return 'OpenRouter';
    if (id === 'openai') return 'OpenAI';
    if (id === 'anthropic') return 'Anthropic';
    const match = providers.find((provider) => provider.id === id);
    return match?.name ?? id;
  }

  function modelDefaultFor(providerId: string): string {
    const provider = providers.find((candidate) => candidate.id === providerId);
    return effectiveDefaultModelForProvider(providerId, provider?.default_model);
  }

  function legacyBackendForProvider(providerId: string): LlmBackend {
    return providerId === 'openrouter' ? 'openrouter' : 'nearai';
  }

  async function refreshProviderCatalog(client = connection.client): Promise<void> {
    if (!client) {
      providers = [];
      gatewayStatus = null;
      providersError = null;
      return;
    }
    providersLoading = true;
    providersError = null;
    try {
      providers = await client.listLlmProviders();
      if (providers.length === 0) providersError = 'Gateway returned no model providers.';
    } catch (err) {
      providers = [];
      providersError = (err as Error).message;
    } finally {
      providersLoading = false;
    }

    try {
      gatewayStatus = await client.gatewayStatus();
    } catch {
      gatewayStatus = null;
    }
  }

  async function refreshModels(providerId: string, client = connection.client): Promise<void> {
    if (!client || !providerId) {
      models = [];
      return;
    }
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (provider?.can_list_models !== true) {
      models = [];
      modelsError = null;
      return;
    }
    modelsLoading = true;
    modelsError = null;
    try {
      models = await client.listLlmModels(providerId);
      if (models.length === 0) modelsError = 'No models returned.';
    } catch (err) {
      models = [];
      modelsError = (err as Error).message;
    } finally {
      modelsLoading = false;
    }
  }

  async function applySelection(): Promise<void> {
    if (applyDisabled) return;
    const profile = activeProfile;
    const providerId = selectedProviderId.trim();
    const modelId = selectedModelId.trim();
    if (!profile || !providerId) return;
    if (profile.mode === 'local' && !LOCAL_SIDECAR_PROVIDERS.has(providerId)) {
      toasts.show(
        `${providerDisplayName(providerId)} is only available on hosted gateways.`,
        'error'
      );
      return;
    }

    applying = true;
    try {
      await updateProfile(profile.id, {
        llmProviderId: providerId,
        llmBackend: legacyBackendForProvider(providerId),
        llmModelId: modelId || undefined
      });
      if ('reloadSettings' in connection) {
        await connection.reloadSettings();
      }
      needsRunnerRestart = profile.mode === 'local' && connection.sidecarStatus === 'running';
      toasts.show(
        needsRunnerRestart
          ? 'Model saved. Restart the runner to use it for new replies.'
          : 'Chat model saved.',
        'success'
      );
    } catch (err) {
      toasts.show(`Model save failed: ${(err as Error).message}`, 'error');
    } finally {
      applying = false;
    }
  }

  async function restartRunner(): Promise<void> {
    if (restarting) return;
    restarting = true;
    try {
      await connection.stopSidecar();
      const ok = await connection.startSidecar();
      needsRunnerRestart = !ok;
    } finally {
      restarting = false;
    }
  }

  function togglePicker(): void {
    pickerOpen = !pickerOpen;
  }

  function closePicker(): void {
    pickerOpen = false;
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (!pickerOpen) return;
    if (event.key === 'Escape') closePicker();
  }

  $effect(() => {
    const client = connection.client;
    void refreshProviderCatalog(client);
  });

  $effect(() => {
    const profile = activeProfile;
    const providerId = activeProviderId;
    const defaultModel = modelDefaultFor(providerId);
    const key = `${profile.id}:${providerId}:${profile.llmModelId ?? ''}:${defaultModel}`;
    if (key === lastSyncedProfileKey) return;
    lastSyncedProfileKey = key;
    selectedProviderId = providerId;
    selectedModelId = profile.llmModelId ?? defaultModel;
    needsRunnerRestart = false;
  });

  $effect(() => {
    const providerId = selectedProviderId;
    const client = connection.client;
    void refreshModels(providerId, client);
  });
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="chat-model" aria-label="Chat model controls">
  <button
    type="button"
    class="chat-model__trigger"
    aria-expanded={pickerOpen}
    aria-controls="chat-model-picker"
    onclick={togglePicker}
  >
    <span class="chat-model__label">Model</span>
    <span class="chat-model__running" title="Gateway-reported model">
      Running: {runningProviderLabel} / {runningModelLabel || 'server default'}
    </span>
    <svg class="chat-model__chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 6l4 4 4-4" />
    </svg>
  </button>

  {#if pickerOpen}
    <div
      id="chat-model-picker"
      class="chat-model__popover"
      role="group"
      aria-label="Choose chat model"
    >
      <div class="chat-model__row">
        <label class="chat-model__field">
          <span>Provider</span>
          <select bind:value={selectedProviderId} disabled={providersLoading || applying}>
            {#each providerOptions as provider (provider.id)}
              <option value={provider.id}
                >{provider.name ?? providerDisplayName(provider.id)}</option
              >
            {/each}
          </select>
        </label>

        <label class="chat-model__field chat-model__field--model">
          <span>Model</span>
          {#if models.length > 0}
            <select bind:value={selectedModelId} disabled={modelsLoading || applying}>
              {#each models as model (model.id)}
                <option value={model.id}>{model.name ?? model.id}</option>
              {/each}
            </select>
          {:else}
            <input
              bind:value={selectedModelId}
              disabled={modelsLoading || applying}
              placeholder={selectedModelDefault || 'model id'}
              aria-label="Chat model"
            />
          {/if}
        </label>
      </div>

      <div class="chat-model__footer">
        <div class="chat-model__note">
          {#if activeProfile.mode === 'remote'}
            Hosted gateways may enforce their server default.
          {:else if activeProfile.mode === 'local' && !selectedProviderSupportsLocal}
            <span class="chat-model__error">
              {providerDisplayName(selectedProviderId)} needs a hosted gateway.
            </span>
          {:else if !modelReadiness.verified}
            <span class="chat-model__warn">{modelReadiness.description}</span>
          {:else if providersError}
            <span class="chat-model__warn">Provider list unavailable. Using saved model.</span>
          {:else if modelsError}
            <span class="chat-model__warn">Model list unavailable. Type a model id.</span>
          {:else}
            Saved changes apply to new replies.
          {/if}
        </div>
        <div class="chat-model__actions">
          <button
            type="button"
            class="chat-model__apply"
            disabled={applyDisabled}
            onclick={applySelection}
          >
            {applying ? 'Saving...' : 'Apply'}
          </button>
          {#if needsRunnerRestart}
            <button
              type="button"
              class="chat-model__restart"
              disabled={restarting}
              onclick={restartRunner}
            >
              {restarting ? 'Restarting...' : 'Restart runner'}
            </button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .chat-model {
    position: relative;
    display: flex;
    justify-content: flex-start;
    min-height: 2.4rem;
    padding: 0.45rem 0.85rem;
    border-bottom: 1px solid color-mix(in srgb, var(--v2-border) 78%, transparent);
    background: color-mix(in srgb, var(--v2-canvas) 88%, var(--v2-canvas-strong));
  }

  .chat-model__trigger {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    max-width: min(100%, 34rem);
    min-height: 1.9rem;
    border-radius: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--v2-border) 82%, transparent);
    background: color-mix(in srgb, var(--v2-canvas-strong) 86%, transparent);
    color: var(--v2-text);
    padding: 0 0.65rem;
    font: 650 0.78rem/1 var(--font-ui);
    transition:
      border-color 120ms ease,
      background-color 120ms ease,
      color 120ms ease;
  }

  .chat-model__trigger:hover,
  .chat-model__trigger:focus-visible {
    border-color: color-mix(in srgb, var(--v2-accent) 70%, var(--v2-border));
    background: color-mix(in srgb, var(--v2-canvas-strong) 94%, var(--v2-accent) 6%);
    outline: none;
  }

  .chat-model__label {
    color: var(--v2-text-muted);
    font-weight: 700;
  }

  .chat-model__running {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-model__chevron {
    width: 0.75rem;
    height: 0.75rem;
    color: var(--v2-text-muted);
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex-shrink: 0;
  }

  .chat-model__popover {
    position: absolute;
    left: 0.85rem;
    top: calc(100% + 0.35rem);
    z-index: 30;
    width: min(38rem, calc(100vw - 2rem));
    border-radius: 0.65rem;
    border: 1px solid color-mix(in srgb, var(--v2-border) 88%, transparent);
    background: var(--v2-canvas-strong);
    box-shadow:
      0 18px 50px rgb(0 0 0 / 0.32),
      0 0 0 1px rgb(255 255 255 / 0.02) inset;
    padding: 0.85rem;
  }

  .chat-model__row {
    display: grid;
    grid-template-columns: minmax(8rem, 0.8fr) minmax(12rem, 1.4fr);
    gap: 0.65rem;
  }

  .chat-model__field {
    display: grid;
    gap: 0.3rem;
    min-width: 0;
  }

  .chat-model__field span {
    font-size: 0.68rem;
    line-height: 1;
    color: var(--v2-text-muted);
    font-weight: 700;
  }

  .chat-model select,
  .chat-model input {
    min-height: 2rem;
    max-width: 100%;
    border-radius: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--v2-border) 88%, transparent);
    background: var(--v2-canvas);
    color: var(--v2-text);
    font: 600 0.78rem/1.2 var(--font-ui);
    padding: 0 0.55rem;
    outline: none;
  }

  .chat-model input {
    font-family: var(--font-ui);
    font-weight: 600;
  }

  .chat-model select:focus,
  .chat-model input:focus {
    border-color: var(--v2-accent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--v2-accent) 45%, transparent);
  }

  .chat-model__footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid color-mix(in srgb, var(--v2-border) 70%, transparent);
  }

  .chat-model__note {
    min-width: 0;
    color: var(--v2-text-muted);
    font-size: 0.74rem;
    line-height: 1.35;
  }

  .chat-model__actions {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-shrink: 0;
  }

  .chat-model__actions button {
    min-height: 2rem;
    border-radius: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--v2-border) 88%, transparent);
    padding: 0 0.65rem;
    color: var(--v2-text);
    font: 700 0.76rem/1 var(--font-ui);
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
  }

  .chat-model__actions button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .chat-model__apply {
    background: var(--v2-accent);
    border-color: var(--v2-accent);
    color: var(--v2-canvas-strong);
  }

  .chat-model__apply:not(:disabled):hover,
  .chat-model__restart:not(:disabled):hover {
    filter: brightness(1.08);
  }

  .chat-model__restart {
    background: color-mix(in srgb, var(--v2-warning) 16%, transparent);
    border-color: color-mix(in srgb, var(--v2-warning) 55%, transparent);
    color: var(--v2-warning);
  }

  .chat-model__error {
    color: var(--v2-danger);
  }

  .chat-model__warn {
    color: var(--v2-warning);
  }

  @media (max-width: 760px) {
    .chat-model__trigger {
      max-width: 100%;
    }

    .chat-model__popover {
      left: 0.5rem;
      width: calc(100vw - 1rem);
    }

    .chat-model__row {
      grid-template-columns: 1fr;
    }

    .chat-model__footer {
      align-items: stretch;
      flex-direction: column;
    }

    .chat-model__actions {
      justify-content: flex-end;
    }
  }
</style>
