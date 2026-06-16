<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { open as openUrl } from '@tauri-apps/plugin-shell';
  import { connection } from '$lib/stores/connection.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import type { Extension, ExtensionSetupField, ExtensionSetupSchema } from '$lib/api/types';

  type Props = {
    extension: Extension;
    onClose: () => void;
    onSaved: () => void;
  };

  const { extension, onClose, onSaved }: Props = $props();

  type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

  // ---- OAuth device-flow state ----------------------------------------------
  // Per-field flow state. `null` means no flow in progress for this field. We
  // key by `field.key` so multiple oauth fields on the same drawer could each
  // have an independent flow (unlikely in practice, but the schema allows it).
  type OAuthPhase =
    | 'idle' // no flow ever started, render plain "Sign in" button
    | 'starting' // POST /login/start in flight
    | 'pending' // waiting for user authorization; polling /login/poll
    | 'external' // browser redirect OAuth; /oauth/callback completes on gateway
    | 'authorized' // success — flow complete
    | 'denied' // user denied; offer retry
    | 'expired' // device code expired; offer retry
    | 'failed' // server error (incl. "Server does not support OAuth"); offer retry
    | 'cancelled'; // user cancelled mid-flow; back to idle on next click

  type OAuthState = {
    phase: OAuthPhase;
    verification_uri?: string;
    user_code?: string;
    /** Wall-clock ms at which the code expires. Used to drive the countdown. */
    expires_at?: number;
    /** Snapshot of `expires_in` from the server for retry/restart timing. */
    expires_in?: number;
    /** Wire identifier passed to /login/poll. */
    session_id?: string;
    /** Browser redirect OAuth URL returned by /activate on current Reborn gateways. */
    auth_url?: string;
    /** Gateway guidance for hosted/browser OAuth or manual-token fallback. */
    instructions?: string;
    interval_seconds: number;
    /** Last error message surfaced from the server or network layer. */
    error?: string;
    /** Optional identity string returned by the server (e.g. "alice@github"). */
    identity?: string;
  };

  let loadState = $state<LoadState>('idle');
  let loadError = $state<string | null>(null);
  let schema = $state<ExtensionSetupSchema | null>(null);
  /** Field values keyed by `key`. Stringly typed; coerced at submit time. */
  let values = $state<Record<string, string | boolean>>({});
  let submitting = $state(false);

  /** Per-field OAuth flow state, keyed by field.key. */
  let oauthByField = $state<Record<string, OAuthState>>({});
  /** Browser auth started by POST /setup after fields/secrets are saved. */
  let setupSubmitAuth = $state<OAuthState | null>(null);
  /** Force re-render of the countdown without spinning a derived. */
  let nowTick = $state(0);
  const OAUTH_FALLBACK_KEY = '__oauth_sign_in__';

  // Internal handles used to tear down timers when the drawer closes or the
  // user cancels. Kept outside `$state` since they aren't reactive.
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  /** Set when the drawer is being torn down so in-flight polls bail out. */
  let aborted = false;
  /** Tally of consecutive network errors per active flow (resets on success). */
  let pollErrorStreak = 0;

  // True when any OAuth field is mid-flow (pending or starting). While true,
  // every other field in the drawer becomes read-only — the OAuth panel is
  // the entry point per the spec.
  const activeOauth = $derived.by(() => {
    for (const [key, st] of Object.entries(oauthByField)) {
      if (st.phase === 'starting' || st.phase === 'pending') {
        return { key, state: st };
      }
    }
    return null;
  });

  const otherFieldsLocked = $derived(activeOauth !== null);

  // Required fields satisfied? OAuth fields count as "satisfied" once they
  // hit the `authorized` phase; otherwise they block submit if marked
  // required (so the user can't save with an unfinished auth flow).
  const canSubmit = $derived.by(() => {
    if (!schema || submitting) return false;
    if (setupSubmitAuth?.phase === 'external' || setupSubmitAuth?.phase === 'starting') {
      return false;
    }
    if (activeOauth) return false; // never submit mid-flow
    for (const f of fieldsForSchema()) {
      if (!f.required) continue;
      if (f.type === 'oauth') {
        if (oauthByField[f.key]?.phase !== 'authorized') return false;
        continue;
      }
      const v = values[f.key];
      if (typeof v === 'boolean') continue; // boolean always has a value
      if (!v || (typeof v === 'string' && v.trim().length === 0)) return false;
    }
    return true;
  });

  const title = $derived(extension.display_name ?? extension.name);

  /**
   * Best-effort human label for the OAuth button.
   * Prefers the extension's `display_name`, falls back to the raw `name`
   * with first-letter capitalization. e.g. `github` → "GitHub" is not
   * worth a lookup table — we just title-case the name.
   */
  const providerLabel = $derived.by(() => {
    const raw = (extension.display_name ?? extension.name ?? '').trim();
    if (!raw) return 'provider';
    // Already mixed case (e.g. "GitHub", "Notion") — leave alone.
    if (/[A-Z]/.test(raw) && /[a-z]/.test(raw)) return raw;
    // ALL CAPS or all-lower — title-case the first letter.
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  });

  const authProviderLabel = $derived(authProviderName(providerLabel, extension.name));
  const authActionLabel = $derived(`${authActionVerb(authProviderLabel)} ${authProviderLabel}`);
  const categoryLabel = $derived(
    workspaceCategoryLabel(extension.category, extension.name, providerLabel)
  );

  function needsOAuthFallback(nextSchema: ExtensionSetupSchema | null = schema): boolean {
    if (!nextSchema) return false;
    if (nextSchema.oauth_url || nextSchema.fields.some((field) => field.type === 'oauth')) {
      return false;
    }
    if (extension.ready === true || extension.readiness_message === 'ready') return false;
    const category = (extension.category ?? '').toLowerCase();
    const readiness = (extension.readiness_message ?? '').toLowerCase();
    return (
      category === 'oauth' ||
      readiness === 'needs_auth' ||
      readiness.includes('needs_auth') ||
      readiness.includes('oauth') ||
      readiness.includes('sign in') ||
      readiness.includes('auth')
    );
  }

  function fallbackOAuthField(): ExtensionSetupField {
    return {
      key: OAUTH_FALLBACK_KEY,
      label: `${providerLabel} connection`,
      type: 'oauth',
      required: true,
      description:
        'Sign in to authorize this connector. IronClaw will finish the connection once access is confirmed.'
    };
  }

  function fieldsForSchema(
    nextSchema: ExtensionSetupSchema | null = schema
  ): ExtensionSetupField[] {
    if (!nextSchema) return [];
    if (nextSchema.fields.length > 0) return nextSchema.fields;
    return needsOAuthFallback(nextSchema) ? [fallbackOAuthField()] : [];
  }

  const effectiveFields = $derived.by<ExtensionSetupField[]>(() => fieldsForSchema());

  onMount(() => {
    void loadSchema();
  });

  onDestroy(() => {
    teardown();
  });

  function teardown() {
    aborted = true;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  async function loadSchema() {
    const client = connection.client;
    if (!client) {
      loadState = 'error';
      loadError = 'Not connected to IronClaw';
      return;
    }
    loadState = 'loading';
    loadError = null;
    try {
      const loadedSchema = await client.getExtensionSetup(extension.name);
      // Seed defaults so toggles and selects start with the server's intent.
      const seed: Record<string, string | boolean> = {};
      const oauthSeed: Record<string, OAuthState> = {};
      for (const f of fieldsForSchema(loadedSchema)) {
        if (f.type === 'boolean') {
          seed[f.key] = f.default === 'true' || (f.default as unknown) === true;
        } else if (f.type === 'oauth') {
          // OAuth fields don't hold a string value the user can type — the
          // flow lives in `oauthByField`. We still seed an empty string so
          // submit-time iteration doesn't crash if anyone reads `values[key]`.
          seed[f.key] = '';
          oauthSeed[f.key] = { phase: 'idle', interval_seconds: 5 };
        } else if (f.default !== undefined) {
          seed[f.key] = String(f.default);
        } else {
          seed[f.key] = '';
        }
      }
      schema = loadedSchema;
      values = seed;
      oauthByField = oauthSeed;
      loadState = 'loaded';
    } catch (err) {
      loadError = (err as Error).message;
      loadState = 'error';
    }
  }

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    const client = connection.client;
    if (!client || !schema) return;
    submitting = true;
    try {
      // Pass values through verbatim — we don't know the gateway's per-field
      // type, so the only coercion is boolean handling (already correct).
      const res = await client.submitExtensionSetup(extension.name, values);
      if (res.auth_url) {
        setupSubmitAuth = {
          phase: 'external',
          auth_url: res.auth_url,
          instructions:
            res.instructions ??
            res.message ??
            'Finish sign-in in your browser, then return here to check the connection.',
          interval_seconds: 5
        };
        await launchOAuthUrl(res.auth_url);
        toasts.show(`Opened ${providerLabel} sign-in in your browser.`, 'info');
        onSaved();
        return;
      }
      if (res.ok) {
        toasts.show(`Saved setup for ${title}`, 'success');
        onSaved();
        onClose();
      } else {
        toasts.show(`Saved setup for ${title}, but the server didn't confirm`, 'info');
        onSaved();
        onClose();
      }
    } catch (err) {
      toasts.show(`Failed to save: ${(err as Error).message}`, 'error');
    } finally {
      submitting = false;
    }
  }

  async function checkSubmittedBrowserAuthorization() {
    if (!setupSubmitAuth?.auth_url) return;
    const client = connection.client;
    if (!client) return;
    setupSubmitAuth = { ...setupSubmitAuth, phase: 'starting', error: undefined };
    try {
      const res = await client.activateExtension(extension.name);
      if (res.activated || (res.ok && !res.auth_url && !res.awaiting_token)) {
        setupSubmitAuth = { ...setupSubmitAuth, phase: 'authorized', error: undefined };
        toasts.show(`Connected to ${providerLabel}`, 'success');
        onSaved();
        onClose();
        return;
      }
      if (res.auth_url) {
        setupSubmitAuth = {
          ...setupSubmitAuth,
          phase: 'external',
          auth_url: res.auth_url,
          instructions:
            res.instructions ??
            res.message ??
            'Finish sign-in in your browser, then return here to check the connection.',
          error: undefined
        };
        toasts.show(`Still waiting for ${providerLabel} authorization.`, 'info');
        return;
      }
      setupSubmitAuth = {
        ...setupSubmitAuth,
        phase: 'failed',
        error:
          res.instructions ?? res.message ?? `Still waiting for ${providerLabel} authorization.`
      };
    } catch (err) {
      setupSubmitAuth = {
        ...setupSubmitAuth,
        phase: 'failed',
        error: `Could not check ${providerLabel} connection: ${humanAuthError(err)}`
      };
    }
  }

  async function launchOAuthUrl(url: string) {
    try {
      await openUrl(url);
    } catch (err) {
      toasts.show(`Could not open browser: ${(err as Error).message}`, 'error');
    }
  }

  // ---- Device-code flow -----------------------------------------------------

  /**
   * Patch state for a single OAuth field without losing other fields' state.
   * Svelte 5 runes need a fresh object reference for shallow reactivity.
   */
  function patchOAuth(key: string, patch: Partial<OAuthState>) {
    const prev = oauthByField[key] ?? { phase: 'idle', interval_seconds: 5 };
    oauthByField = { ...oauthByField, [key]: { ...prev, ...patch } };
  }

  async function startOAuth(field: ExtensionSetupField) {
    const client = connection.client;
    if (!client) {
      toasts.show('Not connected to IronClaw', 'error');
      return;
    }
    // Reset any previous error / countdown timers for this field.
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    pollErrorStreak = 0;
    patchOAuth(field.key, {
      phase: 'starting',
      error: undefined,
      verification_uri: undefined,
      user_code: undefined,
      session_id: undefined,
      auth_url: undefined,
      instructions: undefined,
      expires_at: undefined,
      expires_in: undefined,
      identity: undefined
    });

    try {
      const res = await client.startExtensionLogin(extension.name);
      if (aborted) return;

      // Server can decline up front — e.g. "Server does not support OAuth".
      if (res.success === false || res.status === 'failed') {
        const handled = await startBrowserAuthorization(field.key, {
          autoOpen: true,
          fallbackMessage: res.message
        });
        if (handled) return;
        patchOAuth(field.key, {
          phase: 'failed',
          error: res.message || 'Server refused to start OAuth flow.'
        });
        return;
      }

      // Already authorized on the server side — short-circuit straight to
      // success (the start endpoint reports this via `activated`).
      if (res.activated) {
        patchOAuth(field.key, {
          phase: 'authorized',
          error: undefined
        });
        toasts.show(`Already connected to ${providerLabel}`, 'success');
        return;
      }

      // Happy path: we have a verification URI + user code. Begin polling.
      const sessionId = res.session_id ?? res.device_code;
      if (!sessionId || !res.verification_uri || !res.user_code) {
        patchOAuth(field.key, {
          phase: 'failed',
          error: 'Server response missing verification URL or user code.'
        });
        return;
      }

      const intervalSeconds =
        typeof res.interval === 'number' && res.interval > 0 ? res.interval : 5;
      const expiresIn =
        typeof res.expires_in === 'number' && res.expires_in > 0 ? res.expires_in : 0;
      const expiresAt = expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined;

      patchOAuth(field.key, {
        phase: 'pending',
        verification_uri: res.verification_uri,
        user_code: res.user_code,
        session_id: sessionId,
        expires_in: expiresIn,
        expires_at: expiresAt,
        interval_seconds: intervalSeconds,
        error: undefined
      });

      // Drive the countdown — 1Hz is plenty.
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = setInterval(() => {
        nowTick = Date.now();
        // Stop ticking once the code is dead.
        const st = oauthByField[field.key];
        if (!st || st.phase !== 'pending') {
          if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
          }
        }
      }, 1000);

      schedulePoll(field.key, intervalSeconds);
    } catch (err) {
      if (aborted) return;
      if (isMissingLoginEndpoint(err)) {
        const handled = await startBrowserAuthorization(field.key, { autoOpen: true });
        if (handled) return;
      }
      patchOAuth(field.key, {
        phase: 'failed',
        error: humanAuthError(err)
      });
    }
  }

  function httpStatus(err: unknown): number | undefined {
    if (typeof err === 'object' && err && 'status' in err) {
      const status = (err as { status?: unknown }).status;
      return typeof status === 'number' ? status : undefined;
    }
    return undefined;
  }

  function isMissingLoginEndpoint(err: unknown): boolean {
    return httpStatus(err) === 404;
  }

  function humanAuthError(err: unknown): string {
    if (isMissingLoginEndpoint(err)) {
      return 'This IronClaw gateway does not expose device sign-in for this connector yet.';
    }
    return err instanceof Error ? err.message : String(err);
  }

  async function startBrowserAuthorization(
    fieldKey: string,
    opts: { autoOpen?: boolean; fallbackMessage?: string; checking?: boolean } = {}
  ): Promise<boolean> {
    const client = connection.client;
    if (!client) return false;
    patchOAuth(fieldKey, {
      phase: 'starting',
      error: undefined,
      verification_uri: undefined,
      user_code: undefined,
      session_id: undefined,
      auth_url: undefined,
      instructions: undefined,
      expires_at: undefined,
      expires_in: undefined,
      identity: undefined
    });

    try {
      const res = await client.activateExtension(extension.name);
      if (aborted) return true;

      if (res.activated || (res.ok && !res.auth_url && !res.awaiting_token)) {
        patchOAuth(fieldKey, {
          phase: 'authorized',
          error: undefined,
          auth_url: undefined,
          instructions: undefined
        });
        toasts.show(`Connected to ${providerLabel}`, 'success');
        onSaved();
        return true;
      }

      if (res.auth_url) {
        patchOAuth(fieldKey, {
          phase: 'external',
          auth_url: res.auth_url,
          instructions:
            res.instructions ??
            res.message ??
            'Finish sign-in in your browser, then return here to check the connection.',
          error: undefined
        });
        if (opts.autoOpen !== false) {
          await launchOAuthUrl(res.auth_url);
          toasts.show(`Opened ${providerLabel} sign-in in your browser.`, 'info');
        } else if (opts.checking) {
          toasts.show(`Still waiting for ${providerLabel} authorization.`, 'info');
        }
        return true;
      }

      patchOAuth(fieldKey, {
        phase: 'failed',
        error:
          res.instructions ??
          res.message ??
          opts.fallbackMessage ??
          `This gateway could not start ${providerLabel} sign-in.`
      });
      return true;
    } catch (err) {
      if (aborted) return true;
      patchOAuth(fieldKey, {
        phase: 'failed',
        error:
          opts.fallbackMessage ??
          `This gateway could not start ${providerLabel} sign-in: ${humanAuthError(err)}`
      });
      return true;
    }
  }

  function schedulePoll(fieldKey: string, intervalSeconds: number) {
    if (aborted) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void pollOnce(fieldKey), intervalSeconds * 1000);
  }

  async function pollOnce(fieldKey: string) {
    if (aborted) return;
    const client = connection.client;
    const st = oauthByField[fieldKey];
    if (!client || !st || st.phase !== 'pending' || !st.session_id) return;

    // Hard-stop polling once the device code expires (avoids hammering the
    // server forever if the user never opens the verification URL).
    if (st.expires_at && Date.now() > st.expires_at) {
      patchOAuth(fieldKey, {
        phase: 'expired',
        error: 'The authorization code expired before you signed in.'
      });
      toasts.show('Authorization code expired', 'error');
      return;
    }

    try {
      const res = await client.pollExtensionLogin(extension.name, st.session_id);
      if (aborted) return;

      pollErrorStreak = 0;

      if (res.status === 'authorized' || res.authorized) {
        patchOAuth(fieldKey, {
          phase: 'authorized',
          error: undefined,
          identity: extractIdentity(res)
        });
        toasts.show(`Connected to ${providerLabel}`, 'success');
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
        if (countdownTimer) {
          clearInterval(countdownTimer);
          countdownTimer = null;
        }
        return;
      }

      if (res.status === 'denied') {
        patchOAuth(fieldKey, {
          phase: 'denied',
          error: res.error || 'Authorization was denied.'
        });
        toasts.show('Authorization denied', 'error');
        return;
      }

      if (res.status === 'expired') {
        patchOAuth(fieldKey, {
          phase: 'expired',
          error: res.error || 'The authorization code expired.'
        });
        toasts.show('Authorization code expired', 'error');
        return;
      }

      if (res.status !== 'pending') {
        // Any other non-pending status is a server-side failure mode.
        patchOAuth(fieldKey, {
          phase: 'failed',
          error: res.error || `Unexpected status: ${res.status}`
        });
        toasts.show('Authorization failed', 'error');
        return;
      }

      // Still pending — schedule the next tick.
      schedulePoll(fieldKey, st.interval_seconds);
    } catch (err) {
      if (aborted) return;
      pollErrorStreak += 1;
      if (pollErrorStreak >= 3) {
        patchOAuth(fieldKey, {
          phase: 'failed',
          error: `Network error after 3 attempts: ${(err as Error).message}`
        });
        toasts.show('Network error during authorization', 'error');
        return;
      }
      // Transient error — retry on the same cadence.
      schedulePoll(fieldKey, st.interval_seconds);
    }
  }

  /**
   * The poll response may carry identity info in non-standard shapes (the
   * brief says "if the response carries any identity info"). We don't make
   * up a field — we just look at whatever the wire DTO exposes today and
   * fall through to undefined if nothing useful is there. The current
   * `DeviceLoginPoll` type only exposes `status / error / authorized`, so
   * this is a no-op until the type grows. Kept as a single chokepoint so
   * the spot to plumb new fields through is obvious.
   */
  function extractIdentity(_res: unknown): string | undefined {
    return undefined;
  }

  function cancelOAuth(fieldKey: string) {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    pollErrorStreak = 0;
    patchOAuth(fieldKey, {
      phase: 'cancelled',
      error: undefined
    });
  }

  function disconnectOAuth(fieldKey: string) {
    // TODO(server): no /api/extensions/{name}/login/revoke endpoint exists
    // today. This is a UI-only reset until the gateway grows one.
    patchOAuth(fieldKey, {
      phase: 'idle',
      verification_uri: undefined,
      user_code: undefined,
      session_id: undefined,
      expires_at: undefined,
      expires_in: undefined,
      identity: undefined,
      auth_url: undefined,
      instructions: undefined,
      error: undefined
    });
    toasts.show(`Cleared local state. Server-side disconnect isn't supported yet.`, 'info');
  }

  async function copyToClipboard(text: string, label: string) {
    try {
      // Tauri's webview ships a real navigator.clipboard.
      await navigator.clipboard.writeText(text);
      toasts.show(`${label} copied`, 'success');
    } catch (err) {
      toasts.show(`Could not copy ${label.toLowerCase()}: ${(err as Error).message}`, 'error');
    }
  }

  /** Seconds remaining for the active code (0 if none / expired). */
  function secondsRemaining(state: OAuthState): number {
    // Touch nowTick so this re-evaluates when the countdown ticks. (Inline
    // void reference avoids an unused-var lint without doing real work.)
    void nowTick;
    if (!state.expires_at) return 0;
    return Math.max(0, Math.ceil((state.expires_at - Date.now()) / 1000));
  }

  function formatCountdown(seconds: number): string {
    if (seconds <= 0) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function authActionVerb(label: string): string {
    const lower = label.toLowerCase();
    if (lower.includes('gmail') || lower.includes('google')) return 'Log in with';
    return 'Connect';
  }

  function authProviderName(label: string, name: string | undefined): string {
    const lower = `${label} ${name ?? ''}`.toLowerCase();
    if (lower.includes('google_calendar') || lower.includes('google calendar')) return 'Google';
    return label;
  }

  function workspaceCategoryLabel(
    category: string | undefined,
    name: string | undefined,
    label: string
  ): string | null {
    const c = (category ?? '').toLowerCase();
    const normalized = `${name ?? ''} ${label}`.toLowerCase();
    if (normalized.includes('gmail') || normalized.includes('mail')) return 'Mail';
    if (normalized.includes('calendar') || normalized.includes('gcal')) return 'Calendar';
    if (normalized.includes('notion')) return 'Knowledge';
    if (normalized.includes('slack')) return 'Team chat';
    if (c === 'mcp') return 'Knowledge';
    if (c === 'oauth') return 'Account';
    if (c === 'channel') return 'Team chat';
    if (c === 'wasm_tool' || c === 'tool') return 'Workspace';
    if (!c) return null;
    return c.replace(/[_-]+/g, ' ').replace(/^./, (m) => m.toUpperCase());
  }

  function displayFieldLabel(field: ExtensionSetupField): string {
    return field.label.replace(/\boauth\b/gi, 'sign-in');
  }

  function isSecretField(field: ExtensionSetupField): boolean {
    const type = String(field.type ?? '').toLowerCase();
    const key = String(field.key ?? '').toLowerCase();
    const label = String(field.label ?? '').toLowerCase();
    return (
      type === 'password' ||
      type === 'secret' ||
      type === 'token' ||
      key.includes('secret') ||
      key.includes('token') ||
      label.includes('secret') ||
      label.includes('token')
    );
  }

  function handleBackdropKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (activeOauth) {
        // Abort the active flow rather than closing the drawer outright —
        // matches the spec ("user cancel: stop polling, close modal").
        cancelOAuth(activeOauth.key);
        return;
      }
      onClose();
    }
  }

  function handleClose() {
    teardown();
    onClose();
  }
</script>

<svelte:window onkeydown={handleBackdropKey} />

<!-- Backdrop -->
<button
  type="button"
  aria-label="Close drawer"
  onclick={handleClose}
  class="fixed inset-0 z-40 bg-black/40 cursor-default"
></button>

<!-- Drawer -->
<div
  class="v2-drawer-shell fixed top-0 right-0 z-50 h-full w-full md:w-[40%] min-w-[360px] max-w-[640px] border-l border-border-subtle flex flex-col overflow-hidden"
  role="dialog"
  aria-modal="true"
  aria-labelledby="extension-setup-title"
>
  <!-- Header -->
  <header class="flex items-start justify-between gap-4 px-6 py-5 border-b border-border-subtle">
    <div class="min-w-0">
      <h2 id="extension-setup-title" class="text-lg font-semibold text-accent-cyan break-words">
        {title}
      </h2>
      <div class="mt-1 flex flex-wrap items-center gap-2">
        {#if extension.version}
          <span class="text-[10px] font-mono text-text-muted bg-bg-deep px-2 py-0.5 rounded">
            v{extension.version}
          </span>
        {/if}
        {#if categoryLabel}
          <span
            class="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border border-border-subtle text-text-muted"
          >
            {categoryLabel}
          </span>
        {/if}
      </div>
    </div>
    <button
      type="button"
      onclick={handleClose}
      aria-label="Close"
      class="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan transition"
    >
      <svg
        viewBox="0 0 24 24"
        class="w-4 h-4"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </header>

  <!-- Body -->
  <div class="flex-1 overflow-auto px-6 py-5">
    {#if loadState === 'loading' || loadState === 'idle'}
      <div class="space-y-4 animate-pulse">
        <div class="h-3 w-1/4 bg-border-subtle rounded"></div>
        <div class="h-10 w-full bg-border-subtle rounded"></div>
        <div class="h-3 w-1/3 bg-border-subtle rounded"></div>
        <div class="h-10 w-full bg-border-subtle rounded"></div>
      </div>
    {:else if loadState === 'error'}
      <div class="surface p-6 flex flex-col items-center justify-center text-center">
        <div class="text-sm text-red-400 mb-2">Failed to load setup</div>
        <div class="text-xs text-text-muted font-mono mb-4 max-w-md break-words">
          {loadError ?? 'Unknown error'}
        </div>
        <button
          type="button"
          onclick={loadSchema}
          class="px-4 py-2 rounded-md border border-accent-cyan text-accent-cyan text-sm font-semibold hover:bg-accent-cyan hover:text-bg-deep transition min-h-[40px]"
        >
          Retry
        </button>
      </div>
    {:else if schema && effectiveFields.length === 0 && !schema.oauth_url}
      <div class="surface p-6 text-sm text-text-muted">
        {extension.ready
          ? `${providerLabel} is connected and ready to use.`
          : `Activate ${providerLabel} from the card to enable it.`}
      </div>
    {:else if schema}
      <form onsubmit={handleSubmit} class="space-y-5">
        {#if schema.notes}
          <p class="text-xs text-text-muted leading-relaxed">{schema.notes}</p>
        {/if}

        {#if setupSubmitAuth?.phase === 'external' && setupSubmitAuth.auth_url}
          <div class="surface px-4 py-5 space-y-4">
            <div class="space-y-1">
              <div class="text-sm font-semibold text-text-primary">
                Finish sign-in in your browser
              </div>
              <div class="text-xs text-text-muted leading-relaxed">
                IronClaw saved the setup details. Complete {providerLabel} sign-in, then check the connection.
              </div>
            </div>
            {#if setupSubmitAuth.instructions}
              <div
                class="rounded-md border border-border-subtle bg-bg-deep/60 px-3 py-2 text-xs text-text-muted leading-relaxed"
              >
                {setupSubmitAuth.instructions}
              </div>
            {/if}
            <div class="flex items-center gap-2">
              <button
                type="button"
                onclick={() => launchOAuthUrl(setupSubmitAuth!.auth_url!)}
                class="flex-1 truncate text-left text-xs font-mono text-accent-cyan underline hover:brightness-110 transition"
                title={setupSubmitAuth.auth_url}
              >
                {setupSubmitAuth.auth_url}
              </button>
              <button
                type="button"
                onclick={() => copyToClipboard(setupSubmitAuth!.auth_url!, 'Sign-in link')}
                class="shrink-0 px-2 py-1.5 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan transition text-[11px] min-h-[32px]"
              >
                Copy link
              </button>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onclick={() => launchOAuthUrl(setupSubmitAuth!.auth_url!)}
                class="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-accent-cyan text-accent-cyan hover:bg-accent-cyan hover:text-bg-deep transition text-xs font-semibold min-h-[36px]"
              >
                Open sign-in
              </button>
              <button
                type="button"
                onclick={checkSubmittedBrowserAuthorization}
                class="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-accent-cyan text-bg-deep hover:brightness-95 transition text-xs font-semibold min-h-[36px]"
              >
                Check connection
              </button>
            </div>
          </div>
        {:else if setupSubmitAuth?.phase === 'starting'}
          <div class="surface px-4 py-3 text-xs text-text-muted">Checking connection…</div>
        {:else if setupSubmitAuth?.phase === 'failed'}
          <div class="surface px-4 py-3 space-y-3">
            <div class="text-xs text-red-400 break-words">
              {setupSubmitAuth.error ?? "Couldn't confirm the connector yet"}
            </div>
            {#if setupSubmitAuth.auth_url}
              <button
                type="button"
                onclick={() =>
                  (setupSubmitAuth = {
                    ...setupSubmitAuth!,
                    phase: 'external',
                    error: undefined
                  })}
                class="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-accent-cyan text-bg-deep text-sm font-semibold hover:brightness-95 transition min-h-[40px]"
              >
                Continue sign-in
              </button>
            {/if}
          </div>
        {/if}

        {#if schema.oauth_url}
          <button
            type="button"
            onclick={() => launchOAuthUrl(schema!.oauth_url!)}
            class="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-accent-gold text-bg-deep text-sm font-semibold hover:brightness-95 transition min-h-[44px]"
          >
            <svg
              viewBox="0 0 24 24"
              class="w-4 h-4"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            {authActionLabel}
          </button>
        {/if}

        {#each effectiveFields as field (field.key)}
          {@const isOAuthField = field.type === 'oauth'}
          {@const oauthState = oauthByField[field.key]}
          {@const isThisFlowActive =
            isOAuthField && (oauthState?.phase === 'starting' || oauthState?.phase === 'pending')}
          {@const lockedByOtherFlow = !isOAuthField && otherFieldsLocked}
          <div class="space-y-1.5 {lockedByOtherFlow ? 'opacity-40 pointer-events-none' : ''}">
            <label
              for={`ext-field-${field.key}`}
              class="block text-xs font-semibold text-text-primary"
            >
              {displayFieldLabel(field)}
              {#if field.required}
                <span class="text-accent-cyan" aria-label="required">*</span>
              {/if}
            </label>
            {#if field.description}
              <p class="text-[11px] text-text-muted leading-relaxed">{field.description}</p>
            {/if}

            {#if field.type === 'boolean'}
              <label class="inline-flex items-center gap-2 cursor-pointer">
                <input
                  id={`ext-field-${field.key}`}
                  type="checkbox"
                  checked={Boolean(values[field.key])}
                  disabled={lockedByOtherFlow}
                  onchange={(e) =>
                    (values = {
                      ...values,
                      [field.key]: (e.currentTarget as HTMLInputElement).checked
                    })}
                  class="sr-only peer"
                />
                <span
                  class="relative inline-block w-9 h-5 bg-border-subtle rounded-full transition peer-checked:bg-accent-cyan after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-4 after:h-4 after:bg-text-primary after:rounded-full after:transition peer-checked:after:translate-x-4"
                ></span>
                <span class="text-xs text-text-muted">
                  {values[field.key] ? 'Enabled' : 'Disabled'}
                </span>
              </label>
            {:else if field.type === 'select'}
              <select
                id={`ext-field-${field.key}`}
                value={String(values[field.key] ?? '')}
                disabled={lockedByOtherFlow}
                onchange={(e) =>
                  (values = {
                    ...values,
                    [field.key]: (e.currentTarget as HTMLSelectElement).value
                  })}
                class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-cyan transition-colors min-h-[40px] disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {#if !field.required}
                  <option value="">— select —</option>
                {/if}
                {#each field.options ?? [] as opt (opt.value)}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            {:else if isOAuthField}
              <!--
                Device-code OAuth panel rendered INSIDE the drawer (per spec).
                Phases:
                  idle / cancelled → "Sign in with <provider>" button
                  starting         → button with spinner
                  pending          → inline panel with URL + code + countdown
                  authorized       → "Connected" pill + Disconnect button
                  denied/expired/failed → inline error + Retry
              -->
              {#if oauthState?.phase === 'authorized'}
                <div class="surface flex items-center justify-between gap-3 px-3 py-3">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="text-accent-cyan text-base leading-none">✓</span>
                    <span class="text-sm text-text-primary truncate">
                      {oauthState.identity ? `Connected as ${oauthState.identity}` : 'Authorized'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onclick={() => disconnectOAuth(field.key)}
                    class="shrink-0 px-3 py-1.5 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan transition text-xs min-h-[32px]"
                    title="Disconnect · clears local state only"
                  >
                    Disconnect
                  </button>
                </div>
              {:else if oauthState?.phase === 'external' && oauthState.auth_url}
                <div class="surface px-4 py-5 space-y-4">
                  <div class="space-y-1">
                    <div class="text-sm font-semibold text-text-primary">
                      Finish sign-in in your browser
                    </div>
                    <div class="text-xs text-text-muted leading-relaxed">
                      After {providerLabel} redirects back to IronClaw, return here and check the connection.
                    </div>
                  </div>

                  {#if oauthState.instructions}
                    <div
                      class="rounded-md border border-border-subtle bg-bg-deep/60 px-3 py-2 text-xs text-text-muted leading-relaxed"
                    >
                      {oauthState.instructions}
                    </div>
                  {/if}

                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      onclick={() => launchOAuthUrl(oauthState.auth_url!)}
                      class="flex-1 truncate text-left text-xs font-mono text-accent-cyan underline hover:brightness-110 transition"
                      title={oauthState.auth_url}
                    >
                      {oauthState.auth_url}
                    </button>
                    <button
                      type="button"
                      onclick={() => copyToClipboard(oauthState.auth_url!, 'Sign-in link')}
                      class="shrink-0 px-2 py-1.5 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan transition text-[11px] min-h-[32px]"
                    >
                      Copy link
                    </button>
                  </div>

                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      type="button"
                      onclick={() => launchOAuthUrl(oauthState.auth_url!)}
                      class="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-accent-cyan text-accent-cyan hover:bg-accent-cyan hover:text-bg-deep transition text-xs font-semibold min-h-[36px]"
                    >
                      Open sign-in
                    </button>
                    <button
                      type="button"
                      onclick={() =>
                        startBrowserAuthorization(field.key, {
                          autoOpen: false,
                          checking: true
                        })}
                      class="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-accent-cyan text-bg-deep hover:brightness-95 transition text-xs font-semibold min-h-[36px]"
                    >
                      Check connection
                    </button>
                  </div>
                </div>
              {:else if isThisFlowActive && oauthState?.phase === 'pending'}
                <div class="surface px-4 py-5 space-y-4">
                  <div class="text-xs text-text-muted leading-relaxed">
                    Open this URL and enter the code below.
                  </div>

                  <!-- Verification URI row -->
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      onclick={() => launchOAuthUrl(oauthState.verification_uri!)}
                      class="flex-1 truncate text-left text-xs font-mono text-accent-cyan underline hover:brightness-110 transition"
                      title={oauthState.verification_uri}
                    >
                      {oauthState.verification_uri}
                    </button>
                    <button
                      type="button"
                      onclick={() => copyToClipboard(oauthState.verification_uri!, 'URL')}
                      class="shrink-0 px-2 py-1.5 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan transition text-[11px] min-h-[32px]"
                    >
                      Copy URL
                    </button>
                  </div>

                  <!-- User code (big mono) -->
                  <div class="flex flex-col items-center gap-2 py-2">
                    <div
                      class="text-[36px] leading-none font-mono font-bold text-accent-cyan tracking-[0.15em] select-all"
                      aria-live="polite"
                    >
                      {oauthState.user_code}
                    </div>
                    <button
                      type="button"
                      onclick={() => copyToClipboard(oauthState.user_code!, 'Code')}
                      class="px-3 py-1.5 rounded-md border border-accent-cyan text-accent-cyan hover:bg-accent-cyan hover:text-bg-deep transition text-xs font-semibold min-h-[32px]"
                    >
                      Copy code
                    </button>
                  </div>

                  <!-- Countdown + waiting state -->
                  <div
                    class="flex items-center justify-between gap-3 pt-2 border-t border-border-subtle"
                  >
                    <div class="flex items-center gap-2 text-xs text-text-muted">
                      <svg
                        viewBox="0 0 24 24"
                        class="w-3.5 h-3.5 animate-spin"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                      >
                        <circle cx="12" cy="12" r="10" opacity="0.25" />
                        <path d="M22 12a10 10 0 0 0-10-10" />
                      </svg>
                      Waiting for authorization…
                    </div>
                    {#if oauthState.expires_at}
                      <div class="text-[11px] font-mono text-text-muted">
                        Expires in {formatCountdown(secondsRemaining(oauthState))}
                      </div>
                    {/if}
                  </div>

                  <div class="flex justify-end">
                    <button
                      type="button"
                      onclick={() => cancelOAuth(field.key)}
                      class="px-3 py-1.5 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan transition text-xs min-h-[32px]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              {:else if oauthState?.phase === 'denied' || oauthState?.phase === 'expired' || oauthState?.phase === 'failed'}
                <div class="surface px-3 py-3 space-y-3">
                  <div class="text-xs text-red-400 break-words">
                    {oauthState.error ?? 'Authorization failed'}
                  </div>
                  <button
                    type="button"
                    onclick={() => startOAuth(field)}
                    class="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-accent-cyan text-bg-deep text-sm font-semibold hover:brightness-95 transition min-h-[40px]"
                  >
                    Retry
                  </button>
                </div>
              {:else}
                <!-- idle / cancelled / starting -->
                <button
                  type="button"
                  onclick={() => startOAuth(field)}
                  disabled={oauthState?.phase === 'starting'}
                  class="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-accent-cyan text-bg-deep text-sm font-semibold hover:brightness-95 transition min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {#if oauthState?.phase === 'starting'}
                    <svg
                      viewBox="0 0 24 24"
                      class="w-4 h-4 animate-spin"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <circle cx="12" cy="12" r="10" opacity="0.25" />
                      <path d="M22 12a10 10 0 0 0-10-10" />
                    </svg>
                    Starting…
                  {:else}
                    <svg
                      viewBox="0 0 24 24"
                      class="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M15 3h6v6" />
                      <path d="M10 14L21 3" />
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    </svg>
                    {authActionLabel}
                  {/if}
                </button>
              {/if}
            {:else}
              <input
                id={`ext-field-${field.key}`}
                type={isSecretField(field) ? 'password' : 'text'}
                value={String(values[field.key] ?? '')}
                disabled={lockedByOtherFlow}
                oninput={(e) =>
                  (values = {
                    ...values,
                    [field.key]: (e.currentTarget as HTMLInputElement).value
                  })}
                placeholder={field.placeholder ?? ''}
                autocomplete={isSecretField(field) ? 'new-password' : 'off'}
                class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors min-h-[40px] font-mono disabled:opacity-60 disabled:cursor-not-allowed"
                aria-label={displayFieldLabel(field)}
              />
            {/if}
          </div>
        {/each}

        <div class="pt-3 flex items-center justify-end gap-2 border-t border-border-subtle">
          <button
            type="button"
            onclick={handleClose}
            class="px-4 py-2 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan transition text-sm min-h-[40px]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            class="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-accent-cyan text-bg-deep text-sm font-semibold hover:brightness-95 transition min-h-[40px] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {#if submitting}
              <svg
                viewBox="0 0 24 24"
                class="w-3.5 h-3.5 animate-spin"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <circle cx="12" cy="12" r="10" opacity="0.25" />
                <path d="M22 12a10 10 0 0 0-10-10" />
              </svg>
              Saving…
            {:else}
              Save
            {/if}
          </button>
        </div>
      </form>
    {/if}
  </div>
</div>
