<script lang="ts">
  // Tool-policy editor (per-user 3-state permissions).
  //
  // Wire: `GET /api/settings/tools` returns one row per tool with
  // `current_state` ∈ {ask_each_time, always_allow, disabled}, plus a
  // `default_state`, a per-tool `locked` boolean, and a `locked_reason`.
  // Writes go through `PUT /api/settings/tools/:name` (one tool at a time)
  // via `client.setToolPermission`. The previous admin-global
  // `getToolPolicy`/`setToolPolicy` surface was a pure deny-list; this
  // editor now reads/writes the richer per-tool state instead.
  //
  // Locked tools (`locked: true`, e.g. `file_undo`, `pairing_approve`)
  // CAN be set to `ask_each_time` or `disabled`, but cannot be escalated
  // to `always_allow` — the wire rejects with 400. The UI guards by
  // graying the `always_allow` radio for locked rows. Bulk actions skip
  // locked rows entirely (because "allow all" can't escalate them and
  // "deny all" would lock the user out of their own approval flow).
  //
  // UX surface (admin prefs):
  //   - Debounced search input (250ms) over name + description.
  //   - Filter pills: All / Ask each time / Always allow / Disabled /
  //     Locked. Persists in localStorage `ironclaw-admin-prefs`.
  //   - Bulk Allow / Deny / Reset operate on visible rows when a filter
  //     is active; confirm dialog kicks in above 5 rows.
  //
  // Dirty tracking: changes are local until Save. Save iterates each
  // changed tool sequentially through `setToolPermission` to avoid
  // hammering the server (and to surface per-tool failures clearly).
  // Discard restores from the last server snapshot.

  import { onMount } from 'svelte';
  import { connection } from '$lib/stores/connection.svelte';
  import { confirmDialog } from '$lib/stores/confirm.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import type { ToolPermission, ToolPermissionEntry } from '$lib/api/types';

  type LoadState = 'idle' | 'loading' | 'loaded' | 'error';
  type SaveState = 'idle' | 'saving' | 'saved' | 'error';

  // The three writable states. `'locked'` shows up in the union for
  // forward-compat but isn't a valid write value — the API maps it to
  // `'disabled'` for us, but we never emit it from the UI.
  type WritableState = 'ask_each_time' | 'always_allow' | 'disabled';

  // Segmented-radio options. Lives at script scope so the inner `{#each}`
  // can iterate it directly without an in-template `{@const}`.
  type RadioOption = {
    v: WritableState;
    label: string;
    tint: 'gold' | 'green' | 'red';
  };
  const RADIO_OPTIONS: RadioOption[] = [
    { v: 'ask_each_time', label: 'Ask each time', tint: 'gold' },
    { v: 'always_allow', label: 'Always allow', tint: 'green' },
    { v: 'disabled', label: 'Disabled', tint: 'red' }
  ];

  // Filter pill domain. `'all'` short-circuits; `'locked'` selects only
  // locked rows (independent of state); the rest narrow to a single
  // state. Kept as a union so the loop below is type-checked against
  // the same shape as `stateFilter`.
  type StateFilter = 'all' | WritableState | 'locked';
  type FilterPill = { v: StateFilter; label: string };
  const FILTER_PILLS: FilterPill[] = [
    { v: 'all', label: 'All' },
    { v: 'ask_each_time', label: 'Ask each time' },
    { v: 'always_allow', label: 'Always allow' },
    { v: 'disabled', label: 'Disabled' },
    { v: 'locked', label: 'Locked' }
  ];

  // Shared localStorage key for the admin route. The system-prompt
  // editor uses its own keys; this one stores tool-policy preferences.
  // Bumped to `v2` to avoid colliding with the old 3-state filter shape
  // (the previous editor used `allow`/`prompt`/`deny` values, which would
  // now hydrate as an unknown filter and silently fall through to `all`
  // — bumping is cleaner than a migration).
  const LS_KEY = 'ironclaw-admin-prefs-v2';
  type PersistedPrefs = {
    search?: string;
    stateFilter?: StateFilter;
  };

  let loadState = $state<LoadState>('idle');
  let loadError = $state<string | null>(null);

  let saveState = $state<SaveState>('idle');
  let saveError = $state<string | null>(null);

  // Hydrated from the server. `serverEntries` is the snapshot used for
  // dirty-checking; `draftStates` is the working draft keyed by tool name.
  // We keep the rich `ToolPermissionEntry` rows separately from the
  // per-tool state map so the UI doesn't lose lock/description metadata
  // when the user flips a radio.
  let serverEntries = $state<ToolPermissionEntry[]>([]);
  let draftStates = $state<Record<string, WritableState>>({});

  // Live input bound to the search field. `debouncedSearch` lags 250ms
  // behind to avoid re-deriving the filtered list on every keystroke.
  let searchInput = $state('');
  let debouncedSearch = $state('');
  let stateFilter = $state<StateFilter>('all');

  // Forbidden trigger: the route owns the 403 banner, but we also
  // surface the message inline if the load itself returned forbidden.
  let forbidden = $state(false);

  const isDisconnected = $derived(
    connection.status === 'disconnected' || connection.status === 'idle' || !connection.client
  );

  // Normalize a wire state to one of the three writable values. Anything
  // unexpected (including the forward-compat `'locked'` alias) collapses
  // to `ask_each_time` — the safest default.
  function toWritable(s: ToolPermission | undefined): WritableState {
    if (s === 'always_allow' || s === 'disabled' || s === 'ask_each_time') {
      return s;
    }
    return 'ask_each_time';
  }

  // Build display rows by joining the server entries with the draft
  // state. Each row keeps its lock metadata for the row UI; the radio
  // reads `state` from the draft.
  type Row = {
    name: string;
    description: string;
    state: WritableState;
    defaultState: WritableState;
    locked: boolean;
    lockedReason: string;
  };

  const allRows = $derived.by<Row[]>(() => {
    return serverEntries.map((e) => ({
      name: e.name,
      description: e.description ?? '',
      state: draftStates[e.name] ?? toWritable(e.permission),
      defaultState: toWritable(e.default_state),
      locked: e.locked === true,
      lockedReason: e.locked_reason ?? ''
    }));
  });

  // Filtered view = search query AND state filter.
  const filteredRows = $derived.by<Row[]>(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return allRows.filter((r) => {
      if (stateFilter === 'locked') {
        if (!r.locked) return false;
      } else if (stateFilter !== 'all') {
        if (r.state !== stateFilter) return false;
      }
      if (!q) return true;
      const hay = `${r.name} ${r.description}`.toLowerCase();
      return hay.includes(q);
    });
  });

  const filterActive = $derived(stateFilter !== 'all' || debouncedSearch.trim().length > 0);

  // Dirty whenever any draft state diverges from the server snapshot.
  // We compare per-tool rather than a serialized projection so the count
  // of changed tools is cheap to derive (used in the Save button label).
  const changedNames = $derived.by<string[]>(() => {
    const out: string[] = [];
    for (const e of serverEntries) {
      const server = toWritable(e.permission);
      const draft = draftStates[e.name] ?? server;
      if (draft !== server) out.push(e.name);
    }
    return out;
  });
  const dirty = $derived(changedNames.length > 0);

  // ---- Lifecycle --------------------------------------------------------

  onMount(() => {
    hydratePrefs();
    void load();
  });

  // Debounce: every keystroke resets a 250ms timer; the timer's payload
  // promotes `searchInput` into `debouncedSearch` (which the filter reads).
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const next = searchInput;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debouncedSearch = next;
      persistPrefs();
    }, 250);
  });

  function isValidStateFilter(v: unknown): v is StateFilter {
    return (
      v === 'all' ||
      v === 'ask_each_time' ||
      v === 'always_allow' ||
      v === 'disabled' ||
      v === 'locked'
    );
  }

  function hydratePrefs() {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PersistedPrefs;
      if (typeof parsed.search === 'string') {
        searchInput = parsed.search;
        debouncedSearch = parsed.search;
      }
      if (isValidStateFilter(parsed.stateFilter)) {
        stateFilter = parsed.stateFilter;
      }
    } catch {
      // Corrupt prefs are non-fatal; the editor opens with defaults.
    }
  }

  function persistPrefs() {
    if (typeof window === 'undefined') return;
    try {
      const payload: PersistedPrefs = {
        search: debouncedSearch,
        stateFilter
      };
      window.localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch {
      // Storage may be full or disabled; ignore.
    }
  }

  async function load() {
    const client = connection.client;
    if (!client) {
      loadState = 'idle';
      return;
    }
    loadState = 'loading';
    loadError = null;
    forbidden = false;
    try {
      const entries = await client.listToolPermissions();
      serverEntries = entries;
      // Reset the draft to match the server. We seed an empty map and
      // let `allRows` fall back to the server permission when a name
      // isn't in the draft — that keeps the dirty check cheap.
      draftStates = {};
      loadState = 'loaded';
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) {
        forbidden = true;
        loadError =
          "This profile's token doesn't have admin role. Switch profile or use a token with admin permission.";
      } else if (status === 404) {
        loadError =
          'Per-tool permissions are not exposed by this gateway. Update IronClaw to ≥0.28.';
      } else {
        loadError = (err as Error).message;
      }
      loadState = 'error';
    }
  }

  // ---- Actions ----------------------------------------------------------

  function setState(name: string, next: WritableState) {
    // Find the row to enforce the locked → always_allow guard. The wire
    // would reject this with a 400 anyway; client-side guarding just
    // avoids the round-trip and keeps the UI consistent.
    const row = allRows.find((r) => r.name === name);
    if (row?.locked && next === 'always_allow') {
      toasts.show(`"${name}" is locked and cannot be set to always_allow.`, 'error');
      return;
    }
    draftStates = { ...draftStates, [name]: next };
  }

  function setStateFilter(v: StateFilter) {
    stateFilter = v;
    persistPrefs();
  }

  function clearFilters() {
    searchInput = '';
    debouncedSearch = '';
    stateFilter = 'all';
    persistPrefs();
  }

  // Bulk helpers respect the active filter and ALWAYS skip locked rows.
  // For `always_allow` the server would reject locked tools anyway; for
  // `disabled` we skip too, because locking is a server-side opinion
  // ("this tool always requires approval") that disabling would
  // undermine (the user wouldn't see the prompt at all).
  async function bulkApply(next: WritableState, verb: string) {
    const scope = filterActive ? filteredRows : allRows;
    const target = scope.filter((r) => !r.locked);
    const skipped = scope.length - target.length;
    if (target.length === 0) {
      toasts.show(
        skipped > 0
          ? `Only locked tools in scope; nothing to ${verb.toLowerCase()}.`
          : 'No tools match the filter',
        'info'
      );
      return;
    }
    if (target.length > 5) {
      const suffix =
        skipped > 0 ? ` (${skipped} locked tool${skipped === 1 ? '' : 's'} will be skipped.)` : '';
      const ok = await confirmDialog.ask({
        title: `${verb} ${target.length} tool${target.length === 1 ? '' : 's'}?`,
        body: `This will ${verb.toLowerCase()} every unlocked tool in the current ${filterActive ? 'filtered' : 'visible'} scope.${suffix}`,
        confirmLabel: `${verb} tools`,
        cancelLabel: 'Keep current policy',
        tone: next === 'disabled' ? 'danger' : 'default'
      });
      if (!ok) return;
    }
    const nextDraft: Record<string, WritableState> = { ...draftStates };
    for (const r of target) nextDraft[r.name] = next;
    draftStates = nextDraft;
    if (skipped > 0) {
      toasts.show(`Skipped ${skipped} locked tool${skipped === 1 ? '' : 's'}.`, 'info');
    }
  }

  function bulkAllow() {
    void bulkApply('always_allow', 'Allow');
  }

  function bulkDeny() {
    void bulkApply('disabled', 'Disable');
  }

  async function bulkReset() {
    // Reset each in-scope tool to its OWN `default_state` — different
    // tools have different defaults, so we don't collapse to a single
    // value here. Locked tools get reset too (the wire allows resetting
    // them as long as their default isn't `always_allow`, which it
    // shouldn't be — the lock implies a non-escalated default).
    const scope = filterActive ? filteredRows : allRows;
    if (scope.length === 0) {
      toasts.show('No tools match the filter', 'info');
      return;
    }
    if (scope.length > 5) {
      const ok = await confirmDialog.ask({
        title: `Reset ${scope.length} tool${scope.length === 1 ? '' : 's'} to default?`,
        body: `Resets every tool in the ${filterActive ? 'filtered' : 'visible'} scope to its gateway default.`,
        confirmLabel: 'Reset tools',
        cancelLabel: 'Keep current policy',
        tone: 'danger'
      });
      if (!ok) return;
    }
    const nextDraft: Record<string, WritableState> = { ...draftStates };
    for (const r of scope) {
      // Defensive: never reset a locked tool to always_allow even if the
      // server somehow claims that as the default — the write would 400.
      const def = r.locked && r.defaultState === 'always_allow' ? 'ask_each_time' : r.defaultState;
      nextDraft[r.name] = def;
    }
    draftStates = nextDraft;
  }

  function discard() {
    draftStates = {};
    saveState = 'idle';
    saveError = null;
  }

  async function save() {
    const client = connection.client;
    if (!client) return;
    if (changedNames.length === 0) return;
    saveState = 'saving';
    saveError = null;
    const failures: string[] = [];
    // Sequential: hitting `PUT /api/settings/tools/:name` once per
    // change avoids hammering the gateway and lets us surface
    // per-tool failures (e.g. a 400 on a locked-tool escalation that
    // slipped past the client-side guard).
    for (const name of changedNames) {
      const next = draftStates[name];
      if (!next) continue;
      const res = await client.setToolPermission(name, next);
      if (!res.ok) failures.push(name);
    }
    // Re-fetch so the UI shows the canonical server state — partial
    // success leaves a mixed draft that's easiest to reconcile by
    // pulling fresh data.
    try {
      const entries = await client.listToolPermissions();
      serverEntries = entries;
      draftStates = {};
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) {
        forbidden = true;
        saveError =
          "This profile's token doesn't have admin role. Switch profile or use a token with admin permission.";
      } else {
        saveError = (err as Error).message;
      }
      saveState = 'error';
      toasts.show(`Save reload failed: ${saveError}`, 'error');
      return;
    }
    if (failures.length === 0) {
      saveState = 'saved';
      toasts.show(
        `Saved ${changedNames.length} tool${changedNames.length === 1 ? '' : 's'}.`,
        'success'
      );
    } else {
      saveState = 'error';
      saveError = `Failed: ${failures.join(', ')}`;
      toasts.show(
        `${failures.length} of ${changedNames.length} tool${changedNames.length === 1 ? '' : 's'} failed to save.`,
        'error'
      );
    }
  }

  // ---- Counts (footer) --------------------------------------------------

  const counts = $derived.by(() => {
    let ask = 0,
      allow = 0,
      disabled = 0,
      locked = 0;
    for (const r of allRows) {
      if (r.state === 'always_allow') allow++;
      else if (r.state === 'disabled') disabled++;
      else ask++;
      if (r.locked) locked++;
    }
    return { ask, allow, disabled, locked, total: allRows.length };
  });

  // ---- Style helpers ----------------------------------------------------

  // Per-state classes. Kept as functions (not inline ternaries) because
  // the table row uses them in three places (border, badge, radio) and
  // re-deriving inline would balloon the markup.
  function rowBorderClass(state: WritableState): string {
    if (state === 'always_allow') return 'border-l-green-500/60';
    if (state === 'disabled') return 'border-l-red-500/60';
    return 'border-l-accent-gold/60';
  }

  function badgeClass(state: WritableState): string {
    if (state === 'always_allow') {
      return 'bg-green-500/15 text-green-400 border-green-500/40';
    }
    if (state === 'disabled') {
      return 'bg-red-500/15 text-red-400 border-red-500/40';
    }
    return 'bg-accent-gold/15 text-accent-gold border-accent-gold/40';
  }

  function badgeLabel(state: WritableState): string {
    if (state === 'always_allow') return 'Always allow';
    if (state === 'disabled') return 'Disabled';
    return 'Ask each time';
  }

  function pillActiveClass(v: StateFilter): string {
    if (v === 'always_allow') {
      return 'bg-green-500 text-bg-deep border-green-500';
    }
    if (v === 'ask_each_time') {
      return 'bg-accent-gold text-bg-deep border-accent-gold';
    }
    if (v === 'disabled') return 'bg-red-500 text-white border-red-500';
    if (v === 'locked') {
      return 'bg-text-muted text-bg-deep border-text-muted';
    }
    return 'bg-accent-cyan text-bg-deep border-accent-cyan';
  }
</script>

<div class="flex flex-col flex-1 min-h-0">
  {#if isDisconnected}
    <div class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]">
      <div class="text-sm text-text-primary mb-2">IronClaw is offline</div>
      <div class="text-xs text-text-muted">
        Configure the connection in
        <a
          href="/settings"
          class="text-accent-cyan underline decoration-dotted hover:decoration-solid">Settings</a
        >.
      </div>
    </div>
  {:else if loadState === 'loading'}
    <div class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]">
      <div class="text-sm text-text-muted">Loading tool permissions…</div>
    </div>
  {:else if loadState === 'error'}
    <div class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]">
      <div class="text-sm text-red-400 mb-2">
        {forbidden ? 'Admin permission required' : 'Failed to load tool permissions'}
      </div>
      <div class="text-xs text-text-muted font-mono mb-4 max-w-md break-words">
        {loadError ?? 'Unknown error'}
      </div>
      {#if !forbidden}
        <button
          type="button"
          onclick={() => void load()}
          class="px-4 py-2 rounded-md border border-accent-cyan text-accent-cyan text-sm font-semibold hover:bg-accent-cyan hover:text-bg-deep transition min-h-[40px]"
        >
          Retry
        </button>
      {/if}
    </div>
  {:else}
    <!-- Bulk actions + search + filter pills. Bulk buttons silently
         change scope when a filter is active — copy + confirm dialog
         make that explicit. Locked tools are skipped on Allow/Deny
         regardless of filter. -->
    <div class="surface p-4 mb-4 flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex items-center gap-2">
          <button
            type="button"
            onclick={bulkAllow}
            class="px-3 py-1.5 rounded-md border border-border-subtle text-xs text-text-primary hover:border-green-500 hover:text-green-400 transition min-h-[32px]"
            title={filterActive
              ? `Always-allow the ${filteredRows.length} filtered tools (locked tools skipped)`
              : 'Always-allow every tool (locked tools skipped)'}
          >
            {filterActive ? `Allow filtered (${filteredRows.length})` : 'Allow all'}
          </button>
          <button
            type="button"
            onclick={bulkDeny}
            class="px-3 py-1.5 rounded-md border border-border-subtle text-xs text-text-primary hover:border-red-500 hover:text-red-400 transition min-h-[32px]"
            title={filterActive
              ? `Disable the ${filteredRows.length} filtered tools (locked tools skipped)`
              : 'Disable every tool (locked tools skipped)'}
          >
            {filterActive ? `Deny filtered (${filteredRows.length})` : 'Deny all'}
          </button>
          <button
            type="button"
            onclick={() => void bulkReset()}
            class="px-3 py-1.5 rounded-md border border-border-subtle text-xs text-text-primary hover:border-accent-gold hover:text-accent-gold transition min-h-[32px]"
            title={filterActive
              ? `Reset the ${filteredRows.length} filtered tools to their default state`
              : 'Reset every tool to its default state'}
          >
            {filterActive ? `Reset filtered (${filteredRows.length})` : 'Reset to default'}
          </button>
        </div>

        <div class="flex-1 min-w-[200px] relative max-w-md ml-auto">
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
            placeholder="Search name + description…"
            class="w-full bg-bg-deep border border-border-subtle rounded-md pl-10 pr-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors min-h-[36px]"
            aria-label="Filter tools"
          />
        </div>
      </div>

      <!-- State filter pills. Pill tints mirror the radio tints used in
           each row so the connection is visual, not just labeled. The
           "Locked" pill uses a neutral muted tint because it's an axis,
           not a state. -->
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[10px] uppercase tracking-wider text-text-muted mr-1">Filter</span>
        {#each FILTER_PILLS as pill (pill.v)}
          {@const active = stateFilter === pill.v}
          <button
            type="button"
            onclick={() => setStateFilter(pill.v)}
            class="px-2.5 py-1 rounded-full text-[11px] font-semibold border transition min-h-[28px] {active
              ? pillActiveClass(pill.v)
              : 'border-border-subtle text-text-muted hover:text-text-primary hover:border-text-muted'}"
          >
            {pill.label}
          </button>
        {/each}
        {#if filterActive}
          <button
            type="button"
            onclick={clearFilters}
            class="ml-auto text-[11px] text-text-muted hover:text-accent-gold transition"
            title="Clear search and filter"
          >
            Clear filters
          </button>
        {/if}
      </div>
    </div>

    <!-- Counts strip. When any filter is active we surface "N of M tools"
         so the operator sees the subset size at a glance. Locked count
         is informational only — it overlaps with the state buckets. -->
    <div class="flex items-center gap-4 text-[11px] text-text-muted font-mono mb-2 px-1">
      <span>
        <span class="inline-block w-2 h-2 rounded-full bg-accent-gold mr-1.5 align-middle"></span>
        Ask <span class="text-text-primary">{counts.ask}</span>
      </span>
      <span>
        <span class="inline-block w-2 h-2 rounded-full bg-green-500 mr-1.5 align-middle"></span>
        Allow <span class="text-text-primary">{counts.allow}</span>
      </span>
      <span>
        <span class="inline-block w-2 h-2 rounded-full bg-red-500 mr-1.5 align-middle"></span>
        Disabled <span class="text-text-primary">{counts.disabled}</span>
      </span>
      <span>
        <span class="inline-block w-2 h-2 rounded-full bg-text-muted mr-1.5 align-middle"></span>
        Locked <span class="text-text-primary">{counts.locked}</span>
      </span>
      <span class="ml-auto">
        {#if filterActive}
          <span class="text-accent-cyan">{filteredRows.length} of {counts.total} tools</span>
        {:else}
          Showing {filteredRows.length} of {counts.total}
        {/if}
      </span>
    </div>

    <!-- Table. CSS grid so columns line up without table semantics.
         Header row sticks to the top of the scroll area for long
         catalogs. Wider right column to fit the status badge + the
         three-button radio. -->
    <div class="flex-1 min-h-0 overflow-auto surface">
      {#if filteredRows.length === 0}
        <div class="p-10 text-center text-xs text-text-muted">
          {filterActive ? 'No tools match the filter' : 'No tools available'}
        </div>
      {:else}
        <div
          class="grid grid-cols-[1fr_140px_320px] sticky top-0 bg-bg-surface border-b border-border-subtle px-4 py-2 text-[10px] uppercase tracking-wider text-text-muted z-10"
        >
          <div>Tool</div>
          <div>Status</div>
          <div class="text-right">Permission</div>
        </div>
        <div>
          {#each filteredRows as row (row.name)}
            <div
              class="grid grid-cols-[1fr_140px_320px] items-center gap-4 px-4 py-2.5 border-b border-border-subtle/60 border-l-2 transition-colors {rowBorderClass(
                row.state
              )} {row.locked
                ? 'bg-red-500/5 opacity-80 hover:opacity-100 hover:bg-red-500/10'
                : 'hover:bg-bg-deep/40'}"
            >
              <div class="min-w-0">
                <div class="flex items-baseline gap-2">
                  <code class="text-sm font-mono text-text-primary truncate">{row.name}</code>
                  {#if row.locked}
                    <span
                      class="shrink-0 inline-flex items-center text-red-400"
                      title={row.lockedReason || 'This tool cannot be set to always_allow.'}
                      aria-label="Locked: {row.lockedReason ||
                        'This tool cannot be set to always_allow.'}"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        class="w-3.5 h-3.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    </span>
                  {/if}
                </div>
                {#if row.description}
                  <div class="text-xs text-text-muted truncate mt-0.5" title={row.description}>
                    {row.description}
                  </div>
                {/if}
                {#if row.locked && row.lockedReason}
                  <div class="text-[10px] text-red-400/80 mt-0.5 truncate" title={row.lockedReason}>
                    {row.lockedReason}
                  </div>
                {/if}
              </div>

              <div>
                <span
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border {badgeClass(
                    row.state
                  )}"
                >
                  {badgeLabel(row.state)}
                </span>
              </div>

              <div class="flex items-center justify-end gap-1">
                <!-- Three-way radio rendered as segmented buttons. Locked
                     rows get the always_allow option grayed out (and
                     the whole row visually dimmed); the other two
                     remain interactive. -->
                {#each RADIO_OPTIONS as opt (opt.v)}
                  {@const active = row.state === opt.v}
                  {@const disabledForLock = row.locked && opt.v === 'always_allow'}
                  <button
                    type="button"
                    onclick={() => setState(row.name, opt.v)}
                    disabled={disabledForLock}
                    title={disabledForLock
                      ? row.lockedReason || 'This tool cannot be set to always_allow.'
                      : opt.label}
                    class="px-2.5 py-1 rounded text-[11px] font-semibold transition min-h-[28px] border disabled:cursor-not-allowed disabled:opacity-30"
                    class:bg-green-500={active && opt.tint === 'green'}
                    class:text-bg-deep={active && (opt.tint === 'green' || opt.tint === 'gold')}
                    class:bg-accent-gold={active && opt.tint === 'gold'}
                    class:bg-red-500={active && opt.tint === 'red'}
                    class:text-white={active && opt.tint === 'red'}
                    class:border-green-500={active && opt.tint === 'green'}
                    class:border-accent-gold={active && opt.tint === 'gold'}
                    class:border-red-500={active && opt.tint === 'red'}
                    class:border-border-subtle={!active}
                    class:text-text-muted={!active}
                    class:hover:text-text-primary={!active && !disabledForLock}
                    class:hover:border-text-muted={!active && !disabledForLock}
                  >
                    {opt.label}
                  </button>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Save/Discard bar. The label calls out the changed-tool count so
         the operator knows what they're about to send. -->
    <div class="mt-4 flex items-center justify-between gap-3">
      <div class="text-xs text-text-muted">
        {#if dirty}
          <span class="text-accent-gold"
            >{changedNames.length} unsaved change{changedNames.length === 1 ? '' : 's'}.</span
          >
        {:else if saveState === 'saved'}
          <span class="text-accent-cyan">Saved.</span>
        {:else if saveState === 'error' && saveError}
          <span class="text-red-400">{saveError}</span>
        {:else}
          <span>Up to date with the server.</span>
        {/if}
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick={discard}
          disabled={!dirty || saveState === 'saving'}
          class="px-4 py-2 rounded-md border border-border-subtle text-sm text-text-primary hover:border-accent-gold hover:text-accent-gold transition disabled:opacity-30 disabled:hover:border-border-subtle disabled:hover:text-text-primary min-h-[40px]"
        >
          Discard
        </button>
        <button
          type="button"
          onclick={() => void save()}
          disabled={!dirty || saveState === 'saving'}
          class="px-4 py-2 rounded-md bg-accent-cyan text-bg-deep text-sm font-semibold hover:brightness-110 transition disabled:opacity-50 min-h-[40px]"
        >
          {saveState === 'saving'
            ? `Saving ${changedNames.length}…`
            : dirty
              ? `Save ${changedNames.length} change${changedNames.length === 1 ? '' : 's'}`
              : 'Save changes'}
        </button>
      </div>
    </div>
  {/if}
</div>
