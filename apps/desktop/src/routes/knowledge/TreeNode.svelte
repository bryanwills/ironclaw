<script lang="ts">
  // One row in the memory tree rail. Files are leaf rows; directories
  // expand inline and lazily fetch their children on first open. The
  // component is recursive — directory children render <TreeNode />
  // for each entry.

  import type { IronClawClient } from '$lib/api/ironclaw';
  import type { MemoryNode } from '$lib/api/types';
  import Self from './TreeNode.svelte';

  interface Props {
    node: MemoryNode;
    /** Indent depth — added to padding so nested rows step in. */
    depth: number;
    /** Path of the file currently shown in the right pane, if any. */
    selectedPath: string | null;
    /** Client used to fetch directory children. */
    client: IronClawClient;
    /** Fired when a file row is clicked. */
    onSelect: (path: string) => void;
    /** Set of currently bookmarked paths (for star indicator). */
    bookmarks?: Set<string>;
    /** Fired when a row is right-clicked. Parent shows a context menu. */
    onContextMenu?: (path: string, type: 'file' | 'dir', clientX: number, clientY: number) => void;
    /**
     * Controlled expansion override.
     *
     * - `true`  → force this node and (recursively) every child to expand.
     * - `false` → force collapse.
     * - `null`  → defer to each node's own `expanded` state.
     *
     * The parent flips this to `true` or `false` to drive a tree-wide
     * expand/collapse, then resets to `null` on the next tick so per-node
     * toggling continues to work. Directory children are loaded lazily on
     * forced expand so the controlled mode actually reveals subtrees.
     */
    forceExpanded?: boolean | null;
  }

  let {
    node,
    depth,
    selectedPath,
    client,
    onSelect,
    bookmarks,
    onContextMenu,
    forceExpanded = null
  }: Props = $props();

  // Per-directory state. We cache children inside the node component so
  // re-collapsing doesn't drop the fetched list — only a hard refresh
  // (not exposed in this version) would re-fetch.
  let expanded = $state(false);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let children = $state<MemoryNode[] | null>(null);

  // Strip any leading slash and trailing slash so we display "daily" not
  // "/daily/". The API returns paths without trailing slashes today, but
  // we normalize defensively in case that changes.
  const displayName = $derived(deriveName(node.path));

  const isSelected = $derived(node.type === 'file' && selectedPath === node.path);
  const isBookmarked = $derived(!!bookmarks?.has(node.path));

  // Effective expansion: forceExpanded wins when non-null, otherwise the
  // per-node state. Directories that are forced open need their children
  // fetched at least once; the effect below handles the lazy load.
  const effectiveExpanded = $derived(forceExpanded === null ? expanded : forceExpanded);

  $effect(() => {
    if (node.type !== 'dir') return;
    if (forceExpanded === true) {
      // Forced expand: load children if we haven't yet, and align local state.
      if (!expanded) expanded = true;
      if (children === null && !loading) {
        void fetchChildren();
      }
    } else if (forceExpanded === false) {
      // Forced collapse: align local state. Cached children stay in memory
      // so the next expand is free.
      if (expanded) expanded = false;
    }
  });

  async function fetchChildren() {
    loading = true;
    loadError = null;
    try {
      const kids = await client.listMemory(node.path);
      // Directories first, then files; both alphabetically by display name.
      kids.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return deriveName(a.path).localeCompare(deriveName(b.path));
      });
      children = kids;
    } catch (err) {
      loadError = (err as Error).message;
      children = [];
    } finally {
      loading = false;
    }
  }

  async function onClickDir() {
    if (loading) return;
    if (!expanded && children === null) {
      await fetchChildren();
    }
    expanded = !expanded;
  }

  function onClickFile() {
    onSelect(node.path);
  }

  function onRowContextMenu(ev: MouseEvent) {
    if (!onContextMenu) return;
    ev.preventDefault();
    onContextMenu(node.path, node.type, ev.clientX, ev.clientY);
  }

  function deriveName(p: string): string {
    const trimmed = p.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  }
</script>

{#if node.type === 'dir'}
  <button
    type="button"
    onclick={onClickDir}
    oncontextmenu={onRowContextMenu}
    class="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-left text-xs text-text-muted hover:bg-bg-surface hover:text-text-primary transition-colors min-h-[28px]"
    style="padding-left: {0.5 + depth * 0.75}rem"
  >
    <svg
      viewBox="0 0 16 16"
      class="w-3 h-3 shrink-0 transition-transform"
      class:rotate-90={effectiveExpanded}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="6 4 10 8 6 12" />
    </svg>
    <svg
      viewBox="0 0 16 16"
      class="w-3.5 h-3.5 shrink-0 text-accent-cyan/70"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path
        d="M1.5 4.5a1 1 0 0 1 1-1h3.4l1.5 1.5h6.1a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1z"
      />
    </svg>
    <span class="truncate flex-1 min-w-0">{displayName}</span>
    {#if isBookmarked}
      <svg
        viewBox="0 0 24 24"
        class="w-3 h-3 shrink-0 text-accent-gold"
        fill="currentColor"
        stroke="currentColor"
        stroke-width="1"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9 12 2" />
      </svg>
    {/if}
  </button>

  {#if effectiveExpanded}
    {#if loading}
      <div
        class="text-xs text-text-muted py-1"
        style="padding-left: {0.5 + (depth + 1) * 0.75 + 1}rem"
      >
        Loading…
      </div>
    {:else if loadError}
      <div
        class="text-xs text-red-400 py-1"
        style="padding-left: {0.5 + (depth + 1) * 0.75 + 1}rem"
      >
        {loadError}
      </div>
    {:else if children && children.length === 0}
      <div
        class="text-xs text-text-muted/60 py-1 italic"
        style="padding-left: {0.5 + (depth + 1) * 0.75 + 1}rem"
      >
        empty
      </div>
    {:else if children}
      {#each children as child (child.path)}
        <Self
          node={child}
          depth={depth + 1}
          {selectedPath}
          {client}
          {onSelect}
          {bookmarks}
          {onContextMenu}
          {forceExpanded}
        />
      {/each}
    {/if}
  {/if}
{:else}
  <button
    type="button"
    onclick={onClickFile}
    oncontextmenu={onRowContextMenu}
    class="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-left text-xs transition-colors border-l-2 min-h-[28px]"
    class:border-accent-cyan={isSelected}
    class:border-transparent={!isSelected}
    class:bg-bg-surface={isSelected}
    class:text-text-primary={isSelected}
    class:text-text-muted={!isSelected}
    class:hover:bg-bg-surface={!isSelected}
    class:hover:text-text-primary={!isSelected}
    style="padding-left: {0.5 + depth * 0.75 + 0.875}rem"
  >
    <svg
      viewBox="0 0 16 16"
      class="w-3.5 h-3.5 shrink-0"
      class:text-accent-cyan={isSelected}
      class:text-text-muted={!isSelected}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M9 1.5H4a1 1 0 0 0-1 1V13.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z" />
      <polyline points="9 1.5 9 5.5 13 5.5" />
    </svg>
    <span class="truncate flex-1 min-w-0">{displayName}</span>
    {#if isBookmarked}
      <svg
        viewBox="0 0 24 24"
        class="w-3 h-3 shrink-0 text-accent-gold"
        fill="currentColor"
        stroke="currentColor"
        stroke-width="1"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9 12 2" />
      </svg>
    {/if}
  </button>
{/if}
