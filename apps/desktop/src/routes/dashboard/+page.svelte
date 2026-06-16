<script lang="ts">
  // Dashboard / "Today" surface.
  //
  // Today is the prepared front door: a ranked morning brief, one sacred
  // approval gate when work is waiting on the user, handled receipts, and
  // active matters. The older tile grid remains as a lower "signals" band
  // for rearrangeable widgets; it no longer owns the first impression.

  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { connection } from '$lib/stores/connection.svelte';
  import { openLoops } from '$lib/stores/open-loops.svelte';
  import { workItems } from '$lib/stores/work-items.svelte';
  import {
    domainLabel,
    statusLabel,
    type WorkItem,
    type WorkItemApprovalBoundary,
    type WorkItemApprovalStatus,
    type WorkItemReceipt
  } from '$lib/data/work-item';
  import GetStarted from '$lib/components/GetStarted.svelte';
  import TileGrid from '$lib/components/dashboard/TileGrid.svelte';
  import Icon from '$lib/components/Icon.svelte';

  type HandledReceipt = {
    item: WorkItem;
    id: string;
    title: string;
    detail: string;
    created_at: string;
    status: WorkItemApprovalStatus | WorkItemReceipt['status'];
  };

  type BriefItem = {
    id: string;
    label: string;
    title: string;
    detail: string;
    tone: 'approval' | 'blocked' | 'ready' | 'watch' | 'handled' | 'active';
    itemId?: string;
  };

  const todayLabel = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric'
  }).format(new Date());

  onMount(async () => {
    workItems.hydrate();
    openLoops.init();
    // Connection is normally initialized by the root layout, but the
    // dashboard route can land first (e.g. user opens via Cmd+0 on
    // app launch). Calling `init()` again is a cheap idempotent
    // operation — the store dedupes via `initialized` + `initPromise`.
    if (!connection.client) {
      try {
        await connection.init();
      } catch {
        // Tile-level error handlers surface load failures inline; we
        // don't need a route-level toast here.
      }
    }
  });

  const liveItems = $derived(
    workItems.items.filter((item) => item.status !== 'done' && item.status !== 'archived')
  );

  const pendingApprovalCount = $derived(
    liveItems.reduce((count, item) => {
      const boundaries = item.approvalBoundaries.filter((gate) => gate.status === 'pending');
      return (
        count +
        (boundaries.length > 0 ? boundaries.length : item.status === 'waiting-approval' ? 1 : 0)
      );
    }, 0)
  );

  const blockedCount = $derived(
    liveItems.filter(
      (item) => item.status === 'blocked' || item.dossier.some((entry) => entry.state === 'missing')
    ).length
  );

  const readyArtifactCount = $derived(
    liveItems.reduce(
      (count, item) =>
        count + item.artifacts.filter((artifact) => artifact.status === 'ready').length,
      0
    )
  );

  const activeWatchCount = $derived(
    liveItems.reduce(
      (count, item) => count + item.watches.filter((watch) => watch.status === 'active').length,
      0
    )
  );

  const sortedAgenda = $derived.by<WorkItem[]>(() =>
    [...liveItems].sort((a, b) => {
      const priority = priorityScore(a) - priorityScore(b);
      if (priority !== 0) return priority;
      return timestamp(b) - timestamp(a);
    })
  );

  const firstDecision = $derived(
    sortedAgenda.find((item) => pendingGate(item) !== null || item.status === 'waiting-approval') ??
      null
  );

  const activeMatters = $derived(sortedAgenda.slice(0, 5));

  const handledReceipts = $derived.by<HandledReceipt[]>(() => {
    const approvalReceipts: HandledReceipt[] = workItems.items.flatMap((item) =>
      item.approvalBoundaries
        .filter((boundary) => boundary.status === 'approved' || boundary.status === 'denied')
        .map((boundary) => ({
          item,
          id: boundary.id,
          title: boundary.action,
          detail: boundary.reason,
          created_at: item.updated_at || item.created_at,
          status: boundary.status
        }))
    );

    const watchReceipts: HandledReceipt[] = workItems.items.flatMap((item) =>
      item.receipts.map((receipt) => ({
        item,
        id: receipt.id,
        title: receipt.title,
        detail: receipt.detail,
        created_at: receipt.created_at,
        status: receipt.status
      }))
    );

    return [...approvalReceipts, ...watchReceipts]
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, 4);
  });

  const briefLine = $derived(
    pendingApprovalCount > 0
      ? `${pendingApprovalCount} approval${pendingApprovalCount === 1 ? '' : 's'} waiting. ${liveItems.length} live matter${liveItems.length === 1 ? '' : 's'}.`
      : liveItems.length > 0
        ? `${liveItems.length} live matter${liveItems.length === 1 ? '' : 's'}. No approvals waiting.`
        : 'No live matters. Connect sources or start work to build the brief.'
  );

  const briefItems = $derived.by<BriefItem[]>(() => {
    const items: BriefItem[] = [];

    if (firstDecision) {
      const gate = pendingGate(firstDecision);
      items.push({
        id: `decision:${firstDecision.id}`,
        label: gate ? 'Needs approval' : 'Needs review',
        title: gate?.action ?? firstDecision.nextAction ?? firstDecision.title,
        detail: gate?.reason ?? firstDecision.objective ?? firstDecision.title,
        tone: 'approval',
        itemId: firstDecision.id
      });
    }

    for (const item of sortedAgenda) {
      if (firstDecision && item.id === firstDecision.id) continue;
      const gate = pendingGate(item);
      const missing = item.dossier.some((entry) => entry.state === 'missing');
      const ready = item.artifacts.find((artifact) => artifact.status === 'ready');
      const activeWatch = item.watches.find((watch) => watch.status === 'active');
      items.push({
        id: `matter:${item.id}`,
        label: gate
          ? 'Needs approval'
          : item.status === 'blocked' || missing
            ? 'Blocked'
            : ready
              ? 'Ready'
              : activeWatch
                ? 'Watching'
                : 'Moving',
        title: item.title,
        detail:
          gate?.reason ??
          item.nextAction ??
          ready?.title ??
          activeWatch?.trigger ??
          item.objective ??
          'No next action set',
        tone: gate
          ? 'approval'
          : item.status === 'blocked' || missing
            ? 'blocked'
            : ready
              ? 'ready'
              : activeWatch
                ? 'watch'
                : 'active',
        itemId: item.id
      });
      if (items.length >= 5) break;
    }

    for (const receipt of handledReceipts) {
      if (items.length >= 5) break;
      items.push({
        id: `receipt:${receipt.item.id}:${receipt.id}`,
        label: receiptVerb(receipt.status),
        title: receipt.title,
        detail: receipt.detail,
        tone: receipt.status === 'failed' ? 'blocked' : 'handled',
        itemId: receipt.item.id
      });
    }

    return items.slice(0, 5);
  });

  function priorityScore(item: WorkItem): number {
    if (pendingGate(item)) return 0;
    if (item.status === 'waiting-approval') return 1;
    if (item.status === 'blocked') return 2;
    if (item.dossier.some((entry) => entry.state === 'missing')) return 3;
    if (item.artifacts.some((artifact) => artifact.status === 'ready')) return 4;
    if (item.nextAction) return 5;
    return 6;
  }

  function pendingGate(item: WorkItem): WorkItemApprovalBoundary | null {
    return item.approvalBoundaries.find((boundary) => boundary.status === 'pending') ?? null;
  }

  function timestamp(item: WorkItem): number {
    const value = Date.parse(item.updated_at || item.created_at);
    return Number.isFinite(value) ? value : 0;
  }

  function formatShortDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return 'Recently';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function receiptVerb(status: HandledReceipt['status']): string {
    if (status === 'approved') return 'Approved';
    if (status === 'denied') return 'Denied';
    if (status === 'handled') return 'Handled';
    if (status === 'failed') return 'Failed';
    return 'Pending';
  }

  function touchedLabel(item: WorkItem, boundary: WorkItemApprovalBoundary | null): string {
    if (boundary?.payload) return boundary.payload;
    const labels = item.links
      .map((link) => link.label)
      .filter(Boolean)
      .join(', ');
    return labels || item.title;
  }

  function leavesMachineLabel(boundary: WorkItemApprovalBoundary | null): string {
    if (!boundary) return 'Nothing leaves without a recorded boundary.';
    switch (boundary.kind) {
      case 'send':
        return 'Outbound message';
      case 'export':
        return 'Exported or shared artifact';
      case 'push':
        return 'Repository or branch change';
      case 'pr':
        return 'Pull request visible outside IronClaw';
      case 'trade':
        return 'Financial order or fund movement';
      case 'write':
        return 'Change in a connected system';
      case 'delete':
        return 'Destructive state change';
      case 'other':
        return 'No external payload declared';
    }
  }

  function reversibleLabel(boundary: WorkItemApprovalBoundary | null): string {
    if (!boundary) return 'No action approved';
    switch (boundary.kind) {
      case 'send':
      case 'trade':
      case 'delete':
      case 'push':
      case 'pr':
        return 'No. Review deliberately.';
      case 'export':
      case 'write':
        return 'Limited, depends on destination.';
      case 'other':
        return 'Unknown until the action is set.';
    }
  }

  function briefToneClass(tone: BriefItem['tone']): string {
    switch (tone) {
      case 'approval':
        return 'border-accent-gold/35 bg-accent-gold/10 text-accent-gold';
      case 'blocked':
        return 'border-danger/35 bg-danger-soft text-danger';
      case 'ready':
        return 'border-positive/35 bg-positive-soft text-positive';
      case 'watch':
        return 'border-accent-cyan/35 bg-accent-cyan/10 text-accent-cyan';
      case 'handled':
        return 'border-border-subtle bg-bg-deep/55 text-text-muted';
      case 'active':
        return 'border-border-subtle bg-bg-deep/55 text-text-muted';
    }
  }

  function statusClass(item: WorkItem): string {
    if (pendingGate(item) || item.status === 'waiting-approval') {
      return 'border-accent-gold/35 bg-accent-gold/10 text-accent-gold';
    }
    if (item.status === 'blocked' || item.dossier.some((entry) => entry.state === 'missing')) {
      return 'border-danger/35 bg-danger-soft text-danger';
    }
    return 'border-positive/35 bg-positive-soft text-positive';
  }

  function resolveGate(
    item: WorkItem,
    boundary: WorkItemApprovalBoundary,
    status: WorkItemApprovalStatus
  ): void {
    workItems.updateApprovalBoundary(item.id, boundary.id, status);
  }

  function openWork(id?: string): void {
    void goto(id ? `/work?item=${encodeURIComponent(id)}` : '/work');
  }

  function openSettings(): void {
    void goto('/settings');
  }
</script>

<svelte:head>
  <title>Today · IronClaw</title>
</svelte:head>

<div class="h-full overflow-auto bg-bg-base/40">
  <div class="mx-auto flex max-w-[1480px] flex-col gap-6 p-6">
    <header
      class="flex flex-wrap items-end justify-between gap-4 border-b border-border-subtle pb-5"
    >
      <div class="min-w-0">
        <p class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-muted">
          {todayLabel}
        </p>
        <h1 class="mt-1 text-[28px] font-semibold leading-[1.15] text-text-primary">Today</h1>
        <p
          class="mt-2 max-w-3xl text-sm leading-6 text-text-muted"
          data-testid="morning-brief-line"
        >
          {briefLine}
        </p>
      </div>
      <div
        class="flex min-h-[36px] items-center gap-2 rounded-md border border-border-subtle bg-bg-deep/55 px-3 text-xs text-text-muted"
      >
        <span
          class="h-2 w-2 rounded-full {connection.status === 'connected'
            ? 'bg-positive'
            : connection.status === 'connecting'
              ? 'bg-warning-v2'
              : 'bg-danger'}"
          aria-hidden="true"
        ></span>
        <span class="truncate">
          {connection.status === 'connected'
            ? `${connection.apiVersion.toUpperCase()} · ${connection.activeProfile?.name ?? 'Default'}`
            : 'Runner not ready'}
        </span>
      </div>
    </header>

    <section
      class="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.75fr)]"
      aria-labelledby="morning-brief-heading"
    >
      <div class="min-w-0">
        <div class="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 id="morning-brief-heading" class="text-base font-semibold text-text-primary">
              Morning Brief
            </h2>
            <p class="mt-1 text-xs text-text-muted">
              Ranked by approvals, blockers, and recent movement.
            </p>
          </div>
          <button
            type="button"
            onclick={() => openWork()}
            class="hidden min-h-[36px] items-center gap-1.5 rounded-md border border-border-subtle px-3 text-xs font-semibold text-text-muted transition-colors hover:border-accent-cyan/45 hover:text-text-primary sm:inline-flex"
          >
            <Icon name="list" class="h-3.5 w-3.5" />
            Work
          </button>
        </div>

        <article
          class="rounded-[var(--v2-radius-card)] border border-border-subtle bg-bg-surface/70 p-5"
          data-testid="today-first-decision"
        >
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0">
              {#if firstDecision}
                {@const gate = pendingGate(firstDecision)}
                <div class="flex items-center gap-2">
                  <span
                    class="rounded-[var(--v2-radius-control)] border border-accent-gold/35 bg-accent-gold/10 px-2 py-1 text-[11px] font-semibold text-accent-gold"
                  >
                    Agent prepared
                  </span>
                  <span class="text-xs text-text-muted">First decision</span>
                </div>
                <h3 class="mt-4 text-xl font-semibold leading-tight text-text-primary">
                  {gate?.action ?? firstDecision.nextAction ?? firstDecision.title}
                </h3>
                <p class="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
                  {gate?.reason || firstDecision.objective || 'Waiting on your review'}
                </p>

                <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div
                    class="rounded-[var(--v2-radius-control)] border border-border-subtle bg-bg-base/50 p-3"
                  >
                    <p
                      class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-muted"
                    >
                      Action
                    </p>
                    <p class="mt-1 text-sm text-text-primary">
                      {gate?.kind ?? 'review'}
                    </p>
                  </div>
                  <div
                    class="rounded-[var(--v2-radius-control)] border border-border-subtle bg-bg-base/50 p-3"
                  >
                    <p
                      class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-muted"
                    >
                      Touches
                    </p>
                    <p class="mt-1 text-sm text-text-primary">
                      {touchedLabel(firstDecision, gate)}
                    </p>
                  </div>
                  <div
                    class="rounded-[var(--v2-radius-control)] border border-border-subtle bg-bg-base/50 p-3"
                  >
                    <p
                      class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-muted"
                    >
                      Leaves This Machine
                    </p>
                    <p class="mt-1 text-sm text-text-primary">
                      {leavesMachineLabel(gate)}
                    </p>
                  </div>
                  <div
                    class="rounded-[var(--v2-radius-control)] border border-border-subtle bg-bg-base/50 p-3"
                  >
                    <p
                      class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-muted"
                    >
                      Reversible
                    </p>
                    <p class="mt-1 text-sm text-text-primary">
                      {reversibleLabel(gate)}
                    </p>
                  </div>
                </div>

                <div class="mt-5 flex flex-wrap items-center gap-2">
                  {#if gate}
                    <button
                      type="button"
                      onclick={() => resolveGate(firstDecision, gate, 'approved')}
                      class="inline-flex min-h-[40px] items-center gap-2 rounded-md border border-accent-cyan/60 bg-accent-cyan px-4 text-sm font-semibold text-bg-deep transition-colors hover:bg-signal-strong"
                    >
                      <Icon name="check" class="h-4 w-4" />
                      Approve
                    </button>
                    <button
                      type="button"
                      onclick={() => resolveGate(firstDecision, gate, 'denied')}
                      class="inline-flex min-h-[40px] items-center gap-2 rounded-md border border-border-subtle px-4 text-sm font-semibold text-text-muted transition-colors hover:border-danger/45 hover:text-text-primary"
                    >
                      Deny
                    </button>
                  {:else}
                    <button
                      type="button"
                      onclick={() => openWork(firstDecision.id)}
                      class="inline-flex min-h-[40px] items-center gap-2 rounded-md border border-accent-cyan/60 bg-accent-cyan px-4 text-sm font-semibold text-bg-deep transition-colors hover:bg-signal-strong"
                    >
                      Open Matter
                    </button>
                  {/if}
                  <button
                    type="button"
                    onclick={() => openWork(firstDecision.id)}
                    class="inline-flex min-h-[40px] items-center gap-2 rounded-md border border-border-subtle px-4 text-sm font-semibold text-text-muted transition-colors hover:border-accent-cyan/45 hover:text-text-primary"
                  >
                    Dossier
                  </button>
                </div>
              {:else}
                <div class="flex items-center gap-2">
                  <span
                    class="rounded-[var(--v2-radius-control)] border border-border-subtle bg-bg-deep/55 px-2 py-1 text-[11px] font-semibold text-text-muted"
                  >
                    Standing by
                  </span>
                  <span class="text-xs text-text-muted">No decision</span>
                </div>
                <h3 class="mt-4 text-xl font-semibold leading-tight text-text-primary">
                  No approvals waiting
                </h3>
                <p class="mt-2 max-w-3xl text-sm leading-6 text-text-muted">
                  {connection.status === 'connected'
                    ? 'Nothing is blocked on your decision.'
                    : 'Connect a runner to prepare real work here.'}
                </p>
                <div class="mt-5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onclick={connection.status === 'connected' ? () => openWork() : openSettings}
                    class="inline-flex min-h-[40px] items-center gap-2 rounded-md border border-accent-cyan/60 bg-accent-cyan px-4 text-sm font-semibold text-bg-deep transition-colors hover:bg-signal-strong"
                  >
                    {connection.status === 'connected' ? 'Open Work' : 'Connect Runner'}
                  </button>
                </div>
              {/if}
            </div>
          </div>
        </article>
      </div>

      <aside
        class="min-w-0 rounded-[var(--v2-radius-card)] border border-border-subtle bg-bg-surface/50 p-4"
        aria-label="Ranked brief queue"
      >
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-sm font-semibold text-text-primary">Brief Queue</h2>
          <span class="text-[11px] tabular-nums text-text-muted">
            {pendingApprovalCount} approvals · {activeWatchCount + openLoops.activeCount} watching
          </span>
        </div>
        {#if briefItems.length > 0}
          <ol class="mt-4 space-y-2" data-testid="today-brief-queue">
            {#each briefItems as item, index (item.id)}
              <li>
                <button
                  type="button"
                  onclick={() => (item.itemId ? openWork(item.itemId) : openWork())}
                  class="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-[var(--v2-radius-control)] border border-border-subtle bg-bg-base/45 p-3 text-left transition-colors hover:border-accent-cyan/40"
                >
                  <span
                    class="flex h-7 w-7 items-center justify-center rounded-[var(--v2-radius-control)] border text-[11px] font-semibold tabular-nums {briefToneClass(
                      item.tone
                    )}"
                  >
                    {index + 1}
                  </span>
                  <span class="min-w-0">
                    <span class="block text-[11px] font-semibold text-text-muted">
                      {item.label}
                    </span>
                    <span class="mt-1 block truncate text-sm font-semibold text-text-primary">
                      {item.title}
                    </span>
                    <span class="mt-1 block line-clamp-2 text-xs leading-5 text-text-muted">
                      {item.detail}
                    </span>
                  </span>
                </button>
              </li>
            {/each}
          </ol>
        {:else}
          <div
            class="mt-4 rounded-[var(--v2-radius-control)] border border-border-subtle bg-bg-base/45 p-4 text-sm text-text-muted"
          >
            No ranked work yet
          </div>
        {/if}
      </aside>
    </section>

    <section
      class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.55fr)]"
      aria-label="Work status"
    >
      <div
        class="min-w-0 rounded-[var(--v2-radius-card)] border border-border-subtle bg-bg-surface/45"
      >
        <div
          class="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3"
        >
          <h2 class="text-sm font-semibold text-text-primary">Active matters</h2>
          <span class="text-[11px] tabular-nums text-text-muted">{liveItems.length} live</span>
        </div>
        {#if activeMatters.length > 0}
          <ul class="divide-y divide-border-subtle/80" data-testid="today-active-matters">
            {#each activeMatters as item (item.id)}
              <li>
                <button
                  type="button"
                  onclick={() => openWork(item.id)}
                  class="grid w-full gap-2 px-4 py-3 text-left transition-colors hover:bg-bg-base/45 md:grid-cols-[minmax(0,1fr)_auto]"
                  aria-label="Open matter {item.title}"
                >
                  <span class="min-w-0">
                    <span class="block truncate text-sm font-semibold text-text-primary">
                      {item.title}
                    </span>
                    <span class="mt-1 block truncate text-xs text-text-muted">
                      {item.nextAction ?? item.objective ?? 'No next action set'}
                    </span>
                  </span>
                  <span class="flex flex-wrap items-center gap-2 md:justify-end">
                    <span
                      class="rounded-[var(--v2-radius-control)] border border-border-subtle bg-bg-deep/60 px-2 py-1 text-[11px] text-text-muted"
                    >
                      {domainLabel(item.domain)}
                    </span>
                    <span
                      class="rounded-[var(--v2-radius-control)] border px-2 py-1 text-[11px] font-semibold {statusClass(
                        item
                      )}"
                    >
                      {statusLabel(item.status)}
                    </span>
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <div class="px-4 py-8 text-sm text-text-muted">No active matters</div>
        {/if}
      </div>

      <div
        class="min-w-0 rounded-[var(--v2-radius-card)] border border-border-subtle bg-bg-surface/45"
      >
        <div
          class="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3"
        >
          <h2 class="text-sm font-semibold text-text-primary">Handled</h2>
          <span class="text-[11px] tabular-nums text-text-muted"
            >{handledReceipts.length} receipts</span
          >
        </div>
        {#if handledReceipts.length > 0}
          <ul class="divide-y divide-border-subtle/80" data-testid="today-handled-receipts">
            {#each handledReceipts as receipt (`${receipt.item.id}:${receipt.id}`)}
              <li class="px-4 py-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-text-primary">
                      {receipt.item.title}
                    </p>
                    <p class="mt-1 text-xs text-text-muted">
                      {receiptVerb(receipt.status)} · {receipt.title}
                    </p>
                  </div>
                  <span class="shrink-0 text-[11px] tabular-nums text-text-muted">
                    {formatShortDate(receipt.created_at)}
                  </span>
                </div>
              </li>
            {/each}
          </ul>
        {:else}
          <div class="px-4 py-8 text-sm text-text-muted">No handled receipts yet</div>
        {/if}
      </div>
    </section>

    <GetStarted />

    <section aria-labelledby="signals-heading">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 id="signals-heading" class="text-base font-semibold text-text-primary">Signals</h2>
          <p class="mt-1 text-xs text-text-muted">Threads, routines, skills, and open loops.</p>
        </div>
      </div>
      <TileGrid />
    </section>
  </div>
</div>
