<script lang="ts">
  // R89: thread recap panel. A dismissable modal that shows the
  // non-destructive summary produced by the recap store. Reading aid only
  // — it never edits the transcript.

  import { recap } from '$lib/stores/recap.svelte';
  import { formatDuration } from '$lib/util/format-time';
  import Icon from './Icon.svelte';

  function onBackdropKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') recap.close();
  }
</script>

{#if recap.open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6"
    role="presentation"
    onclick={() => recap.close()}
    onkeydown={onBackdropKey}
  >
    <!-- Dialog -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="w-full max-w-lg max-h-[80vh] flex flex-col rounded-xl border border-border-subtle
             bg-bg-surface shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="Thread recap"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <header class="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
        <Icon name="spark" class="w-4 h-4 text-accent-cyan" />
        <span class="text-sm font-medium text-text-primary">Thread recap</span>
        <span class="flex-1"></span>
        <button
          type="button"
          onclick={() => recap.close()}
          class="text-text-muted hover:text-text-primary transition-colors"
          aria-label="Close recap"
          title="Close"
        >
          <Icon name="close" class="w-4 h-4" />
        </button>
      </header>

      {#if recap.stats && recap.stats.messageCount > 0}
        <div
          class="flex items-center gap-3 px-4 py-2 border-b border-border-subtle text-[11px] text-text-muted tabular-nums"
        >
          <span>{recap.stats.messageCount} messages</span>
          <span aria-hidden="true">·</span>
          <span>~{recap.stats.estimatedTokens.toLocaleString()} tokens</span>
          {#if recap.stats.spanMs > 0}
            <span aria-hidden="true">·</span>
            <span>over {formatDuration(recap.stats.spanMs)}</span>
          {/if}
        </div>
      {/if}

      <div class="flex-1 overflow-auto px-4 py-3 text-sm">
        {#if recap.loading}
          <div class="flex items-center gap-2 text-text-muted">
            <span
              class="w-3 h-3 rounded-full border-2 border-accent-cyan border-t-transparent animate-spin"
              aria-hidden="true"
            ></span>
            Summarizing…
          </div>
        {:else if recap.error}
          <div class="text-red-300/90">{recap.error}</div>
        {:else}
          <div class="text-text-primary whitespace-pre-wrap leading-relaxed">{recap.summary}</div>
        {/if}
      </div>

      <footer class="px-4 py-2 border-t border-border-subtle text-[11px] text-text-muted">
        A reading aid from this thread. Your messages are untouched.
      </footer>
    </div>
  </div>
{/if}
