<script lang="ts">
  // Tile.svelte — base widget chrome for the dashboard / "Today" surface.
  //
  // Wraps a tile's content in a card with three load-bearing affordances:
  //   - Drag handle (top-left). HTML5 native drag-and-drop on a small
  //     grip glyph; the wrapper card itself stays non-draggable so the
  //     tile's interior buttons / links keep their click targets
  //     untouched. The parent <TileGrid> owns the actual reorder
  //     bookkeeping; this component only emits start/over/end via the
  //     `onDragStart` / `onDragEnd` callbacks.
  //   - ⋮ overflow menu (top-right). v1 surfaces a single action — Remove
  //     — which calls `onRemove(tile.id)`. Future actions (Resize, Refresh,
  //     Pin) extend this menu without touching the tile bodies.
  //   - Body slot (children). The host route mounts the kind-specific
  //     widget here.
  //
  // The drag handle uses `role="button"` because draggable spans aren't
  // self-announcing to screen readers; the aria-label spells the
  // affordance. Keyboard reorder is out of scope for v1 — DnD is the
  // first cut; a Cmd-arrow keyboard chord lands in a follow-up alongside
  // the W7 spatial canvas (same drag-arrange semantics, same handler).

  import { defaultTitleForKind, type TileConfig } from '$lib/stores/dashboard.svelte';

  interface Props {
    tile: TileConfig;
    /**
     * Click-handler for the ⋮ → Remove action. The grid owns the actual
     * mutation against the dashboard store, so the tile just signals the
     * intent.
     */
    onRemove?: (id: string) => void;
    /**
     * Drag-start handler. The grid uses this to record the source index
     * for the eventual `reorder()` call. The event itself is the host's
     * to mutate (effectAllowed / setData) — we only forward it.
     */
    onDragStart?: (e: DragEvent, id: string) => void;
    /** Drag-end handler (fires on the source even when no drop landed). */
    onDragEnd?: (e: DragEvent, id: string) => void;
    /** Children rendered inside the card body. */
    children?: import('svelte').Snippet;
    /** Optional footer snippet (e.g. a "View all →" link). */
    footer?: import('svelte').Snippet;
  }

  let { tile, onRemove, onDragStart, onDragEnd, children, footer }: Props = $props();

  let menuOpen = $state(false);

  const title = $derived<string>(tile.title ?? defaultTitleForKind(tile.kind));

  function toggleMenu(e: MouseEvent) {
    e.stopPropagation();
    menuOpen = !menuOpen;
  }

  function handleRemove() {
    menuOpen = false;
    onRemove?.(tile.id);
  }

  function handleDragStart(e: DragEvent) {
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', tile.id);
      } catch {
        // Some webkit configs reject setData on certain origins —
        // non-fatal for the drag itself, the grid keys off the
        // source-id state instead of relying on dataTransfer payload.
      }
    }
    onDragStart?.(e, tile.id);
  }

  function handleDragEnd(e: DragEvent) {
    onDragEnd?.(e, tile.id);
  }
</script>

<article
  class="dashboard-tile relative flex flex-col h-full min-h-[220px] rounded-lg border border-border-subtle bg-bg-surface/70 overflow-hidden"
  data-tile-id={tile.id}
  data-tile-kind={tile.kind}
>
  <header
    class="flex min-h-[56px] items-center gap-2 px-3 border-b border-border-subtle bg-bg-deep/40"
  >
    <!-- Drag handle. The grip glyph mirrors the per-profile drag handles
         in Sidebar.svelte (six-dot grid) for visual consistency. Only
         the strip itself is draggable, so dragging from the title text
         is a no-op (matches the brief — "drag-to-rearrange tiles" means
         the handle, not a row-wide drag target). -->
    <div
      class="shrink-0 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-text-muted hover:text-accent-cyan hover:bg-bg-surface/80 cursor-grab active:cursor-grabbing transition-colors"
      role="button"
      tabindex="0"
      draggable="true"
      ondragstart={handleDragStart}
      ondragend={handleDragEnd}
      aria-label="Drag to rearrange"
      title="Drag to rearrange"
      data-testid="tile-drag-handle"
    >
      <svg viewBox="0 0 24 24" class="w-3 h-3.5" fill="currentColor" aria-hidden="true">
        <circle cx="9" cy="6" r="1.5" />
        <circle cx="15" cy="6" r="1.5" />
        <circle cx="9" cy="12" r="1.5" />
        <circle cx="15" cy="12" r="1.5" />
        <circle cx="9" cy="18" r="1.5" />
        <circle cx="15" cy="18" r="1.5" />
      </svg>
    </div>

    <h2 class="flex-1 truncate text-sm font-semibold text-text-primary" data-testid="tile-title">
      {title}
    </h2>

    <!-- ⋮ menu. The button mounts a tiny popover below it. Outside
         clicks dismiss via the document-level handler in the grid; we
         keep this component lean and let the grid own the dismiss
         contract. -->
    <div class="relative shrink-0">
      <button
        type="button"
        onclick={toggleMenu}
        class="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface/80 transition-colors"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Tile actions"
        title="Tile actions"
        data-testid="tile-menu-toggle"
      >
        <svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="6" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="12" cy="18" r="1.7" />
        </svg>
      </button>

      {#if menuOpen}
        <div
          class="absolute right-0 top-full mt-1 z-30 min-w-[160px] rounded-md border border-border-subtle bg-bg-deep p-1 shadow-xl"
          role="menu"
        >
          <button
            type="button"
            onclick={handleRemove}
            class="w-full min-h-[44px] flex items-center gap-2 px-3 py-2 rounded-md text-xs text-left hover:bg-bg-surface/80 text-text-primary transition-colors"
            role="menuitem"
            data-testid="tile-remove"
          >
            Remove tile
          </button>
        </div>
      {/if}
    </div>
  </header>

  <div class="flex-1 px-4 py-3 overflow-auto text-sm text-text-primary">
    {#if children}
      {@render children()}
    {/if}
  </div>

  {#if footer}
    <footer class="px-4 py-3 border-t border-border-subtle bg-bg-deep/30 text-xs text-text-muted">
      {@render footer()}
    </footer>
  {/if}
</article>
