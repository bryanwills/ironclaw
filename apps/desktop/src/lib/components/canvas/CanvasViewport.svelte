<script lang="ts">
  // Pan/zoom container for the spatial canvas (R84 / lane W7).
  //
  // A full-size relative viewport. The inner "world" `<div>` is translated
  // by (panX, panY) and scaled by `zoom` via a single CSS transform; nodes
  // and the arrow overlay live inside it in canvas space. A subtle dot grid
  // (CSS radial-gradient) sits on the viewport and is offset/scaled to read
  // as part of the world, giving a parallax-free "infinite paper" feel.
  //
  // Input:
  //   • Ctrl/Cmd + wheel  → zoom about the cursor (keeps the point under
  //     the pointer fixed; standard map-zoom behaviour).
  //   • plain wheel       → pan (trackpad two-finger scroll / shift-wheel
  //     for horizontal).
  //   • pointer-drag on empty space → pan.
  // Drags that start on a node card are stopped by the card (it calls
  // stopPropagation in its header handler), so they never pan the canvas.

  import type { Snippet } from 'svelte';
  import { canvas } from '$lib/stores/canvas.svelte';

  interface Props {
    children?: Snippet;
  }
  let { children }: Props = $props();

  let viewportEl = $state<HTMLDivElement | null>(null);

  // ---- Wheel: zoom (Ctrl/Cmd) or pan ------------------------------------
  function onWheel(e: WheelEvent): void {
    if (e.ctrlKey || e.metaKey) {
      // Zoom about the cursor. Convert the cursor's screen point to a
      // world point at the OLD zoom, apply the new zoom, then re-derive
      // pan so that same world point stays under the cursor.
      e.preventDefault();
      const rect = viewportEl?.getBoundingClientRect();
      const ox = e.clientX - (rect?.left ?? 0);
      const oy = e.clientY - (rect?.top ?? 0);
      const oldZoom = canvas.zoom || 1;
      // Negative deltaY = scroll up = zoom in.
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newZoom = Math.max(0.25, Math.min(3, oldZoom * factor));
      if (newZoom === oldZoom) return;
      const worldX = (ox - canvas.panX) / oldZoom;
      const worldY = (oy - canvas.panY) / oldZoom;
      canvas.setPan(ox - worldX * newZoom, oy - worldY * newZoom);
      canvas.setZoom(newZoom);
    } else {
      // Plain wheel pans. Shift swaps axes for horizontal scroll on a
      // mouse wheel; trackpads already deliver deltaX.
      e.preventDefault();
      const dx = e.shiftKey ? e.deltaY : e.deltaX;
      const dy = e.shiftKey ? 0 : e.deltaY;
      canvas.setPan(canvas.panX - dx, canvas.panY - dy);
    }
  }

  // ---- Pointer-drag pan on empty space ----------------------------------
  let panning = $state(false);
  let panStart = { px: 0, py: 0, ox: 0, oy: 0 };

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    // Only pan when the press lands on empty canvas — the viewport itself
    // or the world `<div>` — never on a node card or its inner controls
    // (textarea / inputs / buttons). Without this guard, clicking into a
    // node's body would start a pan AND `setPointerCapture` would steal the
    // pointer from the input, breaking text selection. The card header also
    // calls stopPropagation, but this target check is the robust backstop
    // that covers body / composer presses too.
    const target = e.target as HTMLElement;
    if (target !== viewportEl && !target.classList.contains('canvas-world')) return;
    panning = true;
    panStart = { px: e.clientX, py: e.clientY, ox: canvas.panX, oy: canvas.panY };
    viewportEl?.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!panning) return;
    canvas.setPan(panStart.ox + (e.clientX - panStart.px), panStart.oy + (e.clientY - panStart.py));
  }

  function onPointerUp(e: PointerEvent): void {
    if (!panning) return;
    panning = false;
    try {
      viewportEl?.releasePointerCapture(e.pointerId);
    } catch {
      // capture already released — non-fatal
    }
  }

  // Dot-grid spacing in canvas units; multiplied by zoom for the CSS layer.
  const GRID = 24;
  const gridSize = $derived(GRID * canvas.zoom);
  // Phase the grid with the pan so dots feel anchored to the world.
  const gridPosX = $derived(canvas.panX % gridSize);
  const gridPosY = $derived(canvas.panY % gridSize);
</script>

<div
  bind:this={viewportEl}
  class="canvas-viewport relative w-full h-full overflow-hidden bg-bg-base
         {panning ? 'cursor-grabbing' : 'cursor-grab'}"
  style="--grid-size: {gridSize}px; background-position: {gridPosX}px {gridPosY}px;"
  onwheel={onWheel}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  role="application"
  aria-label="Spatial canvas"
>
  <div
    class="canvas-world absolute top-0 left-0 origin-top-left"
    style="transform: translate({canvas.panX}px, {canvas.panY}px) scale({canvas.zoom});"
  >
    {@render children?.()}
  </div>
</div>

<style>
  /* Dot grid: a single radial-gradient tile, sized by --grid-size so it
     scales with zoom. The colour is a faint cool grey on the deep base. */
  .canvas-viewport {
    background-image: radial-gradient(circle, rgba(148, 163, 184, 0.16) 1px, transparent 1px);
    background-size: var(--grid-size) var(--grid-size);
  }
  .canvas-world {
    /* Arrows + cards may spill past any nominal bounds. */
    overflow: visible;
    will-change: transform;
  }
</style>
