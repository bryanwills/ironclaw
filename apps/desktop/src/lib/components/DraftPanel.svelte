<script lang="ts">
  // R105: Chief of Staff "draft to send" panel. A dismissable modal that
  // shows a finished draft the CoS wrote in the user's voice, grounded in
  // the active thread. Editable instruction up top ("reply declining",
  // "follow up asking for the timeline") + Regenerate; Copy lifts the draft
  // to the clipboard. Read-only — nothing is posted into the conversation.

  import { draft } from '$lib/stores/draft.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import Icon from './Icon.svelte';
  import MarkdownView from './LazyMarkdownView.svelte';

  let { onRegenerate }: { onRegenerate: () => void } = $props();

  function onInstructionKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onRegenerate();
    }
  }

  async function copyDraft(): Promise<void> {
    if (!draft.draft) return;
    try {
      await navigator.clipboard.writeText(draft.draft);
      toasts.show('Draft copied.', 'success');
    } catch {
      toasts.show('Copy failed. Select and copy manually.', 'error');
    }
  }

  function onBackdropKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') draft.close();
  }
</script>

{#if draft.open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6"
    role="presentation"
    onclick={() => draft.close()}
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
      aria-label="Draft a reply"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <header class="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
        <Icon name="send" class="w-4 h-4 text-accent-cyan" />
        <span class="text-sm font-medium text-text-primary">Draft</span>
        {#if draft.threadLabel}
          <span class="text-[11px] text-text-muted truncate max-w-[40%]" title={draft.threadLabel}>
            · {draft.threadLabel}
          </span>
        {/if}
        <span class="flex-1"></span>
        <button
          type="button"
          onclick={() => onRegenerate()}
          disabled={draft.loading}
          class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-muted
                 hover:text-text-primary hover:bg-bg-hover transition-colors
                 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Rebuild from current instruction"
        >
          <Icon name="pulse" class="w-3.5 h-3.5" />
          Regenerate
        </button>
        <button
          type="button"
          onclick={() => draft.close()}
          class="text-text-muted hover:text-text-primary transition-colors"
          aria-label="Close draft"
          title="Close"
        >
          <Icon name="close" class="w-4 h-4" />
        </button>
      </header>

      <!-- Instruction: what to write. Empty → the CoS infers the likely reply. -->
      <div class="px-4 py-3 border-b border-border-subtle flex items-center gap-2">
        <input
          type="text"
          bind:value={draft.instruction}
          onkeydown={onInstructionKey}
          placeholder="What should this say? (leave blank to infer)"
          class="flex-1 rounded-md border border-border-subtle bg-bg-base px-2.5 py-1.5 text-sm
                 text-text-primary placeholder:text-text-muted
                 focus:outline-none focus:border-accent-cyan transition-colors"
          aria-label="Draft instruction"
        />
        <button
          type="button"
          onclick={() => onRegenerate()}
          disabled={draft.loading}
          class="shrink-0 rounded-md border border-border-subtle px-2.5 py-1.5 text-sm
                 text-text-primary hover:bg-bg-base/60 transition-colors
                 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Draft
        </button>
      </div>

      <div class="flex-1 overflow-auto px-4 py-3 text-sm">
        {#if draft.loading && draft.draft.length === 0}
          <div class="flex items-center gap-2 text-text-muted">
            <span
              class="w-3 h-3 rounded-full border-2 border-accent-cyan border-t-transparent animate-spin"
              aria-hidden="true"
            ></span>
            Writing draft…
          </div>
        {:else if draft.error}
          <div class="text-red-300/90">{draft.error}</div>
        {:else if draft.draft.length > 0}
          <MarkdownView markdown={draft.draft} />
        {:else}
          <div class="text-text-muted">No draft yet.</div>
        {/if}
      </div>

      <footer class="flex items-center gap-2 px-4 py-2 border-t border-border-subtle">
        <span class="flex-1 text-[11px] text-text-muted">
          Drafted in your voice. Read-only; nothing was sent.
        </span>
        <button
          type="button"
          onclick={copyDraft}
          disabled={!draft.draft || draft.loading}
          class="flex items-center gap-1.5 rounded-md bg-accent-cyan/10 border border-accent-cyan/30
                 px-3 py-1.5 text-sm text-accent-cyan hover:bg-accent-cyan/20 transition-colors
                 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Icon name="copy" class="w-3.5 h-3.5" />
          Copy
        </button>
      </footer>
    </div>
  </div>
{/if}
