<script lang="ts">
  // SVG arrow overlay for the spatial canvas (R84 / lane W7).
  //
  // Renders one straight path per edge, from the source node's centre to
  // the target node's centre, capped with an arrowhead marker. Lives
  // INSIDE the transformed world `<div>` (alongside the node cards), so it
  // shares the canvas coordinate space — no manual pan/zoom math here, the
  // parent transform handles it. The `<svg>` is `pointer-events: none` so
  // it never steals drags from the cards beneath it; individual paths
  // re-enable pointer events so an edge can be clicked to delete it.
  //
  // Reactivity: `lines` derives from `canvas.nodes` + `canvas.edges`, so
  // dragging a node recomputes every attached arrow automatically.

  import { canvas, type CanvasNode } from '$lib/stores/canvas.svelte';

  /** Size of the SVG canvas in canvas-space units. Large fixed extent so
   *  arrows are never clipped; the parent `overflow: visible` world div
   *  lets nodes/arrows spill past it anyway. Centred origin handled by the
   *  world div, not here. */
  const EXTENT = 100000;
  const OFFSET = EXTENT / 2;

  function centre(node: CanvasNode): { cx: number; cy: number } {
    return { cx: node.x + node.width / 2, cy: node.y + node.height / 2 };
  }

  interface ArrowLine {
    id: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }

  const lines = $derived.by<ArrowLine[]>(() => {
    const byId = new Map(canvas.nodes.map((n) => [n.id, n]));
    const out: ArrowLine[] = [];
    for (const edge of canvas.edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) continue;
      const a = centre(from);
      const b = centre(to);
      // Offset endpoints into the SVG's local coordinate frame (the SVG is
      // shifted by -OFFSET so negative canvas coords are representable).
      out.push({
        id: edge.id,
        x1: a.cx + OFFSET,
        y1: a.cy + OFFSET,
        x2: b.cx + OFFSET,
        y2: b.cy + OFFSET
      });
    }
    return out;
  });

  function onEdgeClick(id: string): void {
    canvas.disconnect(id);
  }
</script>

<svg
  class="canvas-arrows"
  width={EXTENT}
  height={EXTENT}
  viewBox="0 0 {EXTENT} {EXTENT}"
  style="left: {-OFFSET}px; top: {-OFFSET}px;"
  aria-hidden="true"
>
  <defs>
    <marker
      id="canvas-arrowhead"
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="7"
      markerHeight="7"
      orient="auto-start-reverse"
    >
      <path d="M0 0 L10 5 L0 10 z" fill="#4ca7e6" />
    </marker>
  </defs>

  {#each lines as line (line.id)}
    <!-- Wide transparent hit-line under the visible stroke so the edge is
         easy to click for deletion without pointer-events on the svg. -->
    <line
      x1={line.x1}
      y1={line.y1}
      x2={line.x2}
      y2={line.y2}
      stroke="transparent"
      stroke-width="14"
      class="canvas-arrow-hit"
      role="button"
      tabindex="-1"
      aria-label="Delete connection"
      onclick={() => onEdgeClick(line.id)}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdgeClick(line.id);
        }
      }}
    />
    <line
      x1={line.x1}
      y1={line.y1}
      x2={line.x2}
      y2={line.y2}
      stroke="#4ca7e6"
      stroke-width="1.75"
      stroke-opacity="0.55"
      marker-end="url(#canvas-arrowhead)"
      class="canvas-arrow-line"
    />
  {/each}
</svg>

<style>
  .canvas-arrows {
    position: absolute;
    pointer-events: none;
    overflow: visible;
  }
  /* Re-enable pointer events on the hit-lines only, so edges are clickable
     to delete while the rest of the overlay stays transparent to drags. */
  .canvas-arrow-hit {
    pointer-events: stroke;
    cursor: pointer;
  }
  .canvas-arrow-hit:hover + .canvas-arrow-line {
    stroke-opacity: 0.95;
    stroke-width: 2.25;
  }
</style>
