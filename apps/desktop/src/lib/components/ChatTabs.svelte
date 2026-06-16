<script lang="ts">
  // Chrome-style chat tabs.
  //
  // Sits above the existing thread title row in the chat surface and
  // exposes the user's "open" set as a horizontal strip. Each tab is
  // an open thread; switching is one click. Close (×) drops the tab
  // without deleting the underlying thread. Drag-to-reorder is
  // wired here too.
  //
  // The store (chatTabs) holds the persistence + ordering; this
  // component is a pure renderer + event source. Tab → thread
  // navigation is the parent's responsibility (it owns the
  // SvelteKit `goto`); we just emit `onSelect(threadId)` so the
  // parent decides what to do.

  import { chatTabs } from '$lib/stores/chat-tabs.svelte';
  import { threads as threadsStore } from '$lib/stores/threads.svelte';
  import { threadRename } from '$lib/stores/thread-rename.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    /** Called when the user clicks a tab. Parent navigates. */
    onSelect: (threadId: string) => void;
    /** Called when the user clicks the + button. */
    onNew: () => void;
    /** Called when a tab is closed. Parent decides whether to also
     *  navigate elsewhere (typically to the new active tab). */
    onClose: (threadId: string, nextActive: string | null) => void;
  }

  let { onSelect, onNew, onClose }: Props = $props();

  // Drag-to-reorder state. We carry the dragging index on the
  // module-scope so the same gesture can read it from any tab's drop
  // handler.
  let dragFromIdx = $state<number | null>(null);
  let dragOverIdx = $state<number | null>(null);

  function titleFor(threadId: string): string {
    // The threads store keeps a flat `.threads` array; this lookup is
    // O(n) in worst case but n is bounded by the user's open tabs
    // (cap 12) × the loaded thread count (already paginated). Fine.
    const t = threadsStore.threads.find((x) => x.id === threadId);
    const base = t?.title ?? '(loading…)';
    return threadRename.displayTitle(threadId, base);
  }

  function onTabClick(threadId: string): void {
    chatTabs.setActive(threadId);
    onSelect(threadId);
  }

  function onTabClose(ev: MouseEvent, threadId: string): void {
    ev.stopPropagation();
    const next = chatTabs.close(threadId);
    onClose(threadId, next);
  }

  // Middle-click also closes — universal browser convention.
  function onTabMouseDown(ev: MouseEvent, threadId: string): void {
    if (ev.button === 1) {
      ev.preventDefault();
      const next = chatTabs.close(threadId);
      onClose(threadId, next);
    }
  }

  function onDragStart(ev: DragEvent, idx: number): void {
    dragFromIdx = idx;
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', String(idx));
    }
  }

  function onDragOver(ev: DragEvent, idx: number): void {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    dragOverIdx = idx;
  }

  function onDrop(ev: DragEvent, idx: number): void {
    ev.preventDefault();
    if (dragFromIdx !== null && dragFromIdx !== idx) {
      chatTabs.reorder(dragFromIdx, idx);
    }
    dragFromIdx = null;
    dragOverIdx = null;
  }

  function onDragEnd(): void {
    dragFromIdx = null;
    dragOverIdx = null;
  }
</script>

{#if chatTabs.openTabs.length > 0}
  <div
    class="flex items-center border-b border-border-subtle bg-bg-base/60 overflow-x-auto scrollbar-thin"
    role="tablist"
    aria-label="Open chat tabs"
  >
    {#each chatTabs.openTabs as tabId, idx (tabId)}
      {@const isActive = chatTabs.activeTabId === tabId}
      {@const isDragOver = dragOverIdx === idx && dragFromIdx !== idx}
      <!--
        R45 codex P1: outer was a <button> containing a <span role="button">.
        Nested interactive elements are invalid HTML; click events bubble
        unpredictably and keyboard nav breaks. Switched to a div + role="tab"
        + tabindex; the close affordance is a real <button> sibling now.
      -->
      <div
        role="tab"
        tabindex={isActive ? 0 : -1}
        aria-selected={isActive}
        draggable="true"
        onclick={() => onTabClick(tabId)}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onTabClick(tabId);
          }
        }}
        onmousedown={(e) => onTabMouseDown(e, tabId)}
        ondragstart={(e) => onDragStart(e, idx)}
        ondragover={(e) => onDragOver(e, idx)}
        ondrop={(e) => onDrop(e, idx)}
        ondragend={onDragEnd}
        class="group relative flex items-center gap-2 shrink-0 max-w-[220px] min-w-[140px] h-11 px-3 pr-1
               text-xs cursor-pointer transition-colors
               {isActive
          ? 'text-text-primary border-b-2 border-accent-cyan bg-bg-deep/40'
          : 'text-text-muted border-b-2 border-transparent hover:text-text-primary hover:bg-bg-deep/30'}
               {isDragOver ? 'ring-1 ring-accent-cyan/40' : ''}"
        title={titleFor(tabId)}
      >
        <span class="truncate flex-1 text-left">{titleFor(tabId)}</span>
        <button
          type="button"
          aria-label={`Close tab "${titleFor(tabId)}"`}
          onclick={(e) => onTabClose(e, tabId)}
          class="shrink-0 w-11 h-11 -mr-2 rounded flex items-center justify-center
                 text-text-muted hover:text-danger hover:bg-danger-soft
                 transition-colors
                 {isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}"
        >
          <Icon name="close" class="w-2.5 h-2.5" />
        </button>
      </div>
    {/each}
    <button
      type="button"
      onclick={onNew}
      class="shrink-0 w-11 h-11 flex items-center justify-center text-text-muted
             hover:text-accent-cyan hover:bg-bg-deep/30 transition-colors
             border-b-2 border-transparent"
      aria-label="New chat tab"
      title="New chat (Cmd+T)"
    >
      <Icon name="plus" class="w-3.5 h-3.5" />
    </button>
  </div>
{/if}
