<script lang="ts">
  import { onMount } from 'svelte';
  import type { Job, JobDetail, JobEvent, JobFile } from '$lib/api/types';
  import { connection } from '$lib/stores/connection.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  // Routines already ship the same relative/short-timestamp helpers we need.
  // Reusing them keeps formatting consistent across surfaces; the constraint
  // forbids touching other routes' code so we only IMPORT — we don't alter
  // routines/time.ts here.
  import { relativeTime, shortTimestamp, durationBetween } from '../routines/time';

  type Props = {
    job: Job;
    /** Called when the user dismisses the panel. */
    onclose: () => void;
    /** Called after a cancel/restart so the parent list can re-poll. */
    onmutation?: () => void;
  };

  let { job, onclose, onmutation }: Props = $props();

  // ---- Detail load -----------------------------------------------------
  //
  // The list endpoint only returns id/title/state/timestamps; the detail
  // endpoint enriches with transitions + capability flags. We re-fetch
  // detail on identity change so swapping rows from the parent surface
  // updates the panel without remount.

  let detail = $state<JobDetail | null>(null);
  let detailLoading = $state(false);
  let detailError = $state<string | null>(null);

  // ---- Events ----------------------------------------------------------
  //
  // Events are streamed via `streamJobEvents` (which polls under the hood
  // since the gateway exposes events as a JSON GET, not SSE). We keep the
  // last 100 entries in memory and auto-scroll the bottom into view as
  // new rows land. The cap is a soft FIFO — older events drop off so the
  // panel doesn't grow unbounded on a chatty job.

  const EVENT_CAP = 100;
  let events = $state<JobEvent[]>([]);
  let eventsLoading = $state(true);
  let eventsError = $state<string | null>(null);

  let abort: AbortController | null = null;
  let terminalEl: HTMLDivElement | null = $state(null);
  let autoscroll = $state(true);

  // ---- Files -----------------------------------------------------------
  //
  // Files only exist for sandbox jobs (the gateway 404s on agent jobs).
  // We attempt the fetch defensively and treat 404 as "no files".

  let files = $state<JobFile[]>([]);
  let filesLoading = $state(false);
  let filesError = $state<string | null>(null);

  // ---- Mutation state --------------------------------------------------

  let cancelling = $state(false);
  let restarting = $state(false);

  // Reload detail + restart event stream whenever the parent swaps the
  // job. Both branches depend on the same id so we read it once at the
  // top of the effect.
  $effect(() => {
    const id = job.id;
    void loadDetail(id);
    void loadFiles(id);
    startEventStream(id);
  });

  onMount(() => {
    return () => {
      if (abort) {
        abort.abort();
        abort = null;
      }
    };
  });

  async function loadDetail(id: string): Promise<void> {
    const client = connection.client;
    if (!client) {
      detail = null;
      detailError = 'Not connected.';
      return;
    }
    detailLoading = true;
    detailError = null;
    try {
      detail = await client.getJob(id);
    } catch (err) {
      detail = null;
      detailError = (err as Error).message;
    } finally {
      detailLoading = false;
    }
  }

  async function loadFiles(id: string): Promise<void> {
    const client = connection.client;
    if (!client) {
      files = [];
      return;
    }
    filesLoading = true;
    filesError = null;
    try {
      files = await client.getJobFiles(id);
    } catch (err) {
      // 404 is the common path for agent jobs (no project dir); render
      // the empty state without showing an error banner.
      const msg = (err as Error).message ?? '';
      if (/404/.test(msg)) {
        files = [];
        filesError = null;
      } else {
        files = [];
        filesError = msg;
      }
    } finally {
      filesLoading = false;
    }
  }

  function startEventStream(id: string): void {
    // Tear down any in-flight stream from a previous job id.
    if (abort) abort.abort();
    abort = new AbortController();
    events = [];
    eventsLoading = true;
    eventsError = null;
    const signal = abort.signal;
    const client = connection.client;
    if (!client) {
      eventsError = 'Not connected.';
      eventsLoading = false;
      return;
    }
    void (async () => {
      try {
        for await (const evt of client.streamJobEvents(id, signal)) {
          if (signal.aborted) return;
          // Append + cap at EVENT_CAP. Mutating in place is fine here —
          // Svelte 5 reactivity on `$state` arrays picks up `push` via the
          // proxy, but reassigning the slice makes intent explicit.
          const next = events.concat(evt);
          events = next.length > EVENT_CAP ? next.slice(-EVENT_CAP) : next;
          eventsLoading = false;
          if (autoscroll && terminalEl) {
            // Use rAF so the new row lays out before we scroll. This
            // avoids the visible jump that happens when scrolling
            // before the DOM updates.
            requestAnimationFrame(() => {
              terminalEl?.scrollTo({ top: terminalEl.scrollHeight });
            });
          }
        }
      } catch (err) {
        if (!signal.aborted) {
          eventsError = (err as Error).message;
        }
      } finally {
        eventsLoading = false;
      }
    })();
  }

  async function onCancel(): Promise<void> {
    const client = connection.client;
    if (!client || cancelling) return;
    cancelling = true;
    try {
      const res = await client.cancelJob(job.id);
      if (!res.ok) throw new Error('Server did not confirm cancel.');
      toasts.show(`Cancelled job ${shortId(job.id)}`, 'success');
      onmutation?.();
      // Refresh local detail so the state/transitions reflect cancellation.
      void loadDetail(job.id);
    } catch (err) {
      toasts.show(`Cancel failed: ${(err as Error).message}`, 'error');
    } finally {
      cancelling = false;
    }
  }

  async function onRestart(): Promise<void> {
    const client = connection.client;
    if (!client || restarting) return;
    restarting = true;
    try {
      const res = await client.restartJob(job.id);
      if (!res.ok) throw new Error('Server did not confirm restart.');
      toasts.show(`Restarted job ${shortId(job.id)}`, 'success');
      onmutation?.();
      void loadDetail(job.id);
    } catch (err) {
      toasts.show(`Restart failed: ${(err as Error).message}`, 'error');
    } finally {
      restarting = false;
    }
  }

  function shortId(id: string): string {
    return id.length > 12 ? `${id.slice(0, 8)}…` : id;
  }

  function stateBadgeClass(state: string): string {
    switch (state) {
      case 'completed':
        return 'bg-green-500/10 text-green-400 border-green-500/30';
      case 'failed':
        return 'bg-red-500/10 text-red-400 border-red-500/30';
      case 'cancelled':
        return 'bg-text-muted/10 text-text-muted border-text-muted/30';
      case 'in_progress':
      case 'running':
        return 'bg-accent-gold/10 text-accent-gold border-accent-gold/30';
      case 'stuck':
        return 'bg-orange-500/10 text-orange-400 border-orange-500/30';
      case 'pending':
      default:
        return 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30';
    }
  }

  // Render an event's payload as a one-line JSON preview that can be
  // expanded inline. We keep payloads collapsed by default to keep the
  // terminal-style list compact; clicking the line toggles the full
  // pretty-printed dump.
  let expandedKey = $state<string | null>(null);

  function eventKey(evt: JobEvent): string {
    return evt.id ?? `${evt.event_type}@${evt.created_at}`;
  }

  function previewPayload(payload: unknown): string {
    if (payload === undefined || payload === null) return '';
    try {
      const s = JSON.stringify(payload);
      if (!s) return '';
      return s.length <= 120 ? s : `${s.slice(0, 120)}…`;
    } catch {
      return String(payload);
    }
  }

  function prettyPayload(payload: unknown): string {
    if (payload === undefined || payload === null) return '';
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return String(payload);
    }
  }

  function fmtBytes(b?: number): string {
    if (b === undefined || b === null) return '';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  }

  // Best-effort link from a sandbox job to the underlying agent thread.
  // The IronClaw gateway does NOT today populate a `thread_id` on jobs —
  // the brief asked for "Open thread (if thread_id)" but per the canonical
  // `JobDetailResponse` shape there is no such field. We keep the button
  // here as a placeholder gated on `browse_url`, which is the closest
  // analogue (the in-gateway projects view). Once the server emits a
  // thread/chat link we'll widen this.
  const hasBrowseLink = $derived(detail?.browse_url !== undefined);
</script>

<!-- Slide-in panel: fixed to the right edge, occupies 40% of viewport.
     Mirrors the routines DetailPanel pattern for visual consistency. -->
<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<aside
  class="fixed top-0 right-0 h-screen w-2/5 min-w-[480px] bg-bg-surface border-l border-border-subtle z-40 flex flex-col shadow-2xl"
  role="dialog"
  aria-modal="true"
  aria-label="Job detail"
>
  <header class="px-6 py-5 border-b border-border-subtle flex items-start justify-between gap-4">
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2 mb-2">
        <span
          class="inline-block px-2 py-0.5 rounded text-[10px] uppercase tracking-wide border font-medium {stateBadgeClass(
            detail?.state ?? job.state
          )}"
        >
          {detail?.state ?? job.state}
        </span>
        {#if detail?.job_kind}
          <span class="text-[10px] uppercase tracking-wide text-text-muted font-mono">
            {detail.job_kind}
          </span>
        {/if}
      </div>
      <h2
        class="text-lg font-semibold text-text-primary truncate"
        title={detail?.title ?? job.title}
      >
        {detail?.title || job.title || 'Untitled job'}
      </h2>
      <div class="mt-1 text-[11px] font-mono text-text-muted truncate" title={job.id}>
        {job.id}
      </div>
      <dl class="mt-4 text-xs space-y-1.5">
        <div class="flex items-center gap-2">
          <dt class="text-text-muted w-24 shrink-0">Created</dt>
          <dd class="text-text-primary">{shortTimestamp(detail?.created_at ?? job.created_at)}</dd>
        </div>
        {#if detail?.started_at ?? job.started_at}
          <div class="flex items-center gap-2">
            <dt class="text-text-muted w-24 shrink-0">Started</dt>
            <dd class="text-text-primary">
              {shortTimestamp(detail?.started_at ?? job.started_at)}
            </dd>
          </div>
        {/if}
        {#if detail?.completed_at}
          <div class="flex items-center gap-2">
            <dt class="text-text-muted w-24 shrink-0">Completed</dt>
            <dd class="text-text-primary">{shortTimestamp(detail.completed_at)}</dd>
          </div>
        {/if}
        {#if detail?.elapsed_secs !== undefined}
          <div class="flex items-center gap-2">
            <dt class="text-text-muted w-24 shrink-0">Elapsed</dt>
            <dd class="text-text-primary">
              {durationBetween(
                detail.started_at ?? detail.created_at,
                detail.completed_at ?? new Date().toISOString()
              )}
            </dd>
          </div>
        {/if}
        {#if detail?.job_mode}
          <div class="flex items-center gap-2">
            <dt class="text-text-muted w-24 shrink-0">Mode</dt>
            <dd class="text-text-primary font-mono">{detail.job_mode}</dd>
          </div>
        {/if}
        {#if detail?.user_id ?? job.user_id}
          <div class="flex items-center gap-2">
            <dt class="text-text-muted w-24 shrink-0">User</dt>
            <dd class="text-text-primary font-mono truncate">{detail?.user_id ?? job.user_id}</dd>
          </div>
        {/if}
      </dl>
    </div>

    <button
      type="button"
      onclick={onclose}
      class="text-text-muted hover:text-text-primary transition-colors p-1 -m-1"
      aria-label="Close detail panel"
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
  </header>

  <!-- Action bar: cancel (running) / restart (failed) / browse (sandbox). -->
  <div class="px-6 py-3 border-b border-border-subtle flex items-center gap-2 flex-wrap">
    {#if (detail?.state ?? job.state) === 'in_progress' || (detail?.state ?? job.state) === 'running' || (detail?.state ?? job.state) === 'pending'}
      <button
        type="button"
        onclick={() => void onCancel()}
        disabled={cancelling}
        class="px-3 py-1.5 rounded-md border border-red-500/40 text-red-400 text-xs hover:bg-red-500/10 transition-colors disabled:opacity-50 min-h-[32px]"
      >
        {cancelling ? 'Cancelling…' : 'Cancel job'}
      </button>
    {/if}
    {#if detail?.can_restart && (detail.state === 'failed' || detail.state === 'cancelled' || detail.state === 'stuck')}
      <button
        type="button"
        onclick={() => void onRestart()}
        disabled={restarting}
        class="px-3 py-1.5 rounded-md border border-accent-cyan text-accent-cyan text-xs hover:bg-accent-cyan/10 transition-colors disabled:opacity-50 min-h-[32px]"
      >
        {restarting ? 'Restarting…' : 'Restart'}
      </button>
    {/if}
    {#if hasBrowseLink}
      <!-- The gateway emits a relative `browse_url` (`/projects/<id>/`)
           pointing at its own static UI. The desktop client doesn't host
           that surface, but exposing the path is still useful for users
           who want to copy/open it manually. We render a copy button
           rather than a link to avoid navigating away inside the Tauri
           webview. -->
      <button
        type="button"
        onclick={() => {
          if (!detail?.browse_url) return;
          const full = `${connection.baseUrl}${detail.browse_url}`;
          void navigator.clipboard?.writeText(full).then(() => {
            toasts.show('Copied project URL', 'success');
          });
        }}
        class="px-3 py-1.5 rounded-md border border-border-subtle text-text-muted text-xs hover:border-accent-cyan hover:text-accent-cyan transition-colors min-h-[32px]"
        title="Copy gateway project URL"
      >
        Copy project URL
      </button>
    {/if}
    {#if detailLoading && !detail}
      <span class="text-xs text-text-muted">Loading detail…</span>
    {/if}
    {#if detailError}
      <span class="text-xs text-red-400" title={detailError}>Detail error</span>
    {/if}
  </div>

  <div class="flex-1 overflow-auto px-6 py-5 space-y-6">
    <!-- Transitions timeline (compact). Skipped when empty so agent jobs
         that haven't transitioned yet don't show a stranded header. -->
    {#if detail && detail.transitions.length > 0}
      <section>
        <h3 class="text-xs font-semibold uppercase tracking-wider text-text-muted mb-2">
          Transitions
        </h3>
        <ol class="space-y-1.5 text-xs">
          {#each detail.transitions as t, i (i)}
            <li class="flex items-baseline gap-2">
              <span class="text-text-muted font-mono shrink-0">{shortTimestamp(t.timestamp)}</span>
              <span class="text-text-primary">
                <span class="text-text-muted">{t.from}</span>
                <span class="mx-1 text-text-muted">→</span>
                <span class="font-semibold">{t.to}</span>
              </span>
              {#if t.reason}
                <span class="text-red-400 truncate" title={t.reason}>{t.reason}</span>
              {/if}
            </li>
          {/each}
        </ol>
      </section>
    {/if}

    <!-- Event stream. Auto-scrolls when `autoscroll` is on. -->
    <section>
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-text-muted">
          Event stream
          {#if events.length > 0}
            <span class="ml-2 font-mono normal-case text-text-muted/70 tracking-normal">
              ({events.length}{events.length >= EVENT_CAP ? '+' : ''})
            </span>
          {/if}
        </h3>
        <label
          class="flex items-center gap-1.5 text-[11px] text-text-muted cursor-pointer select-none"
        >
          <input type="checkbox" bind:checked={autoscroll} class="accent-accent-cyan" />
          Autoscroll
        </label>
      </div>

      <div
        bind:this={terminalEl}
        class="bg-bg-deep border border-border-subtle rounded-md p-3 h-64 overflow-auto font-mono text-[11px] leading-relaxed"
      >
        {#if eventsError}
          <div class="text-red-400">{eventsError}</div>
        {:else if eventsLoading && events.length === 0}
          <div class="text-text-muted">Waiting for events…</div>
        {:else if events.length === 0}
          <div class="text-text-muted">No events yet</div>
        {:else}
          {#each events as evt (eventKey(evt))}
            {@const key = eventKey(evt)}
            {@const expanded = expandedKey === key}
            {@const preview = previewPayload(evt.data)}
            <div class="border-b border-border-subtle/40 py-1 last:border-b-0">
              <button
                type="button"
                class="w-full text-left flex items-baseline gap-2 hover:bg-bg-surface/50 -mx-1 px-1 rounded transition-colors"
                onclick={() => (expandedKey = expanded ? null : key)}
                aria-expanded={expanded}
              >
                <span class="text-text-muted shrink-0">{shortTimestamp(evt.created_at)}</span>
                <span class="text-accent-cyan shrink-0">{evt.event_type}</span>
                {#if preview}
                  <span class="text-text-primary truncate flex-1">{preview}</span>
                {/if}
              </button>
              {#if expanded && evt.data !== undefined && evt.data !== null}
                <pre
                  class="mt-1 ml-4 whitespace-pre-wrap text-text-primary bg-bg-surface/50 rounded px-2 py-1 border border-border-subtle/40">{prettyPayload(
                    evt.data
                  )}</pre>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </section>

    <!-- Files section. Only meaningful for sandbox jobs; agent jobs see
         the empty state since the gateway 404s and we suppress that. -->
    <section>
      <h3 class="text-xs font-semibold uppercase tracking-wider text-text-muted mb-2">
        Files
        {#if files.length > 0}
          <span class="ml-2 font-mono normal-case text-text-muted/70 tracking-normal">
            ({files.length})
          </span>
        {/if}
      </h3>

      {#if filesError}
        <div class="text-xs text-red-400">{filesError}</div>
      {:else if filesLoading && files.length === 0}
        <div class="text-xs text-text-muted">Loading files…</div>
      {:else if files.length === 0}
        <div class="text-xs text-text-muted">
          {#if detail?.job_kind === 'agent'}
            Agent jobs produce no files
          {:else}
            No files in this job's workspace
          {/if}
        </div>
      {:else}
        <ul class="text-xs space-y-0.5">
          {#each files as f (f.path)}
            <li
              class="flex items-center gap-2 px-2 py-1 rounded hover:bg-bg-deep/50 transition-colors"
            >
              <span class="shrink-0 text-text-muted">
                {#if f.is_dir}
                  <svg
                    viewBox="0 0 24 24"
                    class="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path
                      d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
                    />
                  </svg>
                {:else}
                  <svg
                    viewBox="0 0 24 24"
                    class="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                {/if}
              </span>
              <span class="flex-1 truncate text-text-primary" title={f.path}>{f.name}</span>
              {#if !f.is_dir && f.size !== undefined}
                <span class="text-[10px] text-text-muted font-mono">{fmtBytes(f.size)}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</aside>
