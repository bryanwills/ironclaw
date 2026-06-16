<script lang="ts">
  // R104: Chief of Staff thread-triage panel. A dismissable modal that shows
  // the executive-filter classification produced by the triage store —
  // recent threads sorted into Decision needed / FYI / Can handle. A reading
  // aid generated from a one-off completion under the CoS persona; it never
  // touches any thread.

  import { triage } from '$lib/stores/triage.svelte';
  import Icon from './Icon.svelte';
  import MarkdownView from './LazyMarkdownView.svelte';

  let { onRegenerate }: { onRegenerate: () => void } = $props();

  function onBackdropKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') triage.close();
  }
</script>

{#if triage.open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6"
    role="presentation"
    onclick={() => triage.close()}
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
      aria-label="Thread triage"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <header class="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
        <Icon name="list" class="w-4 h-4 text-accent-cyan" />
        <span class="text-sm font-medium text-text-primary">Triage</span>
        <span class="text-[11px] text-text-muted">· Decision needed · FYI · Can handle</span>
        <span class="flex-1"></span>
        <button
          type="button"
          onclick={() => onRegenerate()}
          disabled={triage.loading}
          class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-muted
                 hover:text-text-primary hover:bg-bg-hover transition-colors
                 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Re-triage current threads"
        >
          <Icon name="pulse" class="w-3.5 h-3.5" />
          Regenerate
        </button>
        <button
          type="button"
          onclick={() => triage.close()}
          class="text-text-muted hover:text-text-primary transition-colors"
          aria-label="Close triage"
          title="Close"
        >
          <Icon name="close" class="w-4 h-4" />
        </button>
      </header>

      <div class="flex-1 overflow-auto px-4 py-3 text-sm">
        {#if triage.loading && triage.result.length === 0}
          <div class="flex items-center gap-2 text-text-muted">
            <span
              class="w-3 h-3 rounded-full border-2 border-accent-cyan border-t-transparent animate-spin"
              aria-hidden="true"
            ></span>
            Triaging threads…
          </div>
        {:else if triage.error}
          <div class="text-red-300/90">{triage.error}</div>
        {:else if triage.result.length > 0}
          <MarkdownView markdown={triage.result} />
        {:else}
          <div class="text-text-muted">No triage yet.</div>
        {/if}
      </div>

      <footer class="px-4 py-2 border-t border-border-subtle text-[11px] text-text-muted">
        Your Chief of Staff sorted recent threads. Read-only; nothing was sent.
      </footer>
    </div>
  </div>
{/if}
