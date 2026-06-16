<script lang="ts">
  // R101: Chief of Staff daily-brief panel. A dismissable modal that shows
  // the prioritized morning agenda produced by the briefing store — a
  // reading aid generated from a one-off completion under the CoS persona.
  // It never touches any thread.
  //
  // The panel also hosts a compact editor for the user's open loops (tracked
  // commitments). Editing them and hitting "Regenerate" re-runs the brief
  // with the updated context — the page owns thread-gathering, so we call
  // back out via `onRegenerate` rather than reaching for the thread list here.

  import { briefing } from '$lib/stores/briefing.svelte';
  import { openLoops } from '$lib/stores/open-loops.svelte';
  import Icon from './Icon.svelte';
  import MarkdownView from './LazyMarkdownView.svelte';

  let { onRegenerate }: { onRegenerate: () => void } = $props();

  // Draft for the "add a commitment" input.
  let draft = $state('');

  // Friendly date for the header — matches the briefing date the prompt
  // greets by (local day).
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric'
  });

  function addLoop(): void {
    const added = openLoops.add(draft);
    if (added) draft = '';
  }

  function onDraftKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      addLoop();
    }
  }

  function onBackdropKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') briefing.close();
  }
</script>

{#if briefing.open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6"
    role="presentation"
    onclick={() => briefing.close()}
    onkeydown={onBackdropKey}
  >
    <!-- Dialog -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="w-full max-w-xl max-h-[85vh] flex flex-col rounded-xl border border-border-subtle
             bg-bg-surface shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="Daily brief"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <header class="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
        <Icon name="shield" class="w-4 h-4 text-accent-cyan" />
        <span class="text-sm font-medium text-text-primary">Daily brief</span>
        <span class="text-[11px] text-text-muted">· {today}</span>
        <span class="flex-1"></span>
        <button
          type="button"
          onclick={() => onRegenerate()}
          disabled={briefing.loading}
          class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-muted
                 hover:text-text-primary hover:bg-bg-hover transition-colors
                 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Rebuild from current threads and loops"
        >
          <Icon name="pulse" class="w-3.5 h-3.5" />
          Regenerate
        </button>
        <button
          type="button"
          onclick={() => briefing.close()}
          class="text-text-muted hover:text-text-primary transition-colors"
          aria-label="Close brief"
          title="Close"
        >
          <Icon name="close" class="w-4 h-4" />
        </button>
      </header>

      <!-- Open-loops editor: the commitments the CoS weaves into priorities. -->
      <section class="px-4 py-3 border-b border-border-subtle">
        <div class="flex items-center gap-2 mb-2">
          <Icon name="flag" class="w-3.5 h-3.5 text-text-muted" />
          <span class="text-[11px] font-medium uppercase tracking-wide text-text-muted">
            Open loops
          </span>
          {#if openLoops.activeCount > 0}
            <span class="text-[11px] text-text-muted tabular-nums">({openLoops.activeCount})</span>
          {/if}
        </div>

        {#if openLoops.active.length > 0}
          <ul class="flex flex-col gap-1 mb-2 max-h-28 overflow-auto">
            {#each openLoops.active as loop (loop.id)}
              <li class="flex items-center gap-2 group">
                <button
                  type="button"
                  onclick={() => openLoops.toggleDone(loop.id)}
                  class="shrink-0 w-4 h-4 rounded border border-border-subtle text-text-muted
                         hover:border-accent-cyan hover:text-accent-cyan transition-colors
                         flex items-center justify-center"
                  aria-label="Mark done: {loop.text}"
                  title="Mark done"
                >
                </button>
                <span class="flex-1 text-sm text-text-primary truncate" title={loop.text}>
                  {loop.text}
                </span>
                <button
                  type="button"
                  onclick={() => openLoops.remove(loop.id)}
                  class="shrink-0 text-text-muted opacity-0 group-hover:opacity-100
                         hover:text-red-300 transition-all"
                  aria-label="Remove: {loop.text}"
                  title="Remove"
                >
                  <Icon name="trash" class="w-3.5 h-3.5" />
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-[11px] text-text-muted mb-2">
            No commitments tracked. Add one and the brief picks it up.
          </p>
        {/if}

        <div class="flex items-center gap-2">
          <input
            type="text"
            bind:value={draft}
            onkeydown={onDraftKey}
            placeholder="Add a commitment…"
            class="flex-1 rounded-md border border-border-subtle bg-bg-base px-2.5 py-1.5 text-sm
                   text-text-primary placeholder:text-text-muted
                   focus:outline-none focus:border-accent-cyan transition-colors"
            aria-label="Add a commitment"
          />
          <button
            type="button"
            onclick={addLoop}
            disabled={draft.trim().length === 0}
            class="flex items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1.5
                   text-sm text-text-primary hover:bg-bg-hover transition-colors
                   disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Add commitment"
          >
            <Icon name="plus" class="w-3.5 h-3.5" />
            Add
          </button>
        </div>
      </section>

      <!-- The brief itself. -->
      <div class="flex-1 overflow-auto px-4 py-3 text-sm">
        {#if briefing.loading && briefing.brief.length === 0}
          <div class="flex items-center gap-2 text-text-muted">
            <span
              class="w-3 h-3 rounded-full border-2 border-accent-cyan border-t-transparent animate-spin"
              aria-hidden="true"
            ></span>
            Preparing brief…
          </div>
        {:else if briefing.error}
          <div class="text-red-300/90">{briefing.error}</div>
        {:else if briefing.brief.length > 0}
          <MarkdownView markdown={briefing.brief} />
        {:else}
          <div class="text-text-muted">No brief yet.</div>
        {/if}
      </div>

      <footer class="px-4 py-2 border-t border-border-subtle text-[11px] text-text-muted">
        Built by your Chief of Staff from recent threads and loops. Read-only; nothing was sent.
      </footer>
    </div>
  </div>
{/if}
