<script lang="ts">
  // Engine v2 thread detail surface.
  //
  // Rendered as a fixed full-viewport overlay (above the MissionDetail
  // drawer) so the user gets a dedicated reading surface for the full
  // transcript + execution timeline. A header "Back to mission"
  // button + the X close both invoke `onclose`, which returns the user
  // to the MissionDetail panel still expanded behind us.
  //
  // The overlay stacks above MissionDetail (which is `z-40`), so we use
  // `z-50`. This avoids the "drawer on top of drawer" UX while keeping
  // the MissionDetail context for re-entry without a re-fetch.
  //
  // Two backing data sources:
  //   1. GET /api/engine/threads/{id}          → full transcript (messages)
  //   2. GET /api/engine/threads/{id}/events   → execution timeline
  //
  // The wire's /steps endpoint exists but returns {steps: []} on every
  // probed thread today; the panel calls it once and folds anything it
  // returns into the timeline alongside events. Once the gateway lights
  // up /steps, no UI change is needed — the merge keeps both sources
  // visible in chronological order.
  //
  // Live update: while the thread is in a non-terminal state
  // (`Pending` / `Running` / not `Done` / not `Failed`), the panel
  // polls both endpoints on a 2s interval. Polling stops once the
  // thread reaches a terminal state (or the panel unmounts).

  import { onDestroy, onMount } from 'svelte';
  import type {
    EngineThread,
    EngineThreadDetail,
    EngineThreadEvent,
    EngineThreadMessage,
    EngineThreadStep
  } from '$lib/api/types';
  import { connection } from '$lib/stores/connection.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import MarkdownView from '$lib/components/MarkdownView.svelte';
  import Sparkline from '$lib/components/Sparkline.svelte';
  import { createPollingRefresh } from '$lib/util/polling';
  import { relativeTime, shortTimestamp } from '../routines/time';

  type Props = {
    /** The thread row from the parent's list — used as a placeholder
     *  for header/badge content while the detail fetch is in flight,
     *  and as a fallback if the detail endpoint returns null. */
    thread: EngineThread;
    onclose: () => void;
  };

  let { thread, onclose }: Props = $props();

  // ---- Local state ---------------------------------------------------------

  let detail = $state<EngineThreadDetail | null>(null);
  let events = $state<EngineThreadEvent[]>([]);
  let steps = $state<EngineThreadStep[]>([]);
  let initialLoad = $state(true);
  let refreshing = $state(false);
  let loadError = $state<string | null>(null);

  /** Collapsed-by-default content blocks. Keyed by a stable id (message
   *  index or event id) — see toggle() / isOpen(). The System prompt is
   *  often very long (8KB+) and dominates the panel if expanded, so we
   *  start it collapsed and let the user opt-in. Tool args/results are
   *  also collapsed by default to keep the timeline scannable. */
  let openBlocks = $state<Record<string, boolean>>({});

  let enginePoll: ReturnType<typeof createPollingRefresh> | null = null;

  // Poll interval while the thread is live. 2s matches the brief's intent
  // for a "live update" surface without flooding the gateway.
  const POLL_INTERVAL_MS = 2_000;

  // ---- Derived -------------------------------------------------------------

  /** Title: prefer detail.title, fall back to thread.title, then the
   *  first ~80 chars of `goal`, then the id. */
  const displayTitle = $derived.by<string>(() => {
    const d = detail ?? thread;
    const t = (d.title ?? '').trim();
    if (t.length > 0) return t;
    const g = (d.goal ?? '').trim();
    if (g.length > 0) {
      const firstLine = g.split('\n')[0];
      return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
    }
    return d.id;
  });

  /** Current state — prefer fresh detail over the parent's row. */
  const currentState = $derived<string>(detail?.state ?? thread.state ?? 'unknown');

  /** True while the thread is non-terminal. Used to gate polling and to
   *  show a "live" pulse indicator next to the state badge. */
  const isLive = $derived.by<boolean>(() => {
    const s = currentState.toLowerCase();
    return s !== 'done' && s !== 'completed' && s !== 'failed';
  });

  /**
   * Merged execution timeline: events + (any) steps, sorted by timestamp.
   * Each row carries a `kind` discriminator we can switch on for rendering:
   *
   *   { source: 'event', event: EngineThreadEvent }
   *   { source: 'step',  step:  EngineThreadStep }
   *
   * Steps fall in via `created_at`; events via `timestamp`. Rows without
   * a parseable timestamp sort to the bottom (we never silently drop them).
   */
  const timeline = $derived.by<Array<TimelineRow>>(() => {
    const rows: TimelineRow[] = [
      ...events.map((e) => ({ source: 'event' as const, event: e, ts: e.timestamp })),
      ...steps.map((s) => ({ source: 'step' as const, step: s, ts: s.created_at }))
    ];
    rows.sort((a, b) => {
      const aT = a.ts ? Date.parse(a.ts) : NaN;
      const bT = b.ts ? Date.parse(b.ts) : NaN;
      if (Number.isNaN(aT) && Number.isNaN(bT)) return 0;
      if (Number.isNaN(aT)) return 1;
      if (Number.isNaN(bT)) return -1;
      return aT - bT;
    });
    return rows;
  });

  type TimelineRow =
    | { source: 'event'; event: EngineThreadEvent; ts: string }
    | { source: 'step'; step: EngineThreadStep; ts: string | undefined };

  /** Messages from the detail payload (empty until the first fetch lands). */
  const messages = $derived<EngineThreadMessage[]>(detail?.messages ?? []);

  /**
   * Cumulative-token series for the header sparkline.
   *
   * Walks `events` in their merged-timeline order, summing each
   * `StepCompleted` event's `tokens.input_tokens + output_tokens`. The
   * result is a monotonically non-decreasing series that reads as the
   * thread's growing token budget over time. Returns an empty array when
   * no StepCompleted events are recorded yet — the Sparkline renders its
   * empty-state dash in that case.
   *
   * We read from `events` (not `timeline`) so the series is independent
   * of step-row interleaving; `StepCompleted` events are the canonical
   * token-accounting hook on the wire today.
   */
  const tokenSeries = $derived.by<number[]>(() => {
    const out: number[] = [];
    let total = 0;
    for (const e of events) {
      const tag = Object.keys(e.kind ?? {})[0];
      if (tag !== 'StepCompleted') continue;
      const payload = (e.kind as Record<string, unknown>)[tag] as
        | {
            tokens?: { input_tokens?: number; output_tokens?: number };
          }
        | undefined;
      const inT = payload?.tokens?.input_tokens ?? 0;
      const outT = payload?.tokens?.output_tokens ?? 0;
      total += inT + outT;
      out.push(total);
    }
    return out;
  });

  // ---- Helpers -------------------------------------------------------------

  function isOpen(key: string, defaultOpen = false): boolean {
    if (key in openBlocks) return openBlocks[key];
    return defaultOpen;
  }

  function toggle(key: string, defaultOpen = false): void {
    openBlocks = { ...openBlocks, [key]: !isOpen(key, defaultOpen) };
  }

  function stateBadgeClass(state: string | undefined): string {
    const s = (state ?? '').toLowerCase();
    switch (s) {
      case 'running':
        return 'bg-accent-gold/10 text-accent-gold border-accent-gold/30';
      case 'done':
      case 'completed':
        return 'bg-green-500/10 text-green-400 border-green-500/30';
      case 'failed':
        return 'bg-red-500/10 text-red-400 border-red-500/30';
      case 'pending':
      case 'created':
        return 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30';
      default:
        return 'bg-bg-deep text-text-muted border-border-subtle';
    }
  }

  /** Role badge tint for message rows. Wire emits PascalCase. */
  function roleBadgeClass(role: string | undefined): string {
    const r = (role ?? '').toLowerCase();
    switch (r) {
      case 'user':
        return 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30';
      case 'assistant':
        return 'bg-accent-gold/10 text-accent-gold border-accent-gold/30';
      case 'system':
        return 'bg-text-muted/10 text-text-muted border-text-muted/30';
      case 'tool':
      case 'action':
        return 'bg-green-500/10 text-green-400 border-green-500/30';
      default:
        return 'bg-bg-deep text-text-muted border-border-subtle';
    }
  }

  /** Event variant tag, e.g. `MessageAdded`, `StepStarted`. */
  function eventKindTag(e: EngineThreadEvent): string {
    const keys = Object.keys(e.kind ?? {});
    return keys[0] ?? 'Unknown';
  }

  /** Event variant payload (the inner object). May be any shape — render
   *  as JSON for unknown variants. */
  function eventKindPayload(e: EngineThreadEvent): unknown {
    const tag = eventKindTag(e);
    return (e.kind as Record<string, unknown>)[tag];
  }

  /** Variant-specific tint for the timeline row marker. */
  function eventTintClass(tag: string): string {
    switch (tag) {
      case 'MessageAdded':
        return 'border-accent-cyan/40 bg-accent-cyan/5';
      case 'StateChanged':
        return 'border-accent-gold/40 bg-accent-gold/5';
      case 'StepStarted':
        return 'border-border-subtle bg-bg-deep';
      case 'StepCompleted':
        return 'border-green-500/40 bg-green-500/5';
      case 'ActionExecuted':
        return 'border-accent-cyan/40 bg-accent-cyan/5';
      default:
        return 'border-border-subtle bg-bg-deep';
    }
  }

  /** Compact token formatter — 12_345 → "12.3k". */
  function fmtTokens(n: number | undefined): string {
    if (n === undefined || n === null) return '0';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
  }

  /** Cost formatter for total_cost_usd (JSON number). */
  function fmtCost(c: number | undefined): string {
    if (c === undefined || c === null) return '$0.0000';
    if (c < 0.0001) return '<$0.0001';
    return `$${c.toFixed(4)}`;
  }

  function shortId(id: string): string {
    return id.length > 12 ? `${id.slice(0, 8)}…` : id;
  }

  /** Stable JSON stringify for a payload preview block. */
  function payloadJson(p: unknown): string {
    try {
      return JSON.stringify(p, null, 2);
    } catch {
      return String(p);
    }
  }

  // ---- Fetch + poll --------------------------------------------------------

  async function refresh(opts: { silent?: boolean } = {}): Promise<void> {
    const client = connection.client;
    if (!client) {
      if (!opts.silent) loadError = 'Not connected.';
      initialLoad = false;
      return;
    }
    if (!opts.silent) refreshing = true;
    try {
      // Three parallel lookups. Use allSettled so a single endpoint failure
      // doesn't blank the panel — the timeline survives a /steps outage,
      // and the transcript survives a /events outage.
      const [detailRes, eventsRes, stepsRes] = await Promise.allSettled([
        client.getEngineThread(thread.id),
        client.listEngineThreadEvents(thread.id),
        client.getEngineThreadSteps(thread.id)
      ]);
      if (detailRes.status === 'fulfilled') detail = detailRes.value;
      if (eventsRes.status === 'fulfilled') events = eventsRes.value;
      if (stepsRes.status === 'fulfilled') steps = stepsRes.value;

      const allFailed =
        detailRes.status === 'rejected' &&
        eventsRes.status === 'rejected' &&
        stepsRes.status === 'rejected';
      loadError = allFailed
        ? ((detailRes.reason as Error)?.message ?? 'Failed to load thread detail')
        : null;
      if (!opts.silent && loadError !== null) {
        toasts.show(`Refresh failed: ${loadError}`, 'error');
      }
    } catch (err) {
      loadError = (err as Error).message;
      if (!opts.silent) toasts.show(`Refresh failed: ${loadError}`, 'error');
    } finally {
      refreshing = false;
      initialLoad = false;
    }
  }

  // Re-arm the poll timer whenever liveness changes. Stops automatically
  // when the thread reaches Done/Failed and resumes if it transitions
  // back (rare — but cheap to support).
  $effect(() => {
    // Read isLive so the effect re-runs on transition.
    const live = isLive;
    // Lazily create the handle on first run — POLL_INTERVAL_MS + refresh are
    // both in scope by the time effects flush. start()/stop() are idempotent,
    // so toggling on every liveness transition is safe.
    enginePoll ??= createPollingRefresh(() => refresh({ silent: true }), POLL_INTERVAL_MS);
    if (live) enginePoll.start();
    else enginePoll.stop();
  });

  onMount(() => {
    void refresh();
  });

  onDestroy(() => {
    enginePoll?.stop();
  });

  /** Escape key closes the panel — matches the convention used elsewhere
   *  (chat side drawers, log viewer). Handled via a window listener so
   *  the panel works without stealing focus from the timeline. */
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      onclose();
    }
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<!-- Full-viewport overlay. Stacks above MissionDetail (z-40) at z-50 so
     the user reads the thread in isolation. The dark backdrop click
     closes the panel and returns to the MissionDetail drawer behind. -->
<div
  class="fixed inset-0 z-50 bg-bg-deep/90 backdrop-blur-sm flex flex-col"
  role="dialog"
  aria-modal="true"
  aria-label="Engine thread detail"
>
  <header
    class="px-6 py-4 border-b border-border-subtle bg-bg-surface flex items-start justify-between gap-4 shrink-0"
  >
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2 mb-2">
        <button
          type="button"
          onclick={onclose}
          class="flex items-center gap-1.5 text-[11px] text-text-muted hover:text-accent-cyan transition-colors"
          aria-label="Back to mission"
        >
          <svg
            viewBox="0 0 24 24"
            class="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to mission
        </button>
        <span class="text-text-muted">·</span>
        <span
          class="inline-block px-2 py-0.5 rounded text-[10px] uppercase tracking-wide border font-medium {stateBadgeClass(
            currentState
          )}"
        >
          {currentState}
        </span>
        {#if isLive}
          <span
            class="inline-flex items-center gap-1 text-[10px] text-accent-gold"
            title="Polling for live updates"
          >
            <span class="w-1.5 h-1.5 rounded-full bg-accent-gold animate-pulse"></span>
            live
          </span>
        {/if}
        {#if thread.thread_type ?? detail?.thread_type}
          <span class="text-[10px] uppercase tracking-wide text-text-muted font-mono">
            {thread.thread_type ?? detail?.thread_type}
          </span>
        {/if}
      </div>
      <h2 class="text-lg font-semibold text-text-primary truncate" title={displayTitle}>
        {displayTitle}
      </h2>
      <div class="mt-1 text-[11px] font-mono text-text-muted truncate" title={thread.id}>
        {thread.id}
      </div>

      <dl class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px]">
        <div class="flex items-center gap-1.5">
          <dt class="text-text-muted">Steps</dt>
          <dd class="text-text-primary font-mono">
            {detail?.step_count ?? thread.step_count ?? 0}
          </dd>
        </div>
        <div class="flex items-center gap-1.5">
          <dt class="text-text-muted">Tokens</dt>
          <dd class="text-text-primary font-mono">
            {fmtTokens(detail?.total_tokens ?? thread.total_tokens)}
          </dd>
          <!-- Cumulative tokens per StepCompleted event. Area variant
               so the growing budget reads as a trend, not a count. The
               spark is intentionally narrow (90×16) so it slots into
               the metadata dl without breaking the row's baseline. -->
          <span class="ml-1 text-accent-cyan" title="Cumulative tokens per step">
            <Sparkline data={tokenSeries} variant="area" width={90} height={16} color="#4ca7e6" />
          </span>
        </div>
        {#if detail?.total_cost_usd !== undefined}
          <div class="flex items-center gap-1.5">
            <dt class="text-text-muted">Cost</dt>
            <dd class="text-text-primary font-mono">
              {fmtCost(detail.total_cost_usd)}
            </dd>
          </div>
        {/if}
        {#if detail?.max_iterations !== undefined}
          <div class="flex items-center gap-1.5">
            <dt class="text-text-muted">Max iter</dt>
            <dd class="text-text-primary font-mono">{detail.max_iterations}</dd>
          </div>
        {/if}
        {#if (detail?.created_at ?? thread.created_at) !== undefined}
          <div class="flex items-center gap-1.5">
            <dt class="text-text-muted">Created</dt>
            <dd
              class="text-text-primary"
              title={shortTimestamp(detail?.created_at ?? thread.created_at ?? '')}
            >
              {relativeTime(detail?.created_at ?? thread.created_at ?? '')}
            </dd>
          </div>
        {/if}
        {#if detail?.completed_at}
          <div class="flex items-center gap-1.5">
            <dt class="text-text-muted">Completed</dt>
            <dd class="text-text-primary" title={shortTimestamp(detail.completed_at)}>
              {relativeTime(detail.completed_at)}
            </dd>
          </div>
        {/if}
      </dl>
    </div>

    <div class="flex items-center gap-2 shrink-0">
      <button
        type="button"
        onclick={() => void refresh()}
        disabled={refreshing}
        class="flex items-center gap-2 px-3 py-2 rounded-md border border-border-subtle text-xs text-text-muted hover:border-accent-cyan hover:text-accent-cyan transition-colors disabled:opacity-50 min-h-[36px]"
        title="Refresh detail + events"
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
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
      <button
        type="button"
        onclick={onclose}
        class="text-text-muted hover:text-text-primary transition-colors p-1 -m-1"
        aria-label="Close engine thread detail"
      >
        <svg
          viewBox="0 0 24 24"
          class="w-5 h-5"
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
    </div>
  </header>

  <!-- Body: two-column layout — goal/transcript on the left, timeline on
       the right. Each column scrolls independently. On narrower viewports
       the grid collapses to a single column (md breakpoint). -->
  <div class="flex-1 overflow-hidden grid grid-cols-1 md:grid-cols-[1fr_440px] gap-0">
    <!-- Left column: goal + transcript -->
    <div class="overflow-auto px-6 py-5 space-y-6 border-r border-border-subtle">
      <section>
        <h3 class="text-xs uppercase tracking-wide text-text-muted mb-2">Goal</h3>
        {#if (detail?.goal ?? thread.goal)?.trim()}
          <pre
            class="text-xs text-text-primary bg-bg-deep border border-border-subtle rounded-md p-3 whitespace-pre-wrap font-mono leading-relaxed">{(
              detail?.goal ??
              thread.goal ??
              ''
            ).trim()}</pre>
        {:else}
          <p class="text-xs text-text-muted italic">No goal recorded</p>
        {/if}
      </section>

      <section>
        <h3 class="text-xs uppercase tracking-wide text-text-muted mb-2">
          Transcript
          {#if messages.length > 0}
            <span class="text-text-primary">({messages.length})</span>
          {/if}
        </h3>

        {#if initialLoad && messages.length === 0 && !loadError}
          <p class="text-xs text-text-muted italic">Loading transcript…</p>
        {:else if messages.length === 0}
          <p class="text-xs text-text-muted italic">No messages recorded</p>
        {:else}
          <ol class="space-y-3">
            {#each messages as msg, i (i)}
              {@const key = `msg-${i}`}
              {@const isSystem = (msg.role ?? '').toLowerCase() === 'system'}
              {@const open = isOpen(key, !isSystem)}
              <li class="bg-bg-deep border border-border-subtle rounded-md">
                <button
                  type="button"
                  onclick={() => toggle(key, !isSystem)}
                  class="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-bg-surface/50 transition-colors"
                  aria-expanded={open}
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <span
                      class="inline-block shrink-0 px-2 py-0.5 rounded text-[10px] uppercase tracking-wide border font-medium {roleBadgeClass(
                        msg.role
                      )}"
                    >
                      {msg.role ?? 'unknown'}
                    </span>
                    <span class="text-[10px] text-text-muted font-mono">
                      #{i + 1}
                    </span>
                    {#if !open}
                      <span class="text-[11px] text-text-muted truncate">
                        {msg.content?.slice(0, 120).replace(/\s+/g, ' ').trim()}…
                      </span>
                    {/if}
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    {#if msg.timestamp}
                      <span
                        class="text-[10px] text-text-muted"
                        title={shortTimestamp(msg.timestamp)}
                      >
                        {relativeTime(msg.timestamp)}
                      </span>
                    {/if}
                    <svg
                      viewBox="0 0 24 24"
                      class="w-3.5 h-3.5 text-text-muted transition-transform"
                      class:rotate-180={open}
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                </button>
                {#if open}
                  <div class="px-3 pb-3 border-t border-border-subtle">
                    {#if isSystem}
                      <!-- System prompts are typically literal text (not
                           markdown); render in a mono block so escape
                           sequences and code fences are unambiguous. -->
                      <pre
                        class="mt-2 text-xs text-text-primary whitespace-pre-wrap font-mono leading-relaxed max-h-[400px] overflow-auto">{msg.content}</pre>
                    {:else}
                      <div class="mt-2 text-sm text-text-primary">
                        <MarkdownView markdown={msg.content ?? ''} />
                      </div>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
      </section>
    </div>

    <!-- Right column: execution timeline (events + steps merged) -->
    <div class="overflow-auto px-6 py-5">
      <section>
        <h3 class="text-xs uppercase tracking-wide text-text-muted mb-3">
          Timeline
          {#if timeline.length > 0}
            <span class="text-text-primary">({timeline.length})</span>
          {/if}
        </h3>

        {#if initialLoad && timeline.length === 0 && !loadError}
          <p class="text-xs text-text-muted italic">Loading timeline…</p>
        {:else if loadError && timeline.length === 0}
          <p class="text-xs text-red-400">Failed to load timeline</p>
        {:else if timeline.length === 0}
          <p class="text-xs text-text-muted italic">No events recorded</p>
        {:else}
          <ol class="space-y-2">
            {#each timeline as row, i (`${row.source}-${row.source === 'event' ? (row.event.id ?? i) : (row.step.id ?? i)}`)}
              {#if row.source === 'event'}
                {@const e = row.event}
                {@const tag = eventKindTag(e)}
                {@const payload = eventKindPayload(e)}
                {@const key = `evt-${e.id ?? i}`}
                <li class="border rounded-md px-3 py-2 text-xs {eventTintClass(tag)}">
                  <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="font-mono uppercase tracking-wide text-[10px] text-text-primary">
                        {tag}
                      </span>
                      {#if tag === 'StateChanged' && payload && typeof payload === 'object'}
                        {@const p = payload as { from?: string; to?: string }}
                        <span class="text-[10px] text-text-muted">
                          {p.from} → <span class="text-text-primary">{p.to}</span>
                        </span>
                      {:else if tag === 'MessageAdded' && payload && typeof payload === 'object'}
                        {@const p = payload as { role?: string }}
                        <span
                          class="inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide border font-medium {roleBadgeClass(
                            p.role
                          )}"
                        >
                          {p.role}
                        </span>
                      {:else if tag === 'ActionExecuted' && payload && typeof payload === 'object'}
                        {@const p = payload as { action_name?: string; duration_ms?: number }}
                        <span class="text-[10px] text-text-primary font-mono">
                          {p.action_name}
                        </span>
                        {#if p.duration_ms !== undefined}
                          <span class="text-[10px] text-text-muted">
                            {p.duration_ms}ms
                          </span>
                        {/if}
                      {/if}
                    </div>
                    <span
                      class="text-[10px] text-text-muted shrink-0"
                      title={shortTimestamp(e.timestamp)}
                    >
                      {relativeTime(e.timestamp)}
                    </span>
                  </div>

                  {#if tag === 'StepCompleted' && payload && typeof payload === 'object'}
                    {@const p = payload as {
                      step_id?: string;
                      tokens?: {
                        input_tokens?: number;
                        output_tokens?: number;
                        cache_read_tokens?: number;
                        cache_write_tokens?: number;
                        cost_usd?: number;
                      };
                    }}
                    {#if p.tokens}
                      <div
                        class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-text-muted font-mono"
                      >
                        <span>in {fmtTokens(p.tokens.input_tokens)}</span>
                        <span>out {fmtTokens(p.tokens.output_tokens)}</span>
                        {#if p.tokens.cache_read_tokens}
                          <span>cache-r {fmtTokens(p.tokens.cache_read_tokens)}</span>
                        {/if}
                        {#if p.tokens.cache_write_tokens}
                          <span>cache-w {fmtTokens(p.tokens.cache_write_tokens)}</span>
                        {/if}
                        {#if p.tokens.cost_usd !== undefined && p.tokens.cost_usd > 0}
                          <span class="text-text-primary">{fmtCost(p.tokens.cost_usd)}</span>
                        {/if}
                      </div>
                    {/if}
                  {/if}

                  {#if tag === 'ActionExecuted' && payload && typeof payload === 'object'}
                    {@const p = payload as {
                      action_name?: string;
                      call_id?: string;
                      params_summary?: string;
                    }}
                    {#if p.params_summary}
                      <button
                        type="button"
                        onclick={() => toggle(key, false)}
                        class="mt-1 text-[10px] text-text-muted hover:text-accent-cyan transition-colors flex items-center gap-1"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          class="w-3 h-3 transition-transform"
                          class:rotate-90={isOpen(key, false)}
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                        params
                      </button>
                      {#if isOpen(key, false)}
                        <pre
                          class="mt-1 text-[10px] text-text-primary bg-bg-surface border border-border-subtle rounded p-2 whitespace-pre-wrap font-mono overflow-auto max-h-[200px]">{p.params_summary}</pre>
                        {#if p.call_id}
                          <div class="mt-1 text-[10px] text-text-muted font-mono">
                            call_id: {shortId(p.call_id)}
                          </div>
                        {/if}
                      {/if}
                    {/if}
                  {/if}

                  {#if tag === 'MessageAdded' && payload && typeof payload === 'object'}
                    {@const p = payload as { content_preview?: string }}
                    {#if p.content_preview}
                      <div
                        class="mt-1 text-[11px] text-text-muted truncate"
                        title={p.content_preview}
                      >
                        {p.content_preview}
                      </div>
                    {/if}
                  {/if}

                  {#if !['StateChanged', 'MessageAdded', 'StepStarted', 'StepCompleted', 'ActionExecuted'].includes(tag)}
                    <!-- Unknown variant: render the raw payload as JSON. -->
                    <pre
                      class="mt-1 text-[10px] text-text-primary bg-bg-surface border border-border-subtle rounded p-2 whitespace-pre-wrap font-mono overflow-auto max-h-[200px]">{payloadJson(
                        payload
                      )}</pre>
                  {/if}
                </li>
              {:else}
                <!-- Step row (from /steps endpoint). Today this is unreachable
                     since the wire returns []; included so the surface is
                     ready when the gateway lights it up. -->
                {@const s = row.step}
                {@const key = `step-${s.id ?? i}`}
                <li class="border border-border-subtle rounded-md px-3 py-2 text-xs bg-bg-deep">
                  <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="font-mono uppercase tracking-wide text-[10px] text-text-primary">
                        Step{s.step_number !== undefined ? ` ${s.step_number}` : ''}
                      </span>
                      {#if s.kind}
                        <span
                          class="inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide border font-medium {roleBadgeClass(
                            s.kind
                          )}"
                        >
                          {s.kind}
                        </span>
                      {/if}
                      {#if s.tool_name}
                        <span class="text-[10px] text-text-primary font-mono">
                          {s.tool_name}
                        </span>
                      {/if}
                    </div>
                    {#if s.created_at}
                      <span
                        class="text-[10px] text-text-muted shrink-0"
                        title={shortTimestamp(s.created_at)}
                      >
                        {relativeTime(s.created_at)}
                      </span>
                    {/if}
                  </div>

                  {#if s.tokens !== undefined}
                    <div class="mt-1 text-[10px] text-text-muted font-mono">
                      {fmtTokens(s.tokens)} tokens
                    </div>
                  {/if}

                  {#if s.content}
                    <div class="mt-2 text-xs text-text-primary">
                      <MarkdownView markdown={s.content} />
                    </div>
                  {/if}

                  {#if s.tool_args !== undefined}
                    <button
                      type="button"
                      onclick={() => toggle(`${key}-args`, false)}
                      class="mt-1 text-[10px] text-text-muted hover:text-accent-cyan transition-colors flex items-center gap-1"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        class="w-3 h-3 transition-transform"
                        class:rotate-90={isOpen(`${key}-args`, false)}
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                      args
                    </button>
                    {#if isOpen(`${key}-args`, false)}
                      <pre
                        class="mt-1 text-[10px] text-text-primary bg-bg-surface border border-border-subtle rounded p-2 whitespace-pre-wrap font-mono overflow-auto max-h-[200px]">{payloadJson(
                          s.tool_args
                        )}</pre>
                    {/if}
                  {/if}

                  {#if s.tool_result !== undefined}
                    <button
                      type="button"
                      onclick={() => toggle(`${key}-result`, false)}
                      class="mt-1 text-[10px] text-text-muted hover:text-accent-cyan transition-colors flex items-center gap-1"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        class="w-3 h-3 transition-transform"
                        class:rotate-90={isOpen(`${key}-result`, false)}
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                      result
                    </button>
                    {#if isOpen(`${key}-result`, false)}
                      <pre
                        class="mt-1 text-[10px] text-text-primary bg-bg-surface border border-border-subtle rounded p-2 whitespace-pre-wrap font-mono overflow-auto max-h-[200px]">{payloadJson(
                          s.tool_result
                        )}</pre>
                    {/if}
                  {/if}
                </li>
              {/if}
            {/each}
          </ol>
        {/if}
      </section>
    </div>
  </div>
</div>
