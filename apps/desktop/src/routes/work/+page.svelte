<script lang="ts">
  // Work — the durable "Work Item / Matter" surface. A matter unifies an
  // objective across the threads, sources, approvals, and follow-ups that
  // otherwise scatter it. This route is the thin spine: a left list rail and
  // a right detail pane, read + create + light in-place update only. It does
  // NOT replace chat or missions — links here REFERENCE those by id; nothing
  // is sent or written outside the app.
  //
  // Persistence is local-only (the workItems store, localStorage). The route
  // hydrates the store on mount; hydrate() is idempotent because the layout
  // and Today tile can also touch the same spine.
  //
  // Calm + dense by design: list rows, not nested cards; the detail pane uses
  // the same input / label / chip idioms as the memory route.

  import { onDestroy, onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import MarkdownView from '$lib/components/LazyMarkdownView.svelte';
  import WorkProductActions from '$lib/components/WorkProductActions.svelte';
  import { surfaceRefresh } from '$lib/stores/surface-refresh.svelte';
  import { workItems } from '$lib/stores/work-items.svelte';
  import {
    domainLabel,
    statusLabel,
    summarizeStatus,
    WORK_ITEM_DOMAINS,
    WORK_ITEM_STATUSES,
    type WorkItem,
    type WorkItemApprovalStatus,
    type WorkItemDomain,
    type WorkItemStatus
  } from '$lib/data/work-item';
  import {
    getWorkDispatchResume,
    workDispatchChatHref,
    WORK_DISPATCH_RESUME_PARAM
  } from '$lib/util/work-dispatch-resume';

  // ---- Selection -----------------------------------------------------------
  let selectedId = $state<string | null>(null);
  const selected = $derived<WorkItem | null>(
    selectedId ? (workItems.get(selectedId) ?? null) : null
  );
  const requestedItemId = $derived(page.url.searchParams.get('item'));
  const requestedArtifactId = $derived(page.url.searchParams.get('artifact'));
  const requestedResumeId = $derived(page.url.searchParams.get(WORK_DISPATCH_RESUME_PARAM));

  // ---- New-item form state -------------------------------------------------
  let newTitle = $state('');
  let newObjective = $state('');
  let newDomain = $state<WorkItemDomain>('general');
  let formOpen = $state(false);

  onMount(() => {
    workItems.hydrate();
    // Cmd+R surface refresh just re-hydrates (no server round-trip; the store
    // is the source of truth). Keeps parity with other routes' refresh wire.
    surfaceRefresh.register(async () => {
      workItems.reload();
    });
    // Auto-select the first item so the detail pane isn't empty on a populated
    // store.
    if (requestedItemId && workItems.get(requestedItemId)) {
      selectedId = requestedItemId;
    } else if (!selectedId && workItems.items.length > 0) {
      selectedId = workItems.items[0].id;
    }
  });

  $effect(() => {
    if (!requestedItemId) return;
    if (workItems.get(requestedItemId)) selectedId = requestedItemId;
  });

  $effect(() => {
    const artifactId = requestedArtifactId;
    const item = selected;
    if (!artifactId || !item?.artifacts.some((artifact) => artifact.id === artifactId)) return;
    void tick().then(() => {
      if (typeof document === 'undefined') return;
      const el = document.getElementById(artifactElementId(artifactId));
      if (!(el instanceof HTMLElement)) return;
      el.scrollIntoView({ block: 'start' });
      el.focus({ preventScroll: true });
    });
  });

  onDestroy(() => surfaceRefresh.unregister());

  function openForm(): void {
    newTitle = '';
    newObjective = '';
    newDomain = 'general';
    formOpen = true;
  }

  function submitNew(e: SubmitEvent): void {
    e.preventDefault();
    const created = workItems.create({
      title: newTitle,
      objective: newObjective,
      domain: newDomain
    });
    if (!created) return;
    selectedId = created.id;
    formOpen = false;
  }

  function setStatus(status: WorkItemStatus): void {
    if (!selected) return;
    workItems.update(selected.id, { status });
  }

  function setApprovalBoundaryStatus(boundaryId: string, status: WorkItemApprovalStatus): void {
    if (!selected) return;
    const updated = workItems.updateApprovalBoundary(selected.id, boundaryId, status);
    if (!updated || status !== 'approved' || !requestedResumeId) return;
    const resume = getWorkDispatchResume(requestedResumeId);
    if (!resume || resume.workItemId !== updated.id) return;
    const hasOpenBoundary = updated.approvalBoundaries.some(
      (boundary) => boundary.status === 'pending'
    );
    const hasDeniedBoundary = updated.approvalBoundaries.some(
      (boundary) => boundary.status === 'denied'
    );
    if (!hasOpenBoundary && !hasDeniedBoundary) {
      void goto(workDispatchChatHref(resume));
    }
  }

  // ---- Helpers -------------------------------------------------------------
  function statusPillClass(status: WorkItemStatus): string {
    switch (status) {
      case 'active':
        return 'bg-status-info/15 text-status-info';
      case 'waiting-approval':
        return 'bg-status-warning/15 text-status-warning';
      case 'blocked':
        return 'bg-status-error/15 text-status-error';
      case 'done':
        return 'bg-status-success/15 text-status-success';
      case 'archived':
        return 'bg-bg-deep text-text-muted';
    }
  }

  function dossierPillClass(state: WorkItem['dossier'][number]['state']): string {
    if (state === 'missing') return 'bg-status-warning/15 text-status-warning';
    if (state === 'used') return 'bg-status-success/15 text-status-success';
    return 'bg-bg-deep text-text-muted';
  }

  function approvalPillClass(status: WorkItemApprovalStatus): string {
    if (status === 'approved') return 'bg-status-success/15 text-status-success';
    if (status === 'denied') return 'bg-status-error/15 text-status-error';
    return 'bg-status-warning/15 text-status-warning';
  }

  function artifactElementId(id: string): string {
    return `work-artifact-${id}`;
  }

  function artifactStatusLabel(status: WorkItem['artifacts'][number]['status']): string {
    if (status === 'draft') return 'Draft';
    if (status === 'ready') return 'Ready';
    if (status === 'approved') return 'Approved';
    return 'Planned';
  }

  function receiptSourceLabel(source: string): string {
    return source.startsWith('generated-mission:') ? 'Desk generated action' : source;
  }
</script>

<div class="flex h-full overflow-hidden" aria-label="Work">
  <!-- LEFT COLUMN: list rail -->
  <aside
    class="flex flex-col w-[320px] shrink-0 border-r border-border-subtle bg-bg-deep/40"
    aria-label="Work items"
  >
    <header class="px-4 py-3 border-b border-border-subtle">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-baseline gap-2 min-w-0">
          <h1 class="text-sm font-semibold text-text-primary">Work</h1>
          <span
            class="text-[11px] text-text-muted tabular-nums"
            aria-label="{workItems.items.length} matters"
          >
            {workItems.items.length}
          </span>
        </div>
        <button
          type="button"
          onclick={openForm}
          aria-label="New work item"
          class="inline-flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-accent-cyan hover:bg-bg-surface focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:outline-none transition"
        >
          <svg
            viewBox="0 0 24 24"
            class="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    </header>

    <div class="flex-1 overflow-y-auto" data-testid="work-list-body">
      {#if workItems.items.length === 0}
        <p class="px-4 py-3 text-xs text-text-muted">
          No work items yet. Create a matter to track an objective across threads and approvals.
        </p>
      {:else}
        <ul class="py-1" aria-label="Work item list">
          {#each workItems.items as item (item.id)}
            {@const isActive = selectedId === item.id}
            <li>
              <button
                type="button"
                onclick={() => (selectedId = item.id)}
                aria-label={`Open work item ${item.title}`}
                aria-current={isActive ? 'true' : undefined}
                data-testid="work-item-row"
                class="w-full text-left px-4 py-2.5 border-l-2 transition focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:outline-none focus-visible:ring-inset"
                class:border-accent-cyan={isActive}
                class:bg-bg-surface={isActive}
                class:border-transparent={!isActive}
                class:hover:bg-bg-surface={!isActive}
              >
                <div class="flex items-baseline justify-between gap-2 mb-1">
                  <span class="text-[12.5px] font-medium text-text-primary truncate">
                    {item.title}
                  </span>
                  <span
                    class="inline-block px-1.5 py-0 text-[10px] rounded-sm bg-bg-deep text-accent-cyan/80 font-mono shrink-0"
                  >
                    {domainLabel(item.domain)}
                  </span>
                </div>
                <div class="flex items-center gap-2">
                  <span
                    class={`inline-block px-1.5 py-0 text-[10px] rounded-sm shrink-0 ${statusPillClass(item.status)}`}
                  >
                    {statusLabel(item.status)}
                  </span>
                  <span class="text-[11px] text-text-muted truncate">
                    {item.nextAction ?? summarizeStatus(item)}
                  </span>
                </div>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </aside>

  <!-- RIGHT COLUMN: detail -->
  <section class="flex-1 flex flex-col min-w-0 overflow-hidden" aria-label="Work item detail">
    {#if !selected}
      <div class="flex-1 flex items-center justify-center text-text-muted text-sm">
        <p>Pick a work item, or create one.</p>
      </div>
    {:else}
      {@const item = selected}
      <header
        class="flex items-start justify-between gap-4 px-6 py-4 border-b border-border-subtle"
      >
        <div class="min-w-0 space-y-1.5">
          <div class="flex items-center gap-2 min-w-0">
            <h2 class="text-sm font-semibold text-text-primary truncate">{item.title}</h2>
            <span
              class="inline-block px-1.5 py-0 text-[10px] rounded-sm bg-bg-deep text-accent-cyan/80 font-mono shrink-0"
            >
              {domainLabel(item.domain)}
            </span>
          </div>
          <p class="text-[11px] text-text-muted">{summarizeStatus(item)}</p>
        </div>
        <!-- Status is the one in-place update the spine exposes. No external
             actions; this only mutates the local work item. -->
        <div class="flex items-center gap-1.5 shrink-0">
          {#each WORK_ITEM_STATUSES as status (status)}
            {@const isCurrent = item.status === status}
            <button
              type="button"
              onclick={() => setStatus(status)}
              aria-pressed={isCurrent}
              class={[
                'px-2 py-1 rounded-md border text-[11px] transition focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:outline-none',
                isCurrent
                  ? 'border-accent-cyan text-text-primary bg-bg-surface'
                  : 'border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan'
              ].join(' ')}
            >
              {statusLabel(status)}
            </button>
          {/each}
        </div>
      </header>

      <div class="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        <!-- Objective -->
        <section aria-label="Objective" class="space-y-1.5">
          <h3 class="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Objective
          </h3>
          <p class="text-sm text-text-secondary whitespace-pre-wrap">
            {item.objective || 'No objective set'}
          </p>
        </section>

        <!-- Next action -->
        <section aria-label="Next action" class="space-y-1.5">
          <h3 class="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Next action
          </h3>
          <p class="text-sm text-text-secondary">{item.nextAction ?? '—'}</p>
        </section>

        <!-- Runbooks -->
        <section aria-label="Runbooks" class="space-y-1.5">
          <h3 class="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Runbooks
          </h3>
          {#if item.runbookIds.length === 0}
            <p class="text-sm text-text-muted">No runbook selected</p>
          {:else}
            <div class="flex flex-wrap gap-1.5">
              {#each item.runbookIds as runbookId (runbookId)}
                <span
                  class="inline-block px-1.5 py-0 text-[10px] rounded-sm bg-bg-deep text-accent-cyan/80 font-mono"
                >
                  {domainLabel(runbookId)}
                </span>
              {/each}
            </div>
          {/if}
        </section>

        <!-- Links -->
        <section aria-label="Links" class="space-y-1.5">
          <h3 class="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Links</h3>
          {#if item.links.length === 0}
            <p class="text-sm text-text-muted">No linked threads, docs, or sources</p>
          {:else}
            <ul class="divide-y divide-border-subtle border border-border-subtle rounded-md">
              {#each item.links as link (link.kind + ':' + link.ref)}
                <li class="flex items-center gap-2 px-3 py-2">
                  <span
                    class="inline-block px-1.5 py-0 text-[10px] rounded-sm bg-bg-deep text-accent-cyan/80 font-mono shrink-0"
                  >
                    {link.kind}
                  </span>
                  <span class="text-[12.5px] text-text-secondary truncate">{link.label}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <!-- Receipts -->
        <section aria-label="Receipts" class="space-y-1.5">
          <h3 class="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Receipts
          </h3>
          {#if item.receipts.length === 0}
            <p class="text-sm text-text-muted">No handled receipts yet</p>
          {:else}
            <ul class="divide-y divide-border-subtle border border-border-subtle rounded-md">
              {#each item.receipts as receipt (receipt.id)}
                <li class="px-3 py-2">
                  <div class="flex items-center justify-between gap-3">
                    <span class="min-w-0 truncate text-[12.5px] text-text-secondary">
                      {receipt.title}
                    </span>
                    <span
                      class="inline-block shrink-0 rounded-sm bg-positive-soft px-1.5 py-0 text-[10px] text-positive"
                    >
                      {receipt.status === 'handled' ? 'Handled' : 'Failed'}
                    </span>
                  </div>
                  <p class="mt-1 text-[11px] text-text-muted">
                    {receiptSourceLabel(receipt.source)}
                  </p>
                  <p class="mt-1 text-[11px] text-text-muted/80">{receipt.detail}</p>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <!-- Open approvals -->
        <section aria-label="Context dossier" class="space-y-1.5">
          <h3 class="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Context dossier
          </h3>
          {#if item.dossier.length === 0}
            <p class="text-sm text-text-muted">No context attached</p>
          {:else}
            <ul class="divide-y divide-border-subtle border border-border-subtle rounded-md">
              {#each item.dossier as entry, i (entry.state + ':' + entry.label + ':' + i)}
                <li class="px-3 py-2">
                  <div class="flex items-center gap-2 min-w-0">
                    <span
                      class={`inline-block px-1.5 py-0 text-[10px] rounded-sm shrink-0 ${dossierPillClass(entry.state)}`}
                    >
                      {entry.state}
                    </span>
                    <span class="text-[12.5px] text-text-secondary truncate">{entry.label}</span>
                  </div>
                  <p class="mt-1 text-[11px] text-text-muted truncate">
                    {entry.provenance}{entry.detail ? ` — ${entry.detail}` : ''}
                  </p>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <!-- Approval boundaries -->
        <section aria-label="Approval boundaries" class="space-y-1.5">
          <h3 class="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Approval boundaries
          </h3>
          {#if item.approvalBoundaries.length === 0}
            <p class="text-sm text-text-muted">No risky-action boundaries recorded</p>
          {:else}
            <ul class="divide-y divide-border-subtle border border-border-subtle rounded-md">
              {#each item.approvalBoundaries as boundary (boundary.id)}
                <li class="px-3 py-2">
                  <div class="flex items-center gap-2">
                    <span
                      class={`inline-block px-1.5 py-0 text-[10px] rounded-sm shrink-0 ${approvalPillClass(boundary.status)}`}
                    >
                      {boundary.status}
                    </span>
                    <span
                      class="inline-block px-1.5 py-0 text-[10px] rounded-sm bg-bg-deep text-accent-cyan/80 font-mono shrink-0"
                    >
                      {boundary.kind}
                    </span>
                    <span class="text-[12.5px] text-text-secondary">{boundary.action}</span>
                  </div>
                  <p class="mt-1 text-[11px] text-text-muted">{boundary.payload}</p>
                  {#if boundary.reason}
                    <p class="mt-1 text-[11px] text-text-muted/80">{boundary.reason}</p>
                  {/if}
                  {#if boundary.status === 'pending'}
                    <div class="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onclick={() => setApprovalBoundaryStatus(boundary.id, 'approved')}
                        class="px-2.5 py-1 rounded-md border border-status-success/50 text-status-success text-[11px] font-semibold hover:bg-status-success/10 transition"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onclick={() => setApprovalBoundaryStatus(boundary.id, 'denied')}
                        class="px-2.5 py-1 rounded-md border border-status-error/50 text-status-error text-[11px] font-semibold hover:bg-status-error/10 transition"
                      >
                        Deny
                      </button>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <!-- Artifacts -->
        <section aria-label="Artifacts" class="space-y-1.5">
          <h3 class="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Artifacts
          </h3>
          {#if item.artifacts.length === 0}
            <p class="text-sm text-text-muted">No artifacts planned</p>
          {:else}
            <ul class="divide-y divide-border-subtle border border-border-subtle rounded-md">
              {#each item.artifacts as artifact (artifact.id)}
                <li
                  id={artifactElementId(artifact.id)}
                  class="scroll-mt-4 px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
                  tabindex="-1"
                  aria-label={`Artifact ${artifact.title}`}
                >
                  <div class="flex items-center gap-2">
                    <span
                      class="inline-block px-1.5 py-0 text-[10px] rounded-sm bg-bg-deep text-accent-cyan/80 font-mono shrink-0"
                    >
                      {artifactStatusLabel(artifact.status)}
                    </span>
                    <span class="text-[12.5px] text-text-secondary truncate">
                      {artifact.title}
                    </span>
                    <span class="ml-auto text-[11px] text-text-muted shrink-0">
                      {artifact.type}
                    </span>
                  </div>
                  {#if artifact.content}
                    <div
                      class="mt-2 max-h-[420px] overflow-auto rounded-md border border-border-subtle bg-bg-deep/35 px-3 py-2 text-sm"
                      data-testid="work-artifact-content"
                    >
                      <WorkProductActions
                        title={artifact.title}
                        content={artifact.content}
                        compact
                      />
                      <MarkdownView markdown={artifact.content} />
                    </div>
                  {:else}
                    <p class="mt-2 text-xs text-text-muted" data-testid="work-artifact-pending">
                      No draft yet. The artifact appears here when IronClaw produces it.
                    </p>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <!-- Watches -->
        <section aria-label="Watches" class="space-y-1.5">
          <h3 class="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Watches
          </h3>
          {#if item.watches.length === 0}
            <p class="text-sm text-text-muted">No watches attached</p>
          {:else}
            <ul class="divide-y divide-border-subtle border border-border-subtle rounded-md">
              {#each item.watches as watch (watch.id)}
                <li class="px-3 py-2">
                  <div class="flex items-center gap-2">
                    <span
                      class="inline-block px-1.5 py-0 text-[10px] rounded-sm bg-status-info/15 text-status-info shrink-0"
                    >
                      {watch.status}
                    </span>
                    <span class="text-[12.5px] text-text-secondary">{watch.trigger}</span>
                  </div>
                  <p class="mt-1 text-[11px] text-text-muted">
                    {watch.cadence} · {watch.source}{watch.next_check
                      ? ` · next ${watch.next_check}`
                      : ''}
                  </p>
                  <p class="mt-1 text-[11px] text-text-muted/80">{watch.escalation}</p>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <!-- Open approvals -->
        <section aria-label="Open approvals" class="space-y-1.5">
          <h3 class="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Open approvals
          </h3>
          {#if item.openApprovals.length === 0}
            <p class="text-sm text-text-muted">Nothing waiting on approval</p>
          {:else}
            <ul class="space-y-1">
              {#each item.openApprovals as approval, i (i)}
                <li class="text-[12.5px] text-text-secondary">{approval}</li>
              {/each}
            </ul>
          {/if}
        </section>

        <!-- Follow-ups -->
        <section aria-label="Follow-ups" class="space-y-1.5">
          <h3 class="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Follow-ups
          </h3>
          {#if item.followUps.length === 0}
            <p class="text-sm text-text-muted">No follow-ups</p>
          {:else}
            <ul class="space-y-1">
              {#each item.followUps as followUp, i (i)}
                <li class="text-[12.5px] text-text-secondary">{followUp}</li>
              {/each}
            </ul>
          {/if}
        </section>
      </div>
    {/if}
  </section>
</div>

<!-- New work item form — lazy-mounted via the `if` so each open re-seeds the
     inputs cleanly. Backdrop click closes. Create-only; nothing leaves the app. -->
{#if formOpen}
  <button
    type="button"
    aria-label="Close new work item form"
    onclick={() => (formOpen = false)}
    class="fixed inset-0 z-40 bg-black/50 cursor-default"
  ></button>

  <div
    class="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(92vw,460px)] bg-[#0d121f] border border-border-subtle rounded-lg shadow-[0_24px_48px_rgba(0,0,0,0.6)] flex flex-col overflow-hidden"
    role="dialog"
    aria-modal="true"
    aria-labelledby="new-work-title"
    data-testid="new-work-modal"
  >
    <header class="flex items-center justify-between gap-4 px-5 py-4 border-b border-border-subtle">
      <h2 id="new-work-title" class="text-sm font-semibold text-text-primary">New work item</h2>
      <button
        type="button"
        onclick={() => (formOpen = false)}
        aria-label="Close"
        class="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface transition"
      >
        <svg
          viewBox="0 0 24 24"
          class="w-3.5 h-3.5"
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

    <form onsubmit={submitNew} class="flex flex-col gap-4 px-5 py-4">
      <div class="space-y-1.5">
        <label
          for="new-work-title-input"
          class="block text-[11px] font-semibold uppercase tracking-wider text-text-muted"
        >
          Title
        </label>
        <input
          id="new-work-title-input"
          type="text"
          value={newTitle}
          oninput={(e) => (newTitle = (e.currentTarget as HTMLInputElement).value)}
          placeholder="Acme master services agreement"
          autocomplete="off"
          spellcheck="false"
          class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors"
        />
      </div>
      <div class="space-y-1.5">
        <label
          for="new-work-objective"
          class="block text-[11px] font-semibold uppercase tracking-wider text-text-muted"
        >
          Objective
        </label>
        <textarea
          id="new-work-objective"
          rows="4"
          value={newObjective}
          oninput={(e) => (newObjective = (e.currentTarget as HTMLTextAreaElement).value)}
          placeholder="What does done look like?"
          data-testid="new-work-objective"
          class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors resize-none"
        ></textarea>
      </div>
      <div class="space-y-1.5">
        <label
          for="new-work-domain"
          class="block text-[11px] font-semibold uppercase tracking-wider text-text-muted"
        >
          Domain
        </label>
        <select
          id="new-work-domain"
          value={newDomain}
          onchange={(e) =>
            (newDomain = (e.currentTarget as HTMLSelectElement).value as WorkItemDomain)}
          class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-cyan transition-colors"
        >
          {#each WORK_ITEM_DOMAINS as domain (domain)}
            <option value={domain}>{domainLabel(domain)}</option>
          {/each}
        </select>
      </div>
      <div
        class="pt-1 flex items-center justify-end gap-2 border-t border-border-subtle -mx-5 px-5 pt-3"
      >
        <button
          type="button"
          onclick={() => (formOpen = false)}
          class="px-3 py-1.5 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan transition text-xs"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!newTitle.trim()}
          class="inline-flex items-center gap-2 px-4 py-1.5 rounded-md bg-accent-cyan text-bg-deep text-xs font-semibold hover:brightness-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Create
        </button>
      </div>
    </form>
  </div>
{/if}
