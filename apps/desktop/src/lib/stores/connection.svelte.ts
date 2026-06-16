// Connection state for the configured IronClaw gateway.
//
// Uses Svelte 5 runes. The single global instance is consumed by the
// sidebar pill, the settings page, and the chat surface.
//
// Two modes share this store, per-profile:
//   - remote : talks to a Caddy-fronted IronClaw on a remote host.
//   - local  : spawns the bundled sidecar via Tauri, then talks to it on
//              127.0.0.1:<auto-picked-port> using an auto-generated bearer.
//
// Profile-aware: the active profile (selected via `setActiveProfile`)
// drives `baseUrl`, token lookups, and OpenRouter-key scoping. Switching
// profiles via `switchProfile(id)` tears down the previous connection
// (and the sidecar, if applicable) before reconnecting against the new
// profile's settings.
//
// Multi-window: if the window was opened via the `open_profile_window`
// command, a `?profile=<id>` query param tells this store to pin the
// window to that profile *without* mutating the persisted
// `activeProfileId` — each window has its own profile context so a
// "work" and "personal" pair can run side-by-side.

import { invoke } from '@tauri-apps/api/core';
import { IronClawClient } from '$lib/api/ironclaw';
import { effectiveDefaultModelForProvider } from '$lib/data/llm-defaults';
import { diagEnabled, inTauri } from '$lib/utils/runtime';
import { notifications } from './notifications.svelte';
import { telemetry } from './telemetry.svelte';
import {
  DEFAULT_SETTINGS,
  getActiveProfile,
  getOrCreateLocalToken,
  getToken,
  loadSettings,
  resolveTint,
  setActiveProfile,
  sidecarStatus as readSidecarStatus,
  startSidecar,
  stopSidecar,
  type ApiVersion,
  type AppSettings,
  type ProfileConfig
} from './settings.svelte';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

/** Lifecycle of the bundled sidecar (only relevant when mode === 'local'). */
export type SidecarStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error';

const HEALTH_INTERVAL_MS = 30_000;

type ConnectionFailureContext =
  | { kind: 'missing-token' }
  | { kind: 'health'; status: string | null | undefined }
  | { kind: 'error'; error: unknown; baseUrl: string; mode: ProfileConfig['mode'] };

function classifyConnectionFailure(ctx: ConnectionFailureContext): string {
  if (ctx.kind === 'missing-token') {
    return 'No access token — paste your token in Settings.';
  }

  const detail = ctx.kind === 'health' ? (ctx.status ?? '') : describeFailure(ctx.error);
  const original =
    ctx.kind === 'health'
      ? `Health check returned status="${ctx.status ?? 'unknown'}"`
      : cleanFailureMessage(detail || 'Unknown connection error');
  const normalized = `${detail} ${ctx.kind === 'error' ? ctx.baseUrl : ''}`.toLowerCase();
  const httpStatus = ctx.kind === 'error' ? numericFailureStatus(ctx.error) : null;
  const localContext =
    ctx.kind === 'error' && (ctx.mode === 'local' || isLocalGatewayUrl(ctx.baseUrl));

  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    /\b(401|403)\b/.test(normalized) ||
    /\b(unauthori[sz]ed|forbidden|authentication required|invalid token|bad token)\b/.test(
      normalized
    )
  ) {
    return 'Authentication required — sign in to NEAR.AI or check your token.';
  }

  if (httpStatus === 404 || /\b404\b/.test(normalized) || /\bnot found\b/.test(normalized)) {
    return 'Endpoint not found — check the gateway URL and API version (v2 vs v1).';
  }

  if (
    /\b(invalid url|failed to parse url|url parse|certificate|cert_|cert\b|tls|ssl|self-signed|self signed)\b/.test(
      normalized
    )
  ) {
    return "Couldn't reach that URL. Check the address (must be https for remote).";
  }

  if (
    /\b(econnrefused|connection refused)\b/.test(normalized) ||
    (localContext && /\b(fetch failed|failed to fetch)\b/.test(normalized))
  ) {
    return "Local IronClaw isn't running. Start it in Settings, or re-run onboarding.";
  }

  if (
    /\b(timeout|timed out|aborterror|aborted|networkerror|network error|network|enotfound|eai_again|econnreset|econnaborted|etimedout|fetch failed|failed to fetch)\b/.test(
      normalized
    )
  ) {
    return 'Connection timed out. Check your network and the gateway.';
  }

  return cleanFailureMessage(original);
}

function describeFailure(value: unknown, depth = 0): string {
  if (depth > 2 || value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Error || typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts = value instanceof Error ? [value.name, value.message] : [];
    const keys =
      value instanceof Error
        ? ['code', 'status', 'statusText', 'url']
        : ['name', 'message', 'code', 'status', 'statusText', 'url'];
    for (const key of keys) {
      const field = record[key];
      if (typeof field === 'string' || typeof field === 'number') {
        parts.push(String(field));
      }
    }
    parts.push(describeFailure(record.cause, depth + 1));
    return parts.filter(Boolean).join(' ');
  }
  return '';
}

function numericFailureStatus(value: unknown): number | null {
  if (value == null || typeof value !== 'object') return null;
  const status = (value as Record<string, unknown>).status;
  return typeof status === 'number' ? status : null;
}

function cleanFailureMessage(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return firstLine.replace(/^[A-Za-z]*Error:\s*/, '').replace(/\s+/g, ' ') || 'Connection failed';
}

function isLocalGatewayUrl(rawUrl: string): boolean {
  try {
    const { hostname } = new URL(rawUrl);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return /\b(localhost|127\.0\.0\.1|\[::1\]|::1)\b/i.test(rawUrl);
  }
}

class ConnectionStore {
  status = $state<ConnectionStatus>('idle');
  settings = $state<AppSettings>({ ...DEFAULT_SETTINGS });
  token = $state<string | null>(null);
  /** Human-readable error message when status === 'error'. */
  lastError = $state<string | null>(null);
  /**
   * Runtime capability of the active gateway's Reborn WebChat v2 routes.
   * `engine_v2_enabled` is not enough: older local gateways can expose Engine
   * v2 while `/api/webchat/v2/*` still 404s. Chat routing consumes this field
   * so a configured/default v2 profile falls back to the legacy chat surface
   * instead of rendering an empty/broken Reborn panel.
   */
  webChatV2Available = $state<boolean | null>(null);

  /** Local sidecar lifecycle (irrelevant in remote mode; stays 'idle'). */
  sidecarStatus = $state<SidecarStatus>('idle');
  sidecarPort = $state<number | null>(null);
  sidecarError = $state<string | null>(null);

  /**
   * Per-window profile pin. Populated on init() from the `?profile=<id>`
   * query parameter when the window was opened via the multi-window
   * command (`open_profile_window`). When non-null:
   *   - `activeProfile` resolves via this id instead of
   *     `settings.activeProfileId`.
   *   - `switchProfile()` updates this field instead of persisting to
   *     settings.json, so other windows aren't affected.
   * The main window leaves this null and keeps the original
   * persisted-active-profile UX.
   */
  windowProfileOverride = $state<string | null>(null);

  private timer: ReturnType<typeof setInterval> | null = null;
  initialized = $state(false);
  /** In-flight `init()` promise. Cached so concurrent callers from the
   *  layout root, the sidebar, the status bar, and the chat surface
   *  dedupe to ONE initialization AND every caller awaits the same
   *  resolution. Without this, the second caller's `await init()`
   *  resolves before `loadSettings()` has fired — observing the
   *  DEFAULT_SETTINGS placeholder (onboardingComplete: false) instead
   *  of the persisted shape on disk. R29a per CHANGELOG. */
  private initPromise: Promise<void> | null = null;
  /** Last status pushed to the menu-bar tray. Tracked so we only fire
   *  the `update_tray_status` IPC on a real transition, not on every
   *  effect re-run (Svelte may re-evaluate effects when unrelated deps
   *  read the same store). */
  private lastTrayStatus: ConnectionStatus | null = null;

  constructor() {
    // Push connection status into the menu-bar tray icon whenever it
    // changes. Lives inside an `$effect.root` so the IPC fires from
    // whatever surface first mounts the store — no manual subscription
    // bookkeeping. The Rust side maps "error" → disconnected glyph, so
    // we forward the raw status string verbatim.
    //
    // Gated on `inTauri()` (shared helper from $lib/utils/runtime) so
    // browser preview / vitest runs skip the tray IPC entirely. The
    // dev-only shim in `app.html` mocks `update_tray_status` to a no-op
    // resolve, so passing this gate against the shim is safe; the
    // tray-listener side (tray.svelte.ts) uses the stricter
    // `inTauriFully()` because plugin calls need the real dispatcher.
    if (inTauri()) {
      $effect.root(() => {
        $effect(() => {
          const s = this.status;
          if (s === this.lastTrayStatus) return;
          this.lastTrayStatus = s;
          // Errors here are non-fatal — the tray is a status display, not
          // a critical path. Log and move on so a missing tray (e.g. the
          // user hid it via /settings) never breaks the connection layer.
          invoke('update_tray_status', { status: s }).catch((err) => {
            console.warn('update_tray_status failed', err);
          });
        });
      });
    }

    // Per-profile accent-color override. Runs in every webview (Tauri or
    // SSR/dev) — the only gate is `document` being available, since the
    // mechanism is `documentElement.style.setProperty`. When the active
    // profile carries a `tint`, we paint the four `--v2-accent*` CSS
    // variables on the root element so any consumer reading them (sidebar
    // brand glyph, status-bar dot, accent-blue surfaces in app.css) picks
    // the override up without per-component plumbing.
    //
    // Tracks the last applied tint so we only mutate the DOM on a real
    // change (the effect re-runs whenever any read inside it does — e.g.
    // active-profile pivots or settings reloads).
    if (typeof document !== 'undefined') {
      $effect.root(() => {
        $effect(() => {
          // Trigger reactivity on tint AND on identity flips — a profile
          // switch keeps tint stable but should still re-apply in case the
          // old window owned a different palette.
          const tintKey = this.activeProfile.tint ?? 'signal';
          if (tintKey === this.lastAppliedTint) return;
          this.lastAppliedTint = tintKey;
          const palette = resolveTint(this.activeProfile.tint);
          const root = document.documentElement;
          root.style.setProperty('--v2-accent', palette.accent);
          root.style.setProperty('--v2-accent-strong', palette.strong);
          root.style.setProperty('--v2-accent-soft', palette.soft);
          root.style.setProperty('--v2-accent-text', palette.text);
        });
      });
    }
  }

  /** Last tint key written to the document root. Tracked so the $effect
   *  only mutates the DOM on a real change (Svelte may re-evaluate
   *  effects when unrelated deps read the same store). */
  private lastAppliedTint: string | null = null;

  /**
   * Update `sidecarStatus` and fire a desktop notification when the
   * sidecar transitions from `running` into an unexpected terminal state
   * (`exited` or `error`). We only notify in local mode — remote-mode
   * profiles never spawn a sidecar, so a stuck status there shouldn't
   * surface as an alert.
   *
   * User-initiated stops go through `stopSidecar()` which sets the
   * status to `idle`, so this helper deliberately ignores `idle` to
   * avoid notifying on intentional shutdowns.
   */
  private setSidecarStatus(next: SidecarStatus): void {
    const prev = this.sidecarStatus;
    this.sidecarStatus = next;
    const unexpected = next === 'exited' || next === 'error';
    if (
      prev === 'running' &&
      unexpected &&
      this.activeProfile.mode === 'local' &&
      notifications.enabled &&
      notifications.sidecarEvents
    ) {
      const body = this.sidecarError ?? 'Sidecar exited unexpectedly';
      void notifications.notify({
        title: 'IronClaw sidecar stopped',
        body,
        category: 'sidecar'
      });
    }
  }

  /** Active profile derived from current settings — kept as a `$derived` so
   *  callers can read it reactively (the Sidebar profile picker does).
   *
   *  When `windowProfileOverride` is set (i.e. this window was opened via
   *  `open_profile_window`), the override id wins over the persisted
   *  `activeProfileId`. Falls back to the persisted id, then to the first
   *  profile, so even a stale override (profile deleted in another
   *  window) gracefully resolves rather than crashing. */
  activeProfile = $derived<ProfileConfig>(
    (this.windowProfileOverride
      ? this.settings.profiles.find((p) => p.id === this.windowProfileOverride)
      : undefined) ??
      this.settings.profiles.find((p) => p.id === this.settings.activeProfileId) ??
      this.settings.profiles[0]
  );

  /** Active base URL based on the active profile's mode. */
  baseUrl = $derived(
    this.activeProfile.mode === 'local'
      ? this.sidecarPort
        ? `http://127.0.0.1:${this.sidecarPort}`
        : this.activeProfile.localBaseUrl
      : this.activeProfile.remoteBaseUrl
  );

  /**
   * Effective chat API contract. Profiles may request v2, but the live gateway
   * must also expose the WebChat v2 routes; if the probe says no, use v1 so
   * existing conversations and sends continue to work.
   */
  apiVersion = $derived<ApiVersion>(
    this.activeProfile.apiVersion === 'v1' ? 'v1' : this.webChatV2Available === false ? 'v1' : 'v2'
  );

  /** True when a v2/default profile is being kept on legacy chat because the
   *  gateway does not expose `/api/webchat/v2/*`. */
  webChatV2FallbackActive = $derived(
    this.activeProfile.apiVersion !== 'v1' && this.webChatV2Available === false
  );

  /**
   * Configured client, or null if we don't have a token yet.
   * Anyone using `client` must handle the null case.
   */
  client = $derived<IronClawClient | null>(
    this.token ? new IronClawClient({ baseUrl: this.baseUrl, token: this.token }) : null
  );

  /** Load settings + token and start the health-poll loop. Safe to call
   *  repeatedly — concurrent callers await the SAME in-flight promise so
   *  they all observe the loaded settings on resolve (not the
   *  DEFAULT_SETTINGS placeholder). */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        this.settings = await loadSettings();
        // Pick up a `?profile=<id>` query param if this window was opened
        // via the multi-window command. We only honour it when the id
        // matches a real profile — a stale or hand-crafted override
        // silently falls through to the persisted active profile so the
        // UI never ends up rendering an empty active-profile slot.
        this.windowProfileOverride = this.readProfileOverrideFromUrl();
        await this.applyModeAndConnect({ allowAutoStart: true });
        this.initialized = true;
      } finally {
        // Clear the cache regardless of success/failure. On failure a
        // subsequent caller can retry from scratch; on success the
        // `initialized` short-circuit above keeps re-entry cheap.
        this.initPromise = null;
      }
    })();
    return this.initPromise;
  }

  /**
   * Parse `?profile=<id>` from the current window URL. Returns the id
   * iff it (a) is present and (b) matches one of the configured
   * profiles. Otherwise null. Pure — no IPC; safe to call before
   * `loadSettings()` resolves (the matcher just returns null then).
   */
  private readProfileOverrideFromUrl(): string | null {
    if (typeof window === 'undefined' || !window.location?.search) return null;
    try {
      const params = new URLSearchParams(window.location.search);
      const id = params.get('profile');
      if (!id) return null;
      // Only honour ids that actually map to a profile. Anything else is
      // a no-op so a bad query param doesn't desync the UI.
      return this.settings.profiles.some((p) => p.id === id) ? id : null;
    } catch {
      return null;
    }
  }

  /** Re-load settings + token after the user changes them in /settings. */
  async refresh() {
    this.settings = await loadSettings();
    // If the active profile is remote, tear down anything tied to a
    // previous local mode (sidecar). For remote→local we let
    // applyModeAndConnect drive the spawn.
    if (this.activeProfile.mode === 'remote') {
      await this.shutdownSidecarSilently();
    }
    await this.applyModeAndConnect({ allowAutoStart: true });
  }

  /**
   * Lightweight settings reload — no reconnect, no sidecar churn. Used
   * by surfaces that mutate a cosmetic field (e.g. profile `tint`) and
   * need the connection store's view of `settings` to update so dependent
   * `$effect`s (the CSS-variable accent painter) re-run. Avoids the full
   * `refresh()` path which would re-ping the gateway / reconcile the
   * sidecar lifecycle for what is purely a UI change.
   *
   * Also the cross-window sync entry point. When another window calls
   * `saveSettings(...)`, the `broadcast` store dispatches a
   * `settings-changed` message into here so this window's
   * `connection.settings` rune picks up the on-disk change. We
   * deliberately use this lightweight path (not `refresh()`) so a
   * cosmetic change in window A does not bounce window B's gateway
   * connection or sidecar lifecycle. Other broadcast kinds —
   * `connection-event` and `sidecar-status` — are intentionally NOT
   * mirrored here: each window owns its own gateway/sidecar context
   * and observing a peer's transient state would only confuse the UI.
   */
  async reloadSettings(): Promise<void> {
    this.settings = await loadSettings();
  }

  /**
   * Switch the active profile and reconnect. In a default window this
   * persists `activeProfileId` so other surfaces (Sidebar dropdown,
   * Settings page) see the change immediately. In a profile-pinned
   * window (opened via `open_profile_window` with `?profile=`) the
   * switch updates the local `windowProfileOverride` only — settings.json
   * is left alone so the main window and other pinned windows keep their
   * own contexts.
   */
  async switchProfile(id: string): Promise<void> {
    if (this.activeProfile.id === id) return;
    if (this.windowProfileOverride !== null) {
      // Validate the target id exists; ignore unknown ids the same way
      // setActiveProfile would throw.
      if (!this.settings.profiles.some((p) => p.id === id)) {
        throw new Error(`switchProfile: unknown profile id ${id}`);
      }
      this.windowProfileOverride = id;
    } else {
      await setActiveProfile(id);
    }
    // Always tear the sidecar down on a profile switch — even if the new
    // profile is local-mode it may want a different LLM backend or
    // OpenRouter key, and the cleanest path is a fresh spawn.
    await this.shutdownSidecarSilently();
    await this.refresh();
  }

  /**
   * Manually start (or restart) the local sidecar. Surfaces errors to the
   * `sidecarError` field; doesn't throw. The backend is read from the
   * active profile's `llmBackend` (defaults to NEAR.AI Cloud).
   */
  async startSidecar(): Promise<boolean> {
    this.setSidecarStatus('starting');
    this.sidecarError = null;
    try {
      const profile = this.activeProfile;
      // Forward both the legacy backend tag and the new provider id so
      // the Rust side can prefer the richer field when present and fall
      // back to the binary enum otherwise.
      const port = await startSidecar(
        profile.id,
        profile.llmBackend,
        profile.llmProviderId,
        profile.llmModelId ??
          effectiveDefaultModelForProvider(profile.llmProviderId ?? profile.llmBackend)
      );
      this.sidecarPort = port;
      this.setSidecarStatus('running');
      // Opt-in telemetry — `provider` is the identifier the user
      // picked (NEAR.AI, OpenRouter, etc) so we can chart adoption
      // across the four wired backends. No api keys, no port.
      telemetry.recordEvent('sidecar:started', {
        provider: profile.llmProviderId ?? profile.llmBackend ?? 'unknown'
      });
      // Rebind the token to the auto-generated local bearer (global,
      // not per-profile — there's one sidecar per install).
      this.token = await getOrCreateLocalToken();
      this.stopPolling();
      await this.ping();
      this.startPolling();
      return true;
    } catch (err) {
      this.sidecarError = (err as Error).message;
      // setSidecarStatus reads `sidecarError` to populate the
      // notification body — assign before the status flip.
      this.setSidecarStatus('error');
      this.sidecarPort = null;
      this.status = 'error';
      this.lastError = this.sidecarError;
      // Opt-in telemetry — we never put the raw error message on the
      // wire (could include filesystem paths or env content). Just a
      // count + the provider so we can chart failure rates per
      // backend.
      telemetry.recordEvent('sidecar:failed', {
        provider: this.activeProfile.llmProviderId ?? this.activeProfile.llmBackend ?? 'unknown'
      });
      return false;
    }
  }

  /** Manually stop the local sidecar. */
  async stopSidecar(): Promise<void> {
    this.stopPolling();
    await this.shutdownSidecarSilently();
    this.setSidecarStatus('idle');
    this.sidecarPort = null;
    this.status = 'disconnected';
  }

  /** One-shot health check; updates status. Returns true on success. */
  async ping(): Promise<boolean> {
    if (!this.client) {
      this.webChatV2Available = null;
      this.status = 'disconnected';
      if (this.activeProfile.mode === 'remote' && !this.token) {
        this.lastError = classifyConnectionFailure({ kind: 'missing-token' });
      }
      return false;
    }
    this.status = this.status === 'connected' ? 'connected' : 'connecting';
    try {
      const h = await this.client.health();
      if (h.ok) {
        this.webChatV2Available = await this.client.probeWebChatV2();
        this.status = 'connected';
        this.lastError = null;
        return true;
      }
      this.webChatV2Available = null;
      this.status = 'error';
      this.lastError = classifyConnectionFailure({ kind: 'health', status: h.status });
      return false;
    } catch (err) {
      this.webChatV2Available = null;
      this.status = 'error';
      this.lastError = classifyConnectionFailure({
        kind: 'error',
        error: err,
        baseUrl: this.baseUrl,
        mode: this.activeProfile.mode
      });
      return false;
    }
  }

  startPolling() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.ping();
    }, HEALTH_INTERVAL_MS);
  }

  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ---- internals ---------------------------------------------------------

  /**
   * Reconcile the current connection with the active profile's `mode`. In
   * local mode, auto-starts the sidecar when credentials allow (caller may
   * disable via `allowAutoStart: false` if it owns the lifecycle).
   */
  private async applyModeAndConnect(opts: { allowAutoStart: boolean }) {
    this.stopPolling();
    this.webChatV2Available = null;
    const profile = this.activeProfile;
    if (profile.mode === 'local') {
      // First, check whether a sidecar is already running from a prior
      // session (Tauri keeps the SidecarState alive for the app's lifetime,
      // so we only re-spawn if not already up).
      const st = await readSidecarStatus();
      if (st.running && st.port) {
        this.sidecarPort = st.port;
        this.setSidecarStatus('running');
        this.token = await getOrCreateLocalToken();
        await this.ping();
        this.startPolling();
        return;
      }
      // Auto-start only once onboarding is complete. Before that, the
      // onboarding wizard owns the first sidecar launch — auto-starting
      // here can burn first-run boot time inside sidecar/Keychain
      // failures (and a hidden macOS ACL prompt) before the user has even
      // chosen Local vs Hosted. (Codex audit P1.)
      if (opts.allowAutoStart && this.settings.onboardingComplete) {
        await this.startSidecar();
      } else {
        this.setSidecarStatus('idle');
        this.sidecarPort = null;
        this.token = null;
        this.status = 'disconnected';
      }
      return;
    }

    // Remote mode — load the stored bearer for this profile and ping.
    this.token = await getToken(profile.id);
    // Side-channel to Rust stderr so we can see prod state without devtools.
    // Gated on diagEnabled() so release builds stay quiet unless the user
    // opts in via Settings → Debug mode.
    if (diagEnabled()) {
      try {
        // @ts-expect-error — Tauri global available at runtime
        await window.__TAURI_INTERNALS__?.invoke?.('diag_log', {
          msg: `applyModeAndConnect remote: token=${this.token ? `len${this.token.length}` : 'null'} baseUrl=${this.baseUrl} hasClient=${!!this.client}`
        });
      } catch (_) {}
    }
    if (this.client) {
      await this.ping();
      this.startPolling();
    } else {
      this.status = 'disconnected';
      this.lastError = classifyConnectionFailure({ kind: 'missing-token' });
    }
  }

  /** Best-effort sidecar teardown — never throws. */
  private async shutdownSidecarSilently() {
    try {
      await stopSidecar();
    } catch (err) {
      console.warn('stopSidecar failed', err);
    }
    this.setSidecarStatus('idle');
    this.sidecarPort = null;
  }
}

/** Global singleton — import this anywhere. */
export const connection = new ConnectionStore();

// Re-export so legacy callers that imported `getActiveProfile` from the
// connection module still work. Most call sites should pull from
// settings.svelte directly.
export { getActiveProfile };
