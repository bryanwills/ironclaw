<script lang="ts">
  // TileGrid.svelte — 4-column dashboard grid with drag-to-rearrange.
  //
  // Owns three things the individual tile components don't:
  //   - The CSS grid layout (4 columns, gap-4). Each tile renders in
  //     `col-span-{1|2|4}` per its `span`.
  //   - HTML5 drag-and-drop bookkeeping. The Tile component publishes
  //     `onDragStart` / `onDragEnd` against a source id; the wrapper
  //     <div> around each tile owns `dragover` / `drop` against a
  //     target id. On a successful drop the grid calls
  //     `dashboard.reorder(fromIdx, toIdx)`.
  //   - The reset action when the layout is empty (defensive — should
  //     never happen since the store hydrates DEFAULT_LAYOUT, but
  //     guards against a future "clear all tiles" code path).
  //
  // Drop-position UI is the same idiom as the Sidebar's profile
  // popover: a 2px cyan strip above/below the target row signals the
  // insertion edge. The strip lives in the wrapper div, not the tile
  // body, so the tile's chrome stays unmodified.
  //
  // Per the brief the per-tile composer + auto-refresh behaviors are
  // OWNED by the individual tile components (`RecentThreadsTile`, etc).
  // The grid is intentionally dumb about what each tile actually
  // renders.

  import { dashboard, type TileConfig } from '$lib/stores/dashboard.svelte';
  import Tile from './Tile.svelte';
  import RecentThreadsTile from './tiles/RecentThreadsTile.svelte';
  import ActiveRoutinesTile from './tiles/ActiveRoutinesTile.svelte';
  import RecentSkillsTile from './tiles/RecentSkillsTile.svelte';
  import OpenLoopsTile from './tiles/OpenLoopsTile.svelte';
  import WorkQueueTile from './tiles/WorkQueueTile.svelte';

  /** Source id of the in-flight drag (null when not dragging). */
  let draggedTileId = $state<string | null>(null);
  /** Target tile id under the pointer + which edge (before/after). Used
   *  to render the cyan drop indicator. Cleared on drop or dragend. */
  let dropTargetTileId = $state<string | null>(null);
  let dropPosition = $state<'before' | 'after' | null>(null);

  function onTileDragStart(_e: DragEvent, id: string): void {
    draggedTileId = id;
  }

  function onTileDragEnd(): void {
    draggedTileId = null;
    dropTargetTileId = null;
    dropPosition = null;
  }

  function onWrapperDragOver(e: DragEvent, tileId: string): void {
    if (!draggedTileId || draggedTileId === tileId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    // 4-column grid → vertical lists at narrow viewports collapse to
    // before/after on Y; wide grid uses X for left/right neighbors.
    // We pick whichever axis has more travel so the indicator follows
    // the user's actual intent.
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    const horizontal = Math.abs(dx) > Math.abs(dy);
    dropTargetTileId = tileId;
    dropPosition = horizontal ? (dx < 0 ? 'before' : 'after') : dy < 0 ? 'before' : 'after';
  }

  function onWrapperDragLeave(e: DragEvent, tileId: string): void {
    const target = e.currentTarget as HTMLElement;
    const related = e.relatedTarget as Node | null;
    if (related && target.contains(related)) return;
    if (dropTargetTileId === tileId) {
      dropTargetTileId = null;
      dropPosition = null;
    }
  }

  function onWrapperDrop(e: DragEvent, targetId: string): void {
    e.preventDefault();
    const sourceId = draggedTileId;
    const pos = dropPosition;
    draggedTileId = null;
    dropTargetTileId = null;
    dropPosition = null;
    if (!sourceId || !pos || sourceId === targetId) return;
    const fromIdx = dashboard.tiles.findIndex((t) => t.id === sourceId);
    const targetIdx = dashboard.tiles.findIndex((t) => t.id === targetId);
    if (fromIdx < 0 || targetIdx < 0) return;
    // Compute the destination index AFTER removing the source — same
    // shape as the Sidebar profile reorder. `before` lands at the
    // target's current slot; `after` lands one past it.
    const insertBefore = pos === 'before';
    let toIdx: number;
    if (fromIdx < targetIdx) {
      toIdx = insertBefore ? targetIdx - 1 : targetIdx;
    } else {
      toIdx = insertBefore ? targetIdx : targetIdx + 1;
    }
    dashboard.reorder(fromIdx, toIdx);
  }

  function handleRemove(id: string): void {
    dashboard.remove(id);
  }

  /** Map `tile.span` onto a tailwind col-span class. Falls back to the
   *  half-width slot for any unexpected value (the store coerces these
   *  on load, but render-time tiles from a hot-mutation could still
   *  carry a stale shape). */
  function colSpanClass(span: TileConfig['span']): string {
    switch (span) {
      case 1:
        return 'col-span-1';
      case 4:
        return 'col-span-4';
      case 2:
      default:
        return 'col-span-2';
    }
  }
</script>

{#if dashboard.tiles.length === 0}
  <!-- Empty state. The store hydrates to DEFAULT_LAYOUT on first
       launch so this only fires when the user has explicitly removed
       every tile. We surface a single reset action rather than a long
       "add tile" gallery — the gallery lands with W5 (generative
       widgets) when there are user-promotable widgets to pick from. -->
  <div
    class="flex flex-col items-center justify-center min-h-[280px] rounded-lg border border-dashed border-border-subtle bg-bg-surface/40 text-text-muted gap-3"
  >
    <p class="text-sm">No tiles. Reset to restore the defaults.</p>
    <button
      type="button"
      onclick={() => dashboard.reset()}
      class="min-h-[44px] px-4 rounded-md text-xs bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/40 hover:bg-accent-cyan/20 transition-colors"
    >
      Reset layout
    </button>
  </div>
{:else}
  <div class="grid grid-cols-4 gap-5 auto-rows-min items-stretch" data-testid="tile-grid">
    {#each dashboard.tiles as tile (tile.id)}
      {@const isDragging = draggedTileId === tile.id}
      {@const isDropTarget = dropTargetTileId === tile.id && draggedTileId !== tile.id}
      <div
        class="relative transition-opacity {colSpanClass(tile.span)}"
        class:opacity-50={isDragging}
        ondragover={(e) => onWrapperDragOver(e, tile.id)}
        ondragleave={(e) => onWrapperDragLeave(e, tile.id)}
        ondrop={(e) => onWrapperDrop(e, tile.id)}
        role="presentation"
      >
        {#if isDropTarget && dropPosition === 'before'}
          <span
            class="absolute -top-1 left-1 right-1 h-0.5 bg-accent-cyan rounded-full pointer-events-none z-20"
            aria-hidden="true"
          ></span>
        {/if}
        {#if isDropTarget && dropPosition === 'after'}
          <span
            class="absolute -bottom-1 left-1 right-1 h-0.5 bg-accent-cyan rounded-full pointer-events-none z-20"
            aria-hidden="true"
          ></span>
        {/if}

        <Tile
          {tile}
          onRemove={handleRemove}
          onDragStart={onTileDragStart}
          onDragEnd={onTileDragEnd}
        >
          {#if tile.kind === 'work-queue'}
            <WorkQueueTile />
          {:else if tile.kind === 'recent-threads'}
            <RecentThreadsTile />
          {:else if tile.kind === 'active-routines'}
            <ActiveRoutinesTile />
          {:else if tile.kind === 'recent-skills'}
            <RecentSkillsTile />
          {:else if tile.kind === 'open-loops'}
            <OpenLoopsTile />
          {:else}
            <!-- Custom widget placeholder. The W5 generative-widget
                 framework owns the actual renderer; until it lands we
                 keep the tile visible but inert so a hand-edited blob
                 doesn't kill the page. -->
            <p class="text-xs text-text-muted">Custom widget (not yet wired)</p>
          {/if}
        </Tile>
      </div>
    {/each}

    <!-- Opt-in for the Open Loops tile when a persisted layout predates it
         (new layouts include it by default). A single dashed cell rather
         than a full add-tile gallery — that lands with W5. -->
    {#if !dashboard.tiles.some((t) => t.kind === 'open-loops')}
      <button
        type="button"
        onclick={() => dashboard.add({ id: 'open-loops', kind: 'open-loops', span: 2 })}
        class="col-span-2 flex items-center justify-center gap-2 min-h-[120px] rounded-lg border border-dashed border-border-subtle bg-bg-surface/40 text-text-muted hover:text-text-primary hover:border-accent-cyan/50 hover:bg-bg-surface/70 transition-colors text-sm"
        data-testid="add-open-loops-tile"
      >
        <span aria-hidden="true">+</span>
        Add Open Loops
      </button>
    {/if}

    {#if !dashboard.tiles.some((t) => t.kind === 'work-queue')}
      <button
        type="button"
        onclick={() => dashboard.add({ id: 'work-queue', kind: 'work-queue', span: 4 })}
        class="col-span-4 flex min-h-[96px] items-center justify-center gap-2 rounded-lg border border-dashed border-border-subtle bg-bg-surface/40 text-sm text-text-muted transition-colors hover:border-accent-cyan/50 hover:bg-bg-surface/70 hover:text-text-primary"
        data-testid="add-work-queue-tile"
      >
        <span aria-hidden="true">+</span>
        Add Work Queue
      </button>
    {/if}
  </div>
{/if}
