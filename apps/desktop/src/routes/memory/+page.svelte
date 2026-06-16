<script lang="ts">
  // Memory inspector — flat surface over the agent's accumulated memory
  // store, complementing the /knowledge route's tree view.
  //
  // The two surfaces share the same backend (`/api/memory/*`) but expose
  // different mental models:
  //
  //   - /knowledge: hierarchical browser. Mirrors the on-disk shape so the
  //     user can drill into `projects/ironclaw/...`. Good for documents
  //     they wrote.
  //   - /memory (this route): flat card list of every leaf doc, sorted by
  //     last-updated. Good for inspecting what the agent has been writing
  //     into memory over time. Edit + delete in-place.
  //
  // We deliberately load the full tree in one request via the v0.29
  // `/api/memory/tree` endpoint so the left rail can render an MRU list
  // and the search filter can operate over the full set without paging.
  // For a 100-doc store this is trivially cheap; if it ever grows past
  // a few thousand we can switch to lazy paging at the gateway.
  //
  // Deletion goes through `client.deleteMemory(path)`. The gateway today
  // (v0.28.2 / v0.29.0 on abby) does NOT implement the DELETE handler —
  // both attempted shapes 404. The button surfaces a clean error toast
  // and the row stays in place; no silent "succeeded" state. Once the
  // server lands the route the UI just works.

  import { onDestroy, onMount, type Component } from 'svelte';
  import { exportMemoryTree } from '$lib/api/files';
  import { connection } from '$lib/stores/connection.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { surfaceRefresh } from '$lib/stores/surface-refresh.svelte';
  import type { IronClawClient } from '$lib/api/ironclaw';
  import type { MemoryNode } from '$lib/api/types';

  // ---- List + selection state ----------------------------------------------
  let MarkdownView = $state<Component<any> | null>(null);

  // `nodes` is the full file-only set (the tree endpoint returns both files
  // and dirs; we filter to leaves at load time so the rest of the view
  // never has to think about it).
  let nodes = $state<MemoryNode[]>([]);
  let listLoading = $state(false);
  let listError = $state<string | null>(null);

  // `searchInput` is the raw text in the search box; `filter` is the
  // debounced/committed lowercased value the derived list filters on.
  // The debounce is 200 ms — short enough that typing feels live, long
  // enough that we don't recompute on every keystroke.
  let searchInput = $state('');
  let filter = $state('');
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  // Selected node + its content. The detail panel reads these and re-renders
  // when the selection changes. `selectedNode` holds the canonical
  // MemoryNode (with `updated_at` etc.) for the title bar; `selectedContent`
  // is the rendered body.
  let selectedNode = $state<MemoryNode | null>(null);
  let selectedContent = $state<string>('');
  let detailLoading = $state(false);
  let detailError = $state<string | null>(null);

  // Edit-mode state for the detail panel. When `editing` is true the body
  // is a textarea; when false it's the rendered markdown. `draft` is the
  // working copy — it's only written to the server (and back to
  // selectedContent) on Save.
  let editing = $state(false);
  let draft = $state('');
  let saving = $state(false);

  // Delete confirmation — two-step click on the Delete button. First click
  // arms the button (label flips to "Confirm delete"); second click within
  // CONFIRM_WINDOW_MS actually fires the delete. Anything else (clicking
  // elsewhere, selecting another node, mouse-leaving the button) disarms.
  let deleteArmed = $state(false);
  let deleteArmTimer: ReturnType<typeof setTimeout> | null = null;
  const CONFIRM_WINDOW_MS = 4000;
  let deleting = $state(false);

  // New-memory modal. Lazy-mounted so each open seeds fresh state without
  // any reset code.
  let newModalOpen = $state(false);
  let exportingToFinder = $state(false);
  let loadedContents = $state<Record<string, string>>({});

  // Relative-time tick. Re-render every minute so the "12m ago" labels age
  // without page reloads. Stamped via `nowMs` and read by `relativeTime`.
  let nowMs = $state(Date.now());

  const client = $derived<IronClawClient | null>(connection.client);

  // ---- Derived: filtered list ----------------------------------------------
  // The filter is a case-insensitive substring match across path + content
  // preview. Server-side search (`searchMemory`) returns scored hits across
  // FULL content, but it's a different endpoint and we don't want a
  // round-trip on every keystroke. The substring filter operates on what's
  // already loaded, which is fine for the inspector's "I know roughly what
  // I'm looking for" use case.
  const filteredNodes = $derived.by(() => {
    if (!filter) return nodes;
    const needle = filter.toLowerCase();
    return nodes.filter((n) => n.path.toLowerCase().includes(needle));
  });

  // ---- Lifecycle -----------------------------------------------------------
  onMount(async () => {
    MarkdownView = (await import('$lib/components/MarkdownView.svelte')).default;
    // The sidebar's connection.init() may still be in flight if the user
    // landed directly on /memory; wait one beat so we don't fire a request
    // with a null client.
    if (!connection.client) {
      await connection.init();
    }
    // Stamp the attempted-status BEFORE loadNodes so the post-mount
    // reconnect-watcher effect doesn't fire a second time on first paint.
    if (connection.status === 'connected') {
      lastConnectedAttempt = 'connected';
    }
    await loadNodes();

    // Wire Cmd+R surface refresh — re-fetches the node list. We do NOT
    // clear the selection on refresh: the user is usually using refresh
    // to see "did my last write land?" and reselecting from scratch
    // would feel like a bug.
    surfaceRefresh.register(async () => {
      await loadNodes();
    });
  });

  onDestroy(() => surfaceRefresh.unregister());

  $effect(() => {
    const tickTimer = setInterval(() => {
      nowMs = Date.now();
    }, 60_000);
    return () => clearInterval(tickTimer);
  });

  // If connection comes online after first mount (user fixed creds in
  // settings, etc.), load nodes ONCE per connect transition. The earlier
  // `nodes.length === 0` gate was broken: an empty memory tree (common on
  // a fresh install) leaves nodes.length at 0 after loadNodes() succeeds,
  // the effect re-fires, and we get an infinite request/toast loop until
  // the route is left. R45 codex P1.
  //
  // Track the last connection.status we acted on; only re-load when the
  // status flips back to 'connected' from something else. That covers the
  // legitimate "user fixed creds" case without re-loading on every empty
  // tree.
  let lastConnectedAttempt = $state<string>('');
  $effect(() => {
    if (connection.status === 'connected' && lastConnectedAttempt !== 'connected' && !listLoading) {
      lastConnectedAttempt = 'connected';
      void loadNodes();
    } else if (connection.status !== 'connected') {
      lastConnectedAttempt = connection.status;
    }
  });

  // ---- Loaders -------------------------------------------------------------
  async function loadNodes(): Promise<void> {
    if (!client) {
      listError = 'IronClaw client unavailable';
      return;
    }
    listLoading = true;
    listError = null;
    try {
      const tree = await client.getMemoryTree();
      // Leaves only — the inspector is a flat doc view, dirs would be
      // empty cards. We could fall back to listMemory() flat for older
      // gateways, but the tree endpoint has been stable since v0.27.
      const files = tree.filter((n) => n.type === 'file');
      // Newest-first by updated_at when the server reports it; alphabetical
      // tiebreaker for stable ordering when timestamps match (e.g. bulk
      // import).
      files.sort((a, b) => {
        const ta = a.updated_at ?? '';
        const tb = b.updated_at ?? '';
        if (ta && tb && ta !== tb) return tb.localeCompare(ta);
        if (ta && !tb) return -1;
        if (!ta && tb) return 1;
        return a.path.localeCompare(b.path);
      });
      nodes = files;
    } catch (err) {
      listError = (err as Error).message;
      toasts.show(`Failed to load memory: ${listError}`, 'error');
    } finally {
      listLoading = false;
    }
  }

  async function selectNode(node: MemoryNode): Promise<void> {
    // Cancel any pending delete confirmation when selection changes —
    // moving away from a node should reset its armed state.
    disarmDelete();
    // Discard in-progress edits without a confirm. Keeping it simple: if
    // the user wants to keep their draft they shouldn't click away.
    editing = false;
    draft = '';

    selectedNode = node;
    selectedContent = '';
    detailError = null;
    if (!client) {
      detailError = 'IronClaw client unavailable';
      return;
    }
    detailLoading = true;
    try {
      const res = await client.readMemory(node.path);
      selectedContent = res.content;
      loadedContents = { ...loadedContents, [node.path]: res.content };
    } catch (err) {
      detailError = (err as Error).message;
      toasts.show(`Failed to load memory: ${detailError}`, 'error');
    } finally {
      detailLoading = false;
    }
  }

  // ---- Search debounce -----------------------------------------------------
  function onSearchInput(value: string): void {
    searchInput = value;
    if (searchDebounce) clearTimeout(searchDebounce);
    // Immediate empty-clear so backspacing to nothing snaps results back.
    if (!value) {
      filter = '';
      return;
    }
    searchDebounce = setTimeout(() => {
      filter = value;
    }, 200);
  }

  function clearSearch(): void {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchInput = '';
    filter = '';
  }

  // ---- Edit / Save / Cancel ------------------------------------------------
  function startEdit(): void {
    if (!selectedNode) return;
    draft = selectedContent;
    editing = true;
  }

  function cancelEdit(): void {
    editing = false;
    draft = '';
  }

  async function saveEdit(): Promise<void> {
    if (!selectedNode || !client) return;
    saving = true;
    try {
      // writeMemory is path-based — replaces the doc at `path`. We DO NOT
      // pass `append:true` here; the editor is a replace, not an append.
      await client.writeMemory(selectedNode.path, draft);
      selectedContent = draft;
      loadedContents = { ...loadedContents, [selectedNode.path]: draft };
      editing = false;
      draft = '';
      // Stamp the local node with `now` so the list re-sorts and the
      // "updated x ago" label refreshes without an extra round-trip.
      const nowIso = new Date().toISOString();
      nodes = nodes.map((n) => (n.path === selectedNode!.path ? { ...n, updated_at: nowIso } : n));
      selectedNode = { ...selectedNode, updated_at: nowIso };
      toasts.show('Memory saved', 'success');
    } catch (err) {
      toasts.show(`Save failed: ${(err as Error).message}`, 'error');
    } finally {
      saving = false;
    }
  }

  // ---- Delete (two-click confirm) ------------------------------------------
  function armDelete(): void {
    if (deleteArmTimer) clearTimeout(deleteArmTimer);
    deleteArmed = true;
    deleteArmTimer = setTimeout(() => {
      deleteArmed = false;
    }, CONFIRM_WINDOW_MS);
  }

  function disarmDelete(): void {
    if (deleteArmTimer) clearTimeout(deleteArmTimer);
    deleteArmed = false;
  }

  async function confirmDelete(): Promise<void> {
    if (!selectedNode || !client) return;
    deleting = true;
    try {
      // NOTE: As of 2026-05-27 the gateway's DELETE handler is not yet
      // wired (see api/ironclaw.ts `deleteMemory` comment block). Calls
      // will 404 against the running server — we surface that as an
      // error toast and keep the list intact.
      await client.deleteMemory(selectedNode.path);
      const removed = selectedNode.path;
      nodes = nodes.filter((n) => n.path !== removed);
      selectedNode = null;
      selectedContent = '';
      loadedContents = Object.fromEntries(
        Object.entries(loadedContents).filter(([path]) => path !== removed)
      );
      toasts.show('Memory deleted', 'success');
    } catch (err) {
      toasts.show(`Delete failed: ${(err as Error).message}`, 'error');
    } finally {
      deleting = false;
      disarmDelete();
    }
  }

  // ---- New memory ----------------------------------------------------------
  async function createMemory(path: string, content: string): Promise<void> {
    if (!client) {
      toasts.show('IronClaw client unavailable', 'error');
      return;
    }
    try {
      const res = await client.writeMemory(path, content);
      if (!res.ok) {
        toasts.show("Server didn't confirm the write", 'error');
        return;
      }
      // Insert at the top of the list with a stamped updated_at. A
      // background refresh would also pick this up but we want the new
      // card visible immediately.
      const nowIso = new Date().toISOString();
      const created: MemoryNode = {
        path: res.path ?? path,
        type: 'file',
        updated_at: nowIso
      };
      nodes = [created, ...nodes.filter((n) => n.path !== created.path)];
      newModalOpen = false;
      toasts.show('Memory created', 'success');
      // Auto-select the newly created entry so the user can verify the
      // rendered content immediately.
      await selectNode(created);
    } catch (err) {
      toasts.show(`Create failed: ${(err as Error).message}`, 'error');
    }
  }

  // ---- Copy id to clipboard ------------------------------------------------
  async function copyId(): Promise<void> {
    if (!selectedNode) return;
    try {
      await navigator.clipboard.writeText(selectedNode.path);
      toasts.show('Path copied', 'success');
    } catch {
      toasts.show('Copy failed', 'error');
    }
  }

  async function onExportToFinder(): Promise<void> {
    // Full-content export for every tree node requires a read-per-file
    // pass; this v1 exports only files opened in the detail pane.
    const files = nodes
      .filter((n) => loadedContents[n.path] !== undefined)
      .map((n) => ({ path: n.path, content: loadedContents[n.path] }));
    if (files.length === 0) {
      toasts.show('Open a memory file before exporting', 'error');
      return;
    }
    exportingToFinder = true;
    try {
      const path = await exportMemoryTree(connection.activeProfile.id, files);
      toasts.show(`Exported ${files.length} files to ${path}`, 'success');
    } catch (err) {
      toasts.show(`Export failed: ${(err as Error).message}`, 'error');
    } finally {
      exportingToFinder = false;
    }
  }

  // ---- Helpers -------------------------------------------------------------
  /** Truncate a string for a 1-line list preview. */
  function previewLine(s: string, maxLen = 80): string {
    const firstLine = s.split('\n').find((l) => l.trim().length > 0) ?? '';
    const trimmed = firstLine.trim();
    if (trimmed.length <= maxLen) return trimmed || '(empty)';
    return trimmed.slice(0, maxLen - 1) + '…';
  }

  /** Derive a folder-prefix tag from a path: `projects/foo/bar.md` → `projects`.
   *  Returns null for top-level paths. Used as a visual "tag" in the absence
   *  of a server-side tagging system. */
  function pathTag(path: string): string | null {
    const idx = path.indexOf('/');
    if (idx <= 0) return null;
    return path.slice(0, idx);
  }

  function relativeTime(iso: string | undefined, now: number): string {
    if (!iso) return '—';
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return iso;
    const diff = now - then;
    if (diff < 60_000) return 'just now';
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return `${years}y ago`;
  }

  // ---- New-memory modal helpers (inline; small surface) --------------------
  let newPath = $state('');
  let newContent = $state('');
  let newTagsInput = $state('');
  let newSubmitting = $state(false);

  function openNew(): void {
    newPath = '';
    newContent = '';
    newTagsInput = '';
    newSubmitting = false;
    newModalOpen = true;
  }

  function closeNew(): void {
    if (newSubmitting) return;
    newModalOpen = false;
  }

  async function submitNew(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const path = newPath.trim();
    if (!path) {
      toasts.show('Path is required', 'error');
      return;
    }
    // Tags are a UI affordance only today — the server has no tag column,
    // so we fold them into a front-matter line so they survive round-trip
    // and stay visible to the user. When/if the server grows native tags
    // we can lift this client-side concatenation out.
    const tagLine = newTagsInput.trim() ? `tags: ${newTagsInput.trim()}\n\n` : '';
    const body = tagLine + newContent;
    newSubmitting = true;
    try {
      await createMemory(path, body);
    } finally {
      newSubmitting = false;
    }
  }

  function onNewKey(e: KeyboardEvent): void {
    if (!newModalOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeNew();
    }
  }

  // ---- Reactive cleanup ----------------------------------------------------
  $effect(() => {
    return () => {
      if (searchDebounce) clearTimeout(searchDebounce);
      if (deleteArmTimer) clearTimeout(deleteArmTimer);
    };
  });
</script>

<svelte:window onkeydown={onNewKey} />

<div class="flex h-full overflow-hidden">
  <!-- LEFT COLUMN: list rail -->
  <aside
    class="flex flex-col w-[300px] shrink-0 border-r border-border-subtle bg-bg-deep/40"
    aria-label="Memory list"
  >
    <header class="px-4 py-3 border-b border-border-subtle space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-baseline gap-2 min-w-0">
          <h1 class="text-sm font-semibold text-text-primary">Memory</h1>
          <span
            class="text-[11px] text-text-muted tabular-nums"
            aria-label="{nodes.length} entries"
          >
            {nodes.length}
          </span>
        </div>
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            onclick={() => void onExportToFinder()}
            disabled={exportingToFinder}
            title="Export to ~/Documents/IronClaw and open in Finder"
            class="inline-flex items-center justify-center h-7 px-2.5 rounded-md border border-border-subtle text-[11px] text-text-muted hover:text-text-primary hover:border-accent-cyan focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:outline-none transition disabled:opacity-50"
          >
            {exportingToFinder ? 'Opening…' : 'Open in Finder'}
          </button>
          <button
            type="button"
            onclick={() => void loadNodes()}
            disabled={listLoading}
            aria-label="Refresh memory list"
            class="inline-flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:outline-none transition disabled:opacity-50"
          >
            <svg
              viewBox="0 0 24 24"
              class="w-3.5 h-3.5"
              class:animate-spin={listLoading}
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
          <button
            type="button"
            onclick={openNew}
            aria-label="New memory entry"
            class="inline-flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-accent-cyan hover:bg-bg-surface focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:outline-none transition"
          >
            <svg
              viewBox="0 0 24 24"
              class="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
      </div>
      <div class="relative">
        <input
          type="search"
          value={searchInput}
          oninput={(e) => onSearchInput((e.currentTarget as HTMLInputElement).value)}
          placeholder="Filter…"
          aria-label="Filter memory entries"
          autocomplete="off"
          spellcheck="false"
          class="w-full bg-bg-deep border border-border-subtle rounded-md pl-7 pr-7 py-1.5 text-xs text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors"
        />
        <svg
          viewBox="0 0 24 24"
          class="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-muted pointer-events-none"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        {#if searchInput}
          <button
            type="button"
            onclick={clearSearch}
            aria-label="Clear filter"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 inline-flex items-center justify-center rounded text-text-muted hover:text-text-primary"
          >
            <svg
              viewBox="0 0 24 24"
              class="w-3 h-3"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        {/if}
      </div>
    </header>

    <div class="flex-1 overflow-y-auto" data-testid="memory-list-body">
      {#if listLoading && nodes.length === 0}
        <p class="px-4 py-3 text-xs text-text-muted">Loading…</p>
      {:else if listError}
        <p class="px-4 py-3 text-xs text-red-400" role="alert">{listError}</p>
      {:else if filteredNodes.length === 0 && nodes.length > 0}
        <p class="px-4 py-3 text-xs text-text-muted">No entries match "{filter}".</p>
      {:else if filteredNodes.length === 0}
        <p class="px-4 py-3 text-xs text-text-muted">
          No memory yet. Add a fact, preference, or decision to remember.
        </p>
      {:else}
        <ul class="py-1" aria-label="Memory entries">
          {#each filteredNodes as node (node.path)}
            {@const isActive = selectedNode?.path === node.path}
            {@const tag = pathTag(node.path)}
            <li>
              <button
                type="button"
                onclick={() => void selectNode(node)}
                aria-label={`Open memory ${node.path}`}
                aria-current={isActive ? 'true' : undefined}
                data-testid="memory-card"
                class="w-full text-left px-4 py-2.5 border-l-2 transition focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:outline-none focus-visible:ring-inset"
                class:border-accent-cyan={isActive}
                class:bg-bg-surface={isActive}
                class:border-transparent={!isActive}
                class:hover:bg-bg-surface={!isActive}
              >
                <div class="flex items-baseline justify-between gap-2 mb-0.5">
                  <span class="text-[12.5px] font-medium text-text-primary truncate">
                    {node.path}
                  </span>
                  <span class="text-[10px] text-text-muted shrink-0 tabular-nums">
                    {relativeTime(node.updated_at, nowMs)}
                  </span>
                </div>
                {#if tag}
                  <div class="flex items-center gap-1 mb-1">
                    <span
                      class="inline-block px-1.5 py-0 text-[10px] rounded-sm bg-bg-deep text-accent-cyan/80 font-mono"
                    >
                      {tag}
                    </span>
                  </div>
                {/if}
                <p class="text-[11.5px] text-text-muted truncate">
                  {previewLine(node.path)}
                </p>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </aside>

  <!-- RIGHT COLUMN: detail -->
  <section class="flex-1 flex flex-col min-w-0 overflow-hidden" aria-label="Memory detail">
    {#if !selectedNode}
      <div class="flex-1 flex items-center justify-center text-text-muted text-sm">
        <p>Pick a memory to inspect.</p>
      </div>
    {:else}
      {@const node = selectedNode}
      <header
        class="flex items-start justify-between gap-4 px-6 py-4 border-b border-border-subtle"
      >
        <div class="min-w-0 space-y-1.5">
          <div class="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onclick={() => void copyId()}
              aria-label="Copy memory path"
              title="Copy path"
              class="font-mono text-[12.5px] text-text-primary px-2 py-0.5 rounded bg-bg-surface hover:bg-bg-deep focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:outline-none transition truncate max-w-full"
            >
              {node.path}
            </button>
            {#if pathTag(node.path)}
              <span
                class="inline-block px-1.5 py-0 text-[10px] rounded-sm bg-bg-deep text-accent-cyan/80 font-mono shrink-0"
              >
                {pathTag(node.path)}
              </span>
            {/if}
          </div>
          <p class="text-[11px] text-text-muted">
            Updated {relativeTime(node.updated_at, nowMs)}
          </p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          {#if !editing}
            <button
              type="button"
              onclick={startEdit}
              disabled={detailLoading}
              aria-label="Edit memory"
              class="px-3 py-1.5 rounded-md border border-border-subtle text-text-primary hover:border-accent-cyan focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:outline-none transition text-xs disabled:opacity-50"
            >
              Edit
            </button>
            <button
              type="button"
              onclick={deleteArmed ? () => void confirmDelete() : armDelete}
              onmouseleave={() => {
                if (deleteArmed && !deleting) disarmDelete();
              }}
              disabled={deleting}
              aria-label={deleteArmed ? 'Confirm delete memory' : 'Delete memory'}
              data-armed={deleteArmed}
              class={[
                'px-3 py-1.5 rounded-md border text-xs transition focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:outline-none disabled:opacity-50',
                deleteArmed
                  ? 'border-red-500 text-red-400 bg-red-500/10'
                  : 'border-border-subtle text-text-muted hover:text-red-400 hover:border-red-500'
              ].join(' ')}
            >
              {deleting ? 'Deleting…' : deleteArmed ? 'Confirm delete' : 'Delete'}
            </button>
          {:else}
            <button
              type="button"
              onclick={cancelEdit}
              disabled={saving}
              class="px-3 py-1.5 rounded-md border border-border-subtle text-text-muted hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:outline-none transition text-xs disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onclick={() => void saveEdit()}
              disabled={saving}
              class="px-3 py-1.5 rounded-md bg-accent-cyan text-bg-deep text-xs font-semibold hover:brightness-95 focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:outline-none transition disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          {/if}
        </div>
      </header>

      <div class="flex-1 overflow-y-auto px-6 py-5">
        {#if detailLoading}
          <p class="text-xs text-text-muted">Loading…</p>
        {:else if detailError}
          <p class="text-xs text-red-400" role="alert">{detailError}</p>
        {:else if editing}
          <textarea
            value={draft}
            oninput={(e) => (draft = (e.currentTarget as HTMLTextAreaElement).value)}
            aria-label="Memory content"
            data-testid="memory-edit-textarea"
            class="w-full min-h-[60vh] bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors font-mono resize-y"
            placeholder="Markdown content…"
          ></textarea>
        {:else}
          <MarkdownView markdown={selectedContent} />
        {/if}
      </div>
    {/if}
  </section>
</div>

<!-- New-memory modal — lazy-mounted via the `if` so each open re-seeds the
     inputs cleanly. Backdrop click + Esc close. -->
{#if newModalOpen}
  <button
    type="button"
    aria-label="Close new memory modal"
    onclick={closeNew}
    class="fixed inset-0 z-40 bg-black/50 cursor-default"
  ></button>

  <div
    class="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(92vw,460px)] bg-[#0d121f] border border-border-subtle rounded-lg shadow-[0_24px_48px_rgba(0,0,0,0.6)] flex flex-col overflow-hidden"
    role="dialog"
    aria-modal="true"
    aria-labelledby="new-memory-title"
    data-testid="new-memory-modal"
  >
    <header class="flex items-center justify-between gap-4 px-5 py-4 border-b border-border-subtle">
      <h2 id="new-memory-title" class="text-sm font-semibold text-text-primary">New memory</h2>
      <button
        type="button"
        onclick={closeNew}
        aria-label="Close"
        class="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface transition"
      >
        <svg
          viewBox="0 0 24 24"
          class="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </header>

    <form onsubmit={submitNew} class="flex flex-col gap-4 px-5 py-4">
      <div class="space-y-1.5">
        <label
          for="new-memory-path"
          class="block text-[11px] font-semibold uppercase tracking-wider text-text-muted"
        >
          Path
        </label>
        <input
          id="new-memory-path"
          type="text"
          value={newPath}
          oninput={(e) => (newPath = (e.currentTarget as HTMLInputElement).value)}
          placeholder="notes/observation.md"
          autocomplete="off"
          spellcheck="false"
          class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors font-mono"
        />
      </div>
      <div class="space-y-1.5">
        <label
          for="new-memory-content"
          class="block text-[11px] font-semibold uppercase tracking-wider text-text-muted"
        >
          Content
        </label>
        <textarea
          id="new-memory-content"
          rows="8"
          value={newContent}
          oninput={(e) => (newContent = (e.currentTarget as HTMLTextAreaElement).value)}
          placeholder="What does the agent know now?"
          data-testid="new-memory-content"
          class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors font-mono resize-none"
        ></textarea>
      </div>
      <div class="space-y-1.5">
        <label
          for="new-memory-tags"
          class="block text-[11px] font-semibold uppercase tracking-wider text-text-muted"
        >
          Tags (optional)
        </label>
        <input
          id="new-memory-tags"
          type="text"
          value={newTagsInput}
          oninput={(e) => (newTagsInput = (e.currentTarget as HTMLInputElement).value)}
          placeholder="comma, separated"
          autocomplete="off"
          spellcheck="false"
          class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors"
        />
      </div>
      <div
        class="pt-1 flex items-center justify-end gap-2 border-t border-border-subtle -mx-5 px-5 pt-3"
      >
        <button
          type="button"
          onclick={closeNew}
          disabled={newSubmitting}
          class="px-3 py-1.5 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan transition text-xs disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={newSubmitting || !newPath.trim()}
          class="inline-flex items-center gap-2 px-4 py-1.5 rounded-md bg-accent-cyan text-bg-deep text-xs font-semibold hover:brightness-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {newSubmitting ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  </div>
{/if}
