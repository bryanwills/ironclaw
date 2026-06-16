<script lang="ts">
  import { onMount, type Component } from 'svelte';
  import type { PromotableBlock } from '$lib/api/types';

  let {
    markdown = '',
    onPromote
  }: { markdown?: string; onPromote?: (block: PromotableBlock) => void } = $props();

  let MarkdownView = $state<Component<{
    markdown?: string;
    onPromote?: (block: PromotableBlock) => void;
  }> | null>(null);

  onMount(() => {
    let active = true;
    void import('./MarkdownView.svelte').then((mod) => {
      if (active) MarkdownView = mod.default;
    });
    return () => {
      active = false;
    };
  });
</script>

{#if MarkdownView}
  <MarkdownView {markdown} {onPromote} />
{:else}
  <div class="lazy-markdown-fallback">{markdown}</div>
{/if}

<style>
  .lazy-markdown-fallback {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
