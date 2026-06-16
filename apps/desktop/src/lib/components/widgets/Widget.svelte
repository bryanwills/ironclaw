<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Widget } from '$lib/api/types';
  import { widgets } from '$lib/stores/widgets.svelte';

  interface Props {
    widget: Widget;
    surface: 'dashboard' | 'canvas' | 'chat';
    children?: Snippet;
  }

  let { widget, surface, children }: Props = $props();

  const isPinnedHere = $derived(widget.pinned_to.includes(surface));
  const isPinnedToDashboard = $derived(widget.pinned_to.includes('dashboard'));

  function togglePin() {
    const target = surface === 'chat' ? 'dashboard' : surface;
    if (widget.pinned_to.includes(target)) {
      widgets.unpin(widget.id, target);
    } else {
      widgets.pin(widget.id, target);
    }
  }
</script>

<div class="rounded-lg border border-border-subtle bg-bg-deep p-3 flex flex-col gap-2">
  <div class="flex items-center justify-between gap-3 text-xs">
    <span class="font-semibold text-text-primary truncate" title={widget.title}>{widget.title}</span
    >
    <div class="flex items-center gap-1 text-text-muted shrink-0">
      <button
        type="button"
        class="widget-action"
        title="Refresh"
        aria-label="Refresh widget"
        onclick={() => void widgets.refresh(widget.id)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 12a8 8 0 0 1-13.5 5.8" />
          <path d="M4 12A8 8 0 0 1 17.5 6.2" />
          <path d="M17.5 2.8v3.4h-3.4" />
          <path d="M6.5 21.2v-3.4h3.4" />
        </svg>
      </button>
      <button
        type="button"
        class="widget-action"
        title={isPinnedHere || isPinnedToDashboard ? 'Unpin' : 'Pin to dashboard'}
        aria-label={isPinnedHere || isPinnedToDashboard ? 'Unpin widget' : 'Pin widget'}
        aria-pressed={isPinnedHere || isPinnedToDashboard}
        onclick={togglePin}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M14.5 4.5 19.5 9.5" />
          <path d="m9 14.8-4.5 4.7" />
          <path d="M8.1 4.7 19.3 15.9" />
          <path d="M8.1 4.7 6.5 9.9 4 12.4l7.6 7.6 2.5-2.5 5.2-1.6" />
        </svg>
      </button>
      <button type="button" class="widget-action" title="Share" aria-label="Share widget">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7.5 12.5 16.5 7.5" />
          <path d="M7.5 11.5 16.5 16.5" />
          <circle cx="5.5" cy="13" r="2.5" />
          <circle cx="18.5" cy="6.5" r="2.5" />
          <circle cx="18.5" cy="17.5" r="2.5" />
        </svg>
      </button>
      <button type="button" class="widget-action" title="More" aria-label="Widget actions">
        <span class="text-base leading-none">⋯</span>
      </button>
    </div>
  </div>
  <div class="min-w-0">
    {#if children}
      {@render children()}
    {/if}
  </div>
</div>

<style>
  .widget-action {
    display: inline-flex;
    width: 1.5rem;
    height: 1.5rem;
    align-items: center;
    justify-content: center;
    border-radius: 0.25rem;
    color: inherit;
    transition:
      color 120ms ease,
      background 120ms ease;
  }

  .widget-action:hover {
    color: #4ca7e6;
    background: rgba(76, 167, 230, 0.1);
  }

  .widget-action svg {
    width: 0.875rem;
    height: 0.875rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
