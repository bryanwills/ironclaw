<script lang="ts">
  // LLM provider picker — the rich, registry-driven replacement for the
  // binary NEAR.AI / OpenRouter radio in /settings. Renders inside the
  // Local-mode area because the active provider is what the bundled
  // sidecar uses; the gateway's `/api/llm/providers` catalog drives the
  // dropdown.
  //
  // No props — consumes the connection store directly so the picker
  // re-syncs automatically on profile switches.
  //
  // Behaviour:
  //   - Top dropdown lists every provider from the registry, with badges
  //     for builtin / configured / api-key-required.
  //   - The active provider card below shows adapter, status, default
  //     model (dropdown when `can_list_models`, free text otherwise),
  //     base URL (input when required, muted default text otherwise),
  //     and a credential section whose shape switches on
  //     `credential_kind`.
  //   - Test connection + List models call into the client (which is
  //     null in offline mode, so the buttons disable gracefully).
  //   - Save writes the provider id to ProfileConfig + the secret to
  //     Keychain. For backward compatibility the legacy `llmBackend`
  //     field is set to `'openrouter'` only when the chosen provider is
  //     openrouter; everything else lands on `'nearai'` so a downgraded
  //     binary still spawns the right sidecar block.
  //
  // The picker never mutates the cached api key in JS state — values
  // round-trip through the Keychain IPC, and the input field renders the
  // masked placeholder when a secret is already vaulted.

  import { open as shellOpen } from '@tauri-apps/plugin-shell';
  import type { LlmModel, LlmProvider } from '$lib/api/types';
  import { effectiveDefaultModelForProvider } from '$lib/data/llm-defaults';
  import { connection } from '$lib/stores/connection.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import {
    deleteLlmProviderCredential,
    deleteOpenRouterKey,
    getLlmProviderCredential,
    getOpenRouterKey,
    setLlmProviderCredential,
    setOpenRouterKey,
    updateProfile,
    type LlmBackend
  } from '$lib/stores/settings.svelte';

  // Source of truth: src-tauri/src/lib.rs `start_sidecar` provider match
  // arms. Any provider outside this set returns the native unsupported
  // sidecar error before the bundled gateway can spawn.
  const LOCAL_SIDECAR_PROVIDERS = new Set(['nearai', 'openrouter', 'openai', 'anthropic']);

  // ---- Registry --------------------------------------------------------

  let providers = $state<LlmProvider[]>([]);
  let providersLoading = $state(false);
  let providersError = $state<string | null>(null);

  // ---- Form state (lives in the parent so child branches share it) ----

  /** Provider id currently selected in the dropdown. Driven by both the
   *  active profile's `llmProviderId` and user clicks. */
  let selectedId = $state<string>('nearai');

  /** Optional override for the default model. Empty string = "use the
   *  registry-supplied default". Populated from the active profile on
   *  load and from a List-models click. */
  let modelDraft = $state('');

  /** Optional override for the base URL. Only meaningful when the
   *  selected provider has `base_url_required`. */
  let baseUrlDraft = $state('');

  /** Free-form credential input. The semantics depend on the
   *  provider's credential_kind:
   *    - api_key / open_ai_compatible → secret API key
   *    - file_based_credentials → path on disk
   *    - aws_credentials → access key id
   *  Cleared on every save / clear; the masked placeholder communicates
   *  whether a value is already stored. */
  let credentialDraft = $state('');

  /** AWS-only secondary fields. Kept separate from `credentialDraft` so
   *  the access-key / secret-key pair can both be edited at once. */
  let awsSecretDraft = $state('');
  let awsRegionDraft = $state('us-east-1');

  /** True if the active provider already has a credential vaulted. Drives
   *  the placeholder + the "Clear" affordance. */
  let credentialStored = $state(false);

  // ---- Test connection / List models -----------------------------------

  let testStatus = $state<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  let testMessage = $state<string | null>(null);

  let modelsLoading = $state(false);
  let modelsError = $state<string | null>(null);
  /** Cached model catalog for the selected provider; populated on List
   *  models. Renders the default-model dropdown instead of free text. */
  let modelOptions = $state<LlmModel[]>([]);

  let saving = $state(false);

  // ---- Derived shorthands ----------------------------------------------

  const selectedProvider = $derived<LlmProvider | undefined>(
    providers.find((p) => p.id === selectedId)
  );

  /** Which credential UI to render. Falls back to `'api_key'` when the
   *  registry omits the field — matches what the OpenRouter / OpenAI
   *  builtins do. */
  const credentialKind = $derived<string>(selectedProvider?.credential_kind ?? 'api_key');

  /** True when the provider's `can_list_models` flag is set. Drives the
   *  default-model surface (dropdown vs free text). */
  const canListModels = $derived(selectedProvider?.can_list_models === true);

  /** Display-only base URL when the user can't override it. */
  const fallbackBaseUrl = $derived(selectedProvider?.base_url ?? '');

  const isLocalMode = $derived(connection.activeProfile?.mode === 'local');

  const selectedProviderSupportedLocally = $derived(
    selectedProvider ? LOCAL_SIDECAR_PROVIDERS.has(selectedProvider.id) : true
  );

  const blocksLocalSave = $derived(isLocalMode && !selectedProviderSupportedLocally);

  // ---- Load + reset on profile / catalog change ------------------------

  async function fetchProviders() {
    const client = connection.client;
    if (!client) {
      providers = [];
      providersError = 'Not connected to a gateway yet.';
      providersLoading = false;
      return;
    }
    providersLoading = true;
    providersError = null;
    try {
      const out = await client.listLlmProviders();
      providers = out;
      if (out.length === 0) {
        providersError = 'Gateway returned an empty provider catalog.';
      }
    } catch (err) {
      providersError = (err as Error).message;
    } finally {
      providersLoading = false;
    }
  }

  // Re-fetch the catalog whenever the active client flips (profile
  // switch / sidecar restart). Also primes `selectedId` from the active
  // profile so the dropdown matches what's on disk.
  $effect(() => {
    void connection.client; // dep
    void fetchProviders();
  });

  $effect(() => {
    const profile = connection.activeProfile;
    if (!profile) return;
    selectedId =
      profile.llmProviderId && profile.llmProviderId.length > 0
        ? profile.llmProviderId
        : profile.llmBackend;
  });

  // Whenever the selection changes, reset the form drafts to the
  // registry defaults + reload the stored credential flag.
  $effect(() => {
    const provider = selectedProvider;
    if (!provider) return;
    const profile = connection.activeProfile;
    modelDraft =
      profile?.llmProviderId === provider.id && profile.llmModelId
        ? profile.llmModelId
        : effectiveDefaultModelForProvider(provider.id, provider.default_model);
    baseUrlDraft = '';
    credentialDraft = '';
    awsSecretDraft = '';
    modelOptions = [];
    testStatus = 'idle';
    testMessage = null;
    modelsError = null;
    void refreshCredentialStored();
  });

  async function refreshCredentialStored() {
    const profile = connection.activeProfile;
    const provider = selectedProvider;
    if (!profile || !provider) {
      credentialStored = false;
      return;
    }
    // OpenRouter keeps its dedicated slot for backward compat with the
    // legacy radio. Everything else lands in the per-provider slot.
    try {
      const value =
        provider.id === 'openrouter'
          ? await getOpenRouterKey(profile.id)
          : await getLlmProviderCredential(profile.id, provider.id);
      credentialStored = !!value;
    } catch (err) {
      console.warn('refreshCredentialStored failed', err);
      credentialStored = false;
    }
  }

  // ---- Buttons ---------------------------------------------------------

  async function onTestConnection() {
    const client = connection.client;
    const provider = selectedProvider;
    if (!client || !provider) return;
    testStatus = 'testing';
    testMessage = null;
    try {
      const config: Record<string, unknown> = {
        adapter: provider.adapter ?? '',
        base_url:
          provider.base_url_required && baseUrlDraft.trim()
            ? baseUrlDraft.trim()
            : (provider.base_url ?? ''),
        model:
          modelDraft.trim() || effectiveDefaultModelForProvider(provider.id, provider.default_model)
      };
      if (credentialDraft.trim()) {
        config.api_key = credentialDraft.trim();
      }
      const res = await client.testLlmConnection(provider.id, config);
      if (res.ok) {
        testStatus = 'ok';
        testMessage = res.model ? `Connected (model: ${res.model})` : 'Connected';
      } else {
        testStatus = 'fail';
        testMessage = res.error ?? 'Connection test failed';
      }
    } catch (err) {
      testStatus = 'fail';
      testMessage = (err as Error).message;
    }
  }

  async function onListModels() {
    const client = connection.client;
    const provider = selectedProvider;
    if (!client || !provider) return;
    modelsLoading = true;
    modelsError = null;
    try {
      const out = await client.listLlmModels(provider.id);
      modelOptions = out;
      if (out.length === 0) {
        modelsError = 'Gateway returned no models for this provider.';
      }
    } catch (err) {
      modelsError = (err as Error).message;
    } finally {
      modelsLoading = false;
    }
  }

  async function onOpenSignInFlow() {
    // NEAR.AI's session-token flow happens in the IronClaw web UI; for
    // device-code OAuth providers we open the same URL and let the
    // gateway drive the flow. The sidecar must already be running so the
    // user has a base URL to point at.
    const port = connection.sidecarPort;
    if (!port) {
      toasts.show('Start the sidecar before signing in', 'error');
      return;
    }
    try {
      await shellOpen(`http://127.0.0.1:${port}/`);
      toasts.show('Opened IronClaw · complete sign-in there', 'info');
    } catch (err) {
      toasts.show(`Could not open browser: ${(err as Error).message}`, 'error');
    }
  }

  async function onSave() {
    const profile = connection.activeProfile;
    const provider = selectedProvider;
    if (!profile || !provider) return;
    if (isLocalMode && !LOCAL_SIDECAR_PROVIDERS.has(provider.id)) {
      toasts.show(
        `${provider.name} is remote gateway only. Choose a supported local provider or switch this profile to a hosted gateway.`,
        'error'
      );
      return;
    }
    saving = true;
    try {
      // Persist the provider id on the active profile; derive the
      // legacy `llmBackend` for older code paths.
      const legacyBackend: LlmBackend = provider.id === 'openrouter' ? 'openrouter' : 'nearai';
      await updateProfile(profile.id, {
        llmProviderId: provider.id,
        llmBackend: legacyBackend,
        llmModelId: modelDraft.trim() || undefined
      });

      // Save the credential to the right Keychain slot, when the user
      // typed one in. Empty input = "leave the existing vaulted value
      // alone" so users can change provider without re-typing keys.
      const trimmed = credentialDraft.trim();
      if (trimmed && needsCredentialInput(credentialKind)) {
        if (provider.id === 'openrouter') {
          await setOpenRouterKey(profile.id, trimmed);
        } else if (credentialKind === 'aws_credentials') {
          // Store the access key id under the per-provider slot and the
          // secret under a `<provider>:secret:<profile>` pseudo-slot.
          // For v1 we collapse both into the same provider slot using a
          // `accessKey|secret|region` envelope so the sidecar can split
          // them out — the secret/region path isn't wired in v1 yet.
          const secret = awsSecretDraft.trim();
          const region = awsRegionDraft.trim() || 'us-east-1';
          await setLlmProviderCredential(
            profile.id,
            provider.id,
            JSON.stringify({ accessKey: trimmed, secret, region })
          );
        } else {
          await setLlmProviderCredential(profile.id, provider.id, trimmed);
        }
      }

      credentialDraft = '';
      awsSecretDraft = '';
      await refreshCredentialStored();
      // Reload the connection store so the new provider id flows through
      // to the sidecar on the next start/restart. We don't auto-restart
      // here — the user does that explicitly from the sidecar card.
      await connection.refresh();
      toasts.show(`Provider set to ${provider.name}`, 'success');
    } catch (err) {
      toasts.show(`Save failed: ${(err as Error).message}`, 'error');
    } finally {
      saving = false;
    }
  }

  async function onClearCredential() {
    const profile = connection.activeProfile;
    const provider = selectedProvider;
    if (!profile || !provider) return;
    try {
      if (provider.id === 'openrouter') {
        await deleteOpenRouterKey(profile.id);
      } else {
        await deleteLlmProviderCredential(profile.id, provider.id);
      }
      credentialDraft = '';
      awsSecretDraft = '';
      await refreshCredentialStored();
      toasts.show('Credential cleared', 'success');
    } catch (err) {
      toasts.show(`Clear failed: ${(err as Error).message}`, 'error');
    }
  }

  /** True when this credential_kind exposes an input field at all.
   *  `session_token` (NEAR.AI) and `o_auth_device_code` are click-to-
   *  authenticate flows, and `ollama` runs against a local URL with no
   *  secret. */
  function needsCredentialInput(kind: string): boolean {
    return (
      kind === 'api_key' ||
      kind === 'open_ai_compatible' ||
      kind === 'file_based_credentials' ||
      kind === 'aws_credentials'
    );
  }

  function badgeLabel(p: LlmProvider): string[] {
    const out: string[] = [];
    if (p.configured) out.push('configured');
    if (p.builtin) out.push('builtin');
    if (p.has_api_key === false && p.credential_kind === 'api_key') {
      out.push('key required');
    }
    return out;
  }

  function localSupportLabel(p: LlmProvider): string {
    return LOCAL_SIDECAR_PROVIDERS.has(p.id) ? 'Supported locally' : 'Remote gateway only';
  }
</script>

<div class="surface p-5 space-y-4">
  <div>
    <h2 class="text-sm font-semibold text-text-primary">LLM provider</h2>
    <p class="text-xs text-text-muted mt-1">
      {#if isLocalMode}
        The bundled sidecar uses this provider for inference. Only providers marked supported
        locally can spawn in local mode.
      {:else}
        Hosted gateways manage which providers can run.
      {/if}
      The list comes from the gateway's
      <code class="font-mono">/api/llm/providers</code>
      registry.
    </p>
  </div>

  {#if providersLoading && providers.length === 0}
    <div class="text-xs text-text-muted italic">Loading providers…</div>
  {:else if providersError && providers.length === 0}
    <div class="px-3 py-2 rounded-md bg-red-950/40 border border-red-800/60">
      <p class="text-xs text-red-200 break-words">{providersError}</p>
    </div>
  {:else}
    <!-- Provider dropdown -->
    <div>
      <label for="llm-provider-select" class="block text-xs text-text-muted mb-1"> Provider </label>
      <select
        id="llm-provider-select"
        bind:value={selectedId}
        class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-cyan min-h-[44px]"
      >
        {#each providers as p (p.id)}
          {@const labels = badgeLabel(p)}
          {@const localLabel = isLocalMode ? localSupportLabel(p) : null}
          <option value={p.id}>
            {p.name}{labels.length > 0 || localLabel
              ? ` — ${[...labels, localLabel].filter(Boolean).join(' · ')}`
              : ''}
          </option>
        {/each}
      </select>
    </div>
  {/if}

  {#if selectedProvider}
    <!-- Active provider card -->
    <div class="border border-border-subtle rounded-md p-4 space-y-4 bg-bg-deep/40">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div class="text-sm font-semibold text-text-primary">
            {selectedProvider.name}
          </div>
          <div class="text-[11px] font-mono text-text-muted mt-0.5">
            adapter: {selectedProvider.adapter ?? '—'}
          </div>
        </div>
        <div class="flex items-center gap-2 text-[10px] uppercase tracking-wide">
          {#if selectedProvider.configured}
            <span
              class="px-1.5 py-0.5 rounded bg-green-500/10 text-green-300 border border-green-500/30"
            >
              configured
            </span>
          {:else}
            <span
              class="px-1.5 py-0.5 rounded bg-accent-gold/10 text-accent-gold border border-accent-gold/30"
            >
              needs setup
            </span>
          {/if}
          {#if selectedProvider.builtin}
            <span
              class="px-1.5 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/30"
            >
              builtin
            </span>
          {/if}
          {#if isLocalMode}
            {#if selectedProviderSupportedLocally}
              <span
                class="px-1.5 py-0.5 rounded bg-green-500/10 text-green-300 border border-green-500/30"
              >
                Supported locally
              </span>
            {:else}
              <span
                class="px-1.5 py-0.5 rounded bg-red-500/10 text-red-300 border border-red-500/30"
              >
                Remote gateway only
              </span>
            {/if}
          {/if}
        </div>
      </div>

      {#if blocksLocalSave}
        <div class="px-3 py-2 rounded-md bg-red-950/40 border border-red-800/60">
          <p class="text-xs text-red-200">
            {selectedProvider.name} is remote gateway only. The bundled local sidecar cannot spawn it
            yet. Choose NEAR.AI, OpenRouter, OpenAI, or Anthropic for local mode, or switch this profile
            to a hosted gateway.
          </p>
        </div>
      {/if}

      <!-- Base URL -->
      {#if selectedProvider.base_url_required}
        <div>
          <label for="llm-base-url" class="block text-xs text-text-muted mb-1">
            Base URL <span class="text-accent-gold">·</span> required
          </label>
          <input
            id="llm-base-url"
            type="text"
            bind:value={baseUrlDraft}
            placeholder={fallbackBaseUrl || 'https://…'}
            aria-describedby="llm-base-url-help"
            disabled
            class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-muted focus:outline-none min-h-[44px] disabled:cursor-not-allowed disabled:opacity-70"
          />
          <p id="llm-base-url-help" class="mt-1 text-[11px] text-text-muted">
            Base URL isn't configurable here yet — set it in the IronClaw web UI.
          </p>
        </div>
      {:else if fallbackBaseUrl}
        <div>
          <div class="block text-xs text-text-muted mb-1">Base URL</div>
          <div
            class="text-xs font-mono text-text-muted bg-bg-deep border border-border-subtle rounded-md px-3 py-2 min-h-[44px] flex items-center break-all"
          >
            {fallbackBaseUrl}
          </div>
        </div>
      {/if}

      <!-- Default model -->
      <div>
        <label for="llm-default-model" class="block text-xs text-text-muted mb-1">
          Default model
        </label>
        {#if canListModels && modelOptions.length > 0}
          <select
            id="llm-default-model"
            bind:value={modelDraft}
            aria-describedby="llm-default-model-help"
            class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary focus:outline-none focus:border-accent-cyan min-h-[44px]"
          >
            {#each modelOptions as m (m.id)}
              <option value={m.id}>{m.name ?? m.id}</option>
            {/each}
          </select>
        {:else}
          <input
            id="llm-default-model"
            type="text"
            bind:value={modelDraft}
            placeholder={effectiveDefaultModelForProvider(
              selectedProvider.id,
              selectedProvider.default_model
            )}
            aria-describedby="llm-default-model-help"
            class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary focus:outline-none focus:border-accent-cyan min-h-[44px]"
          />
        {/if}
        <p id="llm-default-model-help" class="mt-1 text-[11px] text-text-muted">
          Saved on this profile. Local runner changes apply after restart; hosted gateways may keep
          their server default.
        </p>
        {#if canListModels}
          <button
            type="button"
            onclick={() => void onListModels()}
            disabled={modelsLoading || !connection.client}
            class="mt-2 text-xs text-accent-cyan underline decoration-dotted hover:decoration-solid disabled:opacity-50"
          >
            {modelsLoading ? 'Listing…' : 'List models'}
          </button>
        {/if}
        {#if modelsError}
          <p class="mt-1 text-[11px] text-red-400">{modelsError}</p>
        {/if}
      </div>

      <!-- Credentials, per credential_kind -->
      {#if credentialKind === 'api_key' || credentialKind === 'open_ai_compatible'}
        <div>
          <label for="llm-api-key" class="block text-xs text-text-muted mb-1"> API key </label>
          <input
            id="llm-api-key"
            type="password"
            bind:value={credentialDraft}
            placeholder={credentialStored ? '•••• stored in macOS Keychain' : 'sk-…'}
            class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary focus:outline-none focus:border-accent-cyan min-h-[44px]"
          />
        </div>
      {:else if credentialKind === 'session_token' || credentialKind === 'o_auth_device_code'}
        <div class="space-y-2">
          <div class="text-xs text-text-muted">
            {credentialKind === 'session_token'
              ? 'This provider uses session-token auth. Sign in via the IronClaw web UI.'
              : 'This provider uses OAuth device-code flow. Sign in via the IronClaw web UI.'}
          </div>
          <button
            type="button"
            onclick={() => void onOpenSignInFlow()}
            class="px-3 py-1.5 rounded-md bg-accent-cyan text-bg-deep text-xs font-semibold hover:brightness-110 transition min-h-[36px]"
          >
            Sign in
          </button>
        </div>
      {:else if credentialKind === 'file_based_credentials'}
        <div>
          <label for="llm-cred-file" class="block text-xs text-text-muted mb-1">
            Credentials file path
          </label>
          <input
            id="llm-cred-file"
            type="text"
            bind:value={credentialDraft}
            placeholder={credentialStored ? '(stored)' : '/path/to/credentials.json'}
            class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary focus:outline-none focus:border-accent-cyan min-h-[44px]"
          />
        </div>
      {:else if credentialKind === 'aws_credentials'}
        <div class="space-y-3">
          <div>
            <label for="aws-access-key" class="block text-xs text-text-muted mb-1">
              Access key id
            </label>
            <input
              id="aws-access-key"
              type="text"
              bind:value={credentialDraft}
              placeholder={credentialStored ? '(stored)' : 'AKIA…'}
              class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary focus:outline-none focus:border-accent-cyan min-h-[44px]"
            />
          </div>
          <div>
            <label for="aws-secret-key" class="block text-xs text-text-muted mb-1">
              Secret access key
            </label>
            <input
              id="aws-secret-key"
              type="password"
              bind:value={awsSecretDraft}
              placeholder={credentialStored ? '••••' : '…'}
              class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary focus:outline-none focus:border-accent-cyan min-h-[44px]"
            />
          </div>
          <div>
            <label for="aws-region" class="block text-xs text-text-muted mb-1"> Region </label>
            <input
              id="aws-region"
              type="text"
              bind:value={awsRegionDraft}
              placeholder="us-east-1"
              class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary focus:outline-none focus:border-accent-cyan min-h-[44px]"
            />
          </div>
        </div>
      {:else if credentialKind === 'ollama'}
        <div class="text-xs text-text-muted">
          Ollama runs locally on
          <code class="font-mono">{fallbackBaseUrl || 'http://127.0.0.1:11434'}</code>
          — no API key needed.
        </div>
      {:else}
        <div class="text-xs text-text-muted">
          This provider can't be configured here yet. Set it up in the IronClaw web UI.
        </div>
      {/if}

      <!-- Action row: test / list / save -->
      <div class="flex flex-wrap items-center gap-2 pt-2">
        <button
          type="button"
          onclick={() => void onTestConnection()}
          disabled={testStatus === 'testing' || !connection.client}
          class="px-3 py-1.5 rounded-md border border-accent-cyan text-accent-cyan text-xs font-semibold hover:bg-accent-cyan hover:text-bg-deep transition disabled:opacity-50 min-h-[36px]"
        >
          {testStatus === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          onclick={() => void onSave()}
          disabled={saving || blocksLocalSave}
          class="px-3 py-1.5 rounded-md bg-accent-cyan text-bg-deep text-xs font-semibold hover:brightness-110 transition disabled:opacity-50 min-h-[36px]"
        >
          {saving ? 'Saving…' : 'Save provider'}
        </button>
        {#if credentialStored && needsCredentialInput(credentialKind)}
          <button
            type="button"
            onclick={() => void onClearCredential()}
            class="px-3 py-1.5 rounded-md border border-border-subtle text-text-primary text-xs font-semibold hover:border-accent-gold hover:text-accent-gold transition min-h-[36px]"
          >
            Clear credential
          </button>
        {/if}

        {#if testStatus === 'ok'}
          <span class="text-xs text-accent-cyan flex items-center gap-1">
            <svg
              viewBox="0 0 24 24"
              class="w-4 h-4"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {testMessage}
          </span>
        {:else if testStatus === 'fail'}
          <span class="text-xs text-red-400 flex items-center gap-1">
            <svg
              viewBox="0 0 24 24"
              class="w-4 h-4"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            {testMessage}
          </span>
        {/if}
      </div>
    </div>
  {/if}
</div>
