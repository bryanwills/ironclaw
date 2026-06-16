<script lang="ts">
  // Spatial canvas route (R84 / lane W7).
  //
  // The research-mode surface: an infinite, pannable, zoomable workspace
  // where notes / threads / widgets become draggable node cards connected
  // by arrows. See docs/WORKSPACE-OS.md §"Spatial canvas".
  //
  // Implementation note (commit body has the full rationale): this is a
  // LIGHTWEIGHT native-Svelte canvas, NOT a tldraw embed. tldraw is ~600 KB
  // with a heavy React runtime that doesn't compose with Svelte 5 runes
  // without a brittle React-in-Svelte bridge. A CSS-transform viewport +
  // absolute-positioned cards + an SVG arrow overlay gives the same
  // research-graph UX with zero new deps and no interop layer.
  //
  // This route owns the surface-level orchestration: the floating toolbar
  // (+ Note / zoom / Fit), the pending-arrow handshake between two nodes,
  // and the "Ask this node…" dispatch. All node/edge/viewport state lives
  // in the canvas store; the components are thin views over it.

  import { untrack } from 'svelte';
  import CanvasArrows from '$lib/components/canvas/CanvasArrows.svelte';
  import CanvasNode from '$lib/components/canvas/CanvasNode.svelte';
  import CanvasViewport from '$lib/components/canvas/CanvasViewport.svelte';
  import {
    buildNodePrompt,
    canvas,
    DEFAULT_NODE_HEIGHT,
    DEFAULT_NODE_WIDTH,
    MAX_ZOOM,
    MIN_ZOOM
  } from '$lib/stores/canvas.svelte';
  import { subAgents } from '$lib/stores/sub-agents.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';

  // The viewport fills the route; we read its size to centre new notes and
  // to compute the Fit transform.
  let stageEl = $state<HTMLDivElement | null>(null);

  function stageSize(): { w: number; h: number } {
    const r = stageEl?.getBoundingClientRect();
    return { w: r?.width ?? 1000, h: r?.height ?? 700 };
  }

  /** Convert the centre of the current viewport into canvas-space coords,
   *  so a new note lands where the user is looking regardless of pan/zoom. */
  function viewportCentreInCanvas(): { x: number; y: number } {
    const { w, h } = stageSize();
    const z = canvas.zoom || 1;
    return {
      x: (w / 2 - canvas.panX) / z - DEFAULT_NODE_WIDTH / 2,
      y: (h / 2 - canvas.panY) / z - DEFAULT_NODE_HEIGHT / 2
    };
  }

  // Cascade successive adds a little so they don't stack pixel-perfect.
  let addNudge = 0;

  function addNote(): void {
    const c = viewportCentreInCanvas();
    const off = (addNudge % 5) * 26;
    addNudge += 1;
    canvas.addNote(c.x + off, c.y + off);
  }

  // ---- Pending-arrow handshake ------------------------------------------
  // ⋮ → "Start arrow" sets a source; clicking another card completes it.
  let arrowFrom = $state<string | null>(null);

  function onStartArrow(id: string): void {
    arrowFrom = id;
    toasts.show('Click another node to connect', 'info');
  }

  function onPick(id: string): void {
    if (!arrowFrom) return;
    if (arrowFrom === id) {
      // Clicking the source again cancels.
      arrowFrom = null;
      return;
    }
    canvas.connect(arrowFrom, id);
    arrowFrom = null;
  }

  // ---- Ask-this-node → sub-agent dispatch (R88) -------------------------
  // The node composer emits (sourceId, question). We spawn a child node to
  // hold the answer, connect an arrow source→child, dispatch a background
  // sub-agent seeded with the source node as context, and stream its
  // progress/result into the child via the effect below. If the gateway
  // doesn't support sub-agents (404 → dispatch returns null) the child
  // shows a clean hint instead of spinning forever.
  let taskNodes = $state<Record<string, string>>({}); // taskId → child node id

  function onAsk(sourceId: string, prompt: string): void {
    void runAsk(sourceId, prompt);
  }

  async function runAsk(sourceId: string, prompt: string): Promise<void> {
    const source = canvas.nodes.find((n) => n.id === sourceId);
    const child = canvas.addNote(
      (source?.x ?? 100) + (source?.width ?? DEFAULT_NODE_WIDTH) + 60,
      source?.y ?? 100
    );
    canvas.updateNode(child.id, {
      kind: 'thread',
      title: `↳ ${prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt}`,
      body: 'Dispatching sub-agent…'
    });
    if (source) canvas.connect(source.id, child.id);

    const full = buildNodePrompt(source?.title ?? '', source?.body ?? '', prompt);
    let taskId: string | null;
    try {
      taskId = await subAgents.dispatch({ prompt: full, parentThreadId: `canvas:${sourceId}` });
    } catch (err) {
      canvas.updateNode(child.id, { body: `Failed to dispatch: ${(err as Error).message}` });
      toasts.show('Sub-agent dispatch failed', 'error');
      return;
    }
    if (taskId === null) {
      canvas.updateNode(child.id, {
        body: 'Sub-agents need a newer IronClaw gateway — this build’s /api/v1/tasks endpoint isn’t available yet.'
      });
      toasts.show('Sub-agents not supported by this gateway', 'error');
      return;
    }
    taskNodes = { ...taskNodes, [taskId]: child.id };
  }

  // Last body written per child node. updateNode replaces the whole nodes
  // array + re-persists to localStorage + re-renders every node and the
  // arrow overlay, so we skip the write when the streamed text is unchanged
  // (R90 P1 — a chatty sub-agent would otherwise force a full canvas
  // re-render + storage write on every progress chunk). Plain Map, not
  // $state: pure bookkeeping that must not feed reactivity.
  const lastWrittenBody = new Map<string, string>();

  // Mirror each tracked sub-agent's live state into its child node. The
  // tracked reads (taskNodes + the sub-agent store) drive re-runs; the
  // canvas writes are wrapped in untrack() so updateNode's internal read of
  // canvas.nodes can't feed back into this effect and loop.
  $effect(() => {
    const updates = Object.entries(taskNodes).map(([taskId, nodeId]) => {
      const task = subAgents.all().find((t) => t.id === taskId);
      const progress = subAgents.progressFor(taskId);
      let body: string;
      if (!task) body = 'Working…';
      else if (task.status === 'succeeded') body = task.result ?? '(no result returned)';
      else if (task.status === 'failed') body = `Failed: ${task.error ?? 'unknown error'}`;
      else if (task.status === 'cancelled') body = 'Cancelled';
      else body = progress.trim() || 'Working…';
      return { nodeId, body };
    });
    untrack(() => {
      for (const { nodeId, body } of updates) {
        if (lastWrittenBody.get(nodeId) === body) continue; // no change → skip
        lastWrittenBody.set(nodeId, body);
        canvas.updateNode(nodeId, { body });
      }
    });
  });

  // ---- Zoom controls ----------------------------------------------------
  const zoomPct = $derived(Math.round(canvas.zoom * 100));

  function zoomBy(factor: number): void {
    // Zoom about the viewport centre so the focus point is stable.
    const { w, h } = stageSize();
    const oldZoom = canvas.zoom || 1;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom * factor));
    if (newZoom === oldZoom) return;
    const cx = w / 2;
    const cy = h / 2;
    const worldX = (cx - canvas.panX) / oldZoom;
    const worldY = (cy - canvas.panY) / oldZoom;
    canvas.setPan(cx - worldX * newZoom, cy - worldY * newZoom);
    canvas.setZoom(newZoom);
  }

  /** Frame all nodes: reset zoom to 1 and pan so the nodes' bounding box is
   *  centred. With no nodes, recentre the origin. */
  function fit(): void {
    const { w, h } = stageSize();
    if (canvas.nodes.length === 0) {
      canvas.setZoom(1);
      canvas.setPan(w / 2, h / 2);
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of canvas.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    }
    const pad = 80;
    const bw = maxX - minX + pad * 2;
    const bh = maxY - minY + pad * 2;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(w / bw, h / bh, 1)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    canvas.setZoom(z);
    canvas.setPan(w / 2 - cx * z, h / 2 - cy * z);
  }

  function clearAll(): void {
    if (canvas.nodes.length === 0) return;
    canvas.clear();
    arrowFrom = null;
    toasts.show('Canvas cleared', 'info');
  }
</script>

<svelte:head><title>Canvas · IronClaw</title></svelte:head>

<!-- Named region landmark: the spatial canvas is a full-bleed board with no
     `<h1>`, so the stage root carries an accessible name for screen-reader
     navigation + the a11y sweep anchor. -->
<div class="relative w-full h-full" bind:this={stageEl} role="region" aria-label="Canvas">
  <CanvasViewport>
    <CanvasArrows />
    {#each canvas.nodes as node (node.id)}
      <CanvasNode
        {node}
        arrowSource={arrowFrom === node.id}
        onstartarrow={onStartArrow}
        onpick={onPick}
        onask={onAsk}
      />
    {/each}
  </CanvasViewport>

  <!-- Floating toolbar (top-left). -->
  <div
    class="absolute top-4 left-4 z-30 flex items-center gap-1.5 rounded-lg border
           border-border-subtle bg-bg-surface/90 backdrop-blur px-2 py-1.5 shadow-xl"
  >
    <button
      type="button"
      class="text-xs px-2.5 py-1 rounded bg-accent-cyan/15 text-accent-cyan
             hover:bg-accent-cyan/25 font-medium"
      onclick={addNote}
    >
      + Note
    </button>

    <div class="w-px h-5 bg-border-subtle"></div>

    <button
      type="button"
      class="text-xs w-6 py-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-deep"
      onclick={() => zoomBy(1 / 1.2)}
      aria-label="Zoom out"
    >
      −
    </button>
    <button
      type="button"
      class="text-xs w-12 py-1 rounded text-text-muted hover:text-text-primary tabular-nums"
      onclick={() => canvas.setZoom(1)}
      title="Reset zoom"
    >
      {zoomPct}%
    </button>
    <button
      type="button"
      class="text-xs w-6 py-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-deep"
      onclick={() => zoomBy(1.2)}
      aria-label="Zoom in"
    >
      +
    </button>

    <div class="w-px h-5 bg-border-subtle"></div>

    <button
      type="button"
      class="text-xs px-2.5 py-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-deep"
      onclick={fit}
    >
      Fit
    </button>
    {#if canvas.nodes.length > 0}
      <button
        type="button"
        class="text-xs px-2.5 py-1 rounded text-text-muted hover:text-danger hover:bg-danger/10"
        onclick={clearAll}
      >
        Clear
      </button>
    {/if}
  </div>

  <!-- Pending-arrow hint. -->
  {#if arrowFrom}
    <div
      class="absolute top-4 left-1/2 -translate-x-1/2 z-30 rounded-full border border-accent-gold/50
             bg-bg-surface/90 backdrop-blur px-3 py-1 text-xs text-accent-gold shadow-lg"
    >
      Click a node to connect · Esc cancels
    </div>
  {/if}

  <!-- Empty-state hint. -->
  {#if canvas.nodes.length === 0}
    <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div class="text-center max-w-sm px-6">
        <div class="text-sm text-text-primary font-medium mb-1">Start a working map</div>
        <p class="text-xs text-text-muted leading-relaxed">Add a note, then connect ideas.</p>
      </div>
    </div>
  {/if}
</div>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape' && arrowFrom) arrowFrom = null;
  }}
/>
