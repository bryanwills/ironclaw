<script lang="ts">
  // Renders the body of a memory doc. Markdown files (.md) are routed
  // through the shared MarkdownView component (which handles marked +
  // DOMPurify + syntax highlighting + callouts + anchor links); everything
  // else falls into a <pre> so raw structure is preserved.
  //
  // The component also owns an inline-edit mode: pencil flips the body
  // into a full-height monospace textarea, Save POSTs to /api/memory/write
  // via the parent's `onsave` callback (the parent then reloads the doc
  // and toasts), and Cancel reverts with an unsaved-changes confirm.
  //
  // Document outline (TOC) rail (2026-05-27): in read mode for markdown
  // docs only, walks the rendered DOM for h1/h2/h3 ids (set by
  // MarkdownView's heading renderer override — same slug we'd land on
  // from `#slug`) and renders a 200px-wide rail to the right of the
  // content. Active section is the heading closest to (but not above)
  // the scroll viewport top, tracked via a scroll listener on the
  // surface scroll container. Hidden when the outline is short (< 3
  // entries), the viewport is narrow (< 1100px), or we're in edit mode.

  import MarkdownView from '$lib/components/MarkdownView.svelte';
  import { confirmDialog } from '$lib/stores/confirm.svelte';
  import { onMount, tick } from 'svelte';

  interface Props {
    path: string;
    content: string;
    loading: boolean;
    error: string | null;
    /** Called when the user clicks Save. Parent does the network write,
     *  toasts on success/failure, and re-reads the doc; the modal stays
     *  in edit mode until the promise resolves, then drops out of edit
     *  mode on success.  Resolves true on success, false on failure. */
    onsave?: (newContent: string) => Promise<boolean>;
    /** Whether the current path is currently bookmarked. */
    bookmarked?: boolean;
    /** Called when the star icon is clicked. Parent owns the bookmark
     *  store + persistence. */
    onToggleBookmark?: () => void;
  }

  let {
    path,
    content,
    loading,
    error,
    onsave,
    bookmarked = false,
    onToggleBookmark
  }: Props = $props();

  const isMarkdown = $derived(/\.(md|mdx|markdown)$/i.test(path));

  // ---- Edit mode -------------------------------------------------------

  let editing = $state(false);
  /** Draft text bound to the textarea; seeded from `content` on entry. */
  let draft = $state('');
  /** Snapshot of `content` at the moment edit mode opened — used for the
   *  unsaved-changes confirm so we don't compare against a stale prop. */
  let originalAtEditStart = $state('');
  let saving = $state(false);
  let textareaEl: HTMLTextAreaElement | undefined = $state();

  const dirty = $derived(editing && draft !== originalAtEditStart);
  // Disable the pencil while loading/error or when there is no doc loaded.
  // The parent only renders this component when a path is selected, but
  // we still guard against the empty-content + still-loading case.
  const canEdit = $derived(!loading && !error && !!path);

  // If the parent swaps to a different path while we're editing, exit
  // edit mode silently — the old draft no longer makes sense for the new
  // file, and any unsaved work was on the old path.
  let lastEditPath = $state('');
  $effect(() => {
    if (editing && path !== lastEditPath) {
      editing = false;
      draft = '';
      originalAtEditStart = '';
    }
  });

  function enterEdit() {
    if (!canEdit) return;
    draft = content;
    originalAtEditStart = content;
    lastEditPath = path;
    editing = true;
    // Focus the textarea after the DOM updates. The microtask hop is
    // enough; we don't need requestAnimationFrame here.
    queueMicrotask(() => textareaEl?.focus());
  }

  async function cancelEdit() {
    if (dirty) {
      const ok = await confirmDialog.ask({
        title: `Discard changes to ${path}?`,
        body: 'Discards unsaved edits and restores the last save.',
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
        tone: 'danger'
      });
      if (!ok) return;
    }
    editing = false;
    draft = '';
    originalAtEditStart = '';
  }

  async function handleSave() {
    if (saving || !onsave) return;
    saving = true;
    try {
      const ok = await onsave(draft);
      if (ok) {
        // Parent will re-fetch and update `content`; drop out of edit mode
        // so the user sees the fresh render. Don't reset originalAtEditStart
        // here — it's only meaningful while editing.
        editing = false;
        draft = '';
        originalAtEditStart = '';
      }
      // On failure, stay in edit mode so the user doesn't lose their work.
      // The parent is responsible for the error toast.
    } finally {
      saving = false;
    }
  }

  function handleKey(event: KeyboardEvent) {
    if (!editing) return;
    // Cmd+S / Ctrl+S → save. We capture both so a Linux/Windows webview
    // behaves the same as macOS without depending on Tauri platform info.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void handleSave();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      void cancelEdit();
    }
  }

  // TODO(2026-05-27): add a "Delete" button to the header (red on hover, next
  // to Edit) once the gateway implements `DELETE /api/memory?path=...` or
  // `POST /api/memory/delete`. Live-server probe today returns 404 for both
  // shapes. The client method `client.deleteMemory(path)` is pre-wired in
  // `src/lib/api/ironclaw.ts`. Wiring plan: add an `ondelete?: (path:
  // string) => Promise<void>` prop on this component, click → styled
  // confirm dialog ("Delete this document? This can't be undone."), then
  // call `ondelete(path)`; the parent (knowledge/+page.svelte) clears
  // `selectedPath`, refreshes the tree, and toasts.

  // ---- Document outline (TOC) -----------------------------------------

  interface OutlineEntry {
    level: 1 | 2 | 3;
    text: string;
    id: string;
  }

  /** Hide the TOC rail entirely if the doc has fewer entries than this. */
  const MIN_OUTLINE_ENTRIES = 3;
  /** Viewport width breakpoint below which the TOC rail is hidden. */
  const TOC_MIN_VIEWPORT = 1100;
  /** localStorage key for the collapsed/expanded state of the TOC rail. */
  const TOC_COLLAPSED_KEY = 'ironclaw-knowledge-toc-collapsed';

  /** Wrapper around the MarkdownView so we can query its rendered DOM. */
  let mdWrapperEl: HTMLDivElement | undefined = $state();
  /** The scroll container that wraps the doc body (.surface).
   *  Captured via `bind:this` so we can attach a scroll listener + scroll
   *  to anchor targets. */
  let scrollContainerEl: HTMLDivElement | undefined = $state();

  let outline = $state<OutlineEntry[]>([]);
  let activeId = $state<string>('');
  let viewportWide = $state(false);
  let tocCollapsed = $state(false);

  onMount(() => {
    // Initial collapsed state from localStorage. We swallow access errors —
    // localStorage can throw in some sandboxed contexts (e.g. private mode)
    // and the TOC is a non-critical enhancement.
    try {
      tocCollapsed = window.localStorage.getItem(TOC_COLLAPSED_KEY) === '1';
    } catch {
      /* noop */
    }
    // Track viewport width via matchMedia — cheaper than a resize listener
    // and fires only on threshold crossings.
    const mql = window.matchMedia(`(min-width: ${TOC_MIN_VIEWPORT}px)`);
    viewportWide = mql.matches;
    const onChange = (e: MediaQueryListEvent) => (viewportWide = e.matches);
    // `addEventListener('change', …)` is the modern API; supported in all
    // current webviews including Tauri's wry/WKWebView.
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  });

  /** Rebuild the outline by walking the rendered markdown DOM for h1/h2/h3.
   *  MarkdownView's renderer override stamps each heading with an `id`
   *  matching the in-doc anchor slug; we reuse those verbatim so clicks
   *  land on the same `#slug` target the inline anchor handle would. */
  async function rebuildOutline() {
    // Wait one tick so the `{@html}` content from MarkdownView is mounted
    // before we walk it.
    await tick();
    if (!mdWrapperEl || !isMarkdown || editing) {
      outline = [];
      return;
    }
    const heads = mdWrapperEl.querySelectorAll<HTMLElement>(
      'h1.md-heading, h2.md-heading, h3.md-heading'
    );
    const next: OutlineEntry[] = [];
    heads.forEach((h) => {
      const id = h.id;
      if (!id) return;
      // The visible text lives inside the `<span>` sibling of the anchor
      // handle (see MarkdownView's heading renderer). Falling back to
      // `textContent` would pull in the SVG's accessible name; the span
      // path is cleaner and matches what the user actually reads.
      const span = h.querySelector('span');
      const text = (span?.textContent ?? h.textContent ?? '').trim();
      if (!text) return;
      const depth = Number(h.tagName.slice(1));
      if (depth !== 1 && depth !== 2 && depth !== 3) return;
      next.push({ level: depth as 1 | 2 | 3, text, id });
    });
    outline = next;
    // After the outline rebuilds, recompute the active heading once so the
    // highlight isn't stale on path switch.
    updateActive();
  }

  /** Active heading = last heading whose top is at or above a small offset
   *  from the scroll-container's top. Falls back to the first entry when
   *  nothing has scrolled past yet. */
  function updateActive() {
    if (!mdWrapperEl || !scrollContainerEl || outline.length === 0) {
      activeId = '';
      return;
    }
    const containerTop = scrollContainerEl.getBoundingClientRect().top;
    // Small offset so a heading flips active just before it touches the
    // very top — matches what feels right when reading.
    const threshold = containerTop + 16;
    let current = outline[0].id;
    for (const entry of outline) {
      const el = mdWrapperEl.querySelector<HTMLElement>(`#${CSS.escape(entry.id)}`);
      if (!el) continue;
      const top = el.getBoundingClientRect().top;
      if (top <= threshold) {
        current = entry.id;
      } else {
        break;
      }
    }
    activeId = current;
  }

  // Rebuild whenever the doc content changes or we toggle out of edit
  // mode. `content`, `path`, `editing`, and `isMarkdown` are all reactive
  // — touching them inside the effect wires up the dependency graph.
  $effect(() => {
    void content;
    void path;
    void editing;
    void isMarkdown;
    void rebuildOutline();
  });

  // Attach a scroll listener to the surface container. Passive + scoped
  // to the container; the listener is cheap (one DOM walk over <= a few
  // dozen headings) and fires only while the user is actually scrolling
  // this panel. We use a scroll listener rather than IntersectionObserver
  // because we need the deterministic "last heading whose top is above
  // viewport top" rule — IO's threshold-based callback timing makes that
  // logic harder to get right across rapid scroll + smooth-scroll cases.
  $effect(() => {
    const el = scrollContainerEl;
    if (!el) return;
    const onScroll = () => updateActive();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  });

  function scrollToHeading(id: string) {
    if (!mdWrapperEl) return;
    const el = mdWrapperEl.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Optimistically mark this entry active so the highlight flips
    // immediately; the scroll listener will reconcile once smooth-scroll
    // settles.
    activeId = id;
  }

  function toggleToc() {
    tocCollapsed = !tocCollapsed;
    try {
      window.localStorage.setItem(TOC_COLLAPSED_KEY, tocCollapsed ? '1' : '0');
    } catch {
      /* noop */
    }
  }

  /** Whether to render the TOC rail at all. */
  const showToc = $derived(
    !editing &&
      !loading &&
      !error &&
      isMarkdown &&
      viewportWide &&
      outline.length >= MIN_OUTLINE_ENTRIES
  );
</script>

<svelte:window onkeydown={handleKey} />

<div class="flex flex-col h-full">
  <div class="flex items-center gap-2 px-1 mb-3">
    <svg
      viewBox="0 0 16 16"
      class="w-4 h-4 text-accent-cyan shrink-0"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M9 1.5H4a1 1 0 0 0-1 1V13.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z" />
      <polyline points="9 1.5 9 5.5 13 5.5" />
    </svg>
    <span class="text-xs font-mono text-text-primary truncate flex-1 min-w-0" title={path}
      >{path}</span
    >

    <!-- Bookmark toggle. Always visible (even in edit mode) so the user can
         star a doc while drafting changes without losing their place. The
         star fills gold when active; outlined otherwise. -->
    {#if onToggleBookmark}
      <button
        type="button"
        onclick={onToggleBookmark}
        title={bookmarked ? 'Remove bookmark' : 'Bookmark document'}
        aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark document'}
        aria-pressed={bookmarked}
        class="inline-flex items-center justify-center w-7 h-7 rounded-md border border-border-subtle hover:border-accent-gold transition disabled:opacity-40 disabled:cursor-not-allowed"
        class:text-accent-gold={bookmarked}
        class:text-text-muted={!bookmarked}
        class:hover:text-accent-gold={!bookmarked}
      >
        <svg
          viewBox="0 0 24 24"
          class="w-3.5 h-3.5"
          fill={bookmarked ? 'currentColor' : 'none'}
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9 12 2" />
        </svg>
      </button>
    {/if}

    <!-- Header actions: Edit (idle) or Save+Cancel (editing). -->
    {#if editing}
      <button
        type="button"
        onclick={() => void cancelEdit()}
        disabled={saving}
        class="text-[11px] px-2.5 py-1 rounded-md border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent-cyan transition disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        type="button"
        onclick={handleSave}
        disabled={saving}
        class="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md bg-accent-cyan text-bg-deep font-semibold hover:brightness-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {#if saving}
          <svg
            viewBox="0 0 24 24"
            class="w-3 h-3 animate-spin"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <circle cx="12" cy="12" r="10" opacity="0.25" />
            <path d="M22 12a10 10 0 0 0-10-10" />
          </svg>
          Saving…
        {:else}
          <!-- Floppy disk save icon. -->
          <svg
            viewBox="0 0 24 24"
            class="w-3 h-3"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
          Save
        {/if}
      </button>
    {:else}
      <button
        type="button"
        onclick={enterEdit}
        disabled={!canEdit}
        title="Edit document"
        aria-label="Edit document"
        class="inline-flex items-center justify-center w-7 h-7 rounded-md border border-border-subtle text-text-muted hover:text-accent-cyan hover:border-accent-cyan transition disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <!-- Pencil icon. -->
        <svg
          viewBox="0 0 24 24"
          class="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
        </svg>
      </button>
    {/if}
  </div>

  <!--
    Body row: doc content (scrolling) + optional TOC rail (fixed within
    the viewer). The TOC is rendered as a sibling of the scroll container
    so it stays put while the user scrolls the doc.
  -->
  <div class="flex-1 min-h-0 flex gap-3 min-w-0">
    <div bind:this={scrollContainerEl} class="surface flex-1 min-w-0 min-h-0 overflow-auto p-6">
      {#if loading}
        <div class="flex items-center justify-center gap-2 py-12 text-text-muted text-sm">
          <svg
            viewBox="0 0 24 24"
            class="w-4 h-4 animate-spin text-accent-cyan"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="9" stroke-opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" />
          </svg>
          Loading…
        </div>
      {:else if error}
        <div class="text-sm text-red-400">{error}</div>
      {:else if editing}
        <!--
          Edit mode: full-height monospace textarea, no border so the surface
          provides the chrome. Padding is deliberately zero on the textarea
          because the surrounding .surface already gives 24px of breathing room.
        -->
        <textarea
          bind:this={textareaEl}
          value={draft}
          oninput={(e) => (draft = (e.currentTarget as HTMLTextAreaElement).value)}
          spellcheck="false"
          class="block w-full h-[70vh] bg-bg-deep text-text-primary text-xs font-mono leading-relaxed resize-none border-0 focus:outline-none focus:ring-0 px-3 py-2 rounded-md"
        ></textarea>
      {:else if isMarkdown}
        <!--
          Wrapper exists so we can query the rendered headings (`h1.md-heading`,
          etc.) without reaching into MarkdownView. MarkdownView stamps each
          heading with an id matching the in-doc anchor slug; the TOC uses
          those ids verbatim.
        -->
        <div bind:this={mdWrapperEl}>
          <MarkdownView markdown={content} />
        </div>
      {:else}
        <pre
          class="text-xs font-mono text-text-primary whitespace-pre-wrap break-words leading-relaxed">{content}</pre>
      {/if}
    </div>

    {#if showToc}
      {#if tocCollapsed}
        <!-- Collapsed: thin gold strip, click anywhere to expand. -->
        <button
          type="button"
          onclick={toggleToc}
          aria-label="Show document outline"
          aria-expanded="false"
          title="Show outline"
          class="shrink-0 w-2 self-stretch rounded-md bg-accent-gold/40 hover:bg-accent-gold/70 transition cursor-pointer"
        ></button>
      {:else}
        <aside
          aria-label="Document outline"
          class="shrink-0 w-[200px] self-start max-h-full overflow-y-auto surface px-3 py-3 text-xs"
        >
          <div class="flex items-center justify-between mb-2">
            <span class="text-[10px] uppercase tracking-wider text-text-muted font-semibold">
              On this page
            </span>
            <button
              type="button"
              onclick={toggleToc}
              aria-label="Collapse outline"
              aria-expanded="true"
              title="Collapse outline"
              class="inline-flex items-center justify-center w-5 h-5 rounded text-text-muted hover:text-accent-cyan transition"
            >
              <!-- Chevron-right: indicates "collapse to the right". -->
              <svg
                viewBox="0 0 24 24"
                class="w-3 h-3"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </button>
          </div>
          <ul class="space-y-0.5">
            {#each outline as entry (entry.id)}
              <li>
                <button
                  type="button"
                  onclick={() => scrollToHeading(entry.id)}
                  class="toc-link block w-full text-left py-1 pr-1 border-l-2 transition truncate"
                  class:toc-link--active={activeId === entry.id}
                  style:padding-left="{8 + (entry.level - 1) * 12}px"
                  title={entry.text}
                >
                  {entry.text}
                </button>
              </li>
            {/each}
          </ul>
        </aside>
      {/if}
    {/if}
  </div>
</div>

<style>
  /* TOC entry: muted by default, cyan on hover, cyan + left border when
     active. Border slot reserved on every row so the active state doesn't
     shift the text 2px to the right. */
  .toc-link {
    border-left-color: transparent;
    color: #9ca3af;
    background: transparent;
  }
  .toc-link:hover {
    color: #4ca7e6;
  }
  .toc-link--active {
    color: #4ca7e6;
    border-left-color: #4ca7e6;
  }
</style>
