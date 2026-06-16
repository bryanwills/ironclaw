<script lang="ts">
  // Cmd+T quick thread switcher. Laser-focused on jumping to existing chat
  // threads — distinct from Cmd+K (palette: nav + actions) and Cmd+Shift+F
  // (global search: cross-surface data).
  //
  // Mounted once at the layout level (`src/routes/+layout.svelte`); summoned
  // via `threadSwitcher.show()` from `$lib/stores/thread-switcher.svelte`.
  //
  // Behavior:
  //   - Modal centered, ~500px wide, ~50% viewport tall.
  //   - Auto-focus search input on open. Esc closes.
  //   - Reads from the `threads` store — no API calls. If threads haven't
  //     been loaded yet (user hasn't visited /chat), shows the empty state.
  //   - Fuzzy substring match by title. Sort:
  //       1) Last selected (most recent first) — from `threads.recent`
  //       2) Then by `updated_at` desc
  //     (so a thread the user just opened sits at the top regardless of
  //     server-side updated_at).
  //   - Highlight matched substring in gold (matches GlobalSearch's
  //     <mark> treatment for visual continuity).
  //   - Up/Down nav; Enter selects + navigates to `/?thread=<id>`.
  //   - "Recent" section pinned to the top when the search input is empty.
  //   - Tint dot per row when the active profile carries a tint (R16d) —
  //     the dot uses the resolved tint color so multi-window users get a
  //     consistent visual cue.

  import { tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { threads } from '$lib/stores/threads.svelte';
  import { threadSwitcher } from '$lib/stores/thread-switcher.svelte';
  import { connection } from '$lib/stores/connection.svelte';
  import { resolveTint } from '$lib/stores/settings.svelte';
  import { threadRename } from '$lib/stores/thread-rename.svelte';
  import type { Thread } from '$lib/api/types';

  // -- types ----------------------------------------------------------------

  /** A row that gets rendered + arrow-navigated. `recentTs` is non-null when
   *  the row was hoisted from the recents list (only set on the Recent
   *  section). */
  interface Row {
    thread: Thread;
    /** ms timestamp when the user last opened this thread, or null if it has
     *  never been opened in this client (or recents was cleared). */
    recentTs: number | null;
  }

  /** Section bucket used by the renderer + flat keyboard-nav index. */
  interface Section {
    kind: 'recent' | 'all';
    title: string;
    rows: Row[];
  }

  // -- ui state -------------------------------------------------------------

  let query = $state('');
  let activeIndex = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);

  // -- lifecycle ------------------------------------------------------------

  // Reset transient state on open AND on close so each open is a blank
  // slate — same pattern as CommandPalette / GlobalSearch.
  $effect(() => {
    if (threadSwitcher.open) {
      void onOpen();
    } else {
      query = '';
      activeIndex = 0;
    }
  });

  async function onOpen() {
    await tick();
    inputEl?.focus();
  }

  // -- derived: recent + filtered + sectioned -------------------------------

  /** Lookup from thread id → recent timestamp. Built once per render off
   *  the rune-backed `threads.recent` array. */
  const recentTsById = $derived<Record<string, number>>(
    threads.recent.reduce<Record<string, number>>((acc, e) => {
      acc[e.id] = e.ts;
      return acc;
    }, {})
  );

  /** Recent threads, hydrated with their full Thread payload. Threads that
   *  vanished from the server (deleted, profile-switch, etc.) drop out so
   *  we don't render dead rows. Order preserved from `threads.recent`. */
  const recentRows = $derived<Row[]>(
    threads.recent
      .map((e): Row | null => {
        const t = threads.threads.find((tt) => tt.id === e.id);
        if (!t) return null;
        return { thread: t, recentTs: e.ts };
      })
      .filter((r): r is Row => r !== null)
  );

  /** All threads after the substring filter. Sort tiers:
   *    1) recentTs desc (recents come first; non-recent rows fall through
   *       to tier 2 with recentTs=null sorted last via `??`)
   *    2) updated_at desc
   *  Both tiers are pre-applied here so the "All" section is correctly
   *  ordered when the query is non-empty (Recent section is hidden then). */
  const filteredRows = $derived<Row[]>(
    (() => {
      const needle = query.trim().toLowerCase();
      const rows: Row[] = threads.threads.map((t) => ({
        thread: t,
        recentTs: recentTsById[t.id] ?? null
      }));
      // Filter on the DISPLAY title (rename overlay wins over server
      // title) so a user who renamed "untitled chat" to "Tax research"
      // can still find it by typing "tax".
      const matched = needle
        ? rows.filter((r) =>
            threadRename
              .displayTitle(r.thread.id, r.thread.title || 'Untitled thread')
              .toLowerCase()
              .includes(needle)
          )
        : rows;
      return matched.sort((a, b) => {
        const ar = a.recentTs ?? -Infinity;
        const br = b.recentTs ?? -Infinity;
        if (ar !== br) return br - ar;
        const au = a.thread.updated_at ? Date.parse(a.thread.updated_at) : 0;
        const bu = b.thread.updated_at ? Date.parse(b.thread.updated_at) : 0;
        return bu - au;
      });
    })()
  );

  /** Sections shown to the user. When the query is empty AND recents exist,
   *  we hoist the recents list as its own section above "All threads"
   *  (deduped — a recent thread doesn't double-render in the "All" list
   *  beneath). When the user types, recents collapse back into the single
   *  ordered list so search has the full set in tiered order. */
  const sections = $derived<Section[]>(
    (() => {
      if (query.trim() === '' && recentRows.length > 0) {
        const recentIds = new Set(recentRows.map((r) => r.thread.id));
        const rest = filteredRows.filter((r) => !recentIds.has(r.thread.id));
        const out: Section[] = [{ kind: 'recent', title: 'Recent', rows: recentRows }];
        if (rest.length > 0) {
          out.push({ kind: 'all', title: 'All threads', rows: rest });
        }
        return out;
      }
      return [{ kind: 'all', title: 'All threads', rows: filteredRows }];
    })()
  );

  /** Flat row list for keyboard navigation. Mirrors the rendered order so
   *  arrow keys move through what the user sees. */
  const flatRows = $derived<Row[]>(sections.flatMap((s) => s.rows));

  /** Row-id → flat-index lookup so hover handlers can sync activeIndex
   *  without re-walking the array. */
  const flatIndexById = $derived<Record<string, number>>(
    flatRows.reduce<Record<string, number>>((acc, r, i) => {
      acc[r.thread.id] = i;
      return acc;
    }, {})
  );

  // Clamp activeIndex into range whenever the list shrinks beneath it
  // (e.g. user typed a more-restrictive query).
  $effect(() => {
    if (activeIndex >= flatRows.length) {
      activeIndex = Math.max(0, flatRows.length - 1);
    }
  });

  // Reset activeIndex on query change so the top match becomes default.
  $effect(() => {
    void query;
    activeIndex = 0;
  });

  // Keep the active row scrolled into view as the user arrows through.
  $effect(() => {
    void activeIndex;
    void tick().then(() => {
      const el = listEl?.querySelector(`[data-row-index="${activeIndex}"]`) as HTMLElement | null;
      el?.scrollIntoView({ block: 'nearest' });
    });
  });

  // -- profile tint ---------------------------------------------------------
  // Resolve the active profile's tint once per render. When the profile has
  // an explicit non-default tint (anything but 'signal'), we paint a small
  // dot indicator on each row so multi-window users see at a glance which
  // profile context this switcher belongs to.
  const tintDot = $derived<string | null>(
    (() => {
      const tint = connection.activeProfile?.tint;
      if (!tint || tint === 'signal') return null;
      return resolveTint(tint).accent;
    })()
  );

  // -- substring highlighting ----------------------------------------------
  // Mirrors GlobalSearch's <mark>-segment splitter so the visual treatment
  // is consistent between the two modals.

  interface Segment {
    text: string;
    hit: boolean;
  }

  function highlight(haystack: string, needle: string): Segment[] {
    if (!needle) return [{ text: haystack, hit: false }];
    const lower = haystack.toLowerCase();
    const target = needle.toLowerCase();
    const segs: Segment[] = [];
    let i = 0;
    while (i < haystack.length) {
      const found = lower.indexOf(target, i);
      if (found < 0) {
        segs.push({ text: haystack.slice(i), hit: false });
        break;
      }
      if (found > i) segs.push({ text: haystack.slice(i, found), hit: false });
      segs.push({ text: haystack.slice(found, found + target.length), hit: true });
      i = found + target.length;
    }
    return segs;
  }

  // -- relative time --------------------------------------------------------
  // Compact "5m / 2h / 3d / 4w" formatter — kept inline rather than pulling
  // a dep. Matches the cadence of the existing thread sidebar (which uses
  // a similar derived label in `Sidebar.svelte`).

  function relativeTime(iso: string | undefined | null): string {
    if (!iso) return '';
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return '';
    const diffMs = Date.now() - ts;
    if (diffMs < 0) return 'now';
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    const wk = Math.floor(day / 7);
    if (wk < 4) return `${wk}w ago`;
    const mo = Math.floor(day / 30);
    if (mo < 12) return `${mo}mo ago`;
    const yr = Math.floor(day / 365);
    return `${yr}y ago`;
  }

  // -- handlers -------------------------------------------------------------

  function activate(row: Row) {
    threads.selectThread(row.thread.id);
    threadSwitcher.close();
    // Use the canonical deep-link so /chat picks the thread up on mount
    // (the +page.svelte route reads `?thread=<id>` and applies it after
    // the list loads). selectThread() above primes the in-memory store so
    // the switch is instant when we're already on /chat.
    void goto(`/chat?thread=${encodeURIComponent(row.thread.id)}`);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      threadSwitcher.close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flatRows.length > 0) activeIndex = (activeIndex + 1) % flatRows.length;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flatRows.length > 0)
        activeIndex = activeIndex === 0 ? flatRows.length - 1 : activeIndex - 1;
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = flatRows[activeIndex];
      if (row) activate(row);
    }
  }

  function onBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      threadSwitcher.close();
    }
  }
</script>

{#if threadSwitcher.open}
  <!-- Backdrop. Click-outside closes. The input traps focus implicitly via
       autofocus + the global keydown listener inside the modal. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[65] flex items-start justify-center pt-[14vh] bg-black/60 backdrop-blur-sm"
    onclick={onBackdropClick}
    role="presentation"
  >
    <div
      class="w-[500px] max-w-[92vw] h-[50vh] max-h-[560px] flex flex-col bg-bg-deep border border-accent-cyan/40 rounded-xl shadow-2xl overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Switch thread"
    >
      <!-- Search input. Auto-focus on open via onOpen → tick → inputEl.focus. -->
      <div class="flex items-center gap-3 px-5 py-4 border-b border-border-subtle">
        <svg
          viewBox="0 0 24 24"
          class="w-4 h-4 text-accent-cyan shrink-0"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <input
          bind:this={inputEl}
          bind:value={query}
          onkeydown={onKeyDown}
          type="text"
          placeholder="Jump to a thread by title…"
          aria-label="Thread switcher search"
          class="flex-1 bg-transparent border-0 outline-none font-mono text-base text-text-primary placeholder:text-text-muted/60"
          spellcheck="false"
          autocomplete="off"
        />
        <kbd
          class="hidden sm:inline-block text-[10px] text-text-muted border border-border-subtle rounded px-1.5 py-0.5 font-mono"
        >
          ESC
        </kbd>
      </div>

      <!-- Results -->
      <div bind:this={listEl} class="flex-1 overflow-y-auto py-2">
        {#if threads.threads.length === 0}
          <!-- Hard empty state — no threads at all. We don't try to trigger
               a load here; the user can navigate to /chat which owns the
               threads lifecycle (init/refresh on send). -->
          <div class="px-5 py-8 text-center text-sm text-text-muted">
            No conversations yet. Start one from the chat page.
          </div>
        {:else if flatRows.length === 0}
          <!-- Soft empty state — threads exist but the query matched none. -->
          <div class="px-5 py-8 text-center text-sm text-text-muted">
            No matches for <span class="text-text-primary">{query}</span>
          </div>
        {:else}
          {#each sections as section (section.kind)}
            {#if section.rows.length > 0}
              <div class="mb-1">
                <div
                  class="px-5 pt-2 pb-1 text-[10px] font-mono uppercase tracking-widest text-text-muted/70"
                >
                  {section.title}
                </div>
                {#each section.rows as row (row.thread.id)}
                  {@const idx = flatIndexById[row.thread.id]}
                  {@const active = idx === activeIndex}
                  {@const title = threadRename.displayTitle(
                    row.thread.id,
                    row.thread.title || 'Untitled thread'
                  )}
                  {@const renamed = threadRename.has(row.thread.id)}
                  {@const count = row.thread.message_count ?? 0}
                  {@const relTime = relativeTime(row.thread.updated_at)}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div
                    data-row-index={idx}
                    onclick={() => activate(row)}
                    onmouseenter={() => (activeIndex = idx)}
                    class="mx-2 px-3 py-2 rounded-md flex items-center gap-3 cursor-pointer border-l-2 transition-colors"
                    class:bg-bg-surface={active}
                    class:border-accent-cyan={active}
                    class:border-transparent={!active}
                    class:hover:bg-bg-surface={!active}
                  >
                    <!-- Tint dot — only painted when the active profile has
                         a non-default tint. Sits at the row's left edge as
                         a quiet visual signal of profile context. -->
                    {#if tintDot}
                      <span
                        class="w-1.5 h-1.5 rounded-full shrink-0"
                        style:background-color={tintDot}
                        aria-hidden="true"
                      ></span>
                    {/if}
                    <span class="flex-1 min-w-0">
                      <span
                        class="text-sm font-semibold truncate block"
                        class:text-text-primary={active}
                        class:text-text-muted={!active}
                      >
                        {#each highlight(title, query.trim()) as seg, i (i)}
                          {#if seg.hit}
                            <mark class="bg-accent-gold/20 text-accent-gold rounded-sm px-0.5">
                              {seg.text}
                            </mark>
                          {:else}
                            <span>{seg.text}</span>
                          {/if}
                        {/each}
                        {#if renamed}
                          <!-- Locally-renamed indicator. Matches the chat
                               header and rail affordance so users see the
                               override status everywhere a title surfaces. -->
                          <span
                            class="text-accent-gold text-[10px] ml-1 align-middle"
                            title="Locally renamed"
                            aria-label="Locally renamed"
                          >
                            ✏
                          </span>
                        {/if}
                      </span>
                      <span class="text-xs text-text-muted/70 truncate block mt-0.5">
                        {#if relTime}{relTime}{/if}
                        {#if relTime && count > 0}<span class="mx-1.5 text-text-muted/40">·</span
                          >{/if}
                        {#if count > 0}{count} message{count === 1
                            ? ''
                            : 's'}{:else if !relTime}Empty{/if}
                      </span>
                    </span>
                  </div>
                {/each}
              </div>
            {/if}
          {/each}
        {/if}
      </div>

      <!-- Footer hint strip -->
      <div
        class="px-5 py-2 border-t border-border-subtle flex items-center gap-4 text-[10px] text-text-muted/70 font-mono"
      >
        <span><kbd class="text-text-muted">↑ ↓</kbd> navigate</span>
        <span><kbd class="text-text-muted">↵</kbd> open</span>
        <span><kbd class="text-text-muted">esc</kbd> close</span>
        <span class="ml-auto"><kbd class="text-text-muted">⌘T</kbd> toggle</span>
      </div>
    </div>
  </div>
{/if}
