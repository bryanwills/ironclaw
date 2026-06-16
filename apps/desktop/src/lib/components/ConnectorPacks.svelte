<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    CONNECTOR_PACKS,
    connectorPackStatus,
    type ConnectorPack,
    type ConnectorPackStatus
  } from '$lib/data/connector-packs';
  import { connection } from '$lib/stores/connection.svelte';
  import type { Extension } from '$lib/api/types';

  type Props = {
    onconnected?: (packId: string) => void;
    onreadinesschange?: (statuses: Record<string, ConnectorPackStatus>) => void;
  };

  type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

  type PackActionState = {
    installing: boolean;
    message: string | null;
    error: string | null;
    unavailable: boolean;
  };

  type StatusView = {
    label: string;
    classes: string;
  };

  let { onconnected, onreadinesschange }: Props = $props();

  const packs = CONNECTOR_PACKS;

  let loadState = $state<LoadState>('idle');
  let loadError = $state<string | null>(null);
  let readinessError = $state<unknown>(null);
  let installed = $state<Extension[]>([]);
  let actionByPack = $state<Record<string, PackActionState>>(createActionState());

  const installedByName = $derived.by(() => {
    const byName = new Map<string, Extension>();
    for (const ext of installed) {
      byName.set(ext.name, ext);
    }
    return byName;
  });

  const runnerReady = $derived(connection.client !== null && connection.status === 'connected');
  const anyInstalling = $derived(Object.values(actionByPack).some((action) => action.installing));

  const STATUS_VIEW: Record<ConnectorPackStatus, StatusView> = {
    checking: {
      label: 'Checking',
      classes: 'border-border-subtle text-text-muted bg-bg-deep'
    },
    unknown: {
      label: 'Unknown',
      classes: 'border-border-subtle text-text-muted bg-bg-deep'
    },
    locked: {
      label: 'Needs runner',
      classes: 'border-border-subtle text-text-muted bg-bg-deep'
    },
    connected: {
      label: 'Connected',
      classes: 'border-accent-cyan/60 text-accent-cyan bg-accent-cyan/10'
    },
    partial: {
      label: 'Partial',
      classes: 'border-yellow-500/50 text-yellow-300 bg-yellow-500/10'
    },
    'needs-auth': {
      label: 'Needs sign-in',
      classes: 'border-orange-500/50 text-orange-300 bg-orange-500/10'
    },
    'not-installed': {
      label: 'Not installed',
      classes: 'border-border-subtle text-text-muted bg-bg-deep'
    }
  };

  const packStatuses = $derived.by(() => {
    const statuses: Record<string, ConnectorPackStatus> = {};
    for (const pack of packs) {
      statuses[pack.id] = statusForPack(pack);
    }
    return statuses;
  });

  $effect(() => {
    onreadinesschange?.(packStatuses);
  });

  $effect(() => {
    if (!runnerReady) {
      installed = [];
      loadState = 'idle';
      loadError = null;
      return;
    }
    untrack(() => void refreshReadiness());
  });

  function createActionState(): Record<string, PackActionState> {
    return Object.fromEntries(
      packs.map((pack) => [
        pack.id,
        {
          installing: false,
          message: null,
          error: null,
          unavailable: false
        }
      ])
    );
  }

  function setPackAction(packId: string, patch: Partial<PackActionState>): void {
    const previous =
      actionByPack[packId] ??
      ({
        installing: false,
        message: null,
        error: null,
        unavailable: false
      } satisfies PackActionState);
    actionByPack = {
      ...actionByPack,
      [packId]: {
        ...previous,
        ...patch
      }
    };
  }

  function statusForPack(pack: ConnectorPack, source = installedByName): ConnectorPackStatus {
    if (!runnerReady) return 'locked';
    if (loadState === 'loading' && installed.length === 0) return 'checking';
    if (loadState === 'error' && installed.length === 0) return 'unknown';
    return connectorPackStatus(pack, source);
  }

  function statusView(status: ConnectorPackStatus): StatusView {
    return STATUS_VIEW[status];
  }

  async function refreshReadiness(opts: { quiet?: boolean } = {}): Promise<Extension[] | null> {
    const client = connection.client;
    if (!client || connection.status !== 'connected') {
      if (!opts.quiet) {
        loadState = 'idle';
        loadError = null;
        installed = [];
      }
      return null;
    }

    if (!opts.quiet) {
      loadState = installed.length === 0 ? 'loading' : loadState;
      loadError = null;
    }

    try {
      const list = await client.listExtensions();
      installed = list.slice().sort((a, b) => a.name.localeCompare(b.name));
      loadState = 'loaded';
      loadError = null;
      readinessError = null;
      return installed;
    } catch (error) {
      loadError = describeError(error);
      readinessError = error;
      if (!opts.quiet) {
        loadState = 'error';
      }
      return null;
    }
  }

  function mapByName(list: Extension[]): Map<string, Extension> {
    const byName = new Map<string, Extension>();
    for (const ext of list) {
      byName.set(ext.name, ext);
    }
    return byName;
  }

  function coreExtensionIds(pack: ConnectorPack): string[] {
    return pack.core_extensions ?? pack.extensions;
  }

  function optionalExtensionIds(pack: ConnectorPack): string[] {
    const core = new Set(coreExtensionIds(pack));
    return pack.extensions.filter((extensionId) => !core.has(extensionId));
  }

  function extensionsHref(pack: ConnectorPack, opts: { setup?: boolean } = {}): string {
    const params = new URLSearchParams({ focus: pack.primary_extension_id });
    if (opts.setup) params.set('setup', '1');
    return `/extensions?${params.toString()}`;
  }

  function openInExtensions(pack: ConnectorPack): void {
    void goto(extensionsHref(pack));
  }

  async function handleConnect(pack: ConnectorPack): Promise<void> {
    const client = connection.client;
    if (!client || connection.status !== 'connected') {
      setPackAction(pack.id, {
        installing: false,
        message: 'Connect a healthy runner first.',
        error: null,
        unavailable: false
      });
      return;
    }

    setPackAction(pack.id, {
      installing: true,
      message: null,
      error: null,
      unavailable: false
    });

    try {
      for (const extensionId of coreExtensionIds(pack)) {
        await client.installExtension(extensionId, pack.extension_kind_hints?.[extensionId]);
      }

      let optionalFailures = 0;
      for (const extensionId of optionalExtensionIds(pack)) {
        try {
          await client.installExtension(extensionId, pack.extension_kind_hints?.[extensionId]);
        } catch {
          optionalFailures += 1;
        }
      }

      const latest = await refreshReadiness({ quiet: true });
      if (!latest) {
        const unavailable = isEndpointUnavailable(readinessError);
        setPackAction(pack.id, {
          installing: false,
          message: unavailable ? 'Not available on this gateway' : null,
          error: unavailable ? null : (loadError ?? 'Could not check connectors.'),
          unavailable
        });
        return;
      }

      const status = statusForPack(pack, mapByName(latest));
      if (status === 'connected') {
        setPackAction(pack.id, {
          installing: false,
          message:
            optionalFailures > 0
              ? 'Connected. Optional apps unavailable on this gateway.'
              : 'Connected',
          error: null,
          unavailable: false
        });
        onconnected?.(pack.id);
        return;
      }

      if (status === 'needs-auth') {
        setPackAction(pack.id, {
          installing: false,
          message: 'Sign-in required. Open setup.',
          error: null,
          unavailable: false
        });
        void goto(extensionsHref(pack, { setup: true }));
        return;
      }

      setPackAction(pack.id, {
        installing: false,
        message:
          optionalFailures > 0
            ? 'Core apps installed. Open setup if optional apps need credentials.'
            : 'Install requested. Open setup if credentials are needed.',
        error: null,
        unavailable: false
      });
      void goto(extensionsHref(pack, { setup: true }));
    } catch (error) {
      const unavailable = isEndpointUnavailable(error);
      setPackAction(pack.id, {
        installing: false,
        message: unavailable ? 'Not available on this gateway' : null,
        error: unavailable ? null : describeError(error),
        unavailable
      });
    }
  }

  function describeError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) return error.message;
    if (typeof error === 'string' && error.trim().length > 0) return error;
    return 'Unknown error';
  }

  function isEndpointUnavailable(error: unknown): boolean {
    const status =
      error && typeof error === 'object' && 'status' in error
        ? (error as { status?: unknown }).status
        : null;
    if (status === 404 || status === 405) return true;
    return /\b(404|405)\b/.test(describeError(error));
  }
</script>

<section class="space-y-4" aria-labelledby="connector-packs-heading" aria-busy={anyInstalling}>
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h2 id="connector-packs-heading" class="text-lg font-semibold text-text-primary">
        Workspace Packs
      </h2>
      <p class="mt-1 text-sm text-text-muted">Curated extension bundles for common workspaces.</p>
    </div>
    <button
      type="button"
      onclick={() => refreshReadiness()}
      disabled={!runnerReady || loadState === 'loading' || anyInstalling}
      class="inline-flex min-h-[44px] items-center justify-center rounded-md border border-border-subtle px-3 py-2 text-sm font-semibold text-text-muted transition hover:border-accent-cyan hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loadState === 'loading' ? 'Checking…' : 'Refresh'}
    </button>
  </div>

  {#if loadState === 'loading' && installed.length === 0}
    <div
      class="rounded-md border border-border-subtle bg-bg-surface px-4 py-3 text-sm text-text-muted"
      role="status"
    >
      Checking connectors…
    </div>
  {:else if loadState === 'error'}
    <div
      class="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
      role="status"
    >
      Could not check connectors.
      <span class="font-mono text-xs text-red-200/80">{loadError ?? 'Unknown error'}</span>
    </div>
  {/if}

  {#if packs.length === 0}
    <div class="rounded-lg border border-border-subtle bg-bg-surface p-6 text-sm text-text-muted">
      No workspace packs available.
    </div>
  {:else}
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {#each packs as pack (pack.id)}
        {@const status = statusForPack(pack)}
        {@const view = statusView(status)}
        {@const action = actionByPack[pack.id]}
        <article
          class="flex min-h-[260px] flex-col rounded-lg border border-border-subtle bg-bg-surface p-4"
        >
          <div class="flex items-start justify-between gap-3">
            <h3 class="min-w-0 text-sm font-semibold text-accent-cyan">
              {pack.display_name}
            </h3>
            <span
              class={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-mono ${view.classes}`}
            >
              {view.label}
            </span>
          </div>

          <p class="mt-3 text-sm leading-relaxed text-text-muted">{pack.description}</p>

          <div class="mt-4">
            <div class="text-[10px] font-mono uppercase tracking-widest text-text-muted/70">
              Example tasks
            </div>
            <ul class="mt-2 space-y-2 text-xs leading-relaxed text-text-muted">
              {#each pack.example_tasks as task (task)}
                <li class="flex gap-2">
                  <span
                    aria-hidden="true"
                    class="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent-cyan"
                  ></span>
                  <span>{task}</span>
                </li>
              {/each}
            </ul>
          </div>

          <div class="mt-auto space-y-3 pt-5">
            {#if action?.message}
              <div
                class="rounded-md border border-border-subtle bg-bg-deep px-3 py-2 text-xs text-text-primary"
                role="status"
              >
                {#if action.message === 'Sign-in required. Open setup.'}
                  <span>Sign-in required. </span>
                  <a
                    href={extensionsHref(pack, { setup: true })}
                    class="text-accent-cyan underline decoration-dotted hover:decoration-solid"
                    >open setup</a
                  >
                {:else}
                  {action.message}
                {/if}
              </div>
            {/if}

            {#if action?.error}
              <div
                class="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200"
                role="alert"
              >
                {action.error}
              </div>
            {/if}

            <div class="grid gap-2 sm:grid-cols-[1fr_auto]">
              <button
                type="button"
                onclick={() => handleConnect(pack)}
                disabled={!runnerReady || action?.installing === true}
                aria-busy={action?.installing === true}
                class="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-accent-cyan px-4 py-2 text-sm font-semibold text-bg-deep transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {action?.installing
                  ? 'Connecting…'
                  : !runnerReady
                    ? 'Connect runner first'
                    : status === 'connected'
                      ? 'Reconnect'
                      : 'Connect'}
              </button>
              <button
                type="button"
                onclick={() => openInExtensions(pack)}
                class="inline-flex min-h-[44px] items-center justify-center rounded-md border border-border-subtle px-3 py-2 text-sm font-semibold text-text-muted transition hover:border-accent-cyan hover:text-text-primary focus:outline-none focus-visible:border-accent-cyan focus-visible:ring-2 focus-visible:ring-accent-cyan/30"
              >
                Open in Extensions
              </button>
            </div>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>
