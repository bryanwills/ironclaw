<script lang="ts">
  // Global About dialog. Modal panel with backdrop, ~500px wide, dark
  // surface with cyan border accent. Renders only when the `open` prop is
  // true; the parent layout passes `aboutStore.open` and `aboutStore.close`
  // so the dialog stays decoupled from the store import (caller can pass
  // any open/close pair, e.g. for embedded preview).
  //
  // Sections (top → bottom):
  //   1. Header — IronClaw mark + wordmark + version subtitle.
  //   2. Gateway info (only when connected) — version, engine v2 flag,
  //      LLM model, enabled channels. Pulled on open via gatewayStatus().
  //   3. Profile info — active profile name+mode and total profile count.
  //   4. Local sidecar — surfaces sidecarStatus + port when local mode.
  //   5. System info — platform / arch / display resolution, best-effort.
  //   6. Links — Logs, Settings, GitHub repo, Report an issue.
  //   7. Footer — credits and close button.
  //
  // Esc + backdrop click close. Focus is trapped on the close button on
  // open so Esc works even before the user clicks anywhere.

  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { connection } from '$lib/stores/connection.svelte';
  import { updater } from '$lib/stores/updater.svelte';
  import { inTauriFully } from '$lib/utils/runtime';
  import type { GatewayStatus } from '$lib/api/types';

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  let { open, onclose }: Props = $props();

  // Resolved lazily from Tauri's `app.getVersion()` (which reads
  // src-tauri/Cargo.toml at build time). Outside Tauri (web preview), falls
  // back to the package.json version baked in via Vite's `__APP_VERSION__`.
  let appVersion = $state<string>('—');
  $effect(() => {
    if (!open) return;
    (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        appVersion = await getVersion();
      } catch {
        // Not running inside Tauri; show a hint.
        appVersion = 'dev';
      }
    })();
  });

  const REPO_URL = 'https://github.com/nearai/ironclaw-desktop-app';
  const ISSUES_URL = 'https://github.com/nearai/ironclaw-desktop-app/issues/new';

  // -- Gateway info ----------------------------------------------------------
  // Fetched once each time the dialog transitions from closed → open so the
  // user always sees a fresh snapshot. Failures (offline / no token) fall
  // back to a "Not connected" line rather than spinning forever.

  type GatewayState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ok'; status: GatewayStatus }
    | { kind: 'disconnected' }
    | { kind: 'error'; message: string };

  let gateway = $state<GatewayState>({ kind: 'idle' });
  let lastOpen = false;

  $effect(() => {
    if (open && !lastOpen) {
      lastOpen = true;
      void loadGatewayInfo();
      // Focus the close button on open so Esc works immediately and the
      // dialog announces a stable focus anchor.
      queueMicrotask(() => closeBtn?.focus());
    } else if (!open && lastOpen) {
      lastOpen = false;
    }
  });

  async function loadGatewayInfo() {
    const c = connection.client;
    if (!c || connection.status !== 'connected') {
      gateway = { kind: 'disconnected' };
      return;
    }
    gateway = { kind: 'loading' };
    try {
      const status = await c.gatewayStatus();
      gateway = { kind: 'ok', status };
    } catch (err) {
      gateway = { kind: 'error', message: (err as Error).message };
    }
  }

  // -- Profile info ----------------------------------------------------------

  const activeProfile = $derived(connection.activeProfile);
  const profileCount = $derived(connection.settings.profiles.length);

  // -- Latest release pill ---------------------------------------------------
  // Mirrors the updater store. Four visual states collapse from the seven
  // underlying statuses so the line stays scannable:
  //   available                       → gold pill + "Update available" CTA
  //   up-to-date                      → green dot + "Up to date"
  //   idle | checking                 → muted dot + "Check pending"
  //   downloading | installing | error → muted dot + status word
  // The CTA calls updater.install(), which downloads + writes the bundle;
  // the layout-level UpdaterBanner already handles the restart prompt
  // when status transitions to "installing".

  type ReleasePill =
    | { kind: 'available'; label: 'Update available'; cta: true }
    | { kind: 'up-to-date'; label: 'Up to date'; cta: false }
    | { kind: 'pending'; label: 'Check pending'; cta: false }
    | { kind: 'busy'; label: string; cta: false };

  const releasePill = $derived.by<ReleasePill>(() => {
    switch (updater.status) {
      case 'available':
        return { kind: 'available', label: 'Update available', cta: true };
      case 'up-to-date':
        return { kind: 'up-to-date', label: 'Up to date', cta: false };
      case 'downloading':
        return { kind: 'busy', label: 'Downloading', cta: false };
      case 'installing':
        return { kind: 'busy', label: 'Installing', cta: false };
      case 'error':
        return { kind: 'busy', label: 'Check failed', cta: false };
      case 'checking':
      case 'idle':
      default:
        return { kind: 'pending', label: 'Check pending', cta: false };
    }
  });

  async function installUpdate() {
    await updater.install();
  }

  // -- Sidecar info ----------------------------------------------------------

  const sidecarVisible = $derived(activeProfile?.mode === 'local');
  const sidecarLine = $derived.by(() => {
    const s = connection.sidecarStatus;
    switch (s) {
      case 'running':
        return connection.sidecarPort ? `Running on :${connection.sidecarPort}` : 'Running';
      case 'starting':
        return 'Starting…';
      case 'exited':
        return 'Stopped';
      case 'error':
        return `Error: ${connection.sidecarError ?? 'unknown'}`;
      case 'idle':
      default:
        return 'Not started';
    }
  });

  // -- System info -----------------------------------------------------------
  // Best-effort, no Tauri os-plugin dependency. We parse navigator.userAgent
  // for the platform string, infer the architecture from userAgentData (where
  // available) or from the UA string, and read screen.width/height for the
  // primary display. These are display strings, not used for control flow.

  interface SystemInfo {
    platform: string;
    architecture: string;
    display: string;
  }

  let system = $state<SystemInfo>({
    platform: 'Unknown',
    architecture: 'Unknown',
    display: 'Unknown'
  });

  onMount(() => {
    system = readSystemInfo();
  });

  function readSystemInfo(): SystemInfo {
    if (typeof navigator === 'undefined') {
      return { platform: 'Unknown', architecture: 'Unknown', display: 'Unknown' };
    }
    const ua = navigator.userAgent ?? '';

    // Platform — prefer the modern UA-data hint when present, else parse the
    // UA. We deliberately keep the display loose ("macOS", "Windows") rather
    // than trying to nail down patch versions; the UA's OS version field
    // hasn't been reliable for years.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uaData = (navigator as any).userAgentData;
    let platform: string;
    if (uaData?.platform) {
      platform = uaData.platform;
    } else if (/Mac OS X|Macintosh/.test(ua)) {
      const m = /Mac OS X (\d+)[._](\d+)/.exec(ua);
      platform = m ? `macOS ${m[1]}.${m[2]}` : 'macOS';
    } else if (/Windows NT/.test(ua)) {
      platform = 'Windows';
    } else if (/Linux/.test(ua)) {
      platform = 'Linux';
    } else {
      platform = 'Unknown';
    }

    // Architecture — userAgentData exposes it on Chromium; otherwise we
    // sniff for arm64 or x86_64 markers in the UA string. Fall back to
    // "Unknown" rather than guessing.
    let architecture = 'Unknown';
    if (uaData?.getHighEntropyValues) {
      // Kick off an async refinement; we don't block initial render on it.
      // TODO: await this via a separate $effect when we move to Tauri os
      // plugin so the call site can show a deterministic value.
      uaData
        .getHighEntropyValues(['architecture', 'platformVersion'])
        .then((vals: { architecture?: string; platformVersion?: string }) => {
          const arch = vals.architecture;
          if (arch) {
            system = {
              ...system,
              architecture: arch === 'arm' ? 'arm64' : arch === 'x86' ? 'x86_64' : arch
            };
          }
        })
        .catch(() => {
          // No-op — the synchronous fallback below already populated arch.
        });
    }
    if (/arm64|aarch64/i.test(ua)) {
      architecture = 'arm64';
    } else if (/x86_64|x64|Win64|WOW64/.test(ua)) {
      architecture = 'x86_64';
    }

    // Display — primary monitor only. The Tauri window may not span the
    // whole screen, but this gives the user a useful identification string
    // when filing a layout bug.
    let display = 'Unknown';
    if (typeof window !== 'undefined' && window.screen) {
      const w = window.screen.width;
      const h = window.screen.height;
      if (w && h) display = `${w}x${h}`;
    }

    return { platform, architecture, display };
  }

  // -- Actions ---------------------------------------------------------------

  function goLogs() {
    onclose();
    void goto('/logs');
  }

  function goSettings() {
    onclose();
    void goto('/settings');
  }

  async function openExternal(url: string) {
    // Dynamic-import the shell plugin so the module isn't pulled into
    // dev-shim sessions (R25-1 dogfood). Calling `plugin:shell|open`
    // against the partial `__TAURI_INTERNALS__` shim in `app.html` would
    // log an "unknown cmd" warning on every click — the runtime gate
    // bails out before the import resolves.
    if (!inTauriFully()) {
      console.warn('[about] shellOpen skipped — not running under full Tauri runtime', url);
      return;
    }
    try {
      const { open: shellOpen } = await import('@tauri-apps/plugin-shell');
      await shellOpen(url);
    } catch (err) {
      // The shell plugin throws when the webview isn't running under Tauri
      // (e.g. SvelteKit dev preview in a plain browser). Surface a console
      // hint and no-op — the user can copy the URL from the link's title.
      console.warn('[about] shellOpen failed', err);
    }
  }

  // -- Keyboard --------------------------------------------------------------

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    }
  }

  let closeBtn = $state<HTMLButtonElement | null>(null);

  // -- Backdrop click --------------------------------------------------------

  function onBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }

  // -- Body scroll lock ------------------------------------------------------
  // Stop the page underneath from scrolling while the modal is up. Restored
  // on close + on destroy so a forced unmount (e.g. HMR) doesn't leave the
  // page in a locked state.

  let savedOverflow = '';
  $effect(() => {
    if (typeof document === 'undefined') return;
    if (open) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = savedOverflow;
      };
    }
  });

  onDestroy(() => {
    if (typeof document !== 'undefined') {
      document.body.style.overflow = savedOverflow;
    }
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh] bg-black/65 backdrop-blur-sm"
    onclick={onBackdropClick}
    onkeydown={onKeyDown}
    role="presentation"
  >
    <div
      class="w-[500px] max-w-[94vw] max-h-[80vh] flex flex-col bg-bg-deep border border-accent-cyan/40 rounded-xl shadow-2xl overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-dialog-title"
    >
      <!-- Header -->
      <header class="flex items-start gap-3 px-5 py-4 border-b border-border-subtle relative">
        <svg
          viewBox="0 0 24 24"
          class="w-8 h-8 text-accent-cyan shrink-0 mt-0.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="M4 7l8-4 8 4-8 4-8-4z" stroke-linejoin="round" />
          <path d="M4 12l8 4 8-4" stroke-linejoin="round" />
          <path d="M4 17l8 4 8-4" stroke-linejoin="round" />
        </svg>
        <div class="flex-1 min-w-0">
          <h1
            id="about-dialog-title"
            class="text-base font-semibold tracking-tight text-accent-cyan"
          >
            IronClaw Desktop
          </h1>
          <p class="text-xs text-text-muted font-mono mt-0.5">v{appVersion}</p>
        </div>
        <button
          bind:this={closeBtn}
          type="button"
          onclick={onclose}
          class="absolute top-3 right-3 p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface transition focus:outline-none focus:ring-1 focus:ring-accent-cyan"
          aria-label="Close About dialog"
        >
          <svg
            viewBox="0 0 24 24"
            class="w-4 h-4"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <!-- Body -->
      <div class="flex-1 overflow-y-auto px-5 py-4 space-y-5 text-xs">
        <!-- Latest release -->
        <section aria-labelledby="about-release-heading">
          <h2
            id="about-release-heading"
            class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold"
          >
            Latest release
          </h2>
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-text-primary font-mono">v{appVersion}</span>
              {#if releasePill.kind === 'up-to-date'}
                <span
                  class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                  data-testid="about-release-pill"
                >
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-400" aria-hidden="true"></span>
                  {releasePill.label}
                </span>
              {:else if releasePill.kind === 'pending'}
                <span
                  class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-text-muted/10 text-text-muted border border-border-subtle"
                  data-testid="about-release-pill"
                >
                  <span class="w-1.5 h-1.5 rounded-full bg-text-muted/60" aria-hidden="true"></span>
                  {releasePill.label}
                </span>
              {:else if releasePill.kind === 'busy'}
                <span
                  class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-text-muted/10 text-text-muted border border-border-subtle"
                  data-testid="about-release-pill"
                >
                  <span class="w-1.5 h-1.5 rounded-full bg-text-muted/60" aria-hidden="true"></span>
                  {releasePill.label}
                </span>
              {/if}
            </div>
            {#if releasePill.cta}
              <button
                type="button"
                onclick={() => void installUpdate()}
                class="px-2.5 py-1 rounded-md text-[11px] font-medium bg-accent-gold/15 text-accent-gold border border-accent-gold/40 hover:bg-accent-gold/25 transition"
                data-testid="about-release-install"
              >
                Update
              </button>
            {/if}
          </div>
        </section>

        <!-- Gateway -->
        <section aria-labelledby="about-gateway-heading">
          <h2
            id="about-gateway-heading"
            class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold"
          >
            Gateway
          </h2>
          {#if gateway.kind === 'loading'}
            <p class="text-text-muted font-mono">Loading…</p>
          {:else if gateway.kind === 'disconnected'}
            <p class="text-text-muted font-mono">Not connected</p>
          {:else if gateway.kind === 'error'}
            <p class="text-red-300 font-mono break-words">
              Error: {gateway.message}
            </p>
          {:else if gateway.kind === 'ok'}
            {@const s = gateway.status}
            <dl class="space-y-1.5">
              <div class="flex justify-between gap-3">
                <dt class="text-text-muted">Version</dt>
                <dd class="text-text-primary font-mono text-right break-all">
                  {s.version ? `v${s.version}` : '—'}
                </dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-text-muted">Engine v2</dt>
                <dd class="text-text-primary font-mono">
                  {s.engine_v2_enabled === undefined
                    ? '—'
                    : s.engine_v2_enabled
                      ? 'enabled'
                      : 'disabled'}
                </dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-text-muted">LLM model</dt>
                <dd class="text-text-primary font-mono text-right break-all">
                  {s.llm_model ?? '—'}
                </dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-text-muted">Enabled channels</dt>
                <dd class="text-text-primary font-mono text-right break-all">
                  {s.enabled_channels.length > 0 ? s.enabled_channels.join(', ') : '—'}
                </dd>
              </div>
            </dl>
          {/if}
        </section>

        <!-- Profile -->
        <section aria-labelledby="about-profile-heading">
          <h2
            id="about-profile-heading"
            class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold"
          >
            Profile
          </h2>
          <dl class="space-y-1.5">
            <div class="flex justify-between gap-3">
              <dt class="text-text-muted">Active</dt>
              <dd class="text-text-primary font-mono text-right break-all">
                {#if activeProfile}
                  {activeProfile.name} <span class="text-text-muted">({activeProfile.mode})</span>
                {:else}
                  —
                {/if}
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-text-muted">Profiles configured</dt>
              <dd class="text-text-primary font-mono">{profileCount}</dd>
            </div>
          </dl>
        </section>

        <!-- Sidecar (local mode only) -->
        {#if sidecarVisible}
          <section aria-labelledby="about-sidecar-heading">
            <h2
              id="about-sidecar-heading"
              class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold"
            >
              Local sidecar
            </h2>
            <dl class="space-y-1.5">
              <div class="flex justify-between gap-3">
                <dt class="text-text-muted">Status</dt>
                <dd class="text-text-primary font-mono text-right break-all">
                  {sidecarLine}
                </dd>
              </div>
            </dl>
          </section>
        {/if}

        <!-- System -->
        <section aria-labelledby="about-system-heading">
          <h2
            id="about-system-heading"
            class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold"
          >
            System
          </h2>
          <dl class="space-y-1.5">
            <div class="flex justify-between gap-3">
              <dt class="text-text-muted">Platform</dt>
              <dd class="text-text-primary font-mono text-right break-all">
                {system.platform}
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-text-muted">Architecture</dt>
              <dd class="text-text-primary font-mono text-right">
                {system.architecture}
              </dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-text-muted">Display</dt>
              <dd class="text-text-primary font-mono text-right">
                {system.display}
              </dd>
            </div>
          </dl>
        </section>

        <!-- Links -->
        <section aria-labelledby="about-links-heading">
          <h2
            id="about-links-heading"
            class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold"
          >
            Links
          </h2>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              onclick={goLogs}
              class="px-2.5 py-1.5 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-text-muted transition text-xs"
            >
              View logs
            </button>
            <button
              type="button"
              onclick={goSettings}
              class="px-2.5 py-1.5 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-text-muted transition text-xs"
            >
              Open settings
            </button>
            <button
              type="button"
              onclick={() => void openExternal(REPO_URL)}
              class="px-2.5 py-1.5 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-text-muted transition text-xs"
              title={REPO_URL}
            >
              GitHub repository
            </button>
            <button
              type="button"
              onclick={() => void openExternal(ISSUES_URL)}
              class="px-2.5 py-1.5 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-text-muted transition text-xs"
              title={ISSUES_URL}
            >
              Report an issue
            </button>
          </div>
        </section>
      </div>

      <!-- Footer -->
      <footer
        class="px-5 py-3 border-t border-border-subtle text-[11px] text-text-muted/80 leading-relaxed"
      >
        Tauri v2, Svelte 5, Tailwind. Markdown via marked + DOMPurify. Auth via macOS Keychain. ©
        2026 Abhishek Vaidyanathan &amp; NEAR AI.
      </footer>
    </div>
  </div>
{/if}
