<script lang="ts">
  // Council panel — multi-model fanout summoned from the chat composer via
  // `/council <prompt>` (or the composer's council button). Replaces the
  // old standalone `/council` route; reuses the council store + the
  // CouncilColumn component. Self-gating overlay (renders nothing unless
  // `council.open`), modelled on RecapPanel.
  //
  // Fanout targets whatever LLM providers the configured backend exposes
  // via `/api/llm/providers`. Multiple distinct models require NEAR.AI
  // Cloud (or another multi-provider backend); a single-provider gateway
  // lists one entry and we surface a hint to that effect.

  import { type Component } from 'svelte';
  import { goto } from '$app/navigation';
  import type { LlmProvider } from '$lib/api/types';
  import { connection } from '$lib/stores/connection.svelte';
  import { council } from '$lib/stores/council.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import Icon from './Icon.svelte';

  const MIN_PROVIDERS = 2;
  const MAX_PROVIDERS = 4;

  let CouncilColumn = $state<Component<Record<string, unknown>> | null>(null);
  let prompt = $state('');
  let providers = $state<LlmProvider[]>([]);
  let catalogLoading = $state(false);
  let catalogError = $state<string | null>(null);
  let loadedOnce = false;

  const selectedCount = $derived(council.selectedProviderIds.length);
  const canConvene = $derived(
    !council.convening &&
      selectedCount >= MIN_PROVIDERS &&
      selectedCount <= MAX_PROVIDERS &&
      prompt.trim().length > 0
  );
  // A single-provider backend can't actually fan out across distinct
  // models — that needs NEAR.AI Cloud (or another multi-provider backend).
  const singleProvider = $derived(!catalogLoading && !catalogError && providers.length <= 1);

  async function loadCatalog(): Promise<void> {
    const client = connection.client;
    if (!client) {
      catalogError = 'IronClaw is offline';
      providers = [];
      return;
    }
    catalogLoading = true;
    catalogError = null;
    try {
      providers = await client.listLlmProviders();
    } catch (err) {
      catalogError = (err as Error).message;
      providers = [];
    } finally {
      catalogLoading = false;
    }
  }

  // On open: seed the prompt from the composer, hydrate the saved
  // selection, lazy-load the column component + provider catalog (once).
  $effect(() => {
    if (!council.open) {
      loadedOnce = false;
      return;
    }
    prompt = council.initialPrompt;
    council.hydrate();
    if (!CouncilColumn) {
      void import('./CouncilColumn.svelte').then((m) => {
        CouncilColumn = m.default as unknown as Component<Record<string, unknown>>;
      });
    }
    if (!loadedOnce) {
      loadedOnce = true;
      void loadCatalog();
    }
  });

  function providerName(id: string): string {
    return providers.find((p) => p.id === id)?.name ?? id;
  }

  const ACCENTS = ['text-accent-cyan', 'text-accent-gold', 'text-emerald-400', 'text-purple-400'];
  function accentClass(id: string): string {
    const idx = council.selectedProviderIds.indexOf(id);
    return ACCENTS[(idx < 0 ? 0 : idx) % ACCENTS.length];
  }

  function onToggleProvider(id: string): void {
    const already = council.selectedProviderIds.includes(id);
    if (!already && selectedCount >= MAX_PROVIDERS) {
      toasts.show(`Pick at most ${MAX_PROVIDERS} models.`, 'info');
      return;
    }
    council.toggleSelected(id);
  }

  async function onConvene(): Promise<void> {
    const client = connection.client;
    if (!client) {
      toasts.show('IronClaw is offline. Verify the gateway in Settings.', 'error');
      return;
    }
    if (!canConvene) return;
    try {
      await council.convene(prompt, [...council.selectedProviderIds], client);
    } catch (err) {
      toasts.show(`Council failed: ${(err as Error).message}`, 'error');
    }
  }

  async function onPromote(idx: number): Promise<void> {
    const client = connection.client;
    if (!client) return;
    try {
      const threadId = await council.promote(idx, client);
      council.closePanel();
      await goto(`/chat?thread=${encodeURIComponent(threadId)}`);
    } catch {
      // promote() already surfaces a toast on failure.
    }
  }

  const gridCols = $derived.by(() => {
    const n = council.runs.length;
    if (n <= 1) return 'grid-cols-1';
    if (n === 2) return 'grid-cols-1 lg:grid-cols-2';
    return 'grid-cols-1 lg:grid-cols-2 xl:grid-cols-3';
  });
</script>

{#if council.open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6"
    role="presentation"
    onclick={() => council.closePanel()}
    onkeydown={(e) => {
      if (e.key === 'Escape') council.closePanel();
    }}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="w-full max-w-4xl max-h-[85vh] flex flex-col rounded-xl border border-border-subtle bg-bg-surface shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="Council, ask multiple models"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <header class="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
        <Icon name="layers" class="w-4 h-4 text-accent-cyan" />
        <span class="text-sm font-medium text-text-primary">Council</span>
        <span class="text-text-muted text-xs"
          >· ask {MIN_PROVIDERS}–{MAX_PROVIDERS} models at once</span
        >
        <span class="flex-1"></span>
        <button
          type="button"
          onclick={() => council.closePanel()}
          class="text-text-muted hover:text-text-primary transition-colors"
          aria-label="Close council"
          title="Close"
        >
          <Icon name="close" class="w-4 h-4" />
        </button>
      </header>

      <div class="flex-1 overflow-auto px-4 py-3 flex flex-col gap-3">
        <!-- Prompt -->
        <textarea
          bind:value={prompt}
          rows="2"
          placeholder="Ask the council…"
          class="w-full bg-bg-deep text-text-primary text-sm px-3 py-2 rounded-md border border-border-subtle outline-none focus:border-accent-cyan resize-y placeholder:text-text-muted"
        ></textarea>

        <!-- Provider picker -->
        {#if catalogLoading}
          <div class="text-xs text-text-muted">Loading models…</div>
        {:else if catalogError}
          <div class="text-xs text-red-300/90">Failed to load models: {catalogError}</div>
        {:else}
          <div class="flex flex-wrap gap-1.5">
            {#each providers as p (p.id)}
              <button
                type="button"
                aria-pressed={council.selectedProviderIds.includes(p.id)}
                onclick={() => onToggleProvider(p.id)}
                class="px-2.5 py-1 rounded-full text-xs border transition-colors
                  {council.selectedProviderIds.includes(p.id)
                  ? 'border-accent-cyan text-accent-cyan bg-accent-cyan/10'
                  : 'border-border-subtle text-text-muted hover:text-text-primary'}"
              >
                {p.name}
              </button>
            {/each}
          </div>
          {#if singleProvider}
            <div class="text-[11px] text-text-muted">
              This backend exposes a single model. Asking several distinct models at once requires
              NEAR.AI Cloud — configure it in Settings → Connection.
            </div>
          {/if}
        {/if}

        <!-- Convene -->
        <div class="flex items-center gap-2">
          <button
            type="button"
            onclick={() => void onConvene()}
            disabled={!canConvene}
            class="text-xs px-3 py-1.5 rounded-md bg-accent-cyan/15 text-accent-cyan hover:bg-accent-cyan/25 font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {council.convening ? 'Convening…' : 'Convene'}
          </button>
          <span class="text-[11px] text-text-muted">
            {selectedCount}/{MAX_PROVIDERS} selected
          </span>
        </div>

        <!-- Columns -->
        {#if council.runs.length > 0 && CouncilColumn}
          {@const Col = CouncilColumn}
          <div class="grid gap-3 {gridCols}">
            {#each council.runs as run, i (run.providerId + ':' + i)}
              <Col
                {run}
                providerName={providerName(run.providerId)}
                accentClass={accentClass(run.providerId)}
                onPromote={() => void onPromote(i)}
              />
            {/each}
          </div>
        {/if}
      </div>

      <footer class="px-4 py-2 border-t border-border-subtle text-[11px] text-text-muted">
        Responses run in sequence. Promote any column to a thread.
      </footer>
    </div>
  </div>
{/if}
