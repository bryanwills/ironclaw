<script lang="ts">
  // Generative missions panel — the agent proposes grounded actions from what
  // the user actually has in front of them, instead of a static menu. Paste in
  // what just came in (a contract, call notes, an email thread); the connected
  // agent reads it and proposes specific next actions, each runnable
  // approval-first into a durable Work item.
  import { goto } from '$app/navigation';
  import { onMount, untrack } from 'svelte';
  import type { Extension } from '$lib/api/types';
  import { generatedMissions } from '$lib/stores/generated-missions.svelte';
  import { connection } from '$lib/stores/connection.svelte';
  import type { ContextItem } from '$lib/util/mission-generator';
  import {
    connectedWorkspaceSources,
    workspaceContextItems,
    workspaceContextSources,
    type WorkspaceContextSource
  } from '$lib/util/workspace-context';

  const gm = generatedMissions;
  let pasted = $state('');
  let installed = $state<Extension[]>([]);
  let sourceLoadState = $state<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  let sourceError = $state<string | null>(null);
  let selectedSourceIds = $state<string[]>([]);
  let sourceSelectionTouched = $state(false);
  let runningMissionId = $state<string | null>(null);
  let runError = $state<string | null>(null);

  const workspaceSources = $derived(workspaceContextSources(installed));
  const connectedSources = $derived(
    workspaceSources.filter((source) => source.status === 'connected')
  );
  const selectedSources = $derived(
    connectedWorkspaceSources(installed, selectedSourceIds as WorkspaceContextSource['id'][])
  );

  const canGenerate = $derived(
    gm.available &&
      (pasted.trim().length > 0 || selectedSources.length > 0) &&
      gm.status !== 'generating'
  );

  onMount(() => {
    void refreshSources();
  });

  $effect(() => {
    const client = connection.client;
    if (!client) {
      installed = [];
      sourceLoadState = 'idle';
      sourceError = null;
      selectedSourceIds = [];
      sourceSelectionTouched = false;
      return;
    }
    untrack(() => void refreshSources());
  });

  $effect(() => {
    const connectedIds = connectedSources.map((source) => source.id);
    if (!sourceSelectionTouched) {
      selectedSourceIds = connectedIds;
      return;
    }
    const connected = new Set(connectedIds);
    const next = selectedSourceIds.filter((id) =>
      connected.has(id as WorkspaceContextSource['id'])
    );
    if (next.length !== selectedSourceIds.length) selectedSourceIds = next;
  });

  async function refreshSources() {
    const client = connection.client;
    if (!client) {
      installed = [];
      sourceLoadState = 'idle';
      sourceError = null;
      return;
    }
    sourceLoadState = installed.length === 0 ? 'loading' : sourceLoadState;
    sourceError = null;
    try {
      installed = await client.listExtensions();
      sourceLoadState = 'loaded';
    } catch (err) {
      sourceError = err instanceof Error ? err.message : 'Could not check connected sources.';
      sourceLoadState = 'error';
    }
  }

  function toggleSource(id: WorkspaceContextSource['id']) {
    sourceSelectionTouched = true;
    selectedSourceIds = selectedSourceIds.includes(id)
      ? selectedSourceIds.filter((x) => x !== id)
      : [...selectedSourceIds, id];
  }

  async function generate() {
    const items: ContextItem[] = [
      ...workspaceContextItems(selectedSources),
      ...(pasted.trim().length > 0
        ? [{ kind: 'note' as const, label: 'Pasted into the Desk', body: pasted }]
        : [])
    ];
    await gm.generateFrom(items);
  }

  async function runMission(id: string) {
    const m = gm.missions.find((x) => x.id === id);
    if (!m) return;
    runningMissionId = id;
    runError = null;
    const result = await gm.run(m);
    runningMissionId = null;
    if (result.status === 'created') {
      const artifactParam = result.artifactId
        ? `&artifact=${encodeURIComponent(result.artifactId)}`
        : '';
      void goto(`/work?item=${encodeURIComponent(result.workItemId)}${artifactParam}`);
      return;
    }
    runError = result.reason;
  }
</script>

<section
  aria-label="Generated actions"
  class="surface border border-border-subtle rounded-lg p-4 space-y-3"
>
  <header class="space-y-1">
    <h2 class="text-sm font-semibold text-text-primary">What needs attention</h2>
    <p class="text-xs text-text-muted">
      IronClaw proposes next actions from connected sources or pasted context. Sending still needs
      your approval.
    </p>
  </header>

  <div class="space-y-2 border-y border-border-subtle py-3">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h3 class="text-xs font-semibold text-text-primary">Connected sources</h3>
        <p class="text-[11px] text-text-muted">
          {connectedSources.length > 0
            ? `${selectedSources.length} of ${connectedSources.length} selected for a read-only sweep.`
            : 'Connect Google Workspace, Slack, or Notion for live context.'}
        </p>
      </div>
      <button
        type="button"
        onclick={refreshSources}
        disabled={!connection.client || sourceLoadState === 'loading'}
        class="min-h-[32px] rounded-md border border-border-subtle px-2.5 py-1 text-xs font-medium text-text-muted transition hover:border-accent-cyan hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
      >
        {sourceLoadState === 'loading' ? 'Checking...' : 'Refresh'}
      </button>
    </div>

    {#if sourceLoadState === 'error'}
      <p class="text-xs text-danger" role="alert">{sourceError}</p>
    {/if}

    {#if connectedSources.length > 0}
      <div class="flex flex-wrap gap-2" aria-label="Connected source selection">
        {#each connectedSources as source (source.id)}
          {@const checked = selectedSourceIds.includes(source.id)}
          <label
            class={`inline-flex min-h-[34px] cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition ${checked ? 'border-accent-cyan/70 bg-accent-cyan/10 text-accent-cyan' : 'border-border-subtle text-text-muted hover:border-accent-cyan/60 hover:text-text-primary'}`}
          >
            <input
              type="checkbox"
              class="sr-only"
              {checked}
              onchange={() => toggleSource(source.id)}
              aria-label={source.label}
            />
            <span class="font-medium">{source.label}</span>
            <span class="text-[11px] opacity-75">{source.summary}</span>
          </label>
        {/each}
      </div>
    {/if}
  </div>

  <textarea
    bind:value={pasted}
    rows="5"
    placeholder="Paste a contract, call notes, or an email thread…"
    aria-label="Context for the agent to propose actions from"
    class="w-full resize-y rounded-md border border-border-subtle bg-bg-deep/60 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-cyan focus:outline-none"
  ></textarea>

  <div class="flex items-center gap-3">
    <button
      type="button"
      onclick={generate}
      disabled={!canGenerate}
      class="inline-flex items-center gap-2 rounded-md bg-accent-cyan px-3 py-2 text-sm font-semibold text-bg-deep transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 min-h-[40px]"
    >
      {#if gm.status === 'generating'}
        <span
          class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-bg-deep/40 border-t-bg-deep"
          aria-hidden="true"
        ></span>
        Generating…
      {:else}
        {selectedSources.length > 0 ? 'Generate from Desk context' : 'Generate actions'}
      {/if}
    </button>
    {#if gm.missions.length > 0 || gm.status === 'error' || gm.status === 'empty'}
      <button
        type="button"
        onclick={() => gm.reset()}
        class="text-xs text-text-muted hover:text-text-primary transition-colors min-h-[40px]"
      >
        Clear
      </button>
    {/if}
  </div>

  {#if !gm.available}
    <p class="text-xs text-accent-gold">
      IronClaw is offline. Connect a gateway in Settings to generate.
    </p>
  {/if}
  {#if runError}
    <p class="text-xs text-danger" role="alert">{runError}</p>
  {/if}

  {#if gm.status === 'error'}
    <p class="text-xs text-danger" role="alert">{gm.error}</p>
  {:else if gm.status === 'empty'}
    <p class="text-xs text-text-muted">No clear action found. Paste more of the item.</p>
  {:else if gm.status === 'ready'}
    <ul class="space-y-2" aria-label="Proposed actions">
      {#each gm.missions as m (m.id)}
        <li class="rounded-md border border-border-subtle bg-bg-surface/40 p-3 space-y-1.5">
          <div class="flex items-start justify-between gap-2">
            <h3 class="text-sm font-medium text-text-primary">{m.title}</h3>
            <span
              class="shrink-0 rounded-full border border-border-subtle px-2 py-0.5 text-[10px] uppercase tracking-wide"
              class:text-accent-gold={m.mode === 'approval'}
              class:text-accent-cyan={m.mode === 'dry-run'}
            >
              {m.mode === 'approval' ? 'needs approval' : 'read-only'}
            </span>
          </div>
          {#if m.why}<p class="text-xs text-text-muted">{m.why}</p>{/if}
          {#if m.deliverable}
            <p class="text-xs text-text-muted">
              <span class="text-text-primary">Gives you:</span>
              {m.deliverable}
            </p>
          {/if}
          <div class="flex items-center gap-2 pt-1">
            <button
              type="button"
              onclick={() => runMission(m.id)}
              disabled={runningMissionId !== null}
              class="rounded-md border border-accent-cyan/60 px-2.5 py-1 text-xs text-accent-cyan hover:bg-accent-cyan/10 transition-colors min-h-[36px]"
            >
              {runningMissionId === m.id ? 'Creating...' : 'Create in Work'}
            </button>
            <button
              type="button"
              onclick={() => gm.dismiss(m.id)}
              class="rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text-primary transition-colors min-h-[36px]"
            >
              Dismiss
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
