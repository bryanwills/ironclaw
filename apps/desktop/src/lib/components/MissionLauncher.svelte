<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { FIRST_RUN_MISSIONS, recommendMissions, type Mission } from '$lib/data/missions';
  import {
    CONNECTOR_PACKS,
    connectorPackById,
    connectorPackStatus,
    type ConnectorPackId,
    type ConnectorPackStatus
  } from '$lib/data/connector-packs';
  import type { Extension } from '$lib/api/types';
  import { connection } from '$lib/stores/connection.svelte';
  import { composerInsert } from '$lib/stores/templates.svelte';
  import { workItems } from '$lib/stores/work-items.svelte';
  import { planFirstRunMissionWorkflow } from '$lib/util/workflow-orchestrator';

  interface Props {
    onlaunch?: (missionId: string) => void;
    packStatuses?: Record<string, ConnectorPackStatus> | null;
  }

  let { onlaunch, packStatuses: providedPackStatuses = null }: Props = $props();

  const missions: Mission[] = FIRST_RUN_MISSIONS;
  type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

  let loadState = $state<LoadState>('idle');
  let loadError = $state<string | null>(null);
  let installed = $state<Extension[]>([]);
  let hourOfDay = $state(new Date().getHours());

  const installedByName = $derived.by(() => {
    const byName = new Map<string, Extension>();
    for (const ext of installed) {
      byName.set(ext.name, ext);
    }
    return byName;
  });
  const runnerReady = $derived(connection.client !== null && connection.status === 'connected');

  const packStatusRecord = $derived.by(() => {
    const statuses = {} as Record<ConnectorPackId, ConnectorPackStatus>;
    for (const pack of CONNECTOR_PACKS) {
      statuses[pack.id] = runnerReady
        ? (providedPackStatuses?.[pack.id] ?? statusForPack(pack.id))
        : 'locked';
    }
    return statuses;
  });
  const packStatuses = $derived.by(() => {
    const statuses = new Map<ConnectorPackId, ConnectorPackStatus>();
    for (const pack of CONNECTOR_PACKS) {
      statuses.set(pack.id, packStatusRecord[pack.id]);
    }
    return statuses;
  });
  // The "Recommended" highlight is connector-driven — its reason cites the connected
  // pack(s). Connectorless utility missions (e.g. Review a Contract, Draft from Notes)
  // are always launchable from the grid, so we exclude them here rather than recommend
  // them without a workspace reason.
  const recommendedMissions = $derived.by(() =>
    recommendMissions(missions, packStatusRecord, hourOfDay)
      .filter((mission) => (mission.required_connectors ?? []).length > 0)
      .slice(0, 2)
  );
  const usesProvidedPackStatuses = $derived(providedPackStatuses !== null);

  onMount(() => {
    hourOfDay = new Date().getHours();
    if (usesProvidedPackStatuses || !runnerReady) return;
    untrack(() => void refreshReadiness());
  });

  $effect(() => {
    if (usesProvidedPackStatuses) return;
    if (!runnerReady) {
      loadState = 'idle';
      installed = [];
      return;
    }
    untrack(() => void refreshReadiness());
  });

  function connectorLabel(id: string): string {
    return (
      connectorPackById(id)?.display_name ??
      id
        .split(/[-_]/)
        .filter(Boolean)
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join(' ')
    );
  }

  function statusForPack(packId: ConnectorPackId): ConnectorPackStatus {
    const pack = connectorPackById(packId);
    if (!pack) return 'unknown';
    if (loadState === 'loading' && installed.length === 0) return 'checking';
    if (loadState === 'error' && installed.length === 0) return 'unknown';
    return connectorPackStatus(pack, installedByName);
  }

  function missingConnectors(mission: Mission): ConnectorPackId[] {
    return (mission.required_connectors ?? []).filter(
      (connector) => packStatuses.get(connector) !== 'connected'
    );
  }

  function missingMessage(missing: ConnectorPackId[]): string {
    const labels = missing.map(connectorLabel);
    if (labels.length === 0) return '';
    if (labels.length === 1) return `Needs ${labels[0]}`;
    return `Needs ${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  }

  function readyConnectorMessage(mission: Mission): string {
    const labels = (mission.required_connectors ?? []).map(connectorLabel);
    if (labels.length === 0) return 'No connectors required';
    if (labels.length === 1) return `${labels[0]} connected`;
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]} connected`;
  }

  function nextConnectorHref(missing: ConnectorPackId[]): string {
    const first = missing[0];
    const pack = first ? connectorPackById(first) : null;
    const focus = pack?.primary_extension_id ?? first ?? '';
    const params = new URLSearchParams({ focus });
    params.set('setup', '1');
    return `/extensions?${params.toString()}`;
  }

  function connectorActionLabel(missing: ConnectorPackId[]): string {
    const first = missing[0];
    if (!first) return 'Open setup';
    return `Connect ${connectorLabel(first)}`;
  }

  function missionPrompt(mission: Mission): string {
    return `Mission: ${mission.title}
Source: mission:${mission.id}
Mode: ${mission.mode}

${mission.prompt}`;
  }

  async function refreshReadiness(): Promise<void> {
    const client = connection.client;
    if (!client || connection.status !== 'connected') {
      loadState = 'idle';
      loadError = null;
      installed = [];
      return;
    }

    loadState = installed.length === 0 ? 'loading' : loadState;
    loadError = null;
    try {
      installed = (await client.listExtensions())
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
      loadState = 'loaded';
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Could not check connectors';
      loadState = 'error';
    }
  }

  function launchMission(mission: Mission): void {
    if (!runnerReady) return;
    const workflow = planFirstRunMissionWorkflow(mission);
    let prompt = missionPrompt(mission);
    if (workflow.status === 'routed') {
      const created = workItems.create({
        ...workflow.route.workItem,
        links: [{ kind: 'mission', ref: mission.id, label: mission.title }]
      });
      if (created) {
        prompt = `Work item: ${created.title}
Runbook: ${created.runbookIds.join(', ') || 'none'}

${prompt}`;
      }
    } else if (workflow.status === 'needs_clarification') {
      prompt = `Routing note: ${workflow.route.reason}. Ask the missing routing/context question before doing external work.

${prompt}`;
    }
    composerInsert.push(prompt, null, {
      title: mission.title,
      source: `mission:${mission.id}`,
      mode: mission.mode,
      autorun: true
    });
    void goto('/chat');
    onlaunch?.(mission.id);
  }
</script>

<section class="w-full" aria-label="First-run missions">
  {#if loadState === 'error'}
    <div
      class="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
      role="status"
    >
      Could not check connectors.
      <span class="font-mono text-xs text-red-200/80">{loadError}</span>
    </div>
  {/if}

  {#if missions.length > 0}
    <div class="mb-4" data-testid="recommended-missions">
      {#if recommendedMissions.length > 0}
        <div class="mb-3 flex items-center justify-between gap-3">
          <h2 class="text-xs font-semibold uppercase text-text-muted">Recommended</h2>
        </div>
        <div class="grid gap-2 md:grid-cols-2">
          {#each recommendedMissions as mission (mission.id)}
            <article
              class="rounded-md border border-accent-cyan/50 bg-bg-deep/60 p-3"
              data-testid={`recommended-mission-${mission.id}`}
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-[11px] font-semibold text-accent-cyan">
                    Recommended · {readyConnectorMessage(mission)}
                  </div>
                  <h3 class="mt-1 text-sm font-semibold text-text-primary">{mission.title}</h3>
                  <p class="mt-1 text-xs leading-5 text-text-muted">{mission.description}</p>
                </div>
                <span
                  class="shrink-0 rounded-full border border-accent-cyan/30 bg-accent-cyan/10 px-2 py-1 text-[11px] font-medium text-accent-cyan"
                >
                  {mission.mode === 'approval' ? 'Approval mode' : 'Dry run'}
                </span>
              </div>
              <button
                type="button"
                onclick={() => launchMission(mission)}
                class="mt-3 inline-flex min-h-[36px] w-full items-center justify-center rounded-md border border-accent-cyan/50 bg-accent-cyan/10 px-3 py-2 text-sm font-semibold text-accent-cyan transition hover:bg-accent-cyan hover:text-bg-deep"
                aria-label={`Launch recommended mission: ${mission.title}`}
              >
                Launch mission
              </button>
            </article>
          {/each}
        </div>
      {:else}
        <p class="text-sm text-text-muted" role="status">
          {runnerReady
            ? 'Connect a workspace pack for a recommendation.'
            : 'Connect a healthy runner for recommendations.'}
        </p>
      {/if}
    </div>

    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="mission-grid">
      {#each missions as mission (mission.id)}
        {@const missing = missingConnectors(mission)}
        {@const disabled = !runnerReady || missing.length > 0}
        <article
          class={`flex min-h-[210px] w-full flex-col rounded-lg border bg-bg-surface/70 p-4 ${disabled ? 'border-border-subtle' : 'border-accent-cyan/50'}`}
          class:opacity-80={disabled}
          data-testid={`mission-card-${mission.id}`}
        >
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <h3
                id={`mission-title-${mission.id}`}
                class="text-sm font-semibold text-text-primary transition-colors group-hover:text-accent-cyan"
              >
                {mission.title}
              </h3>
              <p
                id={`mission-description-${mission.id}`}
                class="mt-2 text-sm leading-5 text-text-muted"
              >
                {mission.description}
              </p>
            </div>
            <span
              class="shrink-0 rounded-full border border-accent-cyan/30 bg-accent-cyan/10 px-2 py-1 text-[11px] font-medium text-accent-cyan"
            >
              {mission.mode === 'approval' ? 'Approval mode' : 'Dry run'}
            </span>
          </div>

          <div class="mt-auto flex flex-wrap gap-2 pt-4" aria-label="Required connectors">
            {#if (mission.required_connectors ?? []).length > 0}
              {#each mission.required_connectors ?? [] as connector}
                <span
                  class="rounded-md border border-border-subtle bg-bg-deep/60 px-2 py-1 text-[11px] font-medium text-text-muted"
                >
                  {connectorLabel(connector)}
                </span>
              {/each}
            {:else}
              <span
                class="rounded-md border border-border-subtle bg-bg-deep/60 px-2 py-1 text-[11px] font-medium text-text-muted"
              >
                No connectors required
              </span>
            {/if}
          </div>

          {#if !runnerReady}
            <div
              class="mt-3 rounded-md border border-border-subtle bg-bg-deep/70 px-3 py-2 text-xs text-text-muted"
              role="status"
            >
              <div class="font-semibold text-text-primary">Connect runner first</div>
              <a
                href="/settings"
                class="mt-1 inline-flex text-accent-cyan underline decoration-dotted hover:decoration-solid"
              >
                Open Settings
              </a>
            </div>
          {:else if missing.length > 0}
            <div
              class="mt-3 rounded-md border border-border-subtle bg-bg-deep/70 px-3 py-2 text-xs text-text-muted"
              role="status"
            >
              <div class="font-semibold text-text-primary">{missingMessage(missing)}</div>
              <a
                href={nextConnectorHref(missing)}
                class="mt-1 inline-flex text-accent-cyan underline decoration-dotted hover:decoration-solid"
              >
                {connectorActionLabel(missing)}
              </a>
            </div>
          {/if}

          <button
            type="button"
            onclick={() => launchMission(mission)}
            {disabled}
            class="mt-3 inline-flex min-h-[40px] w-full items-center justify-center rounded-md border border-accent-cyan/40 px-3 py-2 text-sm font-semibold text-accent-cyan transition hover:bg-accent-cyan hover:text-bg-deep disabled:cursor-not-allowed disabled:border-border-subtle disabled:text-text-muted disabled:hover:bg-transparent"
            aria-label={mission.title}
            aria-describedby={`mission-description-${mission.id}`}
          >
            Launch mission
          </button>
        </article>
      {/each}
    </div>
  {:else}
    <div
      class="rounded-lg border border-border-subtle bg-bg-surface/70 px-4 py-5 text-sm text-text-muted"
      role="status"
    >
      No missions available yet.
    </div>
  {/if}
</section>
