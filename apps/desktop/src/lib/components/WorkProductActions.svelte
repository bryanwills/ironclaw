<script lang="ts">
  import { toasts } from '$lib/stores/toasts.svelte';
  import type { WorkProductExportFormat } from '$lib/util/work-product-export';

  interface Props {
    title: string;
    content: string;
    jsonContent?: string | null;
    compact?: boolean;
    onSaveToWork?: ((content: string, title: string) => void) | null;
  }

  let {
    title,
    content,
    jsonContent = null,
    compact = false,
    onSaveToWork = null
  }: Props = $props();

  const hasContent = $derived(content.trim().length > 0);
  const hasJsonContent = $derived((jsonContent ?? '').trim().length > 0);
  const actionTitle = $derived(title.trim() || 'Work product');

  async function copy(): Promise<void> {
    try {
      const { copyWorkProduct } = await import('$lib/util/work-product-export');
      await copyWorkProduct(content);
      toasts.show('Copied work product', 'success');
    } catch (error) {
      toasts.show(error instanceof Error ? error.message : 'Copy failed', 'error');
    }
  }

  async function download(format: WorkProductExportFormat): Promise<void> {
    try {
      const { exportWorkProduct } = await import('$lib/util/work-product-export');
      await exportWorkProduct({
        title: actionTitle,
        content: format === 'json' ? (jsonContent ?? '') : content,
        format
      });
      toasts.show(`Exported ${format.toUpperCase()}`, 'success');
    } catch (error) {
      toasts.show(error instanceof Error ? error.message : 'Export failed', 'error');
    }
  }

  function saveToWork(): void {
    onSaveToWork?.(content, actionTitle);
  }
</script>

<div class:compact class="work-product-actions" aria-label="Work product actions">
  <button
    type="button"
    class="work-product-actions__button"
    disabled={!hasContent}
    aria-label={`Copy ${actionTitle}`}
    onclick={copy}
  >
    Copy
  </button>
  {#if onSaveToWork}
    <button
      type="button"
      class="work-product-actions__button work-product-actions__button--primary"
      disabled={!hasContent}
      aria-label={`Save ${actionTitle} to Work`}
      onclick={saveToWork}
    >
      Save to Work
    </button>
  {/if}
  <button
    type="button"
    class="work-product-actions__button"
    disabled={!hasContent}
    aria-label={`Export ${actionTitle} as Markdown`}
    onclick={() => download('markdown')}
  >
    MD
  </button>
  {#if hasJsonContent}
    <button
      type="button"
      class="work-product-actions__button"
      disabled={!hasJsonContent}
      aria-label={`Export ${actionTitle} as JSON`}
      onclick={() => download('json')}
    >
      JSON
    </button>
  {/if}
  <button
    type="button"
    class="work-product-actions__button"
    disabled={!hasContent}
    aria-label={`Export ${actionTitle} as HTML`}
    onclick={() => download('html')}
  >
    HTML
  </button>
  <button
    type="button"
    class="work-product-actions__button"
    disabled={!hasContent}
    aria-label={`Export ${actionTitle} as PDF`}
    onclick={() => download('pdf')}
  >
    PDF
  </button>
  <button
    type="button"
    class="work-product-actions__button"
    disabled={!hasContent}
    aria-label={`Export ${actionTitle} as DOCX`}
    onclick={() => download('docx')}
  >
    DOCX
  </button>
</div>

<style>
  .work-product-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
    justify-content: flex-end;
    margin-bottom: 0.55rem;
  }

  .work-product-actions.compact {
    margin-bottom: 0.45rem;
    justify-content: flex-start;
  }

  .work-product-actions__button {
    min-height: 1.65rem;
    border: 1px solid color-mix(in srgb, var(--v2-border, #334155) 82%, transparent);
    border-radius: 0.45rem;
    background: color-mix(in srgb, var(--v2-surface, #111827) 88%, transparent);
    color: var(--v2-text-muted, #94a3b8);
    padding: 0.2rem 0.48rem;
    font: inherit;
    font-size: 0.72rem;
    font-weight: 650;
    line-height: 1;
    cursor: pointer;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      color 120ms ease,
      transform 120ms ease;
  }

  .work-product-actions__button:hover:not(:disabled),
  .work-product-actions__button:focus-visible {
    border-color: var(--v2-accent, #38bdf8);
    color: var(--v2-text-strong, #f8fafc);
    background: color-mix(in srgb, var(--v2-accent, #38bdf8) 15%, transparent);
    outline: none;
  }

  .work-product-actions__button:hover:not(:disabled) {
    transform: translateY(-1px);
  }

  .work-product-actions__button--primary {
    color: var(--v2-text-strong, #f8fafc);
    border-color: color-mix(in srgb, var(--v2-accent, #38bdf8) 55%, transparent);
    background: color-mix(in srgb, var(--v2-accent, #38bdf8) 14%, transparent);
  }

  .work-product-actions__button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
