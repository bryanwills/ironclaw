<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import type { LogEntry, LogLevel } from '$lib/api/types';
  import { connection } from '$lib/stores/connection.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { surfaceRefresh } from '$lib/stores/surface-refresh.svelte';
  import { saveTextDialog } from '$lib/api/files';

  /** Hard cap on the in-memory log buffer. Bursts above this get pruned. */
  const MAX_ENTRIES = 5000;
  /** How many oldest entries to drop in one shot once we hit MAX_ENTRIES. */
  const PRUNE_BATCH = 500;
  /** Filter input debounce. */
  const FILTER_DEBOUNCE_MS = 250;
  /** localStorage write debounce for sticky filter prefs. */
  const PREFS_SAVE_DEBOUNCE_MS = 300;
  /** localStorage keys for sticky state. */
  const PREFS_KEY = 'ironclaw-logs-prefs';
  const HISTORY_KEY = 'ironclaw-logs-history';
  /** Max distinct grep queries to remember. */
  const HISTORY_MAX = 10;

  // ---- Virtualization constants --------------------------------------------
  /**
   * Fixed row height in pixels. All log rows render at exactly this height
   * so the windowing math is a simple division — no per-row measurement.
   * Matches the visual: text-xs (~12px) + leading-5 (20px line) + py-1.5
   * (6px top/bottom) ≈ 32px including the border. The row template enforces
   * this explicitly via inline height + line-height to defeat content-driven
   * growth (long messages clip with overflow-hidden + text-ellipsis on the
   * message cell; titles surface the full text on hover).
   */
  const ITEM_HEIGHT = 32;
  /**
   * Rows rendered above + below the visible window. Smooths fast scrolls so
   * the user doesn't see blank flashes between recycles. Keep small — bigger
   * over-scan means more DOM nodes per frame which is what we're trying to
   * avoid.
   */
  const OVERSCAN = 10;

  const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

  /** Quick-filter pill descriptors. Maps a pill id to the server log level it sets. */
  type QuickFilterId = 'all' | 'warnings' | 'errors';
  interface QuickFilter {
    id: QuickFilterId;
    label: string;
    level: LogLevel;
  }
  /**
   * Quick filters are a thin convenience over the existing level select.
   * "All" = trace (server sends everything; we filter locally to nothing).
   * "Warnings+" = warn (server emits warn + error only).
   * "Errors only" = error (server emits errors only).
   */
  const QUICK_FILTERS: QuickFilter[] = [
    { id: 'all', label: 'All', level: 'trace' },
    { id: 'warnings', label: 'Warnings+', level: 'warn' },
    { id: 'errors', label: 'Errors only', level: 'error' }
  ];

  // ---- Reactive state -------------------------------------------------------

  /**
   * Flat list of log entries in arrival order. Kept as a plain $state array
   * so we can splice/push without reactivity tricks; the filtered view is
   * memoized via $derived.by below.
   */
  let entries = $state<LogEntry[]>([]);

  /** Current effective server log level (last value read or set). */
  let level = $state<LogLevel>('info');
  /** Free-text filter applied client-side. Debounced into `appliedFilter`. */
  let filterInput = $state('');
  /** Debounced version of `filterInput` used for the derived filtered list. */
  let appliedFilter = $state('');
  /** When true, stop accumulating new entries (stream stays open under the hood). */
  let paused = $state(false);
  /** When true, snap to bottom on each new entry. Off by default — live tails are jumpy. */
  let autoScroll = $state(false);
  /** True while the SSE generator is actively pumping events. */
  let streaming = $state(false);

  /** Count of new entries that landed below the viewport since the user scrolled away. */
  let unreadBelow = $state(0);

  // `listEl` is bound via `bind:this` and only read imperatively (scroll
  // math, scroll-to-bottom). Wrapped in $state so Svelte 5's binding check
  // sees a reactive holder.
  let listEl = $state<HTMLDivElement | null>(null);
  let abort: AbortController | null = null;
  let filterTimer: ReturnType<typeof setTimeout> | null = null;
  let prefsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tracks whether the user has scrolled away from the bottom of the list. */
  let stuckToBottom = true;
  /**
   * When true, suppress the prefs-save effect for one tick. Used during the
   * mount-time hydrate so we don't immediately rewrite localStorage with the
   * values we just read from it (and so we don't fire the effect before
   * hydration is complete).
   */
  let prefsReady = $state(false);

  // ---- Search history state -------------------------------------------------
  /** Last N distinct grep queries, MRU first. Persisted to localStorage. */
  let searchHistory = $state<string[]>([]);
  /** True when the filter input has focus AND is empty. Drives history dropdown. */
  let filterFocused = $state(false);
  /** DOM ref to the filter input for click-outside detection. */
  let filterInputEl = $state<HTMLInputElement | null>(null);
  /** DOM ref to the history dropdown for click-outside detection. */
  let historyDropdownEl = $state<HTMLDivElement | null>(null);
  /** Row index hovered in the log list; used to show the copy icon. -1 = none. */
  let hoveredRow = $state<number>(-1);

  // ---- Virtualization state -------------------------------------------------
  /** Current scrollTop of the viewport — drives the visible window slice. */
  let scrollTop = $state(0);
  /** Height of the scrollable viewport, measured on mount + resize. */
  let viewportHeight = $state(0);

  // ---- Narrow-viewport adaptations -----------------------------------------
  /**
   * Breakpoint below which the row layout switches to a compact timestamp
   * (HH:MM:SS, no milliseconds). Tauri's minWidth is 800px; ≤1000px is the
   * window where the timestamp column at 78px starts crowding the message
   * cell, and HH:MM:SS at 56px leaves more room for the target + message.
   */
  const COMPACT_VIEWPORT_PX = 1000;
  /** Drives row-template width + timestamp string format. */
  let compactTime = $state<boolean>(false);

  // ---- Derived filtered view + window slice --------------------------------

  const filtered = $derived.by<LogEntry[]>(() => {
    const q = appliedFilter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) => e.message.toLowerCase().includes(q) || e.target.toLowerCase().includes(q)
    );
  });

  /** Currently active quick filter (derived from `level`). */
  const activeQuickFilter = $derived<QuickFilterId>(
    level === 'error' ? 'errors' : level === 'warn' ? 'warnings' : 'all'
  );

  /**
   * Window slice computed from scrollTop / viewportHeight / ITEM_HEIGHT.
   * Clamped to the bounds of `filtered`. `firstIndex` and `lastIndex` are
   * inclusive of OVERSCAN; the {#each} block iterates this slice directly,
   * and spacer divs above/below restore the correct scrollHeight so the
   * scrollbar represents the full list.
   */
  const windowSlice = $derived.by(() => {
    const total = filtered.length;
    if (total === 0 || viewportHeight === 0) {
      return { first: 0, last: 0, items: [] as Array<{ entry: LogEntry; index: number }> };
    }
    const rough = Math.floor(scrollTop / ITEM_HEIGHT);
    const visibleCount = Math.ceil(viewportHeight / ITEM_HEIGHT);
    const first = Math.max(0, rough - OVERSCAN);
    const last = Math.min(total - 1, rough + visibleCount + OVERSCAN);
    const items: Array<{ entry: LogEntry; index: number }> = [];
    for (let i = first; i <= last; i++) items.push({ entry: filtered[i], index: i });
    return { first, last, items };
  });

  /** Top spacer height = rows skipped above the window. */
  const topSpacer = $derived(windowSlice.first * ITEM_HEIGHT);
  /**
   * Bottom spacer height = rows skipped below the window. (total - last - 1)
   * because `last` is inclusive.
   */
  const bottomSpacer = $derived(
    Math.max(0, (filtered.length - windowSlice.last - 1) * ITEM_HEIGHT)
  );

  // ---- Sticky preferences --------------------------------------------------

  /**
   * Wire shape persisted to localStorage. Versioned so a future migration
   * can detect-and-replace without throwing on parse.
   */
  interface StoredPrefs {
    v: 1;
    level: LogLevel;
    filter: string;
    autoScroll: boolean;
    paused: boolean;
  }

  function hydratePrefs() {
    // Hydrate level/filter/autoScroll/paused + history from localStorage.
    // Wrapped in try/catch because the browser may have disabled storage
    // (private mode, quota error) — we just fall back to defaults rather
    // than break the page.
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredPrefs>;
        if (parsed && parsed.v === 1) {
          if (typeof parsed.level === 'string' && LEVELS.includes(parsed.level)) {
            level = parsed.level;
          }
          if (typeof parsed.filter === 'string') {
            filterInput = parsed.filter;
            appliedFilter = parsed.filter;
          }
          if (typeof parsed.autoScroll === 'boolean') autoScroll = parsed.autoScroll;
          if (typeof parsed.paused === 'boolean') paused = parsed.paused;
        }
      }
    } catch {
      // Corrupt JSON or storage failure — ignore and run with defaults.
    }
    try {
      const rawHistory = window.localStorage.getItem(HISTORY_KEY);
      if (rawHistory) {
        const arr = JSON.parse(rawHistory);
        if (Array.isArray(arr)) {
          searchHistory = arr
            .filter((s): s is string => typeof s === 'string')
            .slice(0, HISTORY_MAX);
        }
      }
    } catch {
      // Same as above — degrade silently.
    }
  }

  function savePrefs() {
    if (typeof window === 'undefined') return;
    try {
      const payload: StoredPrefs = {
        v: 1,
        level,
        filter: filterInput,
        autoScroll,
        paused
      };
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(payload));
    } catch {
      // Storage full / disabled — preferences just won't persist this session.
    }
  }

  function saveHistory() {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(searchHistory));
    } catch {
      // Storage write failed — keep in-memory copy, just don't persist.
    }
  }

  /**
   * Effect: any time a tracked pref changes, debounce-save to localStorage.
   * Gated on `prefsReady` so the mount-time hydrate doesn't immediately
   * fire a redundant write.
   */
  $effect(() => {
    // Read all tracked prefs so Svelte's reactivity wires them up.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    level;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    filterInput;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    autoScroll;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    paused;
    if (!prefsReady) return;
    if (prefsSaveTimer) clearTimeout(prefsSaveTimer);
    prefsSaveTimer = setTimeout(savePrefs, PREFS_SAVE_DEBOUNCE_MS);
  });

  // ---- Lifecycle ------------------------------------------------------------

  onMount(() => {
    hydratePrefs();
    // Defer enabling the save-effect by a tick so the hydrate writes above
    // don't immediately trigger a save.
    void tick().then(() => {
      prefsReady = true;
    });
    void boot();
    // Measure the viewport once the DOM is laid out, then observe resizes so
    // the visible-row count stays in sync with window/sidebar resizing.
    const ro = listEl ? new ResizeObserver(measureViewport) : null;
    void tick().then(() => {
      measureViewport();
      if (ro && listEl) ro.observe(listEl);
    });
    // Click-outside handler for the search history dropdown.
    const onDocPointerDown = (ev: PointerEvent) => {
      if (!filterFocused) return;
      const target = ev.target as Node | null;
      if (!target) return;
      if (filterInputEl && filterInputEl.contains(target)) return;
      if (historyDropdownEl && historyDropdownEl.contains(target)) return;
      filterFocused = false;
    };
    document.addEventListener('pointerdown', onDocPointerDown);

    // Track viewport width via matchMedia so the row layout flips to the
    // compact (no-ms) timestamp format at narrow widths. Cheaper than a
    // resize listener and fires only on threshold crossings.
    const mql = window.matchMedia(`(max-width: ${COMPACT_VIEWPORT_PX}px)`);
    compactTime = mql.matches;
    const onMql = (e: MediaQueryListEvent) => (compactTime = e.matches);
    mql.addEventListener('change', onMql);

    // Surface refresh (Cmd+R): re-open the SSE stream. Closes any
    // active connection first so we get a clean reconnect; the
    // existing buffer of log entries is left in place so the user
    // doesn't lose visible context. Future events come from the new
    // stream.
    surfaceRefresh.register(async () => {
      closeStream();
      openStream();
    });

    return () => {
      ro?.disconnect();
      document.removeEventListener('pointerdown', onDocPointerDown);
      mql.removeEventListener('change', onMql);
    };
  });

  onDestroy(() => {
    teardown();
    surfaceRefresh.unregister();
  });

  function measureViewport() {
    if (!listEl) return;
    viewportHeight = listEl.clientHeight;
  }

  async function boot() {
    if (connection.status !== 'connected') return;
    const client = connection.client;
    if (!client) return;
    try {
      const cur = await client.getLogLevel();
      // If we hydrated a stored level, push it to the server so the
      // stream matches what the UI expects. Otherwise adopt the server's
      // current level.
      if (prefsReady && level !== cur.level) {
        try {
          const res = await client.setLogLevel(level);
          if (!res.ok) level = cur.level;
        } catch {
          level = cur.level;
        }
      } else {
        level = cur.level;
      }
    } catch (err) {
      toasts.show(`Couldn't read log level: ${(err as Error).message}`, 'error');
    }
    openStream();
  }

  function teardown() {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = null;
    if (prefsSaveTimer) clearTimeout(prefsSaveTimer);
    prefsSaveTimer = null;
    closeStream();
  }

  function openStream() {
    const client = connection.client;
    if (!client) return;
    closeStream();
    abort = new AbortController();
    streaming = true;
    void pump(client.streamLogs(abort.signal));
  }

  function closeStream() {
    streaming = false;
    if (abort) {
      abort.abort();
      abort = null;
    }
  }

  async function pump(it: AsyncIterable<LogEntry>) {
    try {
      for await (const entry of it) {
        if (paused) continue;
        appendEntry(entry);
      }
    } catch (err) {
      const msg = (err as Error).message;
      // AbortError on teardown is expected — only surface real failures.
      if (msg && !msg.toLowerCase().includes('abort')) {
        toasts.show(`Log stream error: ${msg}`, 'error');
      }
    } finally {
      streaming = false;
    }
  }

  function appendEntry(entry: LogEntry) {
    // Append, then prune in a batch when we cross MAX_ENTRIES. Doing this in
    // one slice keeps reactivity work O(1) per overflow instead of O(N).
    const next = entries.length >= MAX_ENTRIES ? entries.slice(PRUNE_BATCH) : entries.slice();
    next.push(entry);
    entries = next;

    if (autoScroll) {
      void scrollToBottom();
    } else if (!stuckToBottom) {
      unreadBelow += 1;
    }
  }

  // ---- Event handlers -------------------------------------------------------

  function onFilterInput(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    filterInput = value;
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      appliedFilter = value;
      // Commit non-empty queries to history (MRU, distinct, capped).
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        const next = [trimmed, ...searchHistory.filter((q) => q !== trimmed)].slice(0, HISTORY_MAX);
        searchHistory = next;
        saveHistory();
      }
      // Filter changes the list length under the cursor; reset scroll to the
      // top so the user doesn't end up staring at a blank window past the
      // end of the new (shorter) filtered list.
      if (listEl) {
        listEl.scrollTop = 0;
        scrollTop = 0;
      }
    }, FILTER_DEBOUNCE_MS);
  }

  function onFilterFocus() {
    filterFocused = true;
  }

  function applyHistoryQuery(q: string) {
    filterInput = q;
    appliedFilter = q;
    filterFocused = false;
    if (listEl) {
      listEl.scrollTop = 0;
      scrollTop = 0;
    }
  }

  function clearHistory() {
    searchHistory = [];
    saveHistory();
    filterFocused = false;
  }

  async function onLevelChange(e: Event) {
    const next = (e.target as HTMLSelectElement).value as LogLevel;
    await applyLevel(next);
  }

  async function applyLevel(next: LogLevel) {
    const client = connection.client;
    if (!client) return;
    if (next === level) return;
    const previous = level;
    level = next;
    try {
      const res = await client.setLogLevel(next);
      if (!res.ok) throw new Error('Server did not confirm level change.');
      toasts.show(`Log level set to ${next}`, 'success');
      // Re-open so the server's new buffered window matches the new level.
      openStream();
    } catch (err) {
      level = previous;
      toasts.show(`Set level failed: ${(err as Error).message}`, 'error');
    }
  }

  function onQuickFilter(id: QuickFilterId) {
    const target = QUICK_FILTERS.find((q) => q.id === id);
    if (!target) return;
    void applyLevel(target.level);
  }

  function togglePause() {
    paused = !paused;
  }

  function clearEntries() {
    entries = [];
    unreadBelow = 0;
    if (listEl) {
      listEl.scrollTop = 0;
      scrollTop = 0;
    }
  }

  function onAutoScrollChange(e: Event) {
    autoScroll = (e.target as HTMLInputElement).checked;
    if (autoScroll) {
      unreadBelow = 0;
      void scrollToBottom();
    }
  }

  function onListScroll() {
    if (!listEl) return;
    scrollTop = listEl.scrollTop;
    // 8px slack so we don't lose "at bottom" status to subpixel rounding.
    const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 8;
    stuckToBottom = atBottom;
    if (atBottom) unreadBelow = 0;
  }

  async function scrollToBottom() {
    await tick();
    if (!listEl) return;
    listEl.scrollTop = listEl.scrollHeight;
    scrollTop = listEl.scrollTop;
    stuckToBottom = true;
    unreadBelow = 0;
  }

  function jumpToBottom() {
    autoScroll = true;
    void scrollToBottom();
  }

  // ---- Copy + export -------------------------------------------------------

  /** Canonical single-line format used by both copy-row and export. */
  function formatEntryLine(entry: LogEntry): string {
    return `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.target}: ${entry.message}`;
  }

  async function copyEntry(entry: LogEntry, ev: MouseEvent) {
    // Stop the row hover bubbling — without this, fast double-clicks can
    // bubble into other handlers we add later.
    ev.stopPropagation();
    const text = formatEntryLine(entry);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for sandboxes without clipboard API. Tauri webviews on
        // recent macOS expose navigator.clipboard, but keep this as a
        // safety net so a missing permission doesn't break the feature.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
        } finally {
          document.body.removeChild(ta);
        }
      }
      toasts.show('Log entry copied', 'success');
    } catch (err) {
      toasts.show(`Copy failed: ${(err as Error).message}`, 'error');
    }
  }

  async function exportLogs() {
    if (filtered.length === 0) {
      toasts.show('Nothing to export — filter is empty', 'info');
      return;
    }
    const body = filtered.map(formatEntryLine).join('\n') + '\n';
    const stamp = ymd(new Date());
    const filename = `ironclaw-logs-${stamp}.txt`;
    try {
      const saved = await saveTextDialog(filename, body);
      if (saved) {
        toasts.show(`Exported ${filtered.length} entries`, 'success');
      }
      // If `saved` is null the user cancelled — silently no-op.
    } catch (err) {
      toasts.show(`Export failed: ${(err as Error).message}`, 'error');
    }
  }

  /** YYYY-MM-DD in local time, used for the export filename. */
  function ymd(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // ---- Formatting helpers ---------------------------------------------------

  function formatTime(ts: string): string {
    // Show HH:mm:ss.SSS in the user's local zone — useful for live tail.
    // At narrow viewports (≤1000px) drop the milliseconds so the timestamp
    // column doesn't clip to "14:21:52…" — the dogfood report flagged this
    // specifically. The Tauri minWidth is 800px so 1000px is the right
    // breakpoint to start condensing.
    // Fall back to the raw string if Date parsing chokes.
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    if (compactTime) return `${hh}:${mm}:${ss}`;
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  function levelClasses(l: LogLevel): string {
    switch (l) {
      case 'trace':
        return 'bg-border-subtle/60 text-text-muted';
      case 'debug':
        return 'bg-accent-cyan/10 text-accent-cyan';
      case 'info':
        return 'bg-accent-cyan/20 text-accent-cyan';
      case 'warn':
        return 'bg-accent-gold/15 text-accent-gold';
      case 'error':
        return 'bg-red-500/15 text-red-400';
    }
  }
</script>

<section class="p-8 h-full flex flex-col">
  <header class="mb-4 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold text-text-primary">Logs</h1>
      <p class="text-text-muted text-sm mt-1">Live tail of the gateway's tracing output.</p>
    </div>
  </header>

  {#if connection.status !== 'connected'}
    <!-- Connection guard: no point opening a stream if we can't auth. -->
    <div class="surface flex-1 flex flex-col items-center justify-center gap-2 p-8">
      <svg
        viewBox="0 0 24 24"
        class="w-8 h-8 text-text-muted"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path
          d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
        />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div class="text-sm text-text-primary">IronClaw is offline</div>
      <div class="text-xs text-text-muted">
        Verify the gateway connection in
        <a
          href="/settings"
          class="text-accent-cyan underline decoration-dotted hover:decoration-solid">Settings</a
        >.
      </div>
    </div>
  {:else}
    <!-- Quick-filter pill row. Lives above the main control strip so the
         most common level switches sit at the top of the surface. -->
    <div class="mb-2 flex items-center gap-1.5 text-xs">
      {#each QUICK_FILTERS as q (q.id)}
        <button
          type="button"
          onclick={() => onQuickFilter(q.id)}
          aria-pressed={activeQuickFilter === q.id}
          class="px-2.5 py-1 rounded-full border transition-colors min-h-[26px]"
          class:border-accent-cyan={activeQuickFilter === q.id}
          class:text-accent-cyan={activeQuickFilter === q.id}
          class:bg-accent-cyan={false}
          class:bg-accent-cyan-10={activeQuickFilter === q.id}
          class:border-border-subtle={activeQuickFilter !== q.id}
          class:text-text-muted={activeQuickFilter !== q.id}
          class:hover:border-accent-cyan={activeQuickFilter !== q.id}
          class:hover:text-accent-cyan={activeQuickFilter !== q.id}
          style={activeQuickFilter === q.id ? 'background: rgba(34, 211, 238, 0.08);' : ''}
        >
          {q.label}
        </button>
      {/each}
    </div>

    <!-- Control strip -->
    <div class="surface mb-3 px-3 py-2 flex flex-wrap items-center gap-3 text-xs">
      <div class="flex items-center gap-2">
        <span
          class="w-2 h-2 rounded-full"
          class:bg-green-500={streaming && !paused}
          class:animate-pulse={streaming && !paused}
          class:bg-accent-gold={streaming && paused}
          class:bg-text-muted={!streaming}
        ></span>
        <span class="text-text-muted">
          {#if !streaming}
            Disconnected
          {:else if paused}
            Paused
          {:else}
            Live
          {/if}
        </span>
      </div>

      <div class="h-4 w-px bg-border-subtle"></div>

      <label class="flex items-center gap-2">
        <span class="text-text-muted uppercase tracking-wide">Level</span>
        <select
          value={level}
          onchange={onLevelChange}
          class="bg-bg-deep border border-border-subtle rounded px-2 py-1 text-text-primary focus:outline-none focus:border-accent-cyan"
        >
          {#each LEVELS as l (l)}
            <option value={l}>{l}</option>
          {/each}
        </select>
      </label>

      <!-- Filter input + history dropdown. The dropdown surfaces under the
           input when it's focused AND empty, listing previously-applied
           grep queries. -->
      <div class="flex-1 min-w-[180px] relative">
        <input
          bind:this={filterInputEl}
          type="text"
          value={filterInput}
          oninput={onFilterInput}
          onfocus={onFilterFocus}
          placeholder="Filter by message or target…"
          class="w-full bg-bg-deep border border-border-subtle rounded px-2 py-1 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-cyan"
          aria-label="Filter logs by message or target"
        />
        {#if filterFocused && filterInput.length === 0 && searchHistory.length > 0}
          <div
            bind:this={historyDropdownEl}
            class="absolute left-0 right-0 top-full mt-1 z-20 bg-bg-deep border border-border-subtle rounded shadow-lg overflow-hidden"
          >
            <div
              class="px-2 py-1 text-[10px] uppercase tracking-wide text-text-muted border-b border-border-subtle/60"
            >
              Recent searches
            </div>
            <ul class="max-h-48 overflow-auto">
              {#each searchHistory as q, i (q + i)}
                <li>
                  <button
                    type="button"
                    onclick={() => applyHistoryQuery(q)}
                    class="w-full text-left px-2 py-1 text-text-primary hover:bg-bg-deep hover:text-accent-cyan transition-colors truncate"
                    style="background: transparent;"
                    onmouseenter={(ev) =>
                      ((ev.currentTarget as HTMLButtonElement).style.background =
                        'rgba(34,211,238,0.06)')}
                    onmouseleave={(ev) =>
                      ((ev.currentTarget as HTMLButtonElement).style.background = 'transparent')}
                  >
                    {q}
                  </button>
                </li>
              {/each}
            </ul>
            <button
              type="button"
              onclick={clearHistory}
              class="w-full text-left px-2 py-1 text-[10px] uppercase tracking-wide text-text-muted hover:text-red-400 border-t border-border-subtle/60 transition-colors"
            >
              Clear history
            </button>
          </div>
        {/if}
      </div>

      <button
        type="button"
        onclick={togglePause}
        class="px-2.5 py-1 rounded border border-border-subtle text-text-muted hover:border-accent-cyan hover:text-accent-cyan transition-colors min-h-[28px]"
        aria-pressed={paused}
      >
        {paused ? 'Resume' : 'Pause'}
      </button>

      <button
        type="button"
        onclick={clearEntries}
        class="px-2.5 py-1 rounded border border-border-subtle text-text-muted hover:border-accent-cyan hover:text-accent-cyan transition-colors min-h-[28px]"
      >
        Clear
      </button>

      <button
        type="button"
        onclick={exportLogs}
        class="px-2.5 py-1 rounded border border-border-subtle text-text-muted hover:border-accent-cyan hover:text-accent-cyan transition-colors min-h-[28px] flex items-center gap-1.5"
        title="Export filtered entries"
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
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        Export
      </button>

      <label class="flex items-center gap-1.5 text-text-muted cursor-pointer select-none">
        <input
          type="checkbox"
          checked={autoScroll}
          onchange={onAutoScrollChange}
          class="accent-accent-cyan"
        />
        Auto-scroll
      </label>

      <div class="text-text-muted tabular-nums">
        {filtered.length}{appliedFilter ? ` / ${entries.length}` : ''} entries
      </div>
    </div>

    <!-- Log list -->
    <div class="surface flex-1 overflow-hidden flex flex-col relative">
      <div
        bind:this={listEl}
        onscroll={onListScroll}
        class="flex-1 overflow-auto font-mono text-xs"
      >
        {#if entries.length === 0}
          <div class="h-full flex items-center justify-center text-text-muted">
            {streaming ? 'Waiting for log events…' : 'No log entries yet.'}
          </div>
        {:else if filtered.length === 0}
          <div class="h-full flex items-center justify-center text-text-muted">
            No entries match "{appliedFilter}".
          </div>
        {:else}
          <!--
            Virtualized window. The two spacer divs preserve the total
            scrollHeight (= filtered.length * ITEM_HEIGHT) so the native
            scrollbar reflects the full list, even though only ~viewport+overscan
            rows are mounted in the DOM. Each rendered row is forced to exactly
            ITEM_HEIGHT via inline style so the math stays trivially correct —
            no per-row measurement, no growing/shrinking under the cursor.
          -->
          <div style="height: {topSpacer}px;" aria-hidden="true"></div>
          {#each windowSlice.items as row (row.index + '|' + row.entry.timestamp)}
            <div
              class="group relative grid gap-x-3 px-3 items-center border-b border-border-subtle/30 hover:bg-bg-deep transition-colors"
              style="grid-template-columns: {compactTime
                ? '60px'
                : '82px'} 56px minmax(0, 200px) 1fr 28px; height: {ITEM_HEIGHT}px; line-height: 1.1;"
              onmouseenter={() => (hoveredRow = row.index)}
              onmouseleave={() => (hoveredRow = -1)}
              role="presentation"
            >
              <span
                class="text-text-muted text-[10px] tabular-nums truncate"
                title={row.entry.timestamp}
              >
                {formatTime(row.entry.timestamp)}
              </span>
              <span
                class="px-1.5 rounded text-[10px] uppercase tracking-wide text-center {levelClasses(
                  row.entry.level
                )}"
              >
                {row.entry.level}
              </span>
              <span class="text-text-muted truncate" title={row.entry.target}>
                {row.entry.target}
              </span>
              <span class="text-text-primary truncate" title={row.entry.message}>
                {row.entry.message}
              </span>
              <button
                type="button"
                onclick={(ev) => copyEntry(row.entry, ev)}
                class="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-text-muted hover:text-accent-cyan focus:opacity-100 focus:outline-none focus:text-accent-cyan"
                class:opacity-100={hoveredRow === row.index}
                title="Copy log entry"
                aria-label="Copy log entry"
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
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
            </div>
          {/each}
          <div style="height: {bottomSpacer}px;" aria-hidden="true"></div>
        {/if}
      </div>

      {#if !autoScroll && unreadBelow > 0}
        <button
          type="button"
          onclick={jumpToBottom}
          class="absolute bottom-3 right-4 px-3 py-1.5 rounded-full bg-accent-cyan text-bg-deep text-xs font-medium shadow-lg hover:bg-accent-cyan/90 transition-colors flex items-center gap-1.5"
        >
          <svg
            viewBox="0 0 24 24"
            class="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          {unreadBelow} new
        </button>
      {/if}
    </div>
  {/if}
</section>
