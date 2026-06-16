<script lang="ts">
  import type { MemoryHit } from '$lib/api/types';

  interface Props {
    results: MemoryHit[];
    query: string;
    onClear: () => void;
    onOpen: (path: string) => void;
    selectedPath: string | null;
  }

  let { results, query, onClear, onOpen, selectedPath }: Props = $props();

  function fmtScore(s: number): string {
    // Scores come back as 0-1 floats (FTS bm25 normalized); show as a tight
    // two-decimal so the gold pill stays compact. Clamp negatives to 0.
    const v = Math.max(0, s);
    return v >= 1 ? v.toFixed(0) : v.toFixed(2);
  }
</script>

<div class="flex items-center justify-between mb-3">
  <h2 class="text-sm text-text-primary">
    {results.length}
    {results.length === 1 ? 'result' : 'results'} for
    <span class="text-accent-cyan">«{query}»</span>
  </h2>
  <button
    type="button"
    onclick={onClear}
    class="text-xs text-text-muted hover:text-accent-gold transition-colors px-2 py-1 rounded"
  >
    Clear search
  </button>
</div>

{#if results.length === 0}
  <div class="surface p-8 text-center text-text-muted text-sm">
    No matches for «{query}»
  </div>
{:else}
  <ul class="space-y-2">
    {#each results as hit (hit.path)}
      {@const active = selectedPath === hit.path}
      <li>
        <button
          type="button"
          onclick={() => onOpen(hit.path)}
          class="w-full text-left surface p-4 hover:border-accent-cyan transition-colors"
          class:border-accent-cyan={active}
        >
          <div class="flex items-start justify-between gap-3 mb-2">
            <span class="text-sm font-mono text-accent-cyan truncate" title={hit.path}>
              {hit.path}
            </span>
            <span
              class="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-accent-gold text-bg-deep"
            >
              {fmtScore(hit.score)}
            </span>
          </div>
          {#if hit.snippet}
            <p class="text-xs text-text-muted leading-relaxed whitespace-pre-wrap break-words">
              {hit.snippet}
            </p>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
{/if}
