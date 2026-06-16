<script lang="ts">
  // Usage / cost dashboard.
  //
  // Surfaces the admin-only usage rollup (`GET /api/admin/usage/summary`)
  // plus the per-<user, model> breakdown (`GET /api/admin/usage`). The
  // client already maps both wire shapes onto stable `UsageSummary` /
  // `UsageEvent[]` types — this surface is read-only and concerns itself
  // only with presentation + period-selector wiring.
  //
  // Period selector: the gateway honors `period=hour|day|week|month|year`
  // but ignores `since=`. The API client (`getUsageEvents`) accepts only
  // `since` and internally maps it onto a period bucket via
  // `sinceToPeriod()`. To talk to that helper, we pick a representative
  // timestamp inside the requested bucket — see PERIOD_TO_SINCE_OFFSET.
  //
  // Loading model: a single combined load() runs both calls in parallel.
  // The summary endpoint swallows errors and returns `null`; the events
  // endpoint swallows them and returns `[]`. We can't programmatically
  // distinguish a 401/403 from "no data yet" through these helpers
  // (constraint: don't modify the API client), so the error path includes
  // an admin-permission hint alongside the generic "couldn't load" copy.
  //
  // Auto-poll: a 60s interval re-runs load() while the tab is mounted.
  // The parent route mounts this component via `{#if activeTab === ...}`,
  // so `onDestroy` covers tab-switch cleanup without an explicit visibility
  // observer.

  import { onMount, onDestroy } from 'svelte';
  import { connection } from '$lib/stores/connection.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import Sparkline from '$lib/components/Sparkline.svelte';
  import { createPollingRefresh } from '$lib/util/polling';
  import type { UsageSummary, UsageEvent } from '$lib/api/types';

  type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

  // The five buckets the gateway honors. `month` aligns with the 30-day
  // summary window — that's the default so the table doesn't disagree
  // with the cards on first load.
  type Period = 'hour' | 'day' | 'week' | 'month' | 'year';
  type PeriodPill = { v: Period; label: string };
  const PERIOD_PILLS: PeriodPill[] = [
    { v: 'hour', label: 'Hour' },
    { v: 'day', label: 'Day' },
    { v: 'week', label: 'Week' },
    { v: 'month', label: 'Month' },
    { v: 'year', label: 'Year' }
  ];

  // The API client only exposes `since`, and its internal sinceToPeriod()
  // maps an age onto a bucket via "<=Nx" comparisons. To force a given
  // bucket we pick a timestamp comfortably inside that bucket's range.
  // The boundaries are: hour <=1h, day <=1d, week <=7d, month <=30d,
  // year = everything older. We offset to a safe interior point.
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  function periodToSinceIso(p: Period): string {
    const now = Date.now();
    let ageMs: number;
    switch (p) {
      case 'hour':
        ageMs = 30 * 60 * 1000; // 30m → bucket "hour"
        break;
      case 'day':
        ageMs = 12 * HOUR_MS; // 12h → bucket "day"
        break;
      case 'week':
        ageMs = 3 * DAY_MS; // 3d → bucket "week"
        break;
      case 'month':
        ageMs = 14 * DAY_MS; // 14d → bucket "month"
        break;
      case 'year':
      default:
        ageMs = 100 * DAY_MS; // >30d → bucket "year"
        break;
    }
    return new Date(now - ageMs).toISOString();
  }

  // Refresh cadence. Kept aligned with the 60s auto-poll cadence used by
  // the rest of the desktop (settings page, status pings). 60s is also
  // gentle on the gateway (this is an admin-only endpoint, not high-QPS).
  const AUTO_REFRESH_MS = 60_000;

  let loadState = $state<LoadState>('idle');
  let loadError = $state<string | null>(null);
  let summary = $state<UsageSummary | null>(null);
  let events = $state<UsageEvent[]>([]);
  let period = $state<Period>('month');
  let searchInput = $state('');
  let refreshing = $state(false);
  let usagePoll: ReturnType<typeof createPollingRefresh> | null = null;

  const isDisconnected = $derived(
    connection.status === 'disconnected' || connection.status === 'idle' || !connection.client
  );

  // ---- Lifecycle --------------------------------------------------------

  onMount(() => {
    void load();
    usagePoll = createPollingRefresh(() => {
      // Skip silent polls while the previous one is still in flight or
      // while we're disconnected — avoids stacking failed requests.
      if (refreshing) return;
      if (isDisconnected) return;
      return load({ silent: true });
    }, AUTO_REFRESH_MS);
    usagePoll.start();
  });

  onDestroy(() => {
    usagePoll?.stop();
  });

  // Refetch when the user picks a different period pill. We don't refetch
  // the summary card — it's a single fixed 30-day rollup.
  $effect(() => {
    // Read `period` so Svelte tracks the dep; ignore initial idle state.
    const p = period;
    if (loadState === 'idle') return;
    void loadEventsOnly(p);
  });

  async function load(opts?: { silent?: boolean }) {
    const client = connection.client;
    if (!client) {
      loadState = 'idle';
      return;
    }
    const silent = opts?.silent === true;
    if (!silent) loadState = 'loading';
    refreshing = true;
    loadError = null;
    try {
      const since = periodToSinceIso(period);
      const [s, e] = await Promise.all([
        client.getUsageSummary(),
        client.getUsageEvents({ since })
      ]);
      summary = s;
      events = e;
      // The summary helper swallows errors and returns null. If both
      // fail we surface a "couldn't load" — but we still treat
      // (summary === null AND events === []) as a soft failure rather
      // than "no data yet", because the admin endpoint should at least
      // return a zero-valued summary even on an empty database.
      if (s === null && e.length === 0) {
        loadError =
          "Couldn't load usage. The gateway may be offline, or this profile's token may lack the admin role.";
        loadState = 'error';
      } else {
        loadState = 'loaded';
      }
    } catch (err) {
      loadError = (err as Error).message;
      loadState = 'error';
    } finally {
      refreshing = false;
    }
  }

  async function loadEventsOnly(p: Period) {
    const client = connection.client;
    if (!client) return;
    refreshing = true;
    try {
      const since = periodToSinceIso(p);
      events = await client.getUsageEvents({ since });
    } finally {
      refreshing = false;
    }
  }

  async function refresh() {
    await load();
    toasts.show('Usage refreshed', 'success');
  }

  // ---- Formatters -------------------------------------------------------

  // Parses the wire string (e.g. "0", "0.0312", undefined). Falls back
  // to 0 so the card never shows NaN.
  function parseCost(raw: string | undefined): number {
    if (raw === undefined || raw === null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  // Tiny costs need extra precision so "$0.0001" doesn't round to "$0.00"
  // and look like nothing happened. Anything ≥ $1 uses the standard
  // 2-decimal format; sub-dollar costs use up to 4 decimals.
  function formatCost(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '$0.00';
    if (value >= 1) return `$${value.toFixed(2)}`;
    return `$${value.toFixed(4)}`;
  }

  // Integer formatting with thin-space-style grouping (just `toLocaleString`
  // — keeps the dashboard locale-aware without dragging in a dep).
  function formatInt(value: number | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
    return value.toLocaleString();
  }

  // Compact uptime: "3d 22h", "7h 14m", "12m", "47s". Two units max,
  // skipping zero-valued leading units. Returns "—" for missing input.
  function formatUptime(seconds: number | undefined): string {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      return '—';
    }
    const s = Math.floor(seconds);
    const d = Math.floor(s / 86_400);
    const h = Math.floor((s % 86_400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  // ---- Derived ----------------------------------------------------------

  const totalCostNumeric = $derived(parseCost(summary?.usage_30d?.total_cost));
  const llmCalls = $derived(summary?.usage_30d?.llm_calls ?? 0);
  const inputTokens = $derived(summary?.usage_30d?.input_tokens ?? 0);
  const outputTokens = $derived(summary?.usage_30d?.output_tokens ?? 0);
  const totalTokens = $derived(inputTokens + outputTokens);

  // Bar widths for the input/output side-by-side visualization. Guard
  // against divide-by-zero on empty data; render equal halves in that
  // case so the card still reads as "balanced".
  const tokenBars = $derived.by(() => {
    if (totalTokens <= 0) return { inputPct: 50, outputPct: 50 };
    const inputPct = Math.round((inputTokens / totalTokens) * 100);
    return { inputPct, outputPct: 100 - inputPct };
  });

  // Filtered, sorted table rows. Sort is by cost desc — set in stone for
  // v1 since cost is the field operators actually scan. Search matches
  // user_id and model substrings (case-insensitive).
  const filteredRows = $derived.by(() => {
    const q = searchInput.trim().toLowerCase();
    const rows = events.filter((r) => {
      if (!q) return true;
      const u = (r.user_id ?? '').toLowerCase();
      const m = (r.model ?? '').toLowerCase();
      return u.includes(q) || m.includes(q);
    });
    return [...rows].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  });

  // LLM-calls sparkline series. The wire does NOT expose a daily/weekly
  // time-series of llm_calls — `usage_30d.llm_calls` is a single scalar
  // and `getUsageEvents` returns one row per <user, model> bucket with
  // no `ts` field. As the closest faithful approximation we plot the
  // per-row call_count distribution (top 24 rows, cost-desc to match
  // the table sort) so the card communicates "where the calls go".
  //
  // TODO(admin/UsageDashboard.svelte:llm-calls-spark): swap this for a
  // real daily/weekly time-series once `GET /api/admin/usage/timeseries`
  // (or equivalent) lands. The component already accepts a `data: number[]`
  // — no markup change required, only the derived source.
  const llmCallsSpark = $derived.by<number[]>(() => {
    const sorted = [...events].sort((a, b) => (b.call_count ?? 0) - (a.call_count ?? 0));
    return sorted.slice(0, 24).map((r) => r.call_count ?? 0);
  });
</script>

<div class="flex flex-col flex-1 min-h-0">
  {#if isDisconnected}
    <div class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]">
      <div class="text-sm text-text-primary mb-2">IronClaw is offline</div>
      <div class="text-xs text-text-muted">
        Configure the connection in
        <a
          href="/settings"
          class="text-accent-cyan underline decoration-dotted hover:decoration-solid">Settings</a
        >.
      </div>
    </div>
  {:else if loadState === 'loading'}
    <!-- Skeleton: 4 placeholder cards + a placeholder table. Animated via
         a tailwind `animate-pulse` class so the user clearly sees a
         load-in-progress without a separate spinner component. -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
      {#each Array(4) as _, i (i)}
        <div class="surface p-4 animate-pulse">
          <div class="h-3 w-20 bg-bg-deep rounded mb-3"></div>
          <div class="h-7 w-24 bg-bg-deep rounded"></div>
        </div>
      {/each}
    </div>
    <div class="surface p-4 animate-pulse mb-4">
      <div class="h-3 w-32 bg-bg-deep rounded mb-3"></div>
      <div class="h-3 w-full bg-bg-deep rounded"></div>
    </div>
    <div class="surface flex-1 min-h-0 p-4 animate-pulse">
      <div class="h-3 w-40 bg-bg-deep rounded mb-3"></div>
      <div class="space-y-2">
        {#each Array(5) as _, i (i)}
          <div class="h-4 w-full bg-bg-deep rounded"></div>
        {/each}
      </div>
    </div>
  {:else if loadState === 'error'}
    <div class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]">
      <div class="text-sm text-red-400 mb-2">Couldn't load usage</div>
      <div class="text-xs text-text-muted max-w-md mb-4">
        {loadError ?? 'Unknown error'}
      </div>
      <div class="text-[11px] text-text-muted/70 max-w-md mb-4">
        Usage is admin-only. Switch profile or use a token with the admin role.
      </div>
      <button
        type="button"
        onclick={() => void load()}
        class="px-4 py-2 rounded-md border border-accent-cyan text-accent-cyan text-sm font-semibold hover:bg-accent-cyan hover:text-bg-deep transition min-h-[40px]"
      >
        Retry
      </button>
    </div>
  {:else}
    <!-- Header row: profile-agnostic title + refresh button. -->
    <div class="flex items-center justify-between gap-3 mb-4">
      <div class="text-xs text-text-muted">
        Summary cards cover 30 days; the table follows the selected period.
      </div>
      <button
        type="button"
        onclick={() => void refresh()}
        disabled={refreshing}
        class="px-3 py-1.5 rounded-md border border-border-subtle text-xs text-text-primary hover:border-accent-cyan hover:text-accent-cyan transition disabled:opacity-40 min-h-[32px] flex items-center gap-2"
        title="Refresh · auto every 60s"
      >
        <svg
          viewBox="0 0 24 24"
          class="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class:animate-spin={refreshing}
        >
          <polyline points="23 4 23 10 17 10"></polyline>
          <polyline points="1 20 1 14 7 14"></polyline>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>

    <!-- Summary cards strip (4 cards). Mobile stacks 1-col; sm splits to
         2-col; lg goes 4-col. -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
      <!-- Users card. Sub-stats inline; keeps the card scannable without
           a tooltip. -->
      <div class="surface p-4 flex flex-col">
        <div class="text-[10px] uppercase tracking-wider text-text-muted mb-2">Users</div>
        <div class="text-2xl font-semibold text-text-primary leading-none mb-3">
          {formatInt(summary?.users?.total)}
        </div>
        <div class="grid grid-cols-3 gap-2 text-[11px] text-text-muted mt-auto">
          <div>
            <div class="text-text-primary font-mono">
              {formatInt(summary?.users?.active)}
            </div>
            <div>Active</div>
          </div>
          <div>
            <div class="text-text-primary font-mono">
              {formatInt(summary?.users?.suspended)}
            </div>
            <div>Suspended</div>
          </div>
          <div>
            <div class="text-text-primary font-mono">
              {formatInt(summary?.users?.admins)}
            </div>
            <div>Admins</div>
          </div>
        </div>
      </div>

      <!-- Jobs card. Single number; sub-line clarifies "total queued + run". -->
      <div class="surface p-4 flex flex-col">
        <div class="text-[10px] uppercase tracking-wider text-text-muted mb-2">Jobs</div>
        <div class="text-2xl font-semibold text-text-primary leading-none mb-3">
          {formatInt(summary?.jobs?.total)}
        </div>
        <div class="text-[11px] text-text-muted mt-auto">Total recorded</div>
      </div>

      <!-- LLM calls (30d) card. Big number — the prompt called this out
           explicitly. Sparkline shows the per-row call_count distribution
           (top 24 buckets, cost-desc) as a faithful stand-in until the
           gateway exposes a real daily/weekly time-series; see TODO above
           the derived `llmCallsSpark` for the swap. -->
      <div class="surface p-4 flex flex-col">
        <div class="text-[10px] uppercase tracking-wider text-text-muted mb-2">LLM calls (30d)</div>
        <div class="text-3xl font-semibold text-accent-cyan leading-none mb-3">
          {formatInt(llmCalls)}
        </div>
        <div class="mb-2 text-accent-cyan">
          <Sparkline data={llmCallsSpark} variant="bars" width={160} height={32} color="#4ca7e6" />
        </div>
        <div class="text-[11px] text-text-muted mt-auto">All users and models</div>
      </div>

      <!-- Total cost (30d) card. Accent-gold for monetary callouts. -->
      <div class="surface p-4 flex flex-col">
        <div class="text-[10px] uppercase tracking-wider text-text-muted mb-2">
          Total cost (30d)
        </div>
        <div class="text-3xl font-semibold text-accent-gold leading-none mb-3">
          {formatCost(totalCostNumeric)}
        </div>
        <div class="text-[11px] text-text-muted mt-auto font-mono">
          Wire: "{summary?.usage_30d?.total_cost ?? '—'}"
        </div>
      </div>
    </div>

    <!-- Tokens card. Side-by-side input/output, with a proportional bar
         underneath so the operator gets an at-a-glance read of the mix.
         The bar is purely informational — no axis labels, no tooltip. -->
    <div class="surface p-4 mb-4">
      <div class="flex items-baseline justify-between mb-3">
        <div class="text-[10px] uppercase tracking-wider text-text-muted">Tokens (30d)</div>
        <div class="text-xs text-text-muted font-mono">
          Total <span class="text-text-primary">{formatInt(totalTokens)}</span>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-4 mb-3">
        <div>
          <div class="text-[11px] text-text-muted mb-1">Input</div>
          <div class="text-xl font-semibold text-text-primary font-mono">
            {formatInt(inputTokens)}
          </div>
        </div>
        <div>
          <div class="text-[11px] text-text-muted mb-1">Output</div>
          <div class="text-xl font-semibold text-text-primary font-mono">
            {formatInt(outputTokens)}
          </div>
        </div>
      </div>
      <!-- Proportional bar. Cyan = input, gold = output. Tiny height so
           it reads as a sparkline rather than a chart. -->
      <div
        class="flex w-full h-1.5 rounded-full overflow-hidden bg-bg-deep"
        role="img"
        aria-label="Input vs output token share"
      >
        <div class="bg-accent-cyan h-full" style="width: {tokenBars.inputPct}%"></div>
        <div class="bg-accent-gold h-full" style="width: {tokenBars.outputPct}%"></div>
      </div>
      <div class="flex justify-between text-[10px] text-text-muted/80 mt-1 font-mono">
        <span>Input {tokenBars.inputPct}%</span>
        <span>Output {tokenBars.outputPct}%</span>
      </div>
    </div>

    <!-- Period pills + search. Period drives the table refetch via the
         $effect above. Search is a client-side filter — no extra request. -->
    <div class="surface p-3 mb-3 flex flex-wrap items-center gap-2">
      <span class="text-[10px] uppercase tracking-wider text-text-muted mr-1"> Period </span>
      {#each PERIOD_PILLS as pill (pill.v)}
        {@const active = period === pill.v}
        <button
          type="button"
          onclick={() => (period = pill.v)}
          class="px-3 py-1 rounded-full text-[11px] font-semibold border transition min-h-[28px] {active
            ? 'bg-accent-cyan text-bg-deep border-accent-cyan'
            : 'border-border-subtle text-text-muted hover:text-text-primary hover:border-text-muted'}"
        >
          {pill.label}
        </button>
      {/each}

      <div class="flex-1 min-w-[200px] relative max-w-md ml-auto">
        <span
          class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-muted"
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
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </span>
        <input
          type="search"
          bind:value={searchInput}
          placeholder="Filter user or model…"
          class="w-full bg-bg-deep border border-border-subtle rounded-md pl-10 pr-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors min-h-[36px]"
          aria-label="Filter rows by user or model"
        />
      </div>
    </div>

    <!-- Per-user / per-model table. CSS-grid columns line up the header
         and body without table semantics. Header sticks while the body
         scrolls. -->
    <div class="flex-1 min-h-0 overflow-auto surface">
      {#if filteredRows.length === 0}
        <div class="p-10 text-center text-xs text-text-muted">
          {#if events.length === 0}
            No LLM usage yet. Costs and call counts appear here once IronClaw handles requests.
          {:else}
            No rows match the search
          {/if}
        </div>
      {:else}
        <div
          class="grid grid-cols-[1.2fr_1.5fr_80px_110px_110px_110px] sticky top-0 bg-bg-surface border-b border-border-subtle px-4 py-2 text-[10px] uppercase tracking-wider text-text-muted z-10"
        >
          <div>User</div>
          <div>Model</div>
          <div class="text-right">Calls</div>
          <div class="text-right">In tokens</div>
          <div class="text-right">Out tokens</div>
          <div class="text-right">Cost</div>
        </div>
        <div>
          {#each filteredRows as row, i (`${row.user_id ?? 'unknown'}::${row.model ?? 'unknown'}::${i}`)}
            <div
              class="grid grid-cols-[1.2fr_1.5fr_80px_110px_110px_110px] items-center gap-4 px-4 py-2.5 border-b border-border-subtle/60 hover:bg-bg-deep/40 transition-colors text-sm"
            >
              <div class="font-mono text-text-primary truncate" title={row.user_id ?? ''}>
                {row.user_id ?? '—'}
              </div>
              <div class="font-mono text-text-muted truncate" title={row.model ?? ''}>
                {row.model ?? '—'}
              </div>
              <div class="text-right font-mono text-text-primary">
                {formatInt(row.call_count)}
              </div>
              <div class="text-right font-mono text-text-muted">
                {formatInt(row.input_tokens)}
              </div>
              <div class="text-right font-mono text-text-muted">
                {formatInt(row.output_tokens)}
              </div>
              <div class="text-right font-mono text-accent-gold">
                {formatCost(row.cost ?? 0)}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Uptime footer. Tiny, right-aligned so it reads as metadata, not
         a primary metric. -->
    <div class="mt-3 flex items-center justify-between gap-3 text-[11px] text-text-muted">
      <span>
        {filteredRows.length} row{filteredRows.length === 1 ? '' : 's'} · period
        <span class="text-text-primary">{period}</span>
      </span>
      <span>
        Server uptime
        <span class="text-text-primary font-mono">{formatUptime(summary?.uptime)}</span>
      </span>
    </div>
  {/if}
</div>
