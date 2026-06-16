<!--
  StatusBar.svelte — slim bottom bar that surfaces at-a-glance
  state without forcing the user to navigate to a specific page.

  Three sections:
    - Left:    profile name + mode badge (Remote/Local) + runner port if
               local. Clicking the section navigates to /settings (the
               profile section is the default landing on that page).
    - Center:  LLM provider id. Clicks /settings#provider.
    - Right:   Live indicators — job queue depth (running + pending,
               gold when >0), rolling 30-day token usage (admin-only,
               hidden otherwise), and the last health-ping latency in ms.
               Clicks /jobs.

  Self-contained polling:
    - Jobs summary every 30s when connected.
    - Usage summary every 5 minutes when connected (cached, hidden if
      unavailable — `getUsageSummary` returns null on non-admin tokens).
    - Latency measured by timing `client.health()` on each poll tick
      (30s cadence shared with the jobs poll).

  Compact mode kicks in below 900px viewport — we hide everything except
  the profile name + the connection dot. The threshold is observed via
  `window.matchMedia('(max-width: 899px)')` so resizes update reactively.

  Disconnected state replaces the live values with a single "Disconnected"
  link to /settings. Runner-idle (local mode, not started) surfaces a
  "Start" affordance inline.

  Visibility:
    - Cmd+/ (or Ctrl+/ on non-mac) toggles the bar from the layout.
    - Persistence is via `localStorage.ironclaw-statusbar-visible`; the
      layout reads the key on mount, so the very first paint already
      respects the saved preference.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { connection } from '$lib/stores/connection.svelte';
  import { resolveTint } from '$lib/stores/settings.svelte';

  type Props = {
    /** When false the bar renders nothing. Owned by the layout (Cmd+/). */
    visible?: boolean;
  };

  let { visible = true }: Props = $props();

  // ---- Compact mode (<900px) -------------------------------------------
  // Use a media-query listener so resizes flip the layout reactively. We
  // initialize from window in onMount-equivalent (lazy in $effect) so the
  // SSR-safe default is "not compact" — the desktop window is always
  // wider than 900px on first paint anyway.
  let compact = $state(false);
  $effect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 899px)');
    compact = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      compact = e.matches;
    };
    // Older Safari only ships `addListener`/`removeListener`; modern
    // browsers expose `addEventListener` on MediaQueryList. We use the
    // modern API — Tauri's webview is always recent enough.
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  });

  // ---- Live state ------------------------------------------------------
  let jobsRunning = $state(0);
  let jobsPending = $state(0);
  let tokens30d = $state<number | null>(null);
  let latencyMs = $state<number | null>(null);
  let usageHidden = $state(false);

  /** Queue depth shown in the right cell. Running + pending captures
   *  the "stuff currently in flight" the user actually cares about; we
   *  deliberately exclude completed / failed buckets which aren't an
   *  attention signal. */
  const jobDepth = $derived(jobsRunning + jobsPending);

  // Cache window for the (potentially admin-only) usage summary call. The
  // spec asks for 5-minute caching; we track the last successful fetch
  // and skip subsequent attempts until the window elapses. A `null`
  // result from the API marks usage as unavailable for this profile,
  // and we keep the field hidden until the next reconnect / profile
  // switch (which clears `lastUsageFetch` via the effect below).
  let lastUsageFetch = $state(0);
  const USAGE_TTL_MS = 5 * 60 * 1000;
  const POLL_INTERVAL_MS = 30_000;

  // Whether the active profile + connection are healthy enough that we
  // should attempt live polls. We treat anything other than `connected`
  // as offline for status-bar purposes (the user will already see a
  // banner / sidebar dot for connecting / error states).
  const isConnected = $derived(connection.status === 'connected');

  // Local-runner convenience flags. Local mode + idle status surfaces
  // the "Start" affordance; the spec calls for this inline action so
  // the user can wake the runner without leaving the bar.
  const isLocal = $derived(connection.activeProfile.mode === 'local');
  const sidecarIdle = $derived(
    isLocal && (connection.sidecarStatus === 'idle' || connection.sidecarStatus === 'exited')
  );
  const sidecarStarting = $derived(connection.sidecarStatus === 'starting');

  /** Mode badge label — short for the compact bar. */
  const modeBadge = $derived(connection.activeProfile.mode === 'local' ? 'Local' : 'Remote');

  /** Accent hex for the active profile's tint — drives the profile dot
   *  when connected so the bar visually echoes whichever window-tint the
   *  user picked. Falls back to the design-system signal blue when the
   *  profile has no override (i.e. `tint: undefined`). */
  const tintHex = $derived(resolveTint(connection.activeProfile.tint).accent);

  /** Human-friendly provider label. The wire field is a free-form id
   *  (`nearai`, `openrouter`, `ollama`, ...); the most common two get
   *  proper casing, everything else round-trips verbatim so a custom
   *  registry entry still reads sensibly. */
  const providerLabel = $derived.by(() => {
    const id =
      connection.activeProfile.llmProviderId ?? connection.activeProfile.llmBackend ?? 'nearai';
    if (id === 'nearai') return 'NEAR.AI';
    if (id === 'openrouter') return 'OpenRouter';
    return id;
  });

  /** Compact format for the token-count figure (e.g. 12.4K). */
  function fmtTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

  // ---- Polling ---------------------------------------------------------
  // We run our own poll loop (separate from the connection store's
  // health-ping cadence) because the status bar wants:
  //   - jobs summary every 30s,
  //   - latency measured per poll,
  //   - usage summary every 5 minutes (admin-only; null = hidden).
  //
  // The poller no-ops while disconnected — flips back on automatically
  // via the $effect dependency on `isConnected`.
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function pollOnce(): Promise<void> {
    const client = connection.client;
    if (!client || !isConnected) return;

    // Latency: time a health round-trip. Errors get a null so the cell
    // renders "—" rather than a stale value.
    const t0 =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    try {
      await client.health();
      const t1 =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      latencyMs = Math.max(0, Math.round(t1 - t0));
    } catch {
      latencyMs = null;
    }

    // Jobs depth.
    try {
      const s = await client.jobsSummary();
      jobsRunning = s.in_progress;
      jobsPending = s.pending;
    } catch {
      // Keep last-known values; transient errors shouldn't blank the cell.
    }

    // Usage summary (admin-only; cached for 5 minutes).
    const now = Date.now();
    if (!usageHidden && now - lastUsageFetch >= USAGE_TTL_MS) {
      lastUsageFetch = now;
      try {
        const summary = await client.getUsageSummary();
        if (summary === null) {
          // Most likely a non-admin token. Hide the cell for the rest of
          // this session — re-enabled on reconnect via the effect below.
          usageHidden = true;
          tokens30d = null;
        } else {
          // The summary endpoint reports a rolling 30-day total, not a
          // daily breakdown — surface it verbatim as the rolling-window
          // usage figure. The cell is an at-a-glance heat indicator, not
          // billing-grade truth.
          tokens30d = summary.usage_30d?.tokens ?? null;
        }
      } catch {
        usageHidden = true;
        tokens30d = null;
      }
    }
  }

  // React to connection status flips: when we (re)connect, kick off a
  // fresh poll immediately AND reset the usage-hidden flag (a profile
  // switch may have moved us into / out of admin scope). When we go
  // offline, stop the timer so we don't burn cycles on doomed requests.
  $effect(() => {
    if (isConnected) {
      // Clearing both fields makes a profile switch feel snappy: the
      // bar visibly waits for the next poll rather than showing stale
      // values from the previous gateway.
      usageHidden = false;
      lastUsageFetch = 0;
      void pollOnce();
      if (!pollTimer) {
        pollTimer = setInterval(() => {
          void pollOnce();
        }, POLL_INTERVAL_MS);
      }
    } else {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      // Don't blank `latencyMs` etc. — the bar replaces the whole right
      // section with a "Disconnected" affordance when offline.
    }
    return () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  });

  // ---- Click handlers --------------------------------------------------
  function goSettings() {
    void goto('/settings');
  }
  function goProvider() {
    void goto('/settings#provider');
  }
  function goJobs() {
    void goto('/jobs');
  }
  async function startSidecar() {
    await connection.startSidecar();
  }
</script>

{#if visible}
  <!--
    The bar is full-width and anchored at the bottom of the viewport via
    the layout's flex column. `h-11` keeps every clickable section at the
    44px minimum target size while staying visually quiet.

    Each clickable section is a <button> so keyboard navigation +
    accessibility tree both work. We avoid <a> because we want
    client-side `goto` not a full navigation, and a button with role
    is the semantic match.
  -->
  <div
    class="w-full h-11 flex items-stretch border-t border-border-subtle bg-bg-deep/90 text-text-muted select-none"
    role="status"
    aria-label="IronClaw status bar"
  >
    <!-- Left: profile + mode + runner port. Always shown (even in
         compact mode) — this is the highest-signal cell. -->
    <button
      type="button"
      onclick={goSettings}
      class="flex min-h-[44px] items-center gap-2.5 px-4 min-w-0 border-r border-border-subtle/70 hover:bg-bg-surface/80 hover:text-text-primary transition-colors"
      title="Open profile settings"
    >
      <!-- Connection / tint dot. When connected we paint the profile's
           tint color so the bar visually echoes whichever window-tint
           the user picked (matching the sidebar brand glyph). Other
           states keep their canonical status hue (gold connecting, red
           error / disconnected) since legibility-of-status outranks
           the tint signal when the gateway isn't healthy. -->
      <span
        class="w-2 h-2 rounded-full shrink-0"
        class:bg-accent-gold={connection.status === 'connecting'}
        class:bg-danger={connection.status === 'error' ||
          connection.status === 'disconnected' ||
          connection.status === 'idle'}
        style={connection.status === 'connected' ? `background-color: ${tintHex};` : ''}
        aria-hidden="true"
      ></span>
      <span class="text-xs font-semibold truncate max-w-[180px] text-text-primary">
        {connection.activeProfile.name}
      </span>
      {#if !compact}
        <span
          class="text-[10px] uppercase tracking-wide font-mono px-1.5 py-px rounded border border-border-subtle bg-bg-surface/60 text-text-muted"
        >
          {modeBadge}
        </span>
        {#if isLocal && connection.sidecarPort != null}
          <span class="text-[11px] font-mono text-text-muted" aria-label="Runner port">
            :{connection.sidecarPort}
          </span>
        {/if}
      {/if}
    </button>

    <!-- Center: provider. Hidden in compact mode. The cell uses
         flex-1 to soak the middle of the bar so the right section sits
         flush against the viewport edge. -->
    {#if !compact}
      <button
        type="button"
        onclick={goProvider}
        class="flex-1 min-h-[44px] flex items-center justify-center gap-2 px-4 min-w-0 border-r border-border-subtle/70 hover:bg-bg-surface/80 hover:text-text-primary transition-colors"
        title="Open LLM provider settings"
      >
        <span class="text-xs truncate">
          {providerLabel}
        </span>
      </button>
    {:else}
      <!-- Compact: a flex spacer so the left section doesn't bleed into
           where the right section would normally sit. -->
      <div class="flex-1"></div>
    {/if}

    <!-- Right: live indicators OR offline / runner affordances.
         Hidden in compact mode. -->
    {#if !compact}
      {#if sidecarIdle}
        <!-- Local-mode but runner hasn't started. Render the status
             text + an inline Start button as siblings (no nested
             interactives so the markup stays valid). The status label
             routes to /jobs; the Start button calls into the connection
             store directly. Takes precedence over the generic
             "Disconnected" view so the user can recover in one click
             rather than detouring through /settings. -->
        <div
          class="min-h-[44px] flex items-center gap-2 px-4 text-xs border-l border-border-subtle/70"
          title="Local runner is idle"
        >
          <button
            type="button"
            onclick={goJobs}
            class="min-h-[44px] text-warning-v2 hover:text-text-primary transition-colors"
          >
            Runner: idle
          </button>
          <button
            type="button"
            aria-label="Start runner"
            onclick={startSidecar}
            disabled={sidecarStarting}
            class="min-h-[44px] text-[11px] font-medium px-3 rounded border border-accent-cyan/60 text-accent-cyan hover:bg-accent-cyan hover:text-bg-deep transition-colors disabled:opacity-50 disabled:cursor-progress"
          >
            {sidecarStarting ? 'Starting…' : 'Start'}
          </button>
        </div>
      {:else if connection.status === 'disconnected' || connection.status === 'idle' || connection.status === 'error'}
        <!-- Offline replacement: single link to /settings. The text is
             muted-but-actionable so the user can resolve from here. -->
        <button
          type="button"
          onclick={goSettings}
          class="min-h-[44px] px-4 flex items-center text-xs text-danger hover:text-text-primary hover:bg-bg-surface/80 transition-colors"
          title={connection.lastError ?? 'Runner is offline'}
        >
          Disconnected
        </button>
      {:else}
        <button
          type="button"
          onclick={goJobs}
          class="min-h-[44px] flex items-center gap-4 px-4 hover:bg-bg-surface/80 hover:text-text-primary transition-colors"
          title="Open jobs queue"
        >
          <!-- Jobs depth — running + pending. Gold when there's anything
               in flight so the user notices new work landing. -->
          <span class="flex items-center gap-1.5 text-xs">
            <span class="text-text-muted">Jobs</span>
            <span
              class="font-mono font-medium"
              class:text-text-primary={jobDepth === 0}
              class:text-accent-gold={jobDepth > 0}
            >
              {jobDepth}
            </span>
          </span>

          <!-- Rolling 30-day token usage (admin-only). Hidden when the
               gateway returns null from /api/admin/usage/summary (i.e.
               non-admin token). Label stays "Tokens" for width; the
               title/aria-label carry the rolling-window truth. -->
          {#if !usageHidden && tokens30d != null}
            <span
              class="flex items-center gap-1.5 text-xs"
              title="Tokens, rolling 30 days"
              aria-label="Tokens, rolling 30 days"
            >
              <span class="text-text-muted">Tokens</span>
              <span class="font-mono font-medium text-text-primary">
                {fmtTokens(tokens30d)}
              </span>
            </span>
          {/if}

          <!-- Latency. Renders an em-dash when unavailable so the cell
               doesn't disappear mid-poll. -->
          <span class="flex items-center gap-1.5 text-xs">
            <span class="text-text-muted">Ping</span>
            <span class="font-mono font-medium text-text-primary">
              {latencyMs != null ? `${latencyMs}ms` : '—'}
            </span>
          </span>
        </button>
      {/if}
    {/if}
  </div>
{/if}
