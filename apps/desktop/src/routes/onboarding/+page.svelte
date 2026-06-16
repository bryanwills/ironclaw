<script lang="ts">
  // First-run onboarding — outcome-first orientation with a single required
  // connection decision: where does your agent run?
  //
  //   • Local  → one click. Spawns the bundled sidecar (NEAR.AI Cloud
  //              default, no key needed) and drops you into chat.
  //   • Hosted → prefilled gateway URL + paste your access token. We
  //              health-check BEFORE marking setup complete, so "done"
  //              can never mean "silently broken".
  //
  // Everything optional (custom server URL, API version) lives behind an
  // "Advanced" disclosure so the critical path stays sign-in-simple.
  // Local always uses NEAR.AI Cloud inference — no competing-provider option
  // in first-run (NEAR.AI's model is inference margin). Accent/theme + any
  // backend switching live in Settings.
  //
  // Invariants carried over from the old three-step wizard:
  //   - finishing ALWAYS writes `onboardingComplete: true` so the user is
  //     never trapped here;
  //   - on a save failure we arm the `ironclaw-onboarding-bypass`
  //     localStorage escape hatch the layout honours, so a broken
  //     settings write can't wedge the user on /onboarding forever;
  //   - the draft hydrates from disk in onMount but never clobbers a
  //     choice the user already made (settingsTouched guard).

  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { IronClawClient } from '$lib/api/ironclaw';
  import { CONNECTOR_PACKS } from '$lib/data/connector-packs';
  import { DEFAULT_NEARAI_MODEL } from '$lib/data/llm-defaults';
  import { FIRST_RUN_MISSIONS } from '$lib/data/missions';
  import { connection } from '$lib/stores/connection.svelte';
  import NearMark from '$lib/components/NearMark.svelte';
  import {
    DEFAULT_PROFILE_ID,
    HOSTED_DEFAULT_URL,
    loadSettings,
    saveSettings,
    setToken,
    type ApiVersion,
    type AppSettings,
    type ProfileConfig
  } from '$lib/stores/settings.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { validateHostedUrl } from '$lib/util/validate-url';

  const LOCAL_DEFAULT_URL = 'http://127.0.0.1:3100';
  const connectorPreviewLabels = CONNECTOR_PACKS.map((pack) => pack.display_name);
  const missionPreviewTitles = FIRST_RUN_MISSIONS.slice(0, 4).map((mission) => mission.title);

  let view = $state<'choose' | 'hosted'>('choose');

  let settings = $state<AppSettings>({
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [],
    onboardingComplete: false
  });
  let settingsTouched = $state(false);

  const activeProfile = $derived<ProfileConfig | null>(
    settings.profiles.find((p) => p.id === settings.activeProfileId) ?? null
  );

  let hostedUrl = $state(HOSTED_DEFAULT_URL);
  let tokenInput = $state('');
  let tokenVisible = $state(false);
  let connecting = $state(false);
  let busyLocal = $state(false);
  let localProgress = $state('');
  // False until onMount's loadSettings() resolves. Until then `activeProfile`
  // is null (settings.profiles starts empty), so the Local action would
  // silently no-op on an early click — gate it on this instead.
  let hydrated = $state(false);
  let errorMsg = $state<string | null>(null);

  // Advanced disclosure.
  let showAdvanced = $state(false);
  let apiVersionChoice = $state<ApiVersion>('v2');

  /** Host shown on the "sign in" link so we don't render a full URL. */
  const signInHost = $derived(hostOf(hostedUrl) ?? hostedUrl);

  function hostOf(url: string): string | null {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }

  onMount(async () => {
    try {
      const loaded = await loadSettings();
      if (!settingsTouched) settings = loaded;
      const active = loaded.profiles.find((p) => p.id === loaded.activeProfileId);
      if (active) {
        if (active.remoteBaseUrl && active.remoteBaseUrl !== LOCAL_DEFAULT_URL) {
          hostedUrl = active.remoteBaseUrl;
        }
        apiVersionChoice = active.apiVersion ?? 'v2';
      }
    } finally {
      hydrated = true;
    }
  });

  function patchActiveProfile(patch: Partial<ProfileConfig>) {
    if (!activeProfile) return;
    settingsTouched = true;
    settings = {
      ...settings,
      profiles: settings.profiles.map((p) => (p.id === activeProfile.id ? { ...p, ...patch } : p))
    };
  }

  function clearBypass() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem('ironclaw-onboarding-bypass');
      }
    } catch {
      /* non-fatal */
    }
  }

  function armBypass() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem('ironclaw-onboarding-bypass', '1');
      }
    } catch {
      /* non-fatal */
    }
  }

  /** One-click Local: save mode=local + onboarded, let the connection store
   *  spawn the sidecar (autostart is unblocked once onboardingComplete is
   *  true), then go to chat. The sign-in chip guides NEAR.AI sign-in. */
  async function chooseLocal() {
    if (busyLocal || !activeProfile) return;
    busyLocal = true;
    localProgress = 'Saving settings…';
    errorMsg = null;
    try {
      // Local always runs on NEAR.AI Cloud inference — that's the product's
      // model (NEAR.AI monetizes inference margin), so onboarding never
      // surfaces a competing provider. Power users can still switch backends
      // later in Settings.
      patchActiveProfile({
        mode: 'local',
        llmBackend: 'nearai',
        llmProviderId: 'nearai',
        llmModelId: DEFAULT_NEARAI_MODEL,
        apiVersion: apiVersionChoice
      });
      const next: AppSettings = { ...$state.snapshot(settings), onboardingComplete: true };
      await saveSettings(next);
      clearBypass();
      localProgress = 'Starting local IronClaw and checking health…';
      await connection.refresh();
      // Honest completion: only claim success if the sidecar actually came up
      // and answered a health check. If it didn't (failed to start, or not
      // signed in to NEAR.AI yet), say so and point at Settings rather than
      // dropping the user into a chat that will silently fail on the first
      // message. We still mark onboarding complete (saved above) so they're
      // never trapped here, and the chat composer's offline CTA guides them.
      if (connection.status === 'connected') {
        toasts.show('Running locally on this Mac', 'success');
        localProgress = 'Ready';
      } else {
        toasts.show('Local runner started. Finish setup in Settings.', 'info');
        localProgress = '';
      }
      await goto('/dashboard');
    } catch (err) {
      errorMsg = (err as Error).message;
      armBypass();
      busyLocal = false;
      localProgress = '';
    }
  }

  /** Hosted: health-check the gateway with the pasted token BEFORE marking
   *  onboarding complete, so we never finish into a broken connection. */
  async function connectHosted() {
    if (connecting || !activeProfile) return;
    const token = tokenInput.trim();
    if (!token) {
      errorMsg = 'Paste your access token to connect';
      return;
    }
    // Validate the gateway URL BEFORE constructing a client — a pasted
    // `http://` remote would otherwise send the bearer token in cleartext.
    const validated = validateHostedUrl(hostedUrl.trim() || HOSTED_DEFAULT_URL);
    if (!validated.ok) {
      errorMsg = validated.error;
      return;
    }
    const url = validated.url;
    connecting = true;
    errorMsg = null;
    try {
      const probe = new IronClawClient({ baseUrl: url, token });
      const h = await probe.health();
      if (!h.ok) {
        errorMsg = `Gateway unhealthy (status="${h.status ?? 'unknown'}"). Check the token.`;
        connecting = false;
        return;
      }
      await setToken(activeProfile.id, token);
      patchActiveProfile({ mode: 'remote', remoteBaseUrl: url, apiVersion: apiVersionChoice });
      const next: AppSettings = { ...$state.snapshot(settings), onboardingComplete: true };
      await saveSettings(next);
      clearBypass();
      await connection.refresh();
      toasts.show('Connected', 'success');
      await goto('/dashboard');
    } catch (err) {
      errorMsg = (err as Error).message || "Can't reach the gateway. Check the URL and network.";
      connecting = false;
    }
  }

  /** Single, explicit escape hatch. Reads settings off disk (never the
   *  draft), flips only `onboardingComplete`, and leaves. */
  async function setupLater() {
    errorMsg = null;
    try {
      const onDisk = await loadSettings();
      await saveSettings({ ...onDisk, onboardingComplete: true });
      clearBypass();
      await connection.refresh();
      toasts.show('Finish setup anytime in Settings', 'info');
      await goto('/dashboard');
    } catch (err) {
      armBypass();
      toasts.show(`Couldn't save settings: ${(err as Error).message}`, 'error');
      await goto('/dashboard');
    }
  }

  /** Open the gateway in the browser so the user can sign in to NEAR.AI and
   *  copy their access token. Uses the Tauri shell opener with a web
   *  fallback for dev/preview. */
  async function openSignIn() {
    const url = hostedUrl.trim() || HOSTED_DEFAULT_URL;
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
    } catch {
      try {
        window.open(url, '_blank', 'noopener');
      } catch {
        /* nothing else we can do */
      }
    }
  }

  async function pasteToken() {
    try {
      tokenInput = await navigator.clipboard.readText();
      errorMsg = null;
    } catch (err) {
      errorMsg = (err as Error).message || "Couldn't read the clipboard";
    }
  }
</script>

<div class="ob">
  <div class="ob__panel">
    <header class="ob__head">
      <!-- Official NEAR "N" mark (same glyph as the sidebar wordmark).
           Decorative: the h1 already names the product. Styled via props
           because Svelte's scoped CSS does not cross into the component. -->
      <NearMark size={48} style="display: block; margin: 0 auto 1rem; color: var(--v2-accent);" />
      <h1 class="ob__title">IronClaw Desktop</h1>
      <p class="ob__value">A Chief of Staff for the work moving through your apps.</p>
      <p class="ob__sub">
        Connect a runner, add context, run a mission. Get drafts and decisions back to approve.
      </p>
    </header>

    {#if view === 'choose'}
      <div class="ob__section-label">Step 1 — connect a runner</div>
      <div class="ob__choices">
        <button
          type="button"
          class="ob__choice"
          aria-label="Run locally on this Mac"
          disabled={busyLocal || !hydrated}
          onclick={chooseLocal}
        >
          <span class="ob__choice-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <rect x="4" y="5" width="16" height="11" rx="2.2" />
              <path d="M9 20h6" stroke-linecap="round" />
              <path d="M12 16v4" stroke-linecap="round" />
            </svg>
          </span>
          <span class="ob__choice-copy">
            <span class="ob__choice-title">Run on this Mac</span>
            <span class="ob__choice-desc">
              Run IronClaw on this Mac to brief, triage, and draft locally.
            </span>
          </span>
          <span class="ob__choice-cta"
            >{!hydrated ? 'Loading…' : busyLocal ? 'Starting…' : 'Local →'}</span
          >
          {#if localProgress}
            <span class="ob__progress" aria-live="polite">{localProgress}</span>
          {/if}
        </button>

        <button
          type="button"
          class="ob__choice"
          aria-label="Connect to a hosted gateway"
          onclick={() => {
            errorMsg = null;
            view = 'hosted';
          }}
        >
          <span class="ob__choice-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M7 17.5h9.5a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.7-1.3A4.7 4.7 0 0 0 7 17.5Z" />
              <path d="M9 13h6" stroke-linecap="round" />
              <path d="M12 10v6" stroke-linecap="round" />
            </svg>
          </span>
          <span class="ob__choice-copy">
            <span class="ob__choice-title">Connect to hosted</span>
            <span class="ob__choice-desc">
              Connect to your team's hosted gateway. Sign in, paste your token.
            </span>
          </span>
          <span class="ob__choice-cta">Hosted →</span>
        </button>
      </div>

      <section class="ob__preview" aria-labelledby="ob-preview-title">
        <div class="ob__preview-head">
          <p class="ob__eyebrow">First run</p>
          <h2 id="ob-preview-title" class="ob__preview-title">Connect, brief, approve</h2>
        </div>

        <div class="ob__preview-rows">
          <div class="ob__preview-row">
            <div class="ob__preview-copy">
              <span class="ob__preview-step">Workspace</span>
              <span class="ob__preview-label">Connect your sources</span>
            </div>
            <div class="ob__chips" aria-label="Workspace connector examples">
              {#each connectorPreviewLabels as label}
                <span class="ob__chip">{label}</span>
              {/each}
            </div>
          </div>

          <div class="ob__preview-row">
            <div class="ob__preview-copy">
              <span class="ob__preview-step">Mission</span>
              <span class="ob__preview-label">Get useful work back</span>
            </div>
            <div class="ob__chips" aria-label="First mission examples">
              {#each missionPreviewTitles as title}
                <span class="ob__chip">{title}</span>
              {/each}
            </div>
          </div>
        </div>
      </section>
    {:else}
      <div class="ob__hosted">
        <button type="button" class="ob__back" onclick={() => (view = 'choose')}>← Back</button>
        <div class="ob__field">
          <label class="ob__label" for="ob-token">Access token</label>
          <p class="ob__hint">
            <span>Sign in at</span>
            <button type="button" class="ob__link" onclick={openSignIn}>{signInHost}</button>
            <span>to get your token, then paste it below.</span>
          </p>
          <div class="ob__token-row">
            <input
              id="ob-token"
              class="ob__input"
              type={tokenVisible ? 'text' : 'password'}
              autocomplete="off"
              spellcheck="false"
              placeholder="Paste your access token"
              bind:value={tokenInput}
            />
            <button type="button" class="ob__token-btn" onclick={pasteToken}>Paste</button>
            <button
              type="button"
              class="ob__token-btn"
              aria-pressed={tokenVisible}
              onclick={() => (tokenVisible = !tokenVisible)}
            >
              {tokenVisible ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        <button
          type="button"
          class="ob__connect"
          disabled={connecting || tokenInput.trim().length === 0}
          onclick={connectHosted}
        >
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    {/if}

    {#if errorMsg}
      <p class="ob__error" role="alert">
        <span class="ob__error-icon" aria-hidden="true">!</span>
        <span>{errorMsg}</span>
      </p>
    {/if}

    <details class="ob__adv" bind:open={showAdvanced}>
      <summary class="ob__adv-summary">Advanced</summary>
      <div class="ob__adv-body">
        <div class="ob__field">
          <label class="ob__label" for="ob-url">Custom server URL</label>
          <input
            id="ob-url"
            class="ob__input"
            type="url"
            autocomplete="off"
            spellcheck="false"
            placeholder="https://your-gateway.example"
            bind:value={hostedUrl}
          />
        </div>

        <div class="ob__field">
          <span class="ob__label">API version</span>
          <div class="ob__seg" role="group" aria-label="API version">
            <button
              type="button"
              class="ob__seg-btn"
              class:on={apiVersionChoice === 'v2'}
              onclick={() => (apiVersionChoice = 'v2')}
            >
              v2 (recommended)
            </button>
            <button
              type="button"
              class="ob__seg-btn"
              class:on={apiVersionChoice === 'v1'}
              onclick={() => (apiVersionChoice = 'v1')}
            >
              v1 (legacy)
            </button>
          </div>
        </div>
      </div>
    </details>

    <button type="button" class="ob__later" onclick={setupLater}>Set up later</button>
  </div>
</div>

<style>
  .ob {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100svh;
    padding: clamp(1.25rem, 4vw, 3rem);
    background: var(--v2-canvas-strong);
  }
  .ob__panel {
    width: 100%;
    max-width: 48rem;
    display: flex;
    flex-direction: column;
    gap: 1.35rem;
    animation: ob-enter var(--v2-dur-fast) var(--v2-ease-out);
  }
  .ob__head {
    text-align: center;
    max-width: 37rem;
    margin: 0 auto 0.15rem;
  }
  .ob__title {
    margin: 0;
    /* Focused setup-console scale, not a welcome poster. Solid strong text —
       no gradient headline (reads more premium-tool, less generic SaaS). */
    font-family: var(--font-display);
    font-size: clamp(1.5rem, 3.2vw, 2.05rem);
    line-height: 1.05;
    font-weight: 600;
    letter-spacing: 0;
    color: var(--v2-text-strong);
  }
  .ob__value {
    margin: 0.85rem auto 0;
    max-width: 34rem;
    font-size: 1.04rem;
    line-height: 1.45;
    color: var(--v2-text-strong);
  }
  .ob__sub {
    margin: 0.35rem auto 0;
    max-width: 28rem;
    font-size: 0.98rem;
    line-height: 1.55;
    color: var(--v2-text-muted);
  }
  .ob__preview {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    padding: 1rem;
    border: 1px solid var(--v2-panel-border);
    border-radius: 0.9rem;
    background: var(--v2-surface);
  }
  .ob__preview-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.45rem 0.75rem;
  }
  .ob__eyebrow,
  .ob__section-label,
  .ob__preview-step {
    margin: 0;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--v2-text-faint);
  }
  .ob__preview-title {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.3;
    font-weight: 650;
    color: var(--v2-text-strong);
  }
  .ob__preview-rows {
    display: grid;
    gap: 0.65rem;
  }
  .ob__preview-row {
    display: grid;
    grid-template-columns: minmax(9.5rem, 0.78fr) minmax(0, 1.4fr);
    align-items: center;
    gap: 0.75rem;
    padding-top: 0.65rem;
    border-top: 1px solid var(--v2-border);
  }
  .ob__preview-copy {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  .ob__preview-label {
    font-size: 0.9rem;
    line-height: 1.35;
    font-weight: 600;
    color: var(--v2-text);
  }
  .ob__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    min-width: 0;
  }
  .ob__chip {
    display: inline-flex;
    min-height: 2rem;
    align-items: center;
    padding: 0 0.6rem;
    border: 1px solid var(--v2-border);
    border-radius: 999px;
    background: var(--v2-input-bg);
    color: var(--v2-text-muted);
    font-size: 0.8rem;
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
  }
  .ob__section-label {
    margin: 0.1rem 0 -0.3rem;
  }
  .ob__choices {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.9rem;
  }
  .ob__choice {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 1.1rem;
    min-height: 15rem;
    text-align: left;
    padding: 1.2rem;
    border: 1px solid var(--v2-panel-border);
    border-radius: 0.9rem;
    background: var(--v2-surface);
    color: var(--v2-text);
    cursor: pointer;
    transition:
      border-color var(--v2-dur-fast) var(--v2-ease-out),
      background var(--v2-dur-fast) var(--v2-ease-out),
      opacity var(--v2-dur-fast) var(--v2-ease-out),
      transform var(--v2-dur-fast) var(--v2-ease-out);
  }
  .ob__choice:hover:not(:disabled) {
    border-color: var(--v2-accent);
    background: var(--v2-surface-2);
    transform: translateY(-1px);
  }
  .ob__choice:focus-visible {
    outline: 2px solid var(--v2-accent);
    outline-offset: 3px;
    border-color: var(--v2-accent);
  }
  .ob__choice:active:not(:disabled) {
    transform: translateY(0);
  }
  .ob__choice:disabled {
    opacity: 0.68;
    cursor: progress;
  }
  .ob__choice-icon {
    display: inline-flex;
    width: 3rem;
    height: 3rem;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--v2-border);
    border-radius: 0.75rem;
    background: var(--v2-accent-soft);
    color: var(--v2-accent-text);
  }
  .ob__choice-icon svg {
    width: 1.45rem;
    height: 1.45rem;
  }
  .ob__choice-copy {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0.5rem;
  }
  .ob__choice-title {
    font-size: 1.15rem;
    line-height: 1.2;
    font-weight: 650;
    color: var(--v2-text-strong);
  }
  .ob__choice-desc {
    max-width: 17rem;
    font-size: 0.9rem;
    line-height: 1.55;
    color: var(--v2-text-muted);
  }
  .ob__choice-cta {
    display: inline-flex;
    min-height: 2.75rem;
    width: fit-content;
    align-items: center;
    justify-content: center;
    margin-top: auto;
    padding: 0 0.85rem;
    border: 1px solid var(--v2-border);
    border-radius: 999px;
    background: var(--v2-input-bg);
    font-size: 0.86rem;
    font-weight: 600;
    color: var(--v2-accent-text);
  }
  .ob__progress {
    min-height: 1.25rem;
    margin-top: -0.55rem;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--v2-text-muted);
  }
  .ob__hosted {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: 100%;
    max-width: 34rem;
    margin: 0 auto;
    padding: 1.1rem;
    border: 1px solid var(--v2-panel-border);
    border-radius: 0.9rem;
    background: var(--v2-surface);
    animation: ob-enter var(--v2-dur-fast) var(--v2-ease-out);
  }
  .ob__back {
    align-self: flex-start;
    min-height: 2.75rem;
    margin-bottom: -0.15rem;
    padding: 0 0.4rem;
    border: none;
    background: transparent;
    color: var(--v2-text-muted);
    font: inherit;
    font-size: 0.86rem;
    cursor: pointer;
    transition: color var(--v2-dur-fast) var(--v2-ease-out);
  }
  .ob__back:hover {
    color: var(--v2-text);
  }
  .ob__field {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .ob__label {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--v2-text-strong);
  }
  .ob__hint {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
    margin: 0;
    font-size: 0.84rem;
    line-height: 1.5;
    color: var(--v2-text-muted);
  }
  .ob__link {
    display: inline-flex;
    min-height: 2.75rem;
    align-items: center;
    padding: 0 0.55rem;
    border: 1px solid var(--v2-border);
    border-radius: 999px;
    background: var(--v2-surface-soft);
    color: var(--v2-accent-text);
    font: inherit;
    font-size: 0.84rem;
    text-decoration: none;
    cursor: pointer;
    transition:
      border-color var(--v2-dur-fast) var(--v2-ease-out),
      background var(--v2-dur-fast) var(--v2-ease-out),
      color var(--v2-dur-fast) var(--v2-ease-out);
  }
  .ob__link:hover {
    border-color: var(--v2-accent);
    background: var(--v2-accent-soft);
    color: var(--v2-text-strong);
  }
  .ob__input {
    min-height: 3rem;
    padding: 0 0.85rem;
    border: 1px solid var(--v2-border);
    border-radius: 0.65rem;
    background: var(--v2-input-bg);
    color: var(--v2-text-strong);
    font: inherit;
    font-size: 0.9rem;
    transition:
      border-color var(--v2-dur-fast) var(--v2-ease-out),
      background var(--v2-dur-fast) var(--v2-ease-out);
  }
  .ob__input::placeholder {
    color: var(--v2-text-faint);
  }
  .ob__input:focus {
    outline: none;
    border-color: var(--v2-accent);
    background: var(--v2-surface);
  }
  .ob__input:focus-visible {
    outline: 2px solid var(--v2-accent);
    outline-offset: 2px;
  }
  .ob__token-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 0.45rem;
  }
  .ob__token-row .ob__input {
    min-width: 0;
    width: 100%;
  }
  .ob__token-btn {
    min-height: 3rem;
    padding: 0 0.75rem;
    border: 1px solid var(--v2-border);
    border-radius: 0.65rem;
    background: var(--v2-surface-soft);
    color: var(--v2-text);
    font: inherit;
    font-size: 0.84rem;
    font-weight: 600;
    cursor: pointer;
    transition:
      border-color var(--v2-dur-fast) var(--v2-ease-out),
      background var(--v2-dur-fast) var(--v2-ease-out),
      color var(--v2-dur-fast) var(--v2-ease-out);
  }
  .ob__token-btn:hover {
    border-color: var(--v2-accent);
    background: var(--v2-accent-soft);
    color: var(--v2-text-strong);
  }
  .ob__token-btn:focus-visible {
    outline: 2px solid var(--v2-accent);
    outline-offset: 2px;
  }
  .ob__connect {
    min-height: 3rem;
    margin-top: 0.15rem;
    padding: 0 1rem;
    border: 1px solid var(--v2-accent);
    border-radius: 0.65rem;
    background: var(--v2-accent);
    color: var(--v2-inverse);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    transition:
      opacity var(--v2-dur-fast) var(--v2-ease-out),
      transform var(--v2-dur-fast) var(--v2-ease-out);
  }
  .ob__connect:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .ob__connect:hover:not(:disabled) {
    opacity: 0.92;
  }
  .ob__connect:active:not(:disabled) {
    transform: translateY(1px);
  }
  .ob__error {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    width: 100%;
    max-width: 34rem;
    min-height: 2.75rem;
    margin: 0 auto;
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--v2-danger-text);
    border-radius: 0.65rem;
    background: var(--v2-danger-soft);
    color: var(--v2-danger-text);
    font-size: 0.86rem;
    line-height: 1.45;
    animation: ob-enter var(--v2-dur-fast) var(--v2-ease-out);
  }
  .ob__error-icon {
    display: inline-flex;
    width: 1.25rem;
    height: 1.25rem;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border: 1px solid currentColor;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 700;
    line-height: 1;
  }
  .ob__adv {
    width: 100%;
    max-width: 34rem;
    margin: 0 auto;
    border-top: 1px solid var(--v2-border);
    padding-top: 0.65rem;
  }
  .ob__adv-summary {
    min-height: 2.75rem;
    padding: 0.65rem 0;
    font-size: 0.84rem;
    color: var(--v2-text-muted);
    cursor: pointer;
    transition: color var(--v2-dur-fast) var(--v2-ease-out);
  }
  .ob__adv-summary:hover {
    color: var(--v2-text);
  }
  .ob__adv-summary:focus-visible {
    outline: 2px solid var(--v2-accent);
    outline-offset: 2px;
    border-radius: 0.35rem;
  }
  .ob__adv-body {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-top: 0.35rem;
    padding-bottom: 0.2rem;
    animation: ob-enter var(--v2-dur-fast) var(--v2-ease-out);
  }
  .ob__seg {
    display: flex;
    gap: 0.45rem;
  }
  .ob__seg-btn {
    flex: 1 1 auto;
    min-height: 2.75rem;
    padding: 0 0.7rem;
    border: 1px solid var(--v2-border);
    border-radius: 0.65rem;
    background: var(--v2-surface);
    color: var(--v2-text-muted);
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    transition:
      border-color var(--v2-dur-fast) var(--v2-ease-out),
      background var(--v2-dur-fast) var(--v2-ease-out),
      color var(--v2-dur-fast) var(--v2-ease-out);
  }
  .ob__seg-btn:hover {
    border-color: var(--v2-accent);
    color: var(--v2-text);
  }
  .ob__seg-btn.on {
    border-color: var(--v2-accent);
    color: var(--v2-accent-text);
    background: var(--v2-accent-soft);
  }
  .ob__later {
    align-self: center;
    min-height: 2.75rem;
    margin-top: -0.2rem;
    padding: 0 0.75rem;
    border: none;
    background: transparent;
    color: var(--v2-text-faint);
    font: inherit;
    font-size: 0.84rem;
    cursor: pointer;
    transition: color var(--v2-dur-fast) var(--v2-ease-out);
  }
  .ob__later:hover {
    color: var(--v2-text-muted);
  }

  @keyframes ob-enter {
    from {
      opacity: 0;
      transform: translateY(0.35rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (max-width: 44rem) {
    .ob {
      align-items: flex-start;
    }
    .ob__preview-row {
      grid-template-columns: 1fr;
      align-items: start;
    }
    .ob__chip {
      white-space: normal;
    }
    .ob__choices {
      grid-template-columns: 1fr;
    }
    .ob__choice {
      min-height: 12.5rem;
    }
    .ob__choice-desc {
      max-width: none;
    }
  }
</style>
