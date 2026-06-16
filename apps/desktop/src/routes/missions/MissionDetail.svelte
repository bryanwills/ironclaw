<script lang="ts">
  // Engine v2 mission detail panel.
  //
  // Slides in from the right edge (40% width, mirrors JobDetailPanel /
  // routines DetailPanel so muscle memory transfers). Shows:
  //   - Mission name + status badge + cadence + timestamps
  //   - The full `goal` body (often markdown — we render as a styled
  //     monospace block for v1; markdown rendering can land in v1.1)
  //   - The engine threads scoped to this mission, filtered from the
  //     listEngineThreads() payload the parent passes in (the wire row
  //     does not include mission_id today; once it does the filter is
  //     trivial).
  //
  // Thread rows are click-to-toast — the brief explicitly defers thread
  // detail navigation to v1.1, so the click confirms the row is
  // interactive without bouncing the user out of the missions surface.

  import type { EngineMission, EngineThread } from '$lib/api/types';
  // Reuse the relative-time + short-timestamp helpers from routines —
  // they're stateless string formatters and importing keeps the look
  // consistent across the app. The file-scope constraint forbids
  // mutating other routes; importing a pure helper is fine.
  import { relativeTime, shortTimestamp } from '../routines/time';
  import EngineThreadDetail from './EngineThreadDetail.svelte';

  type Props = {
    mission: EngineMission;
    /** Engine threads for the active gateway, supplied by the parent so
     *  we share the single listEngineThreads() poll. The component
     *  filters down to `t.mission_id === mission.id` itself. */
    threads: EngineThread[];
    onclose: () => void;
  };

  let { mission, threads, onclose }: Props = $props();

  /** Threads belonging to this mission. The wire today does not emit
   *  `mission_id` on thread rows, so this is most often empty — the
   *  empty-state copy spells that out so the user doesn't read a 0
   *  thread count as a bug. Once the gateway lights the field up the
   *  filter is correct without a client change. */
  const missionThreads = $derived<EngineThread[]>(
    threads.filter((t) => typeof t.mission_id === 'string' && t.mission_id === mission.id)
  );

  /** Display name. Prefer `title` (display) over `name` (slug) when both
   *  are present, falling back to the id when neither is set. Keeps the
   *  header readable on the common case (`name = "conversation-insights"`)
   *  while leaving room for a richer title once the gateway emits one. */
  const displayName = $derived<string>(mission.title?.trim() || mission.name?.trim() || mission.id);

  /** Status palette matches the list page so the badge in the panel
   *  reads as the same lifecycle marker. Active=cyan, paused=gold,
   *  completed=green, failed=red, pending=muted, anything else=neutral. */
  function statusBadgeClass(status: string | undefined): string {
    const s = (status ?? '').toLowerCase();
    switch (s) {
      case 'active':
        return 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30';
      case 'paused':
        return 'bg-accent-gold/10 text-accent-gold border-accent-gold/30';
      case 'completed':
        return 'bg-green-500/10 text-green-400 border-green-500/30';
      case 'failed':
        return 'bg-red-500/10 text-red-400 border-red-500/30';
      case 'pending':
        return 'bg-text-muted/10 text-text-muted border-text-muted/30';
      default:
        return 'bg-bg-deep text-text-muted border-border-subtle';
    }
  }

  /** Engine threads carry an execution lifecycle distinct from missions
   *  (Pending / Running / Done / Failed). Use the same palette so a
   *  Running thread reads gold like a Running job in /jobs. */
  function threadStateBadgeClass(state: string | undefined): string {
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
        return 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30';
      default:
        return 'bg-bg-deep text-text-muted border-border-subtle';
    }
  }

  /** Compact thread title. Prefer wire `title`, fall back to the first
   *  ~80 chars of `goal` so the row still reads as something other than
   *  a bare UUID when the gateway omits a title. */
  function threadTitle(t: EngineThread): string {
    if (t.title && t.title.trim().length > 0) return t.title.trim();
    if (t.goal && t.goal.trim().length > 0) {
      const firstLine = t.goal.trim().split('\n')[0];
      return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
    }
    return t.id;
  }

  function shortId(id: string): string {
    return id.length > 12 ? `${id.slice(0, 8)}…` : id;
  }

  /** The thread row currently expanded into the EngineThreadDetail overlay.
   *  Selection is local to this component — opening a thread doesn't close
   *  the mission drawer behind us, so closing the overlay returns the user
   *  to the same mission context. */
  let selectedThread = $state<EngineThread | null>(null);

  function onThreadClick(t: EngineThread): void {
    selectedThread = t;
  }

  function closeThreadDetail(): void {
    selectedThread = null;
  }

  /** Compact token formatter — 12_345 → "12.3k" — so the thread row
   *  stays readable when long-running missions rack up large totals. */
  function fmtTokens(n: number | undefined): string {
    if (n === undefined || n === null) return '0';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
</script>

<!-- Slide-in panel: fixed to the right edge, 40% viewport (min 480px).
     Mirrors the JobDetailPanel layout so the missions surface fits the
     existing visual language. -->
<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<aside
  class="fixed top-0 right-0 h-screen w-2/5 min-w-[480px] bg-bg-surface border-l border-border-subtle z-40 flex flex-col shadow-2xl"
  role="dialog"
  aria-modal="true"
  aria-label="Mission detail"
>
  <header class="px-6 py-5 border-b border-border-subtle flex items-start justify-between gap-4">
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2 mb-2">
        <span
          class="inline-block px-2 py-0.5 rounded text-[10px] uppercase tracking-wide border font-medium {statusBadgeClass(
            mission.status
          )}"
        >
          {mission.status ?? 'unknown'}
        </span>
        {#if mission.cadence_type}
          <span class="text-[10px] uppercase tracking-wide text-text-muted font-mono">
            {mission.cadence_type}
          </span>
        {/if}
      </div>
      <h2 class="text-lg font-semibold text-text-primary truncate" title={displayName}>
        {displayName}
      </h2>
      <div class="mt-1 text-[11px] font-mono text-text-muted truncate" title={mission.id}>
        {mission.id}
      </div>
      <dl class="mt-4 text-xs space-y-1.5">
        {#if mission.cadence_description}
          <div class="flex items-start gap-2">
            <dt class="text-text-muted w-24 shrink-0">Cadence</dt>
            <dd class="text-text-primary">{mission.cadence_description}</dd>
          </div>
        {/if}
        {#if mission.project_id}
          <div class="flex items-center gap-2">
            <dt class="text-text-muted w-24 shrink-0">Project</dt>
            <dd class="text-text-primary font-mono truncate" title={mission.project_id}>
              {shortId(mission.project_id)}
            </dd>
          </div>
        {/if}
        {#if mission.created_at}
          <div class="flex items-center gap-2">
            <dt class="text-text-muted w-24 shrink-0">Created</dt>
            <dd class="text-text-primary" title={shortTimestamp(mission.created_at)}>
              {shortTimestamp(mission.created_at)}
            </dd>
          </div>
        {/if}
        {#if mission.updated_at}
          <div class="flex items-center gap-2">
            <dt class="text-text-muted w-24 shrink-0">Updated</dt>
            <dd class="text-text-primary" title={shortTimestamp(mission.updated_at)}>
              {relativeTime(mission.updated_at)}
            </dd>
          </div>
        {/if}
        <div class="flex items-center gap-2">
          <dt class="text-text-muted w-24 shrink-0">Threads</dt>
          <dd class="text-text-primary">
            {mission.thread_count ?? 0}
          </dd>
        </div>
      </dl>
    </div>

    <button
      type="button"
      onclick={onclose}
      class="text-text-muted hover:text-text-primary transition-colors p-1 -m-1"
      aria-label="Close mission detail panel"
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

  <!-- Body: goal + threads. The panel scrolls as a single column so a
       multi-page goal doesn't push the thread list off-screen. -->
  <div class="flex-1 overflow-auto px-6 py-5 space-y-6">
    <section>
      <h3 class="text-xs uppercase tracking-wide text-text-muted mb-2">Goal</h3>
      {#if mission.goal && mission.goal.trim().length > 0}
        <pre
          class="text-xs text-text-primary bg-bg-deep border border-border-subtle rounded-md p-3 whitespace-pre-wrap font-mono leading-relaxed">{mission.goal.trim()}</pre>
      {:else}
        <p class="text-xs text-text-muted italic">No goal recorded</p>
      {/if}
    </section>

    <section>
      <h3 class="text-xs uppercase tracking-wide text-text-muted mb-2">
        Engine threads
        {#if missionThreads.length > 0}
          <span class="text-text-primary">({missionThreads.length})</span>
        {/if}
      </h3>
      {#if missionThreads.length === 0}
        <p class="text-xs text-text-muted italic">No threads recorded</p>
      {:else}
        <ul class="space-y-2">
          {#each missionThreads as thread (thread.id)}
            <li>
              <button
                type="button"
                onclick={() => onThreadClick(thread)}
                class="w-full text-left bg-bg-deep border border-border-subtle hover:border-accent-cyan rounded-md p-3 transition-colors"
                title={thread.goal ?? thread.title ?? thread.id}
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <div class="text-sm text-text-primary truncate">
                      {threadTitle(thread)}
                    </div>
                    <div class="mt-1 text-[10px] font-mono text-text-muted">
                      {shortId(thread.id)}
                    </div>
                  </div>
                  <span
                    class="inline-block shrink-0 px-2 py-0.5 rounded text-[10px] uppercase tracking-wide border font-medium {threadStateBadgeClass(
                      thread.state
                    )}"
                  >
                    {thread.state ?? 'unknown'}
                  </span>
                </div>
                <div class="mt-2 flex items-center gap-3 text-[10px] text-text-muted">
                  {#if thread.thread_type}
                    <span class="font-mono uppercase tracking-wide">
                      {thread.thread_type}
                    </span>
                  {/if}
                  <span>{thread.step_count ?? 0} steps</span>
                  <span>{fmtTokens(thread.total_tokens)} tokens</span>
                </div>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</aside>

{#if selectedThread}
  <EngineThreadDetail thread={selectedThread} onclose={closeThreadDetail} />
{/if}
