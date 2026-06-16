<script lang="ts">
  import { onDestroy, onMount, type Component } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { Job, JobSummary } from '$lib/api/types';
  import { connection } from '$lib/stores/connection.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { surfaceRefresh } from '$lib/stores/surface-refresh.svelte';
  import { createPollingRefresh } from '$lib/util/polling';
  // Routines ship the same relative-time helper we want; we IMPORT (per the
  // file-scope constraint we don't modify other routes).
  import { relativeTime } from '../routines/time';

  // 15s poll cadence matches the brief. Faster than routines (30s) because
  // background-job state churns more — a tool call can land in 2s.
  const POLL_INTERVAL_MS = 15_000;

  // Persisted UI prefs. Search + filter pill + sort key. Stored under a
  // namespaced key so a future settings panel can wipe in one call.
  const PREFS_STORAGE_KEY = 'ironclaw-jobs-prefs';

  type StateFilter = 'all' | 'in_progress' | 'pending' | 'completed' | 'failed';
  type SortKey = 'created_desc' | 'created_asc' | 'state' | 'title';
  type Prefs = { search: string; filter: StateFilter; sort: SortKey };
  const DEFAULT_PREFS: Prefs = { search: '', filter: 'all', sort: 'created_desc' };

  let JobDetailPanel = $state<Component<any> | null>(null);
  let jobs = $state<Job[]>([]);
  let summary = $state<JobSummary>({
    total: 0,
    pending: 0,
    in_progress: 0,
    running: 0,
    completed: 0,
    failed: 0,
    stuck: 0
  });

  let initialLoad = $state(true);
  let refreshing = $state(false);
  let loadError = $state<string | null>(null);
  let selectedId = $state<string | null>(null);

  /** IDs whose mutation (cancel/restart) is in flight, so row actions
   *  can show a disabled state and we can avoid double-clicks. */
  let cancellingIds = $state<Set<string>>(new Set());
  let restartingIds = $state<Set<string>>(new Set());

  let jobsPoll: ReturnType<typeof createPollingRefresh> | null = null;

  // Search input + debounce.
  let searchInput = $state(DEFAULT_PREFS.search);
  let debouncedQuery = $state(DEFAULT_PREFS.search);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  let filterKey = $state<StateFilter>(DEFAULT_PREFS.filter);
  let sortKey = $state<SortKey>(DEFAULT_PREFS.sort);
  let prefsHydrated = $state(false);

  const selected = $derived(jobs.find((j) => j.id === selectedId) ?? null);

  // Filter pills (match the brief's All / Running / Pending / Completed /
  // Failed labels, mapped onto the gateway's vocabulary which uses
  // `in_progress` instead of `running`).
  const FILTER_PILLS: Array<{ value: StateFilter; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'in_progress', label: 'Running' },
    { value: 'pending', label: 'Pending' },
    { value: 'completed', label: 'Completed' },
    { value: 'failed', label: 'Failed' }
  ];

  const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
    { value: 'created_desc', label: 'Newest first' },
    { value: 'created_asc', label: 'Oldest first' },
    { value: 'state', label: 'Status' },
    { value: 'title', label: 'Title (A-Z)' }
  ];

  // Hydrate persisted prefs at top level so the initial render reflects
  // saved values (not the defaults). localStorage isn't available in SSR
  // — guarded for defensiveness; this surface is SPA-only inside Tauri.
  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(PREFS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Prefs>;
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.search === 'string') {
            searchInput = parsed.search;
            debouncedQuery = parsed.search;
          }
          const f = parsed.filter;
          if (
            f === 'all' ||
            f === 'in_progress' ||
            f === 'pending' ||
            f === 'completed' ||
            f === 'failed'
          ) {
            filterKey = f;
          }
          const s = parsed.sort;
          if (s === 'created_desc' || s === 'created_asc' || s === 'state' || s === 'title') {
            sortKey = s;
          }
        }
      }
    } catch {
      // Corrupt JSON — fall back to defaults; the next write fixes storage.
    }
    prefsHydrated = true;
  } else {
    prefsHydrated = true;
  }

  function matchesFilter(j: Job): boolean {
    if (filterKey === 'all') return true;
    // `in_progress` is the wire value; also accept the historical alias
    // `running` so a server quirk doesn't filter rows out.
    if (filterKey === 'in_progress') {
      return j.state === 'in_progress' || j.state === 'running';
    }
    return j.state === filterKey;
  }

  function matchesSearch(j: Job, q: string): boolean {
    if (!q) return true;
    const hay = `${j.title} ${j.id}`.toLowerCase();
    return hay.includes(q);
  }

  function tsOrZero(iso?: string): number {
    if (!iso) return 0;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
  }

  function applySort(list: Job[]): Job[] {
    const out = list.slice();
    if (sortKey === 'created_desc') {
      out.sort((a, b) => {
        const cmp = tsOrZero(b.created_at) - tsOrZero(a.created_at);
        if (cmp !== 0) return cmp;
        return a.id.localeCompare(b.id);
      });
    } else if (sortKey === 'created_asc') {
      out.sort((a, b) => {
        const cmp = tsOrZero(a.created_at) - tsOrZero(b.created_at);
        if (cmp !== 0) return cmp;
        return a.id.localeCompare(b.id);
      });
    } else if (sortKey === 'state') {
      out.sort((a, b) => {
        const cmp = a.state.localeCompare(b.state);
        if (cmp !== 0) return cmp;
        return tsOrZero(b.created_at) - tsOrZero(a.created_at);
      });
    } else {
      out.sort((a, b) => {
        const cmp = (a.title || '').localeCompare(b.title || '');
        if (cmp !== 0) return cmp;
        return tsOrZero(b.created_at) - tsOrZero(a.created_at);
      });
    }
    return out;
  }

  const filteredJobs = $derived.by(() => {
    const q = debouncedQuery.trim().toLowerCase();
    return applySort(jobs.filter((j) => matchesFilter(j) && matchesSearch(j, q)));
  });

  const filterActive = $derived(debouncedQuery.trim().length > 0 || filterKey !== 'all');

  // Deep-link target id from `?open=<id>` (set by GlobalSearch R14b /
  // CommandPalette R6η). Captured once on mount. If the job isn't loaded
  // on the first refresh we retry after one silent poll cycle, then give
  // up — either way the URL param is cleared so the deep-link can't
  // re-fire on refresh / Back.
  let pendingOpenId: string | null = null;

  onMount(async () => {
    JobDetailPanel = (await import('./JobDetailPanel.svelte')).default;
    pendingOpenId = page.url.searchParams.get('open');
    void (async () => {
      await refresh();
      if (pendingOpenId && tryOpenPending()) return;
      if (pendingOpenId) {
        // List didn't include the id yet — give the gateway one silent
        // poll's worth of time, then clear the param either way.
        await refresh({ silent: true });
        tryOpenPending();
        clearOpenParam();
      }
    })();
    jobsPoll = createPollingRefresh(() => {
      // Don't refresh the list while the detail panel is open — the panel
      // drives its own SSE-poll for events, and reordering rows under an
      // open panel is jarring. Polling resumes when the panel closes.
      // (Per the brief.)
      if (selectedId !== null) return;
      return refresh({ silent: true });
    }, POLL_INTERVAL_MS);
    jobsPoll.start();

    // Surface refresh (Cmd+R): visible refresh of the job list. Unlike
    // the poll, this fires even with a detail panel open — the user
    // explicitly asked for fresh data, so reorder is acceptable.
    surfaceRefresh.register(async () => {
      await refresh();
    });
  });

  /**
   * If a `?open=<id>` deep-link target is pending and matches a loaded
   * job, open its detail panel and clear the URL param. Returns true
   * when the target was found.
   */
  function tryOpenPending(): boolean {
    if (!pendingOpenId) return false;
    const match = jobs.find((j) => j.id === pendingOpenId);
    if (!match) return false;
    selectedId = match.id;
    pendingOpenId = null;
    clearOpenParam();
    return true;
  }

  /**
   * Strip the `?open=<id>` query param from the URL without triggering a
   * navigation reload. Mirrors the routines page approach.
   */
  function clearOpenParam() {
    if (typeof window === 'undefined') return;
    if (!page.url.searchParams.has('open')) return;
    const url = new URL(page.url);
    url.searchParams.delete('open');
    const target = url.pathname + (url.search ? url.search : '') + url.hash;
    void goto(target, { replaceState: true, noScroll: true, keepFocus: true });
  }

  onDestroy(() => {
    jobsPoll?.stop();
    if (debounceTimer) clearTimeout(debounceTimer);
    surfaceRefresh.unregister();
  });

  // Debounce the search input (250ms — matches /routines, /extensions).
  $effect(() => {
    const v = searchInput;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debouncedQuery = v;
    }, 250);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  });

  // Persist prefs. Guarded on `prefsHydrated` so the first reactive run
  // doesn't clobber storage with defaults during mount.
  $effect(() => {
    if (!prefsHydrated) return;
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
    try {
      const payload: Prefs = {
        search: debouncedQuery,
        filter: filterKey,
        sort: sortKey
      };
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Quota / private-mode: non-fatal.
    }
  });

  async function refresh(opts: { silent?: boolean } = {}): Promise<void> {
    const client = connection.client;
    if (!client) {
      if (!opts.silent) loadError = 'Not connected.';
      initialLoad = false;
      return;
    }
    if (!opts.silent) refreshing = true;
    try {
      const [sum, list] = await Promise.all([client.jobsSummary(), client.listJobs()]);
      summary = sum;
      jobs = list;
      loadError = null;
    } catch (err) {
      loadError = (err as Error).message;
      if (!opts.silent) toasts.show(`Refresh failed: ${loadError}`, 'error');
    } finally {
      refreshing = false;
      initialLoad = false;
    }
  }

  async function onCancel(job: Job, ev: Event): Promise<void> {
    ev.stopPropagation();
    const client = connection.client;
    if (!client || cancellingIds.has(job.id)) return;
    cancellingIds = new Set([...cancellingIds, job.id]);
    try {
      const res = await client.cancelJob(job.id);
      if (!res.ok) throw new Error('Server did not confirm cancel.');
      toasts.show(`Cancelled job ${shortId(job.id)}`, 'success');
      void refresh({ silent: true });
    } catch (err) {
      toasts.show(`Cancel failed: ${(err as Error).message}`, 'error');
    } finally {
      const dropped = new Set(cancellingIds);
      dropped.delete(job.id);
      cancellingIds = dropped;
    }
  }

  async function onRestart(job: Job, ev: Event): Promise<void> {
    ev.stopPropagation();
    const client = connection.client;
    if (!client || restartingIds.has(job.id)) return;
    restartingIds = new Set([...restartingIds, job.id]);
    try {
      const res = await client.restartJob(job.id);
      if (!res.ok) throw new Error('Server did not confirm restart.');
      toasts.show(`Restarted job ${shortId(job.id)}`, 'success');
      void refresh({ silent: true });
    } catch (err) {
      toasts.show(`Restart failed: ${(err as Error).message}`, 'error');
    } finally {
      const dropped = new Set(restartingIds);
      dropped.delete(job.id);
      restartingIds = dropped;
    }
  }

  function openDetail(id: string): void {
    selectedId = id;
  }

  function closeDetail(): void {
    selectedId = null;
  }

  /** When the detail panel reports a mutation we re-fetch the list so
   *  state badges + summary counters reflect reality. The panel only
   *  fires this after a successful cancel/restart. */
  function onDetailMutation(): void {
    void refresh({ silent: true });
  }

  function clearFilters(): void {
    searchInput = '';
    debouncedQuery = '';
    filterKey = 'all';
  }

  function shortId(id: string): string {
    return id.length > 12 ? `${id.slice(0, 8)}…` : id;
  }

  function stateBadgeClass(state: string): string {
    switch (state) {
      case 'completed':
        return 'bg-green-500/10 text-green-400 border-green-500/30';
      case 'failed':
        return 'bg-red-500/10 text-red-400 border-red-500/30';
      case 'cancelled':
        return 'bg-text-muted/10 text-text-muted border-text-muted/30';
      case 'in_progress':
      case 'running':
        return 'bg-accent-gold/10 text-accent-gold border-accent-gold/30';
      case 'stuck':
        return 'bg-orange-500/10 text-orange-400 border-orange-500/30';
      case 'pending':
      default:
        return 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30';
    }
  }

  function isRunning(state: string): boolean {
    return state === 'in_progress' || state === 'running' || state === 'pending';
  }

  function isFailedish(state: string): boolean {
    return state === 'failed' || state === 'stuck' || state === 'cancelled';
  }
</script>

<section class="p-8 h-full flex flex-col">
  <header class="mb-6 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold text-text-primary">Jobs</h1>
      <p class="text-text-muted text-sm mt-1">
        Background jobs from tool calls, skill runs, and scheduled routines.
      </p>
    </div>
    {#if connection.status === 'connected'}
      <button
        type="button"
        onclick={() => void refresh()}
        disabled={refreshing}
        class="flex items-center gap-2 px-3 py-2 rounded-md border border-border-subtle text-xs text-text-muted hover:border-accent-cyan hover:text-accent-cyan transition-colors disabled:opacity-50 min-h-[36px]"
      >
        <svg
          viewBox="0 0 24 24"
          class="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class:animate-spin={refreshing}
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    {/if}
  </header>

  {#if connection.status !== 'connected'}
    <!-- Disconnected guard. -->
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
    <!-- Summary strip. Mirrors routines' five-card layout: Total, Running,
         Pending, Completed, Failed. The brief asked for these five. -->
    <div class="grid grid-cols-5 gap-3 mb-6">
      <div class="surface p-4">
        <div class="text-3xl font-bold text-accent-cyan leading-none">{summary.total}</div>
        <div class="text-xs text-text-muted mt-2 uppercase tracking-wide">Total</div>
      </div>
      <div class="surface p-4">
        <div class="text-3xl font-bold text-accent-gold leading-none">{summary.in_progress}</div>
        <div class="text-xs text-text-muted mt-2 uppercase tracking-wide">Running</div>
      </div>
      <div class="surface p-4">
        <div class="text-3xl font-bold text-accent-cyan leading-none">{summary.pending}</div>
        <div class="text-xs text-text-muted mt-2 uppercase tracking-wide">Pending</div>
      </div>
      <div class="surface p-4">
        <div class="text-3xl font-bold text-green-400 leading-none">{summary.completed}</div>
        <div class="text-xs text-text-muted mt-2 uppercase tracking-wide">Completed</div>
      </div>
      <div class="surface p-4">
        <div
          class="text-3xl font-bold leading-none"
          class:text-red-400={summary.failed > 0 || summary.stuck > 0}
          class:text-text-muted={summary.failed === 0 && summary.stuck === 0}
        >
          {summary.failed + summary.stuck}
        </div>
        <div class="text-xs text-text-muted mt-2 uppercase tracking-wide">
          Failed{summary.stuck > 0 ? ` (${summary.stuck} stuck)` : ''}
        </div>
      </div>
    </div>

    <!-- Filter pills + search + sort. Same shape as /routines so muscle
         memory transfers. -->
    <div class="mb-4 flex flex-col gap-3">
      <div
        class="flex flex-wrap items-center gap-1.5"
        role="radiogroup"
        aria-label="Filter jobs by state"
      >
        {#each FILTER_PILLS as pill (pill.value)}
          {@const isSelected = filterKey === pill.value}
          <button
            type="button"
            role="radio"
            aria-checked={isSelected}
            onclick={() => (filterKey = pill.value)}
            class="px-3 py-1 rounded-full text-xs font-medium border transition"
            class:bg-accent-cyan={isSelected}
            class:text-bg-deep={isSelected}
            class:border-accent-cyan={isSelected}
            class:bg-bg-deep={!isSelected}
            class:text-text-muted={!isSelected}
            class:border-border-subtle={!isSelected}
            class:hover:text-text-primary={!isSelected}
            class:hover:border-accent-cyan={!isSelected}
          >
            {pill.label}
          </button>
        {/each}
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <div class="relative flex-1 min-w-[200px] max-w-md">
          <span
            class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-muted"
          >
            <svg
              viewBox="0 0 24 24"
              class="w-4 h-4"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <input
            type="search"
            bind:value={searchInput}
            placeholder="Search title or id…"
            aria-label="Search jobs by title or id"
            class="w-full bg-bg-deep border border-border-subtle rounded-md pl-10 pr-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors min-h-[40px]"
          />
        </div>
        <label class="flex items-center gap-2 text-xs text-text-muted">
          <span class="shrink-0">Sort</span>
          <select
            bind:value={sortKey}
            aria-label="Sort jobs"
            class="bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-cyan transition-colors min-h-[40px]"
          >
            {#each SORT_OPTIONS as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </label>
      </div>

      {#if filterActive}
        <div class="flex items-center justify-between gap-3 text-xs text-text-muted">
          <span>
            <span class="text-text-primary font-semibold">{filteredJobs.length}</span>
            of <span class="text-text-primary">{jobs.length}</span>
            {filteredJobs.length === 1 ? 'job' : 'jobs'}
          </span>
          <button
            type="button"
            onclick={clearFilters}
            class="text-accent-cyan underline decoration-dotted hover:decoration-solid"
          >
            Clear filters
          </button>
        </div>
      {/if}
    </div>

    <!-- Main panel -->
    <div class="surface flex-1 overflow-hidden flex flex-col">
      {#if initialLoad && jobs.length === 0 && !loadError}
        <div class="flex-1 flex items-center justify-center text-text-muted text-sm">
          Loading jobs…
        </div>
      {:else if loadError && jobs.length === 0}
        <div class="flex-1 flex flex-col items-center justify-center gap-2 p-8">
          <div class="text-sm text-red-400">Failed to load jobs</div>
          <div class="text-xs text-text-muted font-mono">{loadError}</div>
          <button
            type="button"
            onclick={() => void refresh()}
            class="mt-3 px-3 py-1.5 rounded-md border border-accent-cyan text-accent-cyan text-xs hover:bg-accent-cyan hover:text-bg-deep transition-colors"
          >
            Retry
          </button>
        </div>
      {:else if jobs.length === 0}
        <div class="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
          <svg
            viewBox="0 0 24 24"
            class="w-10 h-10 text-text-muted"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="3" width="18" height="4" rx="1" />
            <rect x="3" y="10" width="18" height="4" rx="1" />
            <rect x="3" y="17" width="18" height="4" rx="1" />
          </svg>
          <div class="text-sm text-text-primary">No jobs running</div>
          <div class="text-xs text-text-muted max-w-md">
            Tool calls, skill runs, and routines appear here when IronClaw starts work.
          </div>
        </div>
      {:else if filteredJobs.length === 0}
        <div class="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
          <div class="text-sm text-text-primary">No jobs match the filters</div>
          <button
            type="button"
            onclick={clearFilters}
            class="mt-1 px-3 py-1.5 rounded-md border border-accent-cyan text-accent-cyan text-xs hover:bg-accent-cyan hover:text-bg-deep transition-colors"
          >
            Clear filters
          </button>
        </div>
      {:else}
        <div class="overflow-auto">
          <table class="w-full text-sm">
            <thead class="sticky top-0 bg-bg-surface z-10">
              <tr class="text-left text-text-muted border-b border-border-subtle">
                <th class="font-medium px-4 py-3 w-32">ID</th>
                <th class="font-medium px-4 py-3">Title</th>
                <th class="font-medium px-4 py-3 w-32">Status</th>
                <th class="font-medium px-4 py-3 w-32">Created</th>
                <th class="font-medium px-4 py-3 w-40 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {#each filteredJobs as job (job.id)}
                {@const isSelected = selectedId === job.id}
                {@const cancelling = cancellingIds.has(job.id)}
                {@const restarting = restartingIds.has(job.id)}
                <tr
                  class="border-b border-border-subtle/40 transition-colors cursor-pointer"
                  class:bg-bg-deep={isSelected}
                  class:hover:bg-bg-deep={!isSelected}
                  onclick={() => openDetail(job.id)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openDetail(job.id);
                    }
                  }}
                  tabindex="0"
                  aria-label="Open job {shortId(job.id)}"
                >
                  <td class="px-4 py-3 text-text-muted font-mono text-xs">
                    {shortId(job.id)}
                  </td>
                  <td class="px-4 py-3 text-text-primary truncate max-w-md" title={job.title}>
                    {job.title || '—'}
                  </td>
                  <td class="px-4 py-3">
                    <span
                      class="inline-block px-2 py-0.5 rounded text-[10px] uppercase tracking-wide border font-medium {stateBadgeClass(
                        job.state
                      )}"
                    >
                      {job.state}
                    </span>
                  </td>
                  <td class="px-4 py-3 text-text-muted text-xs">
                    {relativeTime(job.created_at)}
                  </td>
                  <td class="px-4 py-3">
                    <div class="flex items-center justify-end gap-1">
                      {#if isRunning(job.state)}
                        <button
                          type="button"
                          onclick={(e) => void onCancel(job, e)}
                          disabled={cancelling}
                          title="Cancel job"
                          aria-label="Cancel {shortId(job.id)}"
                          class="p-2 rounded-md text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent min-h-[36px] min-w-[36px] flex items-center justify-center"
                        >
                          <svg
                            viewBox="0 0 24 24"
                            class="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <circle cx="12" cy="12" r="10" />
                            <line x1="15" y1="9" x2="9" y2="15" />
                            <line x1="9" y1="9" x2="15" y2="15" />
                          </svg>
                        </button>
                      {/if}
                      {#if isFailedish(job.state)}
                        <button
                          type="button"
                          onclick={(e) => void onRestart(job, e)}
                          disabled={restarting}
                          title="Restart job"
                          aria-label="Restart {shortId(job.id)}"
                          class="p-2 rounded-md text-accent-cyan hover:bg-accent-cyan/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent min-h-[36px] min-w-[36px] flex items-center justify-center"
                        >
                          <svg
                            viewBox="0 0 24 24"
                            class="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <polyline points="23 4 23 10 17 10" />
                            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
                          </svg>
                        </button>
                      {/if}
                      <button
                        type="button"
                        onclick={(e) => {
                          e.stopPropagation();
                          openDetail(job.id);
                        }}
                        title="View detail"
                        aria-label="View {shortId(job.id)}"
                        class="p-2 rounded-md text-accent-cyan hover:bg-accent-cyan/10 transition-colors min-h-[36px] min-w-[36px] flex items-center justify-center"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          class="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <line x1="5" y1="12" x2="19" y2="12" />
                          <polyline points="12 5 19 12 12 19" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</section>

{#if selected}
  <JobDetailPanel job={selected} onclose={closeDetail} onmutation={onDetailMutation} />
{/if}
