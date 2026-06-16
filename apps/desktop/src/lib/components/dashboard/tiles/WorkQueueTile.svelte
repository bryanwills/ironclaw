<script lang="ts">
  // WorkQueueTile — the Today command-center view of durable matters.
  // It reads the same local Work Object Spine that /work owns, so Today can
  // surface what needs a decision without making the user rediscover it in chat.

  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    domainLabel,
    statusLabel,
    type WorkItem,
    type WorkItemStatus
  } from '$lib/data/work-item';
  import { workItems } from '$lib/stores/work-items.svelte';
  import Icon from '$lib/components/Icon.svelte';

  onMount(() => workItems.hydrate());

  const liveItems = $derived(
    workItems.items.filter((item) => item.status !== 'done' && item.status !== 'archived')
  );

  const pendingApprovals = $derived(
    liveItems.reduce((count, item) => {
      const boundaryCount = item.approvalBoundaries.filter(
        (gate) => gate.status === 'pending'
      ).length;
      return (
        count + (boundaryCount > 0 ? boundaryCount : item.status === 'waiting-approval' ? 1 : 0)
      );
    }, 0)
  );

  const blockedCount = $derived(
    liveItems.filter(
      (item) => item.status === 'blocked' || item.dossier.some((entry) => entry.state === 'missing')
    ).length
  );

  const activeWatches = $derived(
    liveItems.reduce(
      (count, item) => count + item.watches.filter((watch) => watch.status === 'active').length,
      0
    )
  );

  const readyArtifacts = $derived(
    liveItems.reduce(
      (count, item) =>
        count + item.artifacts.filter((artifact) => artifact.status === 'ready').length,
      0
    )
  );

  const priorityItems = $derived.by<WorkItem[]>(() =>
    [...liveItems].sort((a, b) => priorityScore(a) - priorityScore(b)).slice(0, 4)
  );

  function priorityScore(item: WorkItem): number {
    if (item.approvalBoundaries.some((gate) => gate.status === 'pending')) return 0;
    if (item.status === 'waiting-approval') return 1;
    if (item.status === 'blocked') return 2;
    if (item.dossier.some((entry) => entry.state === 'missing')) return 3;
    if (item.nextAction) return 4;
    return 5;
  }

  function statusClass(status: WorkItemStatus): string {
    switch (status) {
      case 'waiting-approval':
        return 'border-accent-gold/40 bg-accent-gold/10 text-accent-gold';
      case 'blocked':
        return 'border-danger/40 bg-danger-soft text-danger';
      case 'done':
        return 'border-positive/40 bg-positive-soft text-positive';
      case 'archived':
        return 'border-border-subtle bg-bg-base text-text-muted';
      case 'active':
      default:
        return 'border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan';
    }
  }

  function updatedLabel(item: WorkItem): string {
    const date = new Date(item.updated_at || item.created_at);
    if (Number.isNaN(date.getTime())) return 'Updated recently';
    return `Updated ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  }

  function openWork(id?: string): void {
    void goto(id ? `/work?item=${encodeURIComponent(id)}` : '/work');
  }
</script>

<div class="flex h-full flex-col gap-3" data-testid="work-queue-tile">
  <div class="grid grid-cols-4 gap-2">
    <button
      type="button"
      onclick={() => openWork()}
      class="min-h-[64px] rounded-md border border-border-subtle bg-bg-base/50 px-3 py-2 text-left transition-colors hover:border-accent-cyan/40 hover:bg-bg-base"
      aria-label="Open all live work"
    >
      <span class="block text-lg font-semibold text-text-primary">{liveItems.length}</span>
      <span class="block text-[11px] text-text-muted">Live</span>
    </button>
    <button
      type="button"
      onclick={() => openWork()}
      class="min-h-[64px] rounded-md border border-border-subtle bg-bg-base/50 px-3 py-2 text-left transition-colors hover:border-accent-gold/40 hover:bg-bg-base"
      aria-label="Open work waiting on approval"
    >
      <span class="block text-lg font-semibold text-accent-gold">{pendingApprovals}</span>
      <span class="block text-[11px] text-text-muted">Approvals</span>
    </button>
    <button
      type="button"
      onclick={() => openWork()}
      class="min-h-[64px] rounded-md border border-border-subtle bg-bg-base/50 px-3 py-2 text-left transition-colors hover:border-danger/40 hover:bg-bg-base"
      aria-label="Open blocked work"
    >
      <span class="block text-lg font-semibold text-danger">{blockedCount}</span>
      <span class="block text-[11px] text-text-muted">Blocked</span>
    </button>
    <button
      type="button"
      onclick={() => openWork()}
      class="min-h-[64px] rounded-md border border-border-subtle bg-bg-base/50 px-3 py-2 text-left transition-colors hover:border-accent-cyan/40 hover:bg-bg-base"
      aria-label="Open watched work"
    >
      <span class="block text-lg font-semibold text-text-primary">{activeWatches}</span>
      <span class="block text-[11px] text-text-muted">Watches</span>
    </button>
  </div>

  {#if priorityItems.length > 0}
    <ul class="min-h-0 flex-1 space-y-1.5 overflow-auto" data-testid="work-queue-list">
      {#each priorityItems as item (item.id)}
        <li>
          <button
            type="button"
            onclick={() => openWork(item.id)}
            class="group grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-bg-base/60"
            aria-label="Open work item {item.title}"
          >
            <span class="min-w-0">
              <span class="block truncate text-sm font-semibold text-text-primary">
                {item.title}
              </span>
              <span class="mt-0.5 block truncate text-xs text-text-muted">
                {item.nextAction ?? item.objective ?? updatedLabel(item)}
              </span>
            </span>
            <span class="flex shrink-0 items-center gap-1.5">
              {#if item.artifacts.some((artifact) => artifact.status === 'ready')}
                <span
                  class="rounded border border-positive/35 bg-positive-soft px-1.5 py-0.5 text-[10px] font-semibold text-positive"
                  title="Ready artifact"
                >
                  Artifact
                </span>
              {/if}
              <span
                class="rounded border px-1.5 py-0.5 text-[10px] font-semibold {statusClass(
                  item.status
                )}"
              >
                {statusLabel(item.status)}
              </span>
            </span>
            <span class="col-span-2 flex min-w-0 items-center gap-2 text-[11px] text-text-muted">
              <span>{domainLabel(item.domain)}</span>
              {#if item.approvalBoundaries.some((gate) => gate.status === 'pending')}
                <span class="text-accent-gold">Needs approval</span>
              {/if}
              {#if item.dossier.some((entry) => entry.state === 'missing')}
                <span class="text-danger">Missing context</span>
              {/if}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <div
      class="flex min-h-[116px] flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-subtle bg-bg-base/30 px-4 text-center"
    >
      <Icon name="list" class="h-4 w-4 text-text-muted" />
      <p class="text-sm font-semibold text-text-primary">No live work yet</p>
      <p class="max-w-md text-xs leading-5 text-text-muted">
        A work item holds the objective, context, approvals, artifacts, and watches in one place.
      </p>
    </div>
  {/if}

  <div class="flex items-center justify-between gap-2 border-t border-border-subtle pt-2">
    <span class="truncate text-xs text-text-muted">
      {readyArtifacts} ready artifacts across live work
    </span>
    <button
      type="button"
      onclick={() => openWork()}
      class="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-md border border-accent-cyan/30 bg-accent-cyan/10 px-3 text-xs font-semibold text-accent-cyan transition-colors hover:bg-accent-cyan/20"
    >
      <Icon name="list" class="h-3.5 w-3.5" />
      Open Work
    </button>
  </div>
</div>
