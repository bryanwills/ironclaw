<script lang="ts">
  import { onDestroy, onMount, tick, type Component } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { connection } from '$lib/stores/connection.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { pins } from '$lib/stores/pins.svelte';
  import { surfaceRefresh } from '$lib/stores/surface-refresh.svelte';
  import { composerInsert } from '$lib/stores/templates.svelte';
  import type { Skill, SkillTrust } from '$lib/api/types';

  type LoadState = 'idle' | 'loading' | 'loaded' | 'error';
  type SortMode = 'alpha' | 'trust' | 'recent';
  type ViewMode = 'flat' | 'grouped';

  // localStorage keys — keep these stable; renaming silently wipes user prefs.
  const LS_PREFS = 'ironclaw-skills-prefs';
  const LS_RECENT = 'ironclaw-skills-recent';
  const RECENT_LIMIT = 8;

  type PersistedPrefs = {
    viewMode: ViewMode;
    sortMode: SortMode;
  };

  const DEFAULT_PREFS: PersistedPrefs = {
    viewMode: 'flat',
    sortMode: 'alpha'
  };

  let SkillCard = $state<Component<any> | null>(null);
  let SkillDrawer = $state<Component<any> | null>(null);
  let loadState = $state<LoadState>('idle');
  let loadError = $state<string | null>(null);
  let skills = $state<Skill[]>([]);

  // Debounced search input — the rendered value updates immediately, the
  // filter value lags by 250 ms so we don't recompute on every keystroke.
  let searchInput = $state('');
  let debouncedQuery = $state('');
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  let selectedSkill = $state<Skill | null>(null);

  // User-facing preferences. Hydrated from localStorage in onMount so SSR
  // (if it ever ran) sees defaults; persisted on every change via $effect.
  let viewMode = $state<ViewMode>('flat');
  let sortMode = $state<SortMode>('alpha');
  let recentNames = $state<string[]>([]);
  let prefsHydrated = $state(false);

  // Track the last-focused card name so Esc-closing the drawer can restore
  // focus. We store the name (skill identifier) rather than the DOM ref
  // because the underlying card may re-render between focus and close.
  let lastFocusedName = $state<string | null>(null);

  // Deep-link target name from `?focus=<name>` (set by GlobalSearch R14b /
  // CommandPalette R6η). Captured once on mount and consumed after the
  // first `loadSkills()` resolves; cleared either way so the param can't
  // re-fire on refresh / Back.
  let pendingFocusName: string | null = null;

  function loadPrefs(): PersistedPrefs {
    if (typeof window === 'undefined') return { ...DEFAULT_PREFS };
    try {
      const raw = window.localStorage.getItem(LS_PREFS);
      if (!raw) return { ...DEFAULT_PREFS };
      const parsed = JSON.parse(raw) as Partial<PersistedPrefs>;
      const view: ViewMode = parsed.viewMode === 'grouped' ? 'grouped' : 'flat';
      const sort: SortMode =
        parsed.sortMode === 'trust' || parsed.sortMode === 'recent' ? parsed.sortMode : 'alpha';
      return { viewMode: view, sortMode: sort };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  function loadRecent(): string[] {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem(LS_RECENT);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Defensive: drop anything that isn't a string, then cap length.
      return parsed.filter((v): v is string => typeof v === 'string').slice(0, RECENT_LIMIT);
    } catch {
      return [];
    }
  }

  function persistPrefs() {
    if (typeof window === 'undefined') return;
    try {
      const payload: PersistedPrefs = { viewMode, sortMode };
      window.localStorage.setItem(LS_PREFS, JSON.stringify(payload));
    } catch {
      // Storage may be full or disabled — non-fatal.
    }
  }

  function persistRecent() {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(LS_RECENT, JSON.stringify(recentNames));
    } catch {
      // Same rationale as persistPrefs.
    }
  }

  /**
   * Push a skill name onto the head of the recent list, deduping by name.
   * Capped at RECENT_LIMIT. Triggered on Run or "Open in Chat" — both
   * are launches in the user's mental model, even though only one of
   * them runs anything. Drawer opens (just viewing) do NOT count.
   */
  function pushRecent(name: string) {
    const next = [name, ...recentNames.filter((n) => n !== name)].slice(0, RECENT_LIMIT);
    recentNames = next;
    persistRecent();
  }

  function clearRecent() {
    recentNames = [];
    persistRecent();
    toasts.show('Cleared recent skills', 'info');
  }

  // Filter step — runs over the freshly loaded skill list. Always applied
  // before any sort/group transform so search narrows the universe regardless
  // of view mode.
  const filteredSkills = $derived.by(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q)
    );
  });

  /** Sort key for the three modes. The "recent" mode uses recentNames
   *  order; anything not in recents falls to alpha order at the tail. */
  function trustRank(t: SkillTrust | undefined): number {
    switch (t) {
      case 'Bundled':
        return 0;
      case 'Verified':
        return 1;
      case 'Unverified':
        return 2;
      default:
        return 3;
    }
  }

  const sortedSkills = $derived.by(() => {
    const list = filteredSkills.slice();
    if (sortMode === 'alpha') {
      return list.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (sortMode === 'trust') {
      return list.sort(
        (a, b) => trustRank(a.trust) - trustRank(b.trust) || a.name.localeCompare(b.name)
      );
    }
    // 'recent' — recents in pinned order, then alpha for the rest.
    const recentIdx = new Map<string, number>();
    recentNames.forEach((n, i) => recentIdx.set(n, i));
    return list.sort((a, b) => {
      const ai = recentIdx.has(a.name) ? recentIdx.get(a.name)! : Number.POSITIVE_INFINITY;
      const bi = recentIdx.has(b.name) ? recentIdx.get(b.name)! : Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name);
    });
  });

  /**
   * Sectioned view used when `viewMode === 'grouped'`. Only sections with
   * at least one card render. Always sorts members alphabetically within a
   * group regardless of `sortMode` — the group is the primary sort.
   */
  type Section = { id: string; label: string; items: Skill[] };

  const groupedSections = $derived.by<Section[]>(() => {
    const byTrust = new Map<SkillTrust, Skill[]>();
    for (const s of filteredSkills) {
      const key = (s.trust ?? 'Unverified') as SkillTrust;
      // Coalesce unknown trust values into Unverified so they aren't
      // hidden — better to surface them under the highest-suspicion bucket.
      const bucket =
        key === 'Bundled' || key === 'Verified' || key === 'Unverified' ? key : 'Unverified';
      const arr = byTrust.get(bucket) ?? [];
      arr.push(s);
      byTrust.set(bucket, arr);
    }
    const order: Array<{ id: SkillTrust; label: string }> = [
      { id: 'Bundled', label: 'Bundled' },
      { id: 'Verified', label: 'Verified' },
      { id: 'Unverified', label: 'Unverified' }
    ];
    return order
      .map(({ id, label }) => {
        const items = (byTrust.get(id) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
        return { id: id as string, label, items };
      })
      .filter((s) => s.items.length > 0);
  });

  /**
   * Flat-view sections — splits the result list into up to three
   * sections: explicitly pinned skills (gold-starred via the per-card
   * button), recently-used skills, and the rest. Pinned takes priority
   * over recently-used so a user who pinned a skill always sees it at
   * the top even if they ran something else more recently.
   *
   * Each section is restricted to the post-filter set, so search /
   * sort modes still apply (you can search within your pinned skills).
   * Both pinned and recents preserve their insertion order
   * (pin-chronological / launch-chronological respectively) so the
   * section reads predictably.
   */
  const flatSections = $derived.by<Section[]>(() => {
    if (viewMode !== 'flat') return [];
    const filteredSet = new Set(filteredSkills.map((s) => s.name));
    // Explicit pins — first, in insertion order, restricted to skills
    // that survive the current filter (and that still exist in the
    // catalog so the section never renders ghost entries).
    const pinnedList: Skill[] = [];
    for (const name of pins.pins.skill) {
      if (!filteredSet.has(name)) continue;
      const found = filteredSkills.find((s) => s.name === name);
      if (found) pinnedList.push(found);
    }
    const pinnedNames = new Set(pinnedList.map((s) => s.name));
    // Recents — skip anything already surfaced as a pin so a skill
    // never appears in two sections at once.
    const recentList: Skill[] = [];
    for (const name of recentNames) {
      if (!filteredSet.has(name)) continue;
      if (pinnedNames.has(name)) continue;
      const found = filteredSkills.find((s) => s.name === name);
      if (found) recentList.push(found);
    }
    const recentNamesSet = new Set(recentList.map((s) => s.name));
    const rest = sortedSkills.filter(
      (s) => !pinnedNames.has(s.name) && !recentNamesSet.has(s.name)
    );
    const out: Section[] = [];
    if (pinnedList.length > 0) {
      out.push({ id: 'pinned', label: 'Pinned', items: pinnedList });
    }
    if (recentList.length > 0) {
      out.push({ id: 'recent', label: 'Recently used', items: recentList });
    }
    if (out.length > 0) {
      out.push({ id: 'all', label: 'All skills', items: rest });
    } else {
      // Neither pins nor recents — single unlabeled section (existing
      // behavior preserved so the grid layout doesn't shift for users
      // who haven't engaged with either affordance yet).
      out.push({ id: 'all', label: '', items: sortedSkills });
    }
    return out;
  });

  /**
   * Linear list of cards used for keyboard navigation. Order matches the
   * visual reading order: pinned recents (if any) first, then either the
   * flat list or the concatenated group sections. This lets arrow keys
   * traverse the entire grid as one continuous 2D structure.
   */
  const navOrder = $derived.by<Skill[]>(() => {
    if (viewMode === 'grouped') {
      return groupedSections.flatMap((s) => s.items);
    }
    return flatSections.flatMap((s) => s.items);
  });

  // React to search input changes with a 250 ms debounce.
  $effect(() => {
    const value = searchInput;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debouncedQuery = value;
    }, 250);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  });

  // Persist prefs whenever they change. Gated on `prefsHydrated` so the
  // initial hydration doesn't immediately re-write the file with defaults
  // (would happen because $effect fires for the seed assignments too).
  $effect(() => {
    // Touch both so the effect re-runs when either changes.
    const _ = viewMode + sortMode;
    void _;
    if (!prefsHydrated) return;
    persistPrefs();
  });

  // Auto-load when the client becomes available. This handles both the cold
  // start (mount-before-connection-init) and reconnects (token added later
  // in /settings without a page navigation).
  //
  // IMPORTANT: only re-fire when `loadState === 'idle'`. The previous guard
  // `if (loadState === 'loading') return` let through `'loaded'` and
  // `'error'` states, and since this effect reads `loadState` reactively the
  // state transition at the END of `loadSkills()` ('loading' → 'loaded')
  // re-ran the effect, which then called `loadSkills()` again → infinite
  // reload loop, never letting the page reach `networkidle`. Match the
  // `/extensions` pattern: only the initial `'idle'` slot triggers a fetch,
  // and dropping back to `'idle'` is the explicit signal (we clear it when
  // the client goes away).
  $effect(() => {
    const client = connection.client;
    if (!client) {
      loadState = 'idle';
      return;
    }
    if (loadState !== 'idle') return;
    void loadSkills();
  });

  onMount(async () => {
    const [skillCardModule, skillDrawerModule] = await Promise.all([
      import('./SkillCard.svelte'),
      import('./SkillDrawer.svelte')
    ]);
    SkillCard = skillCardModule.default;
    SkillDrawer = skillDrawerModule.default;

    // Hydrate prefs and recents before any user interaction so the first
    // render reflects what the user set last session.
    const p = loadPrefs();
    viewMode = p.viewMode;
    sortMode = p.sortMode;
    recentNames = loadRecent();
    prefsHydrated = true;
    // Capture deep-link target synchronously before any async work so a
    // slow connection init doesn't race with a URL-param mutation.
    pendingFocusName = page.url.searchParams.get('focus');
    // Kick connection init in case this is the first page visited — Sidebar
    // also triggers it, but skill route may render before sidebar mount
    // ordering in some edge cases.
    void connection.init();

    // Surface refresh (Cmd+R): re-fetch the skill catalog. Filters,
    // sort, view-mode, and any open drawer remain in place — only the
    // underlying list reloads.
    surfaceRefresh.register(async () => {
      await loadSkills();
    });
  });

  // Release the registration when the route unmounts.
  onDestroy(() => surfaceRefresh.unregister());

  async function loadSkills() {
    const client = connection.client;
    if (!client) return;
    loadState = 'loading';
    loadError = null;
    try {
      const list = await client.listSkills();
      // Stable alpha sort baseline so the grid doesn't jitter between
      // reloads. The display order is then re-derived by `sortedSkills`.
      skills = list.slice().sort((a, b) => a.name.localeCompare(b.name));
      loadState = 'loaded';
      // If we arrived with `?focus=<name>` from GlobalSearch / palette,
      // pop the drawer for that skill now that the catalog is loaded.
      // Stale-link fallback: toast and clear the param.
      if (pendingFocusName) {
        const name = pendingFocusName;
        pendingFocusName = null;
        const match = skills.find((s) => s.name === name);
        if (match) {
          openSkill(match);
        } else {
          toasts.show('Skill not found', 'error');
        }
        clearFocusParam();
      }
    } catch (err) {
      loadError = (err as Error).message;
      loadState = 'error';
      toasts.show(`Failed to load skills: ${loadError}`, 'error');
    }
  }

  /**
   * Strip the `?focus=<name>` query param from the URL without triggering
   * a navigation reload. Mirrors the routines / knowledge pattern.
   */
  function clearFocusParam() {
    if (typeof window === 'undefined') return;
    if (!page.url.searchParams.has('focus')) return;
    const url = new URL(page.url);
    url.searchParams.delete('focus');
    const target = url.pathname + (url.search ? url.search : '') + url.hash;
    void goto(target, { replaceState: true, noScroll: true, keepFocus: true });
  }

  function openSkill(skill: Skill) {
    // Remember the card so Esc returns focus there. Drawer open doesn't
    // count toward "recently used" — we only mark on actual launches.
    lastFocusedName = skill.name;
    selectedSkill = skill;
  }

  function closeDrawer() {
    selectedSkill = null;
    // Restore focus to the previously-focused card on next tick once the
    // drawer is gone and the grid is interactable again.
    void tick().then(() => {
      const name = lastFocusedName;
      if (!name || typeof document === 'undefined') return;
      const el = document.querySelector<HTMLElement>(`[data-skill-card="${cssEscape(name)}"]`);
      el?.focus();
    });
  }

  /**
   * Minimal CSS.escape fallback. Skill names are typically slugs but the
   * server permits arbitrary characters — escape anything that isn't a
   * standard ident char to keep the attribute selector valid.
   */
  function cssEscape(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  }

  function runSkillFromCard(skill: Skill) {
    // "Run" on a card jumps straight to chat with the usage hint prefilled.
    // Drawer's Open-in-Chat covers the input-argument case. Prefer the
    // server-provided usage_hint over the derived `/${name}` heuristic so
    // skills that surface a different invocation phrase render correctly.
    pushRecent(skill.name);
    const hint = skillUsageHint(skill);
    toasts.show(`Loaded into chat: ${hint}`, 'info');
    // Hand the invocation to the chat composer via the one-shot bus; the
    // active chat surface (v1 page or v2 panel) drains it on arrival.
    composerInsert.push(hint);
    void goto('/chat');
  }

  function handleOpenInChat(skill: Skill) {
    // Surfaced from the drawer — also counts as a launch for recents.
    pushRecent(skill.name);
  }

  /**
   * Extract a slash-style invocation hint from the server's `usage_hint`
   * field, falling back to `/<name>` when absent. The server emits a
   * sentence like "Type `/foo` in chat to force-activate this skill." —
   * we pull the backtick-delimited token out so callers get just the token.
   */
  function skillUsageHint(skill: Skill): string {
    const raw = skill.usage_hint;
    if (raw) {
      const m = raw.match(/`([^`]+)`/);
      if (m) return m[1];
      const trimmed = raw.trim();
      if (trimmed.startsWith('/')) return trimmed.split(/\s+/)[0];
    }
    return `/${skill.name}`;
  }

  /**
   * Compute the column count of the visible card grid by reading the DOM.
   * We use this for ArrowUp/Down navigation — Tailwind's `grid-cols-1
   * md:grid-cols-2 xl:grid-cols-3` doesn't expose the count at runtime, so
   * we sniff it from the parent element's resolved style. Cheap (one call
   * per arrow press) and avoids hardcoding breakpoints.
   */
  function columnCountFor(name: string): number {
    if (typeof document === 'undefined') return 1;
    const card = document.querySelector<HTMLElement>(`[data-skill-card="${cssEscape(name)}"]`);
    const grid = card?.parentElement;
    if (!grid) return 1;
    const style = window.getComputedStyle(grid);
    const tracks = style.gridTemplateColumns.split(' ').filter((t) => t.trim().length > 0);
    return Math.max(1, tracks.length);
  }

  function focusByName(name: string) {
    if (typeof document === 'undefined') return;
    const card = document.querySelector<HTMLElement>(`[data-skill-card="${cssEscape(name)}"]`);
    const el = card?.querySelector<HTMLElement>('[data-skill-card-focus]');
    el?.focus();
  }

  function handleCardFocus(skill: Skill) {
    lastFocusedName = skill.name;
  }

  function handleArrowKey(skill: Skill, key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight') {
    const order = navOrder;
    const idx = order.findIndex((s) => s.name === skill.name);
    if (idx < 0) return;
    let nextIdx = idx;
    if (key === 'ArrowLeft') {
      nextIdx = Math.max(0, idx - 1);
    } else if (key === 'ArrowRight') {
      nextIdx = Math.min(order.length - 1, idx + 1);
    } else if (key === 'ArrowUp') {
      const cols = columnCountFor(skill.name);
      nextIdx = idx - cols;
      if (nextIdx < 0) nextIdx = idx; // clamp at top
    } else if (key === 'ArrowDown') {
      const cols = columnCountFor(skill.name);
      nextIdx = idx + cols;
      if (nextIdx >= order.length) nextIdx = idx; // clamp at bottom
    }
    if (nextIdx === idx) return;
    const next = order[nextIdx];
    if (next) focusByName(next.name);
  }

  const isDisconnected = $derived(
    connection.status === 'disconnected' || connection.status === 'idle' || !connection.client
  );

  const showSkeleton = $derived(
    !isDisconnected && (loadState === 'idle' || loadState === 'loading') && skills.length === 0
  );

  function setViewMode(mode: ViewMode) {
    viewMode = mode;
  }

  // Compact button classes for the segmented header toggles. Inlined here
  // rather than as a CSS @apply since they're used in two places and
  // pulling them into app.css would create dead weight.
  function segBtn(active: boolean): string {
    return `px-3 py-1.5 text-xs font-medium rounded-md transition ${
      active
        ? 'bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/40'
        : 'text-text-muted border border-transparent hover:text-text-primary hover:border-border-subtle'
    }`;
  }
</script>

<section class="p-8 h-full flex flex-col overflow-hidden">
  <header class="mb-5 flex items-baseline justify-between gap-4 flex-wrap">
    <div>
      <h1 class="text-2xl font-semibold text-text-primary">Skills</h1>
      <p class="text-text-muted text-sm mt-1">
        Reusable capabilities IronClaw can call while it works.
        {#if loadState === 'loaded'}
          <span class="text-text-muted/70">·</span>
          <span class="text-text-muted">{skills.length} loaded</span>
        {/if}
      </p>
    </div>

    <!-- Header controls: group toggle + sort dropdown. Both update prefs
         which are persisted to localStorage via $effect. The Browse IronHub
         link sits alongside so the marketplace entrypoint is one click
         away whenever the user is staring at their installed catalog. -->
    <div class="flex items-center gap-3">
      <a
        href="/skills/ironhub"
        class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-accent-cyan/40 text-xs font-semibold text-accent-cyan hover:bg-accent-cyan/10 transition min-h-[34px]"
        title="Browse IronHub and install skills"
      >
        Browse IronHub
      </a>
      <div
        class="inline-flex items-center gap-1 p-0.5 rounded-lg bg-bg-deep border border-border-subtle"
        role="group"
        aria-label="View mode"
      >
        <button
          type="button"
          class={segBtn(viewMode === 'grouped')}
          aria-pressed={viewMode === 'grouped'}
          onclick={() => setViewMode('grouped')}
        >
          Group by trust
        </button>
        <button
          type="button"
          class={segBtn(viewMode === 'flat')}
          aria-pressed={viewMode === 'flat'}
          onclick={() => setViewMode('flat')}
        >
          Flat list
        </button>
      </div>

      <label class="flex items-center gap-2 text-xs text-text-muted">
        <span class="sr-only">Sort skills</span>
        <span aria-hidden="true">Sort</span>
        <select
          bind:value={sortMode}
          class="bg-bg-deep border border-border-subtle rounded-md px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent-cyan transition-colors min-h-[34px]"
          aria-label="Sort skills"
        >
          <option value="alpha">Alphabetical</option>
          <option value="trust">By trust</option>
          <option value="recent">Recently used first</option>
        </select>
      </label>
    </div>
  </header>

  <!-- Search bar -->
  <div class="mb-5 relative max-w-md">
    <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-muted">
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
      placeholder="Filter skills…"
      aria-label="Filter skills"
      disabled={isDisconnected}
      class="w-full bg-bg-deep border border-border-subtle rounded-md pl-10 pr-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors min-h-[40px] disabled:opacity-50 disabled:cursor-not-allowed"
    />
  </div>

  <!-- Content -->
  <div class="flex-1 overflow-auto -mx-2 px-2">
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
    {:else if loadState === 'error'}
      <div class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]">
        <div class="text-sm text-red-400 mb-2">Failed to load skills</div>
        <div class="text-xs text-text-muted font-mono mb-4 max-w-md break-words">
          {loadError ?? 'Unknown error'}
        </div>
        <button
          type="button"
          onclick={loadSkills}
          class="px-4 py-2 rounded-md border border-accent-cyan text-accent-cyan text-sm font-semibold hover:bg-accent-cyan hover:text-bg-deep transition min-h-[40px]"
        >
          Retry
        </button>
      </div>
    {:else if showSkeleton}
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {#each Array(6) as _, i (i)}
          <div
            class="rounded-lg border border-border-subtle bg-bg-surface p-4 min-h-[160px] animate-pulse"
          >
            <div class="h-4 w-1/3 bg-border-subtle rounded mb-3"></div>
            <div class="h-3 w-full bg-border-subtle rounded mb-2"></div>
            <div class="h-3 w-4/5 bg-border-subtle rounded mb-6"></div>
            <div class="flex justify-between items-center">
              <div class="h-5 w-10 bg-border-subtle rounded"></div>
              <div class="h-7 w-16 bg-border-subtle rounded"></div>
            </div>
          </div>
        {/each}
      </div>
    {:else if filteredSkills.length === 0 && debouncedQuery.trim().length > 0}
      <div class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]">
        <div class="text-sm text-text-primary mb-1">No matching skills</div>
        <div class="text-xs text-text-muted">
          No skills match «<span class="text-text-primary">{debouncedQuery}</span>».
        </div>
      </div>
    {:else if filteredSkills.length === 0}
      <div class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]">
        <div class="text-sm text-text-primary mb-1">No skills installed</div>
        <div class="text-xs text-text-muted mb-4">Browse IronHub to install your first skill.</div>
        <a
          href="/skills/ironhub"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-accent-cyan/40 text-xs font-semibold text-accent-cyan hover:bg-accent-cyan/10 transition min-h-[34px]"
          title="Browse IronHub and install skills"
        >
          Browse IronHub
        </a>
      </div>
    {:else if viewMode === 'grouped'}
      <!-- Grouped view: trust-level sections, alpha-sorted within. -->
      <div class="space-y-6 pb-4">
        {#each groupedSections as section (section.id)}
          <div>
            <div class="flex items-baseline justify-between mb-3">
              <h2 class="text-xs font-semibold uppercase tracking-wide text-text-muted">
                {section.label}
              </h2>
              <span class="text-[10px] font-mono text-text-muted/70">
                {section.items.length}
              </span>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {#each section.items as skill (skill.name)}
                <SkillCard
                  {skill}
                  onOpen={openSkill}
                  onRun={runSkillFromCard}
                  onFocus={handleCardFocus}
                  onArrowKey={handleArrowKey}
                />
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <!-- Flat view: optional Pinned section, optional Recently-used,
           then All skills. Pinned header uses the gold accent so users
           can find their explicit-favorites bucket at a glance — it's
           the only place gold is used in section chrome on this page. -->
      <div class="space-y-6 pb-4">
        {#each flatSections as section (section.id)}
          <div>
            {#if section.label}
              <div class="flex items-baseline justify-between mb-3">
                <h2
                  class="text-xs font-semibold uppercase tracking-wide flex items-center gap-1.5"
                  class:text-accent-gold={section.id === 'pinned'}
                  class:text-text-muted={section.id !== 'pinned'}
                >
                  {#if section.id === 'pinned'}
                    <svg
                      viewBox="0 0 24 24"
                      class="w-3 h-3"
                      fill="currentColor"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <polygon
                        points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
                      />
                    </svg>
                  {/if}
                  {section.label}
                </h2>
                {#if section.id === 'recent'}
                  <button
                    type="button"
                    onclick={clearRecent}
                    class="text-[11px] text-text-muted hover:text-accent-cyan transition underline-offset-2 hover:underline"
                  >
                    Clear recent
                  </button>
                {:else}
                  <span class="text-[10px] font-mono text-text-muted/70">
                    {section.items.length}
                  </span>
                {/if}
              </div>
            {/if}
            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {#each section.items as skill (skill.name)}
                <SkillCard
                  {skill}
                  onOpen={openSkill}
                  onRun={runSkillFromCard}
                  onFocus={handleCardFocus}
                  onArrowKey={handleArrowKey}
                />
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>

{#if selectedSkill}
  <SkillDrawer skill={selectedSkill} onClose={closeDrawer} onLaunch={handleOpenInChat} />
{/if}
