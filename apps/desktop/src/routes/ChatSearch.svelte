<script lang="ts">
  // Find-in-thread bar. Cmd/Ctrl+F opens it; Esc closes. While open:
  // ↓/↑ + Enter cycles through matches; matches are wrapped in <mark>
  // tags inside each message bubble (post-markdown render). The active
  // match scrolls into view and gets a stronger highlight.
  //
  // Highlight method:
  //
  //   We use the wrap-in-<mark> approach rather than the CSS Custom
  //   Highlight API (`CSS.highlights`) because:
  //     1. Custom Highlights have uneven Safari/WebKit support and the
  //        Tauri runtime ships WKWebView on macOS.
  //     2. We need explicit per-match active styling + scrollIntoView,
  //        both of which are awkward with Range-only highlights.
  //     3. <mark> tags survive Svelte re-renders so long as we re-apply
  //        on each render — the markdown view rewrites its own HTML
  //        when the buffer changes, so highlights have to re-attach
  //        anyway.
  //
  //   The wrapping logic walks each `.search-target` element's text
  //   nodes, splits them at match boundaries, and wraps the matches.
  //   On clear we replace each <mark> with its text content and call
  //   `normalize()` so the DOM goes back to its pre-search shape.
  //
  // Streaming debounce: re-applying highlights on every SSE token would
  // be O(N tree-walks) per chunk. The parent passes a `streamingHint`
  // counter that increments whenever the buffer mutates; we debounce
  // 250ms before reapplying while that counter is changing.

  import { tick } from 'svelte';

  interface Props {
    /** Scrollable container that holds the message stream. */
    scrollRoot: HTMLDivElement | null;
    /**
     * Increments whenever the rendered content might have changed
     * (history grew, streaming buffer mutated, tool drawer toggled,
     * etc.). We rebuild highlights when this changes — debounced to
     * 250ms so streaming doesn't grind the main thread.
     */
    contentVersion: number;
    /** Called when the bar closes so the parent can drop its open flag. */
    onClose: () => void;
  }

  let { scrollRoot, contentVersion, onClose }: Props = $props();

  // -- state -----------------------------------------------------------------
  let inputEl = $state<HTMLInputElement | null>(null);
  let query = $state('');
  let caseSensitive = $state(false);
  let matchCount = $state(0);
  let activeIdx = $state(0);

  // -- highlight wiring ------------------------------------------------------
  const HIGHLIGHT_CLASS = 'cs-hit';
  const ACTIVE_CLASS = 'cs-hit--active';

  function clearHighlights(root: HTMLElement | null): void {
    if (!root) return;
    const marks = root.querySelectorAll(`mark.${HIGHLIGHT_CLASS}`);
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      // Replace <mark>text</mark> with its text node so subsequent
      // searches operate on a clean text-node graph.
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      // Coalesce adjacent text nodes so the next walk doesn't get
      // confused by per-character splits.
      if (parent instanceof Element) parent.normalize();
    });
  }

  /**
   * Walk every `.search-target` descendant of `root` and wrap occurrences
   * of `q` (case-flag aware) in <mark> tags. Returns the count of marks
   * inserted across the whole tree.
   */
  function applyHighlights(root: HTMLElement | null, q: string, sensitive: boolean): number {
    if (!root || q.length === 0) return 0;
    const targets = root.querySelectorAll<HTMLElement>('.search-target');
    let total = 0;
    targets.forEach((target) => {
      total += wrapInTarget(target, q, sensitive);
    });
    return total;
  }

  function wrapInTarget(target: HTMLElement, q: string, sensitive: boolean): number {
    // Collect candidate text nodes first; we mutate the tree below and
    // an iterator-during-mutation walk would skip siblings.
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // Don't descend into already-highlighted marks (defense in depth
        // — clearHighlights should have stripped them).
        const parent = node.parentElement;
        if (parent && parent.classList.contains(HIGHLIGHT_CLASS)) {
          return NodeFilter.FILTER_REJECT;
        }
        // Skip empty / whitespace-only nodes.
        if (!node.nodeValue || node.nodeValue.length === 0) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const candidates: Text[] = [];
    let n: Node | null = walker.nextNode();
    while (n) {
      candidates.push(n as Text);
      n = walker.nextNode();
    }

    const flags = sensitive ? 'g' : 'gi';
    const re = new RegExp(escapeRegExp(q), flags);
    let inserted = 0;
    for (const node of candidates) {
      const text = node.nodeValue ?? '';
      if (!text) continue;
      re.lastIndex = 0;
      const occurrences: Array<{ start: number; end: number }> = [];
      let m: RegExpExecArray | null = re.exec(text);
      while (m) {
        if (m[0].length === 0) {
          // Zero-width match would loop; bail.
          break;
        }
        occurrences.push({ start: m.index, end: m.index + m[0].length });
        m = re.exec(text);
      }
      if (occurrences.length === 0) continue;
      // Build a sequence of (text-slice | <mark>-slice) and replace the
      // original text node with the new nodes.
      const parent = node.parentNode;
      if (!parent) continue;
      const frag = document.createDocumentFragment();
      let cursor = 0;
      for (const occ of occurrences) {
        if (occ.start > cursor) {
          frag.appendChild(document.createTextNode(text.slice(cursor, occ.start)));
        }
        const mark = document.createElement('mark');
        mark.className = HIGHLIGHT_CLASS;
        mark.textContent = text.slice(occ.start, occ.end);
        frag.appendChild(mark);
        cursor = occ.end;
        inserted += 1;
      }
      if (cursor < text.length) {
        frag.appendChild(document.createTextNode(text.slice(cursor)));
      }
      parent.replaceChild(frag, node);
    }
    return inserted;
  }

  function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }

  function refreshActive(scrollIntoView: boolean): void {
    if (!scrollRoot) return;
    const marks = scrollRoot.querySelectorAll<HTMLElement>(`mark.${HIGHLIGHT_CLASS}`);
    marks.forEach((m) => m.classList.remove(ACTIVE_CLASS));
    if (marks.length === 0) {
      matchCount = 0;
      activeIdx = 0;
      return;
    }
    matchCount = marks.length;
    const clamped = Math.max(0, Math.min(activeIdx, marks.length - 1));
    activeIdx = clamped;
    const cur = marks.item(clamped);
    if (cur) {
      cur.classList.add(ACTIVE_CLASS);
      if (scrollIntoView) {
        cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  // -- debounced rebuild on content/query/case change ------------------------
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  const REBUILD_DEBOUNCE_MS = 250;

  function rebuild(immediate: boolean): void {
    if (rebuildTimer) {
      clearTimeout(rebuildTimer);
      rebuildTimer = null;
    }
    const run = () => {
      clearHighlights(scrollRoot);
      const count = applyHighlights(scrollRoot, query, caseSensitive);
      matchCount = count;
      // Clamp activeIdx so it stays valid across query edits.
      if (activeIdx >= count) activeIdx = 0;
      refreshActive(false);
    };
    if (immediate) {
      run();
    } else {
      rebuildTimer = setTimeout(run, REBUILD_DEBOUNCE_MS);
    }
  }

  // The user's query changes are responsive — apply immediately.
  $effect(() => {
    void query;
    void caseSensitive;
    rebuild(true);
  });

  // Content (history/streaming) changes are debounced so streaming doesn't
  // pin the main thread re-wrapping marks on every token.
  $effect(() => {
    void contentVersion;
    rebuild(false);
  });

  // -- lifecycle / focus -----------------------------------------------------
  $effect(() => {
    // On mount, scroll the input into focus + select.
    void tick().then(() => {
      inputEl?.focus();
      inputEl?.select();
    });
    return () => {
      // Unmount: strip all highlights so the conversation returns to its
      // pristine markdown render.
      if (rebuildTimer) {
        clearTimeout(rebuildTimer);
        rebuildTimer = null;
      }
      clearHighlights(scrollRoot);
    };
  });

  // -- navigation ------------------------------------------------------------
  function next(): void {
    if (matchCount === 0) return;
    activeIdx = (activeIdx + 1) % matchCount;
    refreshActive(true);
  }
  function prev(): void {
    if (matchCount === 0) return;
    activeIdx = (activeIdx - 1 + matchCount) % matchCount;
    refreshActive(true);
  }

  function onInputKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) prev();
      else next();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
  }
</script>

<div
  class="flex items-center gap-2 px-3 py-2 rounded-md border border-border-subtle bg-bg-surface shadow-lg"
  role="search"
>
  <svg
    viewBox="0 0 24 24"
    class="w-4 h-4 text-text-muted shrink-0"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
  <input
    bind:this={inputEl}
    bind:value={query}
    onkeydown={onInputKey}
    type="text"
    placeholder="Find in conversation…"
    aria-label="Find in conversation"
    class="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none min-w-0"
  />

  <span class="text-[11px] text-text-muted tabular-nums shrink-0 select-none">
    {#if query.length === 0}
      &nbsp;
    {:else if matchCount === 0}
      no matches
    {:else}
      {activeIdx + 1} / {matchCount}
    {/if}
  </span>

  <button
    type="button"
    onclick={() => (caseSensitive = !caseSensitive)}
    aria-pressed={caseSensitive}
    title="Match case"
    class="px-1.5 py-0.5 text-[11px] font-mono rounded border transition-colors"
    class:border-accent-cyan={caseSensitive}
    class:text-accent-cyan={caseSensitive}
    class:border-border-subtle={!caseSensitive}
    class:text-text-muted={!caseSensitive}
  >
    Aa
  </button>

  <button
    type="button"
    onclick={prev}
    disabled={matchCount === 0}
    title="Previous match (Shift+Enter)"
    aria-label="Previous match"
    class="p-1 rounded text-text-muted hover:text-accent-cyan hover:bg-bg-deep transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
  >
    <svg
      viewBox="0 0 24 24"
      class="w-3.5 h-3.5"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="18 15 12 9 6 15" />
    </svg>
  </button>
  <button
    type="button"
    onclick={next}
    disabled={matchCount === 0}
    title="Next match (Enter)"
    aria-label="Next match"
    class="p-1 rounded text-text-muted hover:text-accent-cyan hover:bg-bg-deep transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
  >
    <svg
      viewBox="0 0 24 24"
      class="w-3.5 h-3.5"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  </button>

  <button
    type="button"
    onclick={onClose}
    title="Close (Esc)"
    aria-label="Close find bar"
    class="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-deep transition-colors"
  >
    <svg
      viewBox="0 0 24 24"
      class="w-3.5 h-3.5"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  </button>
</div>

<style>
  /* Highlight styles use :global because the <mark> tags are injected
     into descendant message-bubble subtrees, which Svelte's scoped
     styles wouldn't see. */
  :global(mark.cs-hit) {
    background: rgba(251, 191, 36, 0.35); /* accent-gold tint */
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }
  :global(mark.cs-hit--active) {
    background: rgba(76, 167, 230, 0.55); /* signal blue, stronger */
    color: #050810; /* bg-deep — readable on signal blue */
    box-shadow: 0 0 0 1px rgba(76, 167, 230, 0.9);
  }
</style>
