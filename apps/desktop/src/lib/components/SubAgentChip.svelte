<script lang="ts">
  // R57 (lane B4): sub-agent task chip. Renders one dispatched
  // background task's live state — queued / running (with streamed
  // progress preview) / succeeded (with a "view result" expand) /
  // failed. Cancel button while in flight.

  import type { SubAgentTask } from '$lib/api/types';
  import { subAgents } from '$lib/stores/sub-agents.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    task: SubAgentTask;
  }

  let { task }: Props = $props();
  let expanded = $state(false);

  const progress = $derived(subAgents.progressFor(task.id));

  function statusLabel(s: SubAgentTask['status']): string {
    return (
      {
        queued: 'queued',
        running: 'working',
        succeeded: 'done',
        failed: 'failed',
        cancelled: 'cancelled'
      } as const
    )[s];
  }

  function dotClass(s: SubAgentTask['status']): string {
    return (
      {
        queued: 'bg-text-muted',
        running: 'bg-accent-cyan',
        succeeded: 'bg-emerald-400',
        failed: 'bg-red-400',
        cancelled: 'bg-text-muted'
      } as const
    )[s];
  }

  const active = $derived(task.status === 'queued' || task.status === 'running');
</script>

<div class="rounded-md border border-border-subtle bg-bg-deep/40 px-3 py-2 text-xs">
  <div class="flex items-center gap-2">
    <span class="relative w-2 h-2 rounded-full {dotClass(task.status)}" aria-hidden="true">
      {#if task.status === 'running'}
        <span class="absolute inset-0 rounded-full bg-accent-cyan animate-ping opacity-70"></span>
      {/if}
    </span>
    <span class="font-medium text-text-primary">Sub-agent</span>
    <span class="text-text-muted">·</span>
    <span class="lowercase text-text-muted">{statusLabel(task.status)}</span>
    <span class="flex-1"></span>
    {#if active}
      <button
        type="button"
        onclick={() => subAgents.cancel(task.id)}
        class="text-text-muted hover:text-red-300 transition-colors"
        aria-label="Cancel sub-agent task"
        title="Cancel"
      >
        <Icon name="close" class="w-3 h-3" />
      </button>
    {/if}
  </div>

  <div class="mt-1 text-text-muted truncate" title={task.prompt}>{task.prompt}</div>

  {#if task.status === 'running' && progress}
    <div class="mt-1 font-mono text-[10px] text-text-muted line-clamp-3 whitespace-pre-wrap">
      {progress}
    </div>
  {/if}

  {#if task.status === 'succeeded' && task.result}
    <button
      type="button"
      onclick={() => (expanded = !expanded)}
      class="mt-1 text-accent-cyan hover:underline"
    >
      {expanded ? 'Hide result' : 'View result'}
    </button>
    {#if expanded}
      <div class="mt-1 text-text-primary whitespace-pre-wrap border-t border-border-subtle pt-1">
        {task.result}
      </div>
    {/if}
  {/if}

  {#if task.status === 'failed' && task.error}
    <div class="mt-1 text-red-300/80">{task.error}</div>
  {/if}
</div>
