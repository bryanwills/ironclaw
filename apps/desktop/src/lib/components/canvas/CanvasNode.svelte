<script lang="ts">
  // A draggable node card on the spatial canvas (R84 / lane W7).
  //
  // Absolute-positioned inside the transformed world `<div>` at the node's
  // canvas coords. Drag the header to move it; double-click the title to
  // rename inline; edit the body in a textarea; the ⋮ menu deletes or
  // starts an arrow. A small "Ask this node…" input at the bottom emits
  // `onask` (the route wires it; v1 just toasts "coming soon").
  //
  // Drag math (the documented failure mode): pointer movement is in SCREEN
  // pixels, but node coords are CANVAS space. The viewport scales the world
  // by `zoom`, so a 10px screen drag at 2× zoom is only a 5px canvas move.
  // We therefore divide the pointer delta by `canvas.zoom` before applying
  // it. Coords stay transform-free in the store — see canvas.svelte.ts.

  import { canvas, type CanvasNode } from '$lib/stores/canvas.svelte';

  interface Props {
    node: CanvasNode;
    /** True when this node is the pending arrow source (parent-driven). */
    arrowSource?: boolean;
    /** Fired when the ⋮ → "Start arrow" item is chosen. */
    onstartarrow?: (id: string) => void;
    /** Fired when the card is clicked while an arrow is pending — the
     *  parent completes the connection to this node. */
    onpick?: (id: string) => void;
    /** Fired by the "Ask this node…" composer. */
    onask?: (id: string, prompt: string) => void;
  }

  let { node, arrowSource = false, onstartarrow, onpick, onask }: Props = $props();

  // ---- Header drag ------------------------------------------------------
  let dragging = $state(false);
  let dragStart = { px: 0, py: 0, nx: 0, ny: 0 };

  function onHeaderPointerDown(e: PointerEvent): void {
    // Ignore drags that originate on interactive header controls.
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
    if (e.button !== 0) return;
    e.stopPropagation(); // don't let the viewport start a pan
    dragging = true;
    dragStart = { px: e.clientX, py: e.clientY, nx: node.x, ny: node.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onHeaderPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    const z = canvas.zoom || 1;
    // Screen delta → canvas delta: divide by zoom (see header note).
    const dx = (e.clientX - dragStart.px) / z;
    const dy = (e.clientY - dragStart.py) / z;
    canvas.updateNode(node.id, { x: dragStart.nx + dx, y: dragStart.ny + dy });
  }

  function onHeaderPointerUp(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // capture may already be gone — non-fatal
    }
  }

  // ---- Title inline edit ------------------------------------------------
  let editingTitle = $state(false);
  let titleDraft = $state('');

  function beginTitleEdit(): void {
    titleDraft = node.title;
    editingTitle = true;
  }

  function commitTitle(): void {
    canvas.updateNode(node.id, { title: titleDraft.trim() || 'Untitled note' });
    editingTitle = false;
  }

  function onTitleKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTitle();
    } else if (e.key === 'Escape') {
      editingTitle = false;
    }
  }

  // ---- Body edit --------------------------------------------------------
  function onBodyInput(e: Event): void {
    canvas.updateNode(node.id, { body: (e.currentTarget as HTMLTextAreaElement).value });
  }

  // ---- ⋮ menu -----------------------------------------------------------
  let menuOpen = $state(false);

  function toggleMenu(): void {
    menuOpen = !menuOpen;
  }
  function closeMenu(): void {
    menuOpen = false;
  }

  function onDelete(): void {
    closeMenu();
    canvas.removeNode(node.id);
  }
  function onStartArrow(): void {
    closeMenu();
    onstartarrow?.(node.id);
  }

  // ---- Card click (completes a pending arrow) ---------------------------
  function onCardClick(): void {
    onpick?.(node.id);
  }

  // ---- Ask-this-node composer ------------------------------------------
  let askDraft = $state('');

  function submitAsk(): void {
    const prompt = askDraft.trim();
    if (!prompt) return;
    onask?.(node.id, prompt);
    askDraft = '';
  }

  function onAskKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitAsk();
    }
  }
</script>

<!-- The card root captures clicks only to complete a pending arrow
     (parent-driven); the meaningful keyboard affordances live on the
     header controls + composer inside. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="canvas-node absolute rounded-lg border bg-bg-surface shadow-lg flex flex-col
         {arrowSource ? 'border-accent-gold ring-1 ring-accent-gold/50' : 'border-border-subtle'}"
  style="left: {node.x}px; top: {node.y}px; width: {node.width}px; min-height: {node.height}px;"
  role="group"
  aria-label={node.title}
  onclick={onCardClick}
>
  <!-- Header: drag handle + title + ⋮ menu. The whole header is the drag
       surface (cursor: grab); controls inside opt out with data-no-drag. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="canvas-node-header flex items-center gap-1.5 px-2 py-1.5 border-b border-border-subtle
           rounded-t-lg cursor-grab select-none {dragging ? 'cursor-grabbing' : ''}"
    onpointerdown={onHeaderPointerDown}
    onpointermove={onHeaderPointerMove}
    onpointerup={onHeaderPointerUp}
    onpointercancel={onHeaderPointerUp}
  >
    <!-- Grip glyph -->
    <svg class="w-3 h-3 text-text-muted shrink-0" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
      <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
    </svg>

    {#if editingTitle}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        data-no-drag
        class="flex-1 min-w-0 bg-bg-deep text-text-primary text-xs px-1 py-0.5 rounded
               border border-accent-cyan/50 outline-none"
        bind:value={titleDraft}
        onblur={commitTitle}
        onkeydown={onTitleKey}
        autofocus
      />
    {:else}
      <button
        data-no-drag
        type="button"
        class="flex-1 min-w-0 text-left text-xs font-medium text-text-primary truncate
               hover:text-accent-cyan"
        ondblclick={beginTitleEdit}
        title="Double-click to rename"
      >
        {node.title || 'Untitled note'}
      </button>
    {/if}

    <div class="relative shrink-0" data-no-drag>
      <button
        type="button"
        class="px-1 text-text-muted hover:text-text-primary leading-none"
        onclick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Node menu"
      >
        ⋮
      </button>
      {#if menuOpen}
        <!-- Click-away backdrop -->
        <button
          type="button"
          class="fixed inset-0 z-10 cursor-default"
          aria-label="Close menu"
          onclick={closeMenu}
        ></button>
        <div
          class="absolute right-0 top-6 z-20 w-32 rounded-md border border-border-subtle
                 bg-bg-surface shadow-xl py-1 text-xs"
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            class="w-full text-left px-3 py-1.5 text-text-primary hover:bg-accent-cyan/10"
            onclick={onStartArrow}
          >
            Start arrow
          </button>
          <button
            type="button"
            role="menuitem"
            class="w-full text-left px-3 py-1.5 text-danger hover:bg-danger/10"
            onclick={onDelete}
          >
            Delete
          </button>
        </div>
      {/if}
    </div>
  </div>

  <!-- Body: editable note text. -->
  <textarea
    class="flex-1 w-full bg-transparent text-text-primary text-xs px-2 py-1.5 resize-none
           outline-none placeholder:text-text-muted"
    rows="3"
    placeholder="Write a note…"
    value={node.body}
    oninput={onBodyInput}
  ></textarea>

  <!-- Ask-this-node composer (stub — emits onask). -->
  <div class="flex items-center gap-1 px-2 py-1.5 border-t border-border-subtle">
    <input
      class="flex-1 min-w-0 bg-bg-deep text-text-primary text-[11px] px-2 py-1 rounded
             border border-border-subtle outline-none focus:border-accent-cyan
             placeholder:text-text-muted"
      placeholder="Ask this node…"
      bind:value={askDraft}
      onkeydown={onAskKey}
    />
    <button
      type="button"
      class="shrink-0 text-[11px] px-2 py-1 rounded bg-accent-cyan/15 text-accent-cyan
             hover:bg-accent-cyan/25 disabled:opacity-40"
      disabled={!askDraft.trim()}
      onclick={submitAsk}
    >
      Ask
    </button>
  </div>
</div>

<style>
  .canvas-node {
    /* Cards capture their own pointer events so drags don't fall through
       to the viewport pan handler. */
    touch-action: none;
  }
</style>
