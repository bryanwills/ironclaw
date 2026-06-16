<script lang="ts">
  import type { Skill } from '$lib/api/types';
  import { pins } from '$lib/stores/pins.svelte';

  type Props = {
    skill: Skill;
    onOpen: (skill: Skill) => void;
    onRun: (skill: Skill) => void;
    /**
     * Optional focus-related callbacks. The grid container owns the 2D
     * navigation state; the card just reports focus moves and delegates
     * arrow-key handling upward. Optional so any caller that doesn't need
     * keyboard nav can drop the card in unchanged.
     */
    onFocus?: (skill: Skill) => void;
    onArrowKey?: (skill: Skill, key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight') => void;
    /** Stable identifier the parent uses to refocus a specific card. */
    focusId?: string;
  };

  const { skill, onOpen, onRun, onFocus, onArrowKey, focusId }: Props = $props();

  // Whether this skill is in the user's pinned set. Reactive against
  // the pins store so toggling from any surface (this card, palette,
  // future bulk-action menus) flips the star instantly.
  const pinned = $derived(pins.isPinned('skill', skill.name));

  /** Toggle pin from the star button. Stops propagation so the card's
   *  onclick doesn't open the drawer at the same time. */
  function handlePinClick(event: MouseEvent) {
    event.stopPropagation();
    pins.toggle('skill', skill.name, skill.name);
  }

  /** DOM ref so the parent can imperatively .focus() this card. */
  let el = $state<HTMLButtonElement | null>(null);

  // Expose the element via a data-focus-id attribute the parent queries
  // back through the DOM. Using a ref-bag pattern would require a more
  // invasive store; the DOM round-trip is fine for a grid of ~100 cards.
  /**
   * Trust badge metadata. The task spec defines three first-class values
   * (`Bundled`, `Verified`, `Unverified`) styled distinctly. Any other value
   * the server emits is ignored so the badge doesn't render — preferable to
   * surfacing a garbled label and pretending it has a meaning we don't know.
   */
  type BadgeClass = {
    label: string;
    classes: string;
    warn: boolean;
  };

  const trustBadge = $derived.by<BadgeClass | null>(() => {
    const t = skill.trust;
    if (!t) return null;
    switch (t) {
      case 'Bundled':
        return {
          label: 'Bundled',
          classes: 'border-accent-cyan/60 text-accent-cyan bg-accent-cyan/10',
          warn: false
        };
      case 'Verified':
        return {
          label: 'Verified',
          classes: 'border-emerald-400/60 text-emerald-300 bg-emerald-500/10',
          warn: false
        };
      case 'Unverified':
        return {
          label: 'Unverified',
          classes: 'border-accent-gold/60 text-accent-gold bg-accent-gold/10',
          warn: true
        };
      default:
        return null;
    }
  });

  /**
   * Pull a slash token out of the server's `usage_hint`. The server emits a
   * sentence like "Type `/foo` in chat to force-activate this skill." — we
   * extract the backtick-delimited token. Falls back to the derived heuristic.
   */
  const usageHint = $derived.by(() => {
    const raw = skill.usage_hint;
    if (raw) {
      const m = raw.match(/`([^`]+)`/);
      if (m) return m[1];
      const trimmed = raw.trim();
      if (trimmed.startsWith('/')) return trimmed.split(/\s+/)[0];
    }
    return `/${skill.name}`;
  });

  function handleRunClick(event: MouseEvent) {
    // Don't bubble up to the card's onclick handler.
    event.stopPropagation();
    onRun(skill);
  }

  function handleKey(event: KeyboardEvent) {
    // Enter → run; Space → open drawer. This matches the task spec which
    // treats the card as a "run" affordance with Space reserved for the
    // richer detail view.
    if (event.key === 'Enter') {
      event.preventDefault();
      onRun(skill);
      return;
    }
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      onOpen(skill);
      return;
    }
    if (
      event.key === 'ArrowUp' ||
      event.key === 'ArrowDown' ||
      event.key === 'ArrowLeft' ||
      event.key === 'ArrowRight'
    ) {
      // Let the parent compute the next card based on grid geometry.
      // We stop propagation so the page's own keyhandler (search input,
      // drawer) doesn't double-fire.
      event.preventDefault();
      onArrowKey?.(skill, event.key);
    }
  }

  function handleFocus() {
    onFocus?.(skill);
  }
</script>

<div
  data-skill-card={focusId ?? skill.name}
  class="v2-interactive-card group relative flex flex-col p-4 focus-within:outline-none min-h-[160px]"
>
  <!-- Pin star. Sits top-right; when a trust badge is present, the badge
       renders inline next to the star so neither overlaps the other.
       Gold-filled when pinned, hollow + muted when not. Hover lifts the
       muted state to gold for affordance. -->
  <div class="absolute top-3 right-3 flex items-center gap-1.5">
    {#if trustBadge}
      <span
        class={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${trustBadge.classes}`}
        title={trustBadge.warn
          ? 'Unverified skill — review the source before running on production data.'
          : `Trust level: ${trustBadge.label}`}
      >
        {#if trustBadge.warn}
          <svg
            viewBox="0 0 24 24"
            class="w-2.5 h-2.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path
              d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
            />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        {/if}
        {trustBadge.label}
      </span>
    {/if}
    <button
      type="button"
      onclick={handlePinClick}
      title={pinned ? 'Unpin this skill' : 'Pin this skill'}
      aria-label={pinned ? `Unpin ${skill.name}` : `Pin ${skill.name}`}
      aria-pressed={pinned}
      class="inline-flex items-center justify-center w-5 h-5 rounded transition-colors hover:bg-bg-deep"
      class:text-accent-gold={pinned}
      class:text-text-muted={!pinned}
      class:hover:text-accent-gold={!pinned}
    >
      <svg
        viewBox="0 0 24 24"
        class="w-3.5 h-3.5"
        fill={pinned ? 'currentColor' : 'none'}
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polygon
          points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
        />
      </svg>
    </button>
  </div>

  <button
    bind:this={el}
    type="button"
    data-skill-card-focus
    onclick={() => onOpen(skill)}
    onkeydown={handleKey}
    onfocus={handleFocus}
    class="mb-2 flex flex-1 flex-col pr-20 text-left focus:outline-none"
  >
    <h3 class="text-sm font-semibold text-accent-cyan break-words">
      {skill.name}
    </h3>

    <p
      class="mt-2 text-xs text-text-muted leading-relaxed flex-1 overflow-hidden"
      style="display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;"
    >
      {skill.description || 'No description'}
    </p>

    <div
      class="mt-2 max-w-full text-[11px] font-mono text-accent-cyan/90 truncate"
      title="Type this in chat to run"
    >
      {usageHint}
    </div>
  </button>

  <div class="mt-3 pt-3 border-t border-border-subtle flex items-center justify-between">
    <span class="text-[10px] font-mono text-text-muted bg-bg-deep px-2 py-1 rounded">
      v{skill.version || '—'}
    </span>
    <button
      type="button"
      onclick={handleRunClick}
      class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent-gold text-bg-deep text-xs font-semibold hover:brightness-95 transition min-h-[32px]"
      aria-label={`Run ${skill.name}`}
    >
      <svg viewBox="0 0 24 24" class="w-3 h-3" fill="currentColor" stroke="none">
        <polygon points="6 4 20 12 6 20 6 4" />
      </svg>
      Run
    </button>
  </div>
</div>
