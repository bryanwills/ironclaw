<script lang="ts">
  import type { Routine, RoutineRun } from '$lib/api/types';
  import { connection } from '$lib/stores/connection.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import CronPreview from '$lib/components/CronPreview.svelte';
  import { durationBetween, relativeTime, shortTimestamp } from './time';

  type Props = {
    routine: Routine;
    onclose: () => void;
  };

  let { routine, onclose }: Props = $props();

  let runs = $state<RoutineRun[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let expandedRunId = $state<string | null>(null);

  // Re-fetch runs whenever the routine identity changes. Using $effect lets
  // the parent swap routines without remounting the panel.
  $effect(() => {
    void loadRuns(routine.id);
  });

  async function loadRuns(id: string) {
    const client = connection.client;
    if (!client) {
      runs = [];
      loadError = 'Not connected.';
      return;
    }
    loading = true;
    loadError = null;
    try {
      runs = await client.getRoutineRuns(id, 20);
    } catch (err) {
      loadError = (err as Error).message;
      toasts.show(`Failed to load runs: ${loadError}`, 'error');
    } finally {
      loading = false;
    }
  }

  function toggleExpanded(id: string) {
    expandedRunId = expandedRunId === id ? null : id;
  }

  function statusClasses(status: RoutineRun['status']): string {
    switch (status) {
      case 'success':
        return 'bg-green-500/10 text-green-400 border-green-500/30';
      case 'failed':
        return 'bg-red-500/10 text-red-400 border-red-500/30';
      case 'running':
      default:
        return 'bg-accent-gold/10 text-accent-gold border-accent-gold/30';
    }
  }

  function previewOutput(output?: string): string {
    if (!output) return '(no output)';
    const trimmed = output.trim();
    if (trimmed.length <= 100) return trimmed;
    return trimmed.slice(0, 100) + '…';
  }
</script>

<!-- Slide-in panel: fixed to the right edge, occupies 40% of viewport. -->
<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<aside
  class="fixed top-0 right-0 h-screen w-2/5 min-w-[420px] bg-bg-surface border-l border-border-subtle z-40 flex flex-col shadow-2xl"
  role="dialog"
  aria-modal="true"
  aria-label="Routine detail"
>
  <header class="px-6 py-5 border-b border-border-subtle flex items-start justify-between gap-4">
    <div class="min-w-0">
      <h2 class="text-lg font-semibold text-text-primary truncate">{routine.name}</h2>
      <dl class="mt-2 text-xs space-y-1">
        <div class="flex items-start gap-2">
          <dt class="text-text-muted w-20 shrink-0 mt-px">Schedule</dt>
          <dd class="min-w-0 flex flex-col gap-0.5">
            <span class="text-text-primary font-mono truncate">{routine.schedule || '—'}</span>
            <!-- Human-readable preview of the cron expression. -->
            <CronPreview expr={routine.schedule} />
          </dd>
        </div>
        <div class="flex items-center gap-2">
          <dt class="text-text-muted w-20">Enabled</dt>
          <dd
            class="font-medium"
            class:text-accent-cyan={routine.enabled}
            class:text-text-muted={!routine.enabled}
          >
            {routine.enabled ? 'Yes' : 'No'}
          </dd>
        </div>
        <div class="flex items-center gap-2">
          <dt class="text-text-muted w-20">Last run</dt>
          <dd class="text-text-primary">{relativeTime(routine.last_run)}</dd>
        </div>
        <div class="flex items-center gap-2">
          <dt class="text-text-muted w-20">Next run</dt>
          <dd class="text-text-primary">{relativeTime(routine.next_run)}</dd>
        </div>
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

  <div class="flex-1 overflow-auto px-6 py-5">
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-semibold text-text-primary">Recent runs</h3>
      <button
        type="button"
        onclick={() => void loadRuns(routine.id)}
        disabled={loading}
        class="text-xs text-text-muted hover:text-accent-cyan transition-colors disabled:opacity-50"
      >
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>

    {#if loadError}
      <div class="text-xs text-red-400 py-3">{loadError}</div>
    {:else if loading && runs.length === 0}
      <div class="text-xs text-text-muted py-6 text-center">Loading runs…</div>
    {:else if runs.length === 0}
      <div class="text-xs text-text-muted py-6 text-center">No runs recorded</div>
    {:else}
      <table class="w-full text-xs">
        <thead>
          <tr class="text-left text-text-muted border-b border-border-subtle">
            <th class="font-medium py-2 pr-3">Started</th>
            <th class="font-medium py-2 pr-3">Duration</th>
            <th class="font-medium py-2 pr-3">Status</th>
            <th class="font-medium py-2">Output</th>
          </tr>
        </thead>
        <tbody>
          {#each runs as run (run.id)}
            {@const expanded = expandedRunId === run.id}
            <tr class="border-b border-border-subtle/40 align-top">
              <td class="py-2.5 pr-3 text-text-primary font-mono whitespace-nowrap">
                {shortTimestamp(run.started_at)}
              </td>
              <td class="py-2.5 pr-3 text-text-muted whitespace-nowrap">
                {durationBetween(run.started_at, run.finished_at)}
              </td>
              <td class="py-2.5 pr-3">
                <span
                  class="inline-block px-2 py-0.5 rounded text-[10px] uppercase tracking-wide border {statusClasses(
                    run.status
                  )}"
                >
                  {run.status}
                </span>
              </td>
              <td class="py-2.5">
                {#if run.output && run.output.trim().length > 0}
                  <button
                    type="button"
                    onclick={() => toggleExpanded(run.id)}
                    class="text-left text-text-primary hover:text-accent-cyan transition-colors w-full"
                    aria-expanded={expanded}
                  >
                    {#if expanded}
                      <pre
                        class="font-mono text-[11px] whitespace-pre-wrap text-text-primary bg-bg-deep border border-border-subtle rounded p-2 leading-snug">{run.output}</pre>
                    {:else}
                      <span class="font-mono text-[11px] text-text-muted"
                        >{previewOutput(run.output)}</span
                      >
                    {/if}
                  </button>
                {:else}
                  <span class="text-text-muted">—</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</aside>
