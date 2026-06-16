<script lang="ts">
  import { onDestroy, onMount, tick, type Component } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { connection } from '$lib/stores/connection.svelte';
  import { confirmDialog } from '$lib/stores/confirm.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { pins } from '$lib/stores/pins.svelte';
  import { surfaceRefresh } from '$lib/stores/surface-refresh.svelte';
  import { extensionTarget } from '$lib/util/extension-identity';
  import type { Extension, ExtensionTool } from '$lib/api/types';

  type Tab = 'installed' | 'registry';
  type LoadState = 'idle' | 'loading' | 'loaded' | 'error';
  type CategoryFilter = 'all' | 'mcp' | 'oauth' | 'channel' | 'other';
  type SortKey = 'name' | 'readiness' | 'recent';

  // Refresh the installed list + readiness every 30s while the tab is open.
  // The interval is cleared on unmount and whenever the user switches modes
  // (the connection store handles its own polling separately).
  const REFRESH_INTERVAL_MS = 30_000;

  // Persisted UI prefs. Stored under a single namespaced key so a future
  // settings panel can wipe them in one call.
  const PREFS_STORAGE_KEY = 'ironclaw-extensions-prefs';
  type Prefs = { category: CategoryFilter; sort: SortKey };
  const DEFAULT_PREFS: Prefs = { category: 'all', sort: 'name' };

  const KNOWN_CATEGORIES = new Set(['mcp', 'oauth', 'channel']);

  let ExtensionCard = $state<Component<any> | null>(null);
  let SetupDrawer = $state<Component<any> | null>(null);
  let activeTab = $state<Tab>('installed');

  let installedState = $state<LoadState>('idle');
  let installedError = $state<string | null>(null);
  let installed = $state<Extension[]>([]);

  let registryState = $state<LoadState>('idle');
  let registryError = $state<string | null>(null);
  let registry = $state<Extension[]>([]);

  // Tools cache, populated once per page open and refreshed silently with the
  // installed list. Keyed by extension name → list of tool names. Used to
  // power both the search-by-tool-name and the inline expansion feature.
  let toolsByExtension = $state<Map<string, string[]>>(new Map());

  // Per-extension "currently mutating" set so we can disable the right cards
  // while their install/activate/remove call is in flight.
  let busyNames = $state<Set<string>>(new Set());

  // Setup drawer state.
  let setupTarget = $state<Extension | null>(null);

  // Search input (applies to both tabs).
  let searchInput = $state('');
  let debouncedQuery = $state('');
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Persisted prefs: category filter + sort.
  let categoryFilter = $state<CategoryFilter>(DEFAULT_PREFS.category);
  let sortKey = $state<SortKey>(DEFAULT_PREFS.sort);
  // Track when prefs are hydrated from storage so the persist effect doesn't
  // immediately clobber storage with defaults during mount.
  let prefsHydrated = $state(false);

  // Inline tool expansion — only one card open at a time (across both tabs).
  let expandedName = $state<string | null>(null);

  // Deep-link target name from `?focus=<name>` (set by GlobalSearch R14b /
  // CommandPalette R6η). Captured on mount and on same-route navigations,
  // then consumed after both
  // the installed + registry lists resolve (so we can find a match in
  // either tab). Cleared either way so the param can't re-fire on
  // refresh / Back.
  let pendingFocusName = $state<string | null>(null);
  let pendingSetupForFocus = $state(false);
  let lastFocusQuery: string | null = null;
  let focusedName = $state<string | null>(null);
  /**
   * Has the deep-link consumption already happened? Both list-load
   * paths (installed, registry) call `tryConsumeFocus()`; once one of
   * them finds a match (or both report empty), this flips to true so
   * the second load doesn't re-toast / re-scroll.
   */
  let focusConsumed = $state(false);

  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  const runnerReady = $derived(connection.client !== null && connection.status === 'connected');
  const isDisconnected = $derived(!runnerReady);

  // Pill defs (label + value) shared between both tabs.
  const CATEGORY_PILLS: Array<{ value: CategoryFilter; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'mcp', label: 'Knowledge' },
    { value: 'oauth', label: 'Accounts' },
    { value: 'channel', label: 'Team chat' },
    { value: 'other', label: 'Other' }
  ];

  const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
    { value: 'name', label: 'Name (A-Z)' },
    { value: 'readiness', label: 'Readiness' },
    { value: 'recent', label: 'Recently installed' }
  ];

  // ────────────────────────────────────────────────────────────────────────
  // Filter + sort pipeline. Each tab consumes one of these derived arrays.
  // ────────────────────────────────────────────────────────────────────────

  function matchesCategory(ext: Extension): boolean {
    if (categoryFilter === 'all') return true;
    const c = (ext.category ?? '').toLowerCase();
    if (categoryFilter === 'other') {
      // "Other" buckets anything not in the three known categories, including
      // missing/empty values.
      return !KNOWN_CATEGORIES.has(c);
    }
    return c === categoryFilter;
  }

  function matchesSearch(ext: Extension, q: string): boolean {
    if (!q) return true;
    const tools = toolsByExtension.get(ext.name) ?? [];
    const hay = [
      ext.name,
      ext.display_name ?? '',
      ext.description ?? '',
      ...(ext.keywords ?? []),
      ...tools
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  }

  function readinessRank(ext: Extension): number {
    // Sort order: Ready (0) → Needs setup / unknown (1) → Error (2).
    const msg = ext.readiness_message ?? '';
    if (msg.startsWith('error')) return 2;
    if (ext.ready === true || msg === 'ready') return 0;
    return 1;
  }

  function applySort(list: Extension[]): Extension[] {
    const out = list.slice();
    if (sortKey === 'readiness') {
      out.sort((a, b) => {
        const r = readinessRank(a) - readinessRank(b);
        if (r !== 0) return r;
        return (a.display_name ?? a.name).localeCompare(b.display_name ?? b.name);
      });
    } else {
      // The server doesn't currently provide an installed_at timestamp, so
      // "recent" gracefully falls back to name. When the gateway grows a
      // timestamp field, swap in a comparator here without other code moving.
      // TODO(extensions:+page.svelte:applySort): wire installed_at sort once
      // the gateway exposes it on /api/extensions.
      out.sort((a, b) => (a.display_name ?? a.name).localeCompare(b.display_name ?? b.name));
    }
    // Pin-first hoist: stable-sort so explicitly pinned extensions float
    // to the top of the grid regardless of the underlying sort. Pinned
    // entries preserve their pin-chronological order (insertion order in
    // the store), then unpinned entries follow in whatever order the
    // primary sort produced. Reading `pins.pins.extension` here keeps
    // the derived list reactive to pin toggles from any surface.
    const pinIndex = new Map<string, number>();
    pins.pins.extension.forEach((name, i) => pinIndex.set(name, i));
    out.sort((a, b) => {
      const ai = pinIndex.has(a.name) ? pinIndex.get(a.name)! : Number.POSITIVE_INFINITY;
      const bi = pinIndex.has(b.name) ? pinIndex.get(b.name)! : Number.POSITIVE_INFINITY;
      if (ai === bi) return 0; // both pinned at same rank (impossible) or both unpinned → keep primary order
      return ai - bi;
    });
    return out;
  }

  const filteredInstalled = $derived.by(() => {
    const q = debouncedQuery.trim().toLowerCase();
    return applySort(installed.filter((e) => matchesCategory(e) && matchesSearch(e, q)));
  });

  const filteredRegistry = $derived.by(() => {
    const q = debouncedQuery.trim().toLowerCase();
    return applySort(registry.filter((e) => matchesCategory(e) && matchesSearch(e, q)));
  });

  const visibleList = $derived(activeTab === 'installed' ? filteredInstalled : filteredRegistry);
  const sourceLen = $derived(activeTab === 'installed' ? installed.length : registry.length);
  const filterActive = $derived(debouncedQuery.trim().length > 0 || categoryFilter !== 'all');

  // ────────────────────────────────────────────────────────────────────────
  // Lifecycle: hydrate prefs, debounce search, auto-load on connection.
  // ────────────────────────────────────────────────────────────────────────

  // Hydrate persisted prefs on first script run. localStorage isn't available
  // in SSR builds, but this route is SPA-only in the Tauri shell so the guard
  // is mostly defensive.
  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(PREFS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Prefs>;
        if (parsed && typeof parsed === 'object') {
          const cat = parsed.category;
          if (
            cat === 'all' ||
            cat === 'mcp' ||
            cat === 'oauth' ||
            cat === 'channel' ||
            cat === 'other'
          ) {
            categoryFilter = cat;
          }
          const s = parsed.sort;
          if (s === 'name' || s === 'readiness' || s === 'recent') {
            sortKey = s;
          }
        }
      }
    } catch {
      // Corrupt JSON — fall back to defaults and let the next write fix it.
    }
    prefsHydrated = true;
  } else {
    prefsHydrated = true;
  }

  // Persist prefs whenever they change. Guarded on `prefsHydrated` so the
  // initial reactive run doesn't overwrite a freshly-loaded value with the
  // module-scope default.
  $effect(() => {
    if (!prefsHydrated) return;
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
    try {
      const payload: Prefs = { category: categoryFilter, sort: sortKey };
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Quota / private-mode failures are non-fatal.
    }
  });

  // Debounce the search input (applies to both tabs).
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

  // Auto-load when connection becomes available — handles both cold-start
  // (mount-before-init) and reconnects (mode-switch in /settings).
  $effect(() => {
    const ready = runnerReady;
    const client = connection.client;
    if (!ready || !client) {
      installedState = 'idle';
      registryState = 'idle';
      stopRefresh();
      return;
    }
    if (installedState === 'idle') void loadInstalled();
    if (registryState === 'idle') void loadRegistry();
    startRefresh();
  });

  function captureFocusFromUrl(): void {
    const rawFocus = page.url.searchParams.get('focus') ?? '';
    const setup =
      page.url.searchParams.get('setup') === '1' || page.url.searchParams.get('action') === 'setup';
    const focusQuery = `${rawFocus}\u0000${setup ? 'setup' : ''}`;
    if (focusQuery === lastFocusQuery) return;
    lastFocusQuery = focusQuery;

    let targetName: string | null = null;
    try {
      targetName = extensionTarget(rawFocus).name || null;
    } catch {
      targetName = null;
    }
    if (!targetName) return;

    pendingFocusName = targetName;
    pendingSetupForFocus = setup;
    focusConsumed = false;
    tryConsumeFocus();
  }

  $effect(() => {
    captureFocusFromUrl();
  });

  onMount(() => {
    void (async () => {
      const [extensionCardModule, setupDrawerModule] = await Promise.all([
        import('./ExtensionCard.svelte'),
        import('./SetupDrawer.svelte')
      ]);
      ExtensionCard = extensionCardModule.default;
      SetupDrawer = setupDrawerModule.default;
    })();

    // Capture deep-link target synchronously so a slow connection init
    // doesn't race with a URL-param mutation from elsewhere.
    captureFocusFromUrl();
    void connection.init();

    // Surface refresh (Cmd+R): reload installed + readiness + tools and
    // the registry view in parallel. Mirrors the post-install hook that
    // refetches everything so the user gets a fully fresh page.
    surfaceRefresh.register(async () => {
      await Promise.all([loadInstalled(), loadRegistry()]);
    });

    return () => stopRefresh();
  });

  // Release the surface-refresh registration when the route unmounts.
  // The interval cleanup above already runs via the onMount return; we
  // keep that path untouched and only add the unregister here.
  onDestroy(() => surfaceRefresh.unregister());

  /**
   * Try to satisfy the `?focus=<name>` deep-link against whatever lists
   * have loaded so far. Called from both list loaders after their data
   * lands; the `focusConsumed` flag is idempotent so the second caller
   * (whichever lands last) doesn't double-fire.
   *
   *   - Match in `installed`  → stay on installed tab, expand the card.
   *   - Match in `registry`   → flip to registry tab (registry cards
   *                              don't expand, so just scrolling is
   *                              the visible affordance).
   *   - No match yet          → wait; the OTHER load may still find it.
   *   - Both lists loaded, no match → toast "Extension not found" and
   *                                    clear the param.
   *
   * After a successful match we wait one tick for the grid to mount the
   * matched card, then `scrollIntoView` its wrapper. The wrapper carries
   * `data-extension-card={name}` and `display: contents` so the grid
   * layout is unchanged.
   */
  function focusCard(name: string): void {
    void tick().then(() => {
      if (typeof document === 'undefined') return;
      focusedName = name;
      const el = document.querySelector<HTMLElement>(`[data-extension-card="${cssEscape(name)}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => {
        if (focusedName === name) focusedName = null;
      }, 4500);
    });
  }

  function tryConsumeFocus() {
    if (focusConsumed) return;
    const name = pendingFocusName;
    if (!name) return;
    const inInstalled = installed.find((e) => e.name === name);
    const inRegistry = registry.find((e) => e.name === name);
    const match = inInstalled ?? inRegistry;
    if (match) {
      focusConsumed = true;
      pendingFocusName = null;
      // Flip to whichever tab holds the match. Prefer installed if it's
      // in both (an installed extension may also appear in the registry
      // — installed is the more actionable surface).
      if (inInstalled) {
        activeTab = 'installed';
        expandedName = name;
        if (pendingSetupForFocus) {
          setupTarget = inInstalled;
        }
      } else {
        activeTab = 'registry';
        // Registry cards don't expand inline — collapse any installed
        // expansion so the visual focus is on the new card.
        expandedName = null;
        if (pendingSetupForFocus && inRegistry) {
          const ext = inRegistry;
          pendingFocusName = null;
          pendingSetupForFocus = false;
          void installRegistryAndOpenSetup(ext);
          return;
        }
      }
      // Let the each-block paint the card before scrolling. Without the
      // tick, querySelector returns null on first load.
      focusCard(name);
      clearFocusParam();
      pendingSetupForFocus = false;
      return;
    }
    // No match yet — only give up after BOTH lists have loaded.
    if (installedState === 'loaded' && registryState === 'loaded') {
      focusConsumed = true;
      pendingFocusName = null;
      pendingSetupForFocus = false;
      toasts.show('Extension not found', 'error');
      clearFocusParam();
    }
  }

  /**
   * Minimal CSS.escape fallback. Extension names are typically slugs but
   * the server permits arbitrary characters — escape anything that isn't
   * a standard ident char to keep the attribute selector valid.
   */
  function cssEscape(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  }

  /**
   * Strip the `?focus=<name>` query param from the URL without triggering
   * a navigation reload. Mirrors the routines / knowledge pattern.
   */
  function clearFocusParam() {
    if (typeof window === 'undefined') return;
    if (
      !page.url.searchParams.has('focus') &&
      !page.url.searchParams.has('setup') &&
      !page.url.searchParams.has('action')
    ) {
      return;
    }
    const url = new URL(page.url);
    url.searchParams.delete('focus');
    url.searchParams.delete('setup');
    url.searchParams.delete('action');
    const target = url.pathname + (url.search ? url.search : '') + url.hash;
    void goto(target, { replaceState: true, noScroll: true, keepFocus: true });
  }

  function startRefresh() {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
      // Quietly refresh the installed list + its readiness. Don't toast on
      // failure during the silent poll — keep the last good state visible.
      // Also avoid replacing optimistic/user-visible state while a mutation or
      // setup flow is active; the mutation path does its own explicit refetch.
      if (busyNames.size > 0 || setupTarget) return;
      void loadInstalled({ quiet: true });
    }, REFRESH_INTERVAL_MS);
  }

  function stopRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  async function loadInstalled(opts: { quiet?: boolean } = {}) {
    const client = connection.client;
    if (!client) return null;
    if (opts.quiet && (busyNames.size > 0 || setupTarget)) return installed;
    if (!opts.quiet) {
      installedState = installed.length === 0 ? 'loading' : installedState;
      installedError = null;
    }
    try {
      // Fetch installed + tool index in parallel. Both endpoints are cheap
      // and the tool index needs to refresh alongside installs so the inline
      // expansion stays accurate.
      const [list, tools] = await Promise.all([
        client.listExtensions(),
        client.extensionTools().catch(() => [] as ExtensionTool[])
      ]);
      if (opts.quiet && (busyNames.size > 0 || setupTarget)) return installed;
      installed = list.slice().sort((a, b) => a.name.localeCompare(b.name));
      const next = new Map<string, string[]>();
      for (const t of tools) {
        const names = next.get(t.extension) ?? [];
        names.push(t.name);
        next.set(t.extension, names);
      }
      for (const [k, v] of next) {
        v.sort((a, b) => a.localeCompare(b));
        next.set(k, v);
      }
      toolsByExtension = next;
      installedState = 'loaded';
      // Consume any pending `?focus=<name>` deep-link now that this
      // list is live. Safe to call repeatedly — `focusConsumed` guards.
      tryConsumeFocus();
      return installed;
    } catch (err) {
      installedError = (err as Error).message;
      if (!opts.quiet) {
        installedState = 'error';
        toasts.show(`Failed to load extensions: ${installedError}`, 'error');
      }
      return null;
    }
  }

  async function loadRegistry() {
    const client = connection.client;
    if (!client) return;
    registryState = 'loading';
    registryError = null;
    try {
      const list = await client.listRegistry();
      registry = list
        .slice()
        .sort((a, b) => (a.display_name ?? a.name).localeCompare(b.display_name ?? b.name));
      registryState = 'loaded';
      // Same as loadInstalled — try to satisfy the deep-link if either
      // list now contains the target.
      tryConsumeFocus();
    } catch (err) {
      registryError = (err as Error).message;
      registryState = 'error';
      toasts.show(`Failed to load registry: ${registryError}`, 'error');
    }
  }

  function setBusy(name: string, busy: boolean) {
    const next = new Set(busyNames);
    if (busy) next.add(name);
    else next.delete(name);
    busyNames = next;
  }

  async function installRegistryAndOpenSetup(ext: Extension): Promise<void> {
    const client = connection.client;
    if (!client) return;
    const label = ext.display_name ?? ext.name;
    setBusy(ext.name, true);
    try {
      const res = await client.installExtension(ext.name, ext.category);
      const [latest] = await Promise.all([loadInstalled(), loadRegistry()]);
      const updated = latest?.find((item) => item.name === ext.name);
      if (updated) {
        activeTab = 'installed';
        expandedName = updated.name;
        setupTarget = updated;
        focusCard(updated.name);
        toasts.show(`Installed ${label}; opening setup`, 'success');
      } else if (res.ok) {
        toasts.show(
          `Install requested for ${label}; waiting for IronClaw to report it installed before setup can open.`,
          'info'
        );
      } else {
        toasts.show(`Install request sent for ${label}`, 'info');
      }
      clearFocusParam();
    } catch (err) {
      toasts.show(`Install failed: ${(err as Error).message}`, 'error');
    } finally {
      pendingSetupForFocus = false;
      setBusy(ext.name, false);
    }
  }

  async function handleInstall(ext: Extension) {
    const client = connection.client;
    if (!client) return;
    const label = ext.display_name ?? ext.name;
    setBusy(ext.name, true);
    try {
      const res = await client.installExtension(ext.name, ext.category);
      // Refresh both panes — registry's `installed` flag and the installed
      // list both move when this succeeds.
      const [latest] = await Promise.all([loadInstalled(), loadRegistry()]);
      const confirmed = latest?.some((item) => item.name === ext.name) === true;
      const updated = latest?.find((item) => item.name === ext.name);
      if (confirmed) {
        toasts.show(`Installed ${label}`, 'success');
        if (updated && updated.ready !== true && updated.readiness_message !== 'ready') {
          setupTarget = updated;
        }
      } else if (res.ok) {
        toasts.show(
          `Install requested for ${label}; waiting for IronClaw to report it installed.`,
          'info'
        );
      } else {
        toasts.show(`Install request sent for ${label}`, 'info');
      }
    } catch (err) {
      toasts.show(`Install failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(ext.name, false);
    }
  }

  async function handleToggleActivate(ext: Extension) {
    const client = connection.client;
    if (!client) return;
    const label = ext.display_name ?? ext.name;
    if (ext.active) {
      toasts.show(`Deactivate is not supported for ${label} by this gateway.`, 'info');
      return;
    }
    setBusy(ext.name, true);
    try {
      const res = await client.activateExtension(ext.name);
      const latest = await loadInstalled();
      const updated = latest?.find((item) => item.name === ext.name);
      if (updated?.active === true) {
        toasts.show(`Activated ${label}`, 'success');
      } else if (res.ok) {
        toasts.show(
          `Activation requested for ${label}; waiting for IronClaw to report it active.`,
          'info'
        );
      } else {
        toasts.show(`Activation request sent for ${label}`, 'info');
      }
    } catch (err) {
      toasts.show(`Action failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(ext.name, false);
    }
  }

  async function handleRemove(ext: Extension) {
    const client = connection.client;
    if (!client) return;
    const label = ext.display_name ?? ext.name;
    const ok = await confirmDialog.ask({
      title: `Remove ${label}?`,
      body: `Uninstalls ${label}. You can reinstall it from the registry later.`,
      confirmLabel: 'Remove extension',
      cancelLabel: 'Keep extension',
      tone: 'danger'
    });
    if (!ok) {
      return;
    }
    setBusy(ext.name, true);
    try {
      const res = await client.removeExtension(ext.name);
      const [latest] = await Promise.all([loadInstalled(), loadRegistry()]);
      const confirmed = latest?.some((item) => item.name === ext.name) === false;
      if (confirmed) {
        toasts.show(`Removed ${label}`, 'success');
      } else if (res.ok) {
        toasts.show(
          `Remove requested for ${label}; waiting for IronClaw to report it removed.`,
          'info'
        );
      } else {
        toasts.show(`Remove request sent for ${label}`, 'info');
      }
      // If the removed card was expanded, collapse it.
      if (confirmed && expandedName === ext.name) expandedName = null;
    } catch (err) {
      toasts.show(`Remove failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(ext.name, false);
    }
  }

  function openSetup(ext: Extension) {
    setupTarget = ext;
  }

  function closeSetup() {
    setupTarget = null;
  }

  async function handleSetupSaved() {
    const target = setupTarget;
    // Setup flow may have switched readiness from "needs setup" → "ready".
    const latest = await loadInstalled();
    if (!target) return;
    const updated = latest?.find((item) => item.name === target.name);
    if (updated && updated.ready !== true && updated.readiness_message !== 'ready') {
      toasts.show(
        `Setup saved for ${target.display_name ?? target.name}; waiting for IronClaw to report it ready.`,
        'info'
      );
    }
  }

  function setTab(t: Tab) {
    activeTab = t;
    // Collapse any inline tool list when crossing tabs — the registry tab
    // never expands and the visual focus shifts elsewhere.
    expandedName = null;
  }

  function handleToggleTools(ext: Extension) {
    expandedName = expandedName === ext.name ? null : ext.name;
  }

  function clearFilters() {
    searchInput = '';
    debouncedQuery = '';
    categoryFilter = 'all';
  }

  const showInstalledSkeleton = $derived(
    !isDisconnected &&
      (installedState === 'idle' || installedState === 'loading') &&
      installed.length === 0
  );
  const showRegistrySkeleton = $derived(
    !isDisconnected &&
      (registryState === 'idle' || registryState === 'loading') &&
      registry.length === 0
  );

  function formatExtensionName(name: string | null): string {
    if (!name) return 'this connector';
    return name
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(' ');
  }
</script>

<section class="p-8 h-full flex flex-col overflow-hidden">
  <header class="mb-5 flex items-baseline justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold text-text-primary">Extensions</h1>
      <p class="text-text-muted text-sm mt-1">
        Connect Gmail, Calendar, Slack, Notion, and more.
        {#if installedState === 'loaded'}
          <span class="text-text-muted/70">·</span>
          <span class="text-text-muted">{installed.length} installed</span>
        {/if}
      </p>
    </div>
  </header>

  <!-- Tabs -->
  <div
    class="mb-4 flex items-center gap-1 border-b border-border-subtle"
    role="tablist"
    aria-label="Extension sources"
  >
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === 'installed'}
      onclick={() => setTab('installed')}
      class="px-4 py-2 text-sm font-medium border-b-2 -mb-px transition"
      class:border-accent-cyan={activeTab === 'installed'}
      class:text-accent-cyan={activeTab === 'installed'}
      class:border-transparent={activeTab !== 'installed'}
      class:text-text-muted={activeTab !== 'installed'}
      class:hover:text-text-primary={activeTab !== 'installed'}
    >
      Installed
      {#if installed.length > 0}
        <span class="ml-1.5 text-[10px] font-mono text-text-muted bg-bg-deep px-1.5 py-0.5 rounded">
          {installed.length}
        </span>
      {/if}
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === 'registry'}
      onclick={() => setTab('registry')}
      class="px-4 py-2 text-sm font-medium border-b-2 -mb-px transition"
      class:border-accent-cyan={activeTab === 'registry'}
      class:text-accent-cyan={activeTab === 'registry'}
      class:border-transparent={activeTab !== 'registry'}
      class:text-text-muted={activeTab !== 'registry'}
      class:hover:text-text-primary={activeTab !== 'registry'}
    >
      Registry
      {#if registry.length > 0}
        <span class="ml-1.5 text-[10px] font-mono text-text-muted bg-bg-deep px-1.5 py-0.5 rounded">
          {registry.length}
        </span>
      {/if}
    </button>
  </div>

  <!-- Toolbar: category pills + search + sort. Same shape in both tabs so the
       UI's controls stay where the user expects them. -->
  <div class="mb-4 flex flex-col gap-3">
    <div
      class="flex flex-wrap items-center gap-1.5"
      role="radiogroup"
      aria-label="Filter extensions by category"
    >
      {#each CATEGORY_PILLS as pill (pill.value)}
        {@const selected = categoryFilter === pill.value}
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          onclick={() => (categoryFilter = pill.value)}
          disabled={isDisconnected}
          class="px-3 py-1 rounded-full text-xs font-medium border transition disabled:opacity-50 disabled:cursor-not-allowed"
          class:bg-accent-cyan={selected}
          class:text-bg-deep={selected}
          class:border-accent-cyan={selected}
          class:bg-bg-deep={!selected}
          class:text-text-muted={!selected}
          class:border-border-subtle={!selected}
          class:hover:text-text-primary={!selected}
          class:hover:border-accent-cyan={!selected}
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
          placeholder="Search name, description, or tool…"
          disabled={isDisconnected}
          aria-label="Search extensions"
          class="w-full bg-bg-deep border border-border-subtle rounded-md pl-10 pr-3 py-2 text-sm text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:border-accent-cyan transition-colors min-h-[40px] disabled:opacity-50 disabled:cursor-not-allowed"
        />
      </div>
      <label class="flex items-center gap-2 text-xs text-text-muted">
        <span class="shrink-0">Sort</span>
        <select
          bind:value={sortKey}
          disabled={isDisconnected}
          aria-label="Sort extensions"
          class="bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent-cyan transition-colors min-h-[40px] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {#each SORT_OPTIONS as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </label>
    </div>

    {#if filterActive && !isDisconnected}
      <div class="flex items-center justify-between gap-3 text-xs text-text-muted">
        <span>
          <span class="text-text-primary font-semibold">{visibleList.length}</span>
          result{visibleList.length === 1 ? '' : 's'}
          {#if sourceLen > 0}
            <span class="text-text-muted/70">of {sourceLen}</span>
          {/if}
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

  <!-- Content -->
  <div class="flex-1 overflow-auto -mx-2 px-2">
    {#if isDisconnected}
      <div class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]">
        <div class="text-sm text-text-primary mb-2">
          {#if pendingSetupForFocus && pendingFocusName}
            Connect IronClaw to set up {formatExtensionName(pendingFocusName)}
          {:else}
            IronClaw is offline
          {/if}
        </div>
        <div class="max-w-md text-xs leading-5 text-text-muted">
          {#if pendingSetupForFocus && pendingFocusName}
            Setup for {formatExtensionName(pendingFocusName)} is queued. Connect a runner or gateway,
            then return here.
          {:else}
            Connect a runner to install or configure connectors.
          {/if}
        </div>
        <div class="mt-4 flex flex-wrap items-center justify-center gap-2">
          <a
            href="/settings"
            class="inline-flex min-h-[36px] items-center rounded-md border border-accent-cyan/60 px-3 py-1.5 text-xs font-semibold text-accent-cyan transition hover:bg-accent-cyan/10"
          >
            Open Settings
          </a>
          <a
            href="/onboarding"
            class="inline-flex min-h-[36px] items-center rounded-md border border-border-subtle px-3 py-1.5 text-xs font-semibold text-text-muted transition hover:border-accent-cyan hover:text-text-primary"
          >
            Connect runner
          </a>
        </div>
      </div>
    {:else if activeTab === 'installed'}
      {#if installedState === 'error'}
        <div
          class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]"
        >
          <div class="text-sm text-red-400 mb-2">Failed to load extensions</div>
          <div class="text-xs text-text-muted font-mono mb-4 max-w-md break-words">
            {installedError ?? 'Unknown error'}
          </div>
          <button
            type="button"
            onclick={() => loadInstalled()}
            class="px-4 py-2 rounded-md border border-accent-cyan text-accent-cyan text-sm font-semibold hover:bg-accent-cyan hover:text-bg-deep transition min-h-[40px]"
          >
            Retry
          </button>
        </div>
      {:else if showInstalledSkeleton}
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {#each Array(6) as _, i (i)}
            <div
              class="rounded-lg border border-border-subtle bg-bg-surface p-4 min-h-[180px] animate-pulse"
            >
              <div class="h-4 w-1/3 bg-border-subtle rounded mb-3"></div>
              <div class="h-3 w-full bg-border-subtle rounded mb-2"></div>
              <div class="h-3 w-4/5 bg-border-subtle rounded mb-6"></div>
              <div class="flex justify-between items-center">
                <div class="h-5 w-20 bg-border-subtle rounded"></div>
                <div class="h-7 w-24 bg-border-subtle rounded"></div>
              </div>
            </div>
          {/each}
        </div>
      {:else if installed.length === 0}
        <div
          class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]"
        >
          <div class="text-sm text-text-primary mb-1">No extensions installed</div>
          <div class="text-xs text-text-muted">
            Browse the <button
              type="button"
              onclick={() => setTab('registry')}
              class="text-accent-cyan underline decoration-dotted hover:decoration-solid"
              >Registry</button
            > to add some.
          </div>
        </div>
      {:else if filteredInstalled.length === 0}
        <div
          class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]"
        >
          <div class="text-sm text-text-primary mb-1">No matching extensions</div>
          <div class="text-xs text-text-muted">
            <button
              type="button"
              onclick={clearFilters}
              class="text-accent-cyan underline decoration-dotted hover:decoration-solid"
              >Clear the filters</button
            >
            to see all {installed.length}.
          </div>
        </div>
      {:else}
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 pb-4">
          {#each filteredInstalled as ext (ext.name)}
            <!--
              `display: contents` wrapper exposes a queryable element
              (`[data-extension-card]`) for the `?focus=<name>` deep-link
              scroll target without altering the CSS Grid layout — the
              `<ExtensionCard>` root stays the grid item.
            -->
            <div
              class="contents"
              data-extension-card={ext.name}
              data-extension-active={ext.active === true ? 'true' : 'false'}
              data-extension-focused={focusedName === ext.name ? 'true' : 'false'}
            >
              <ExtensionCard
                extension={ext}
                variant="installed"
                busy={busyNames.has(ext.name)}
                toolNames={toolsByExtension.get(ext.name) ?? []}
                expanded={expandedName === ext.name}
                onToggleTools={handleToggleTools}
                onSetup={openSetup}
                onToggleActivate={handleToggleActivate}
                onRemove={handleRemove}
              />
            </div>
          {/each}
        </div>
      {/if}
    {:else if activeTab === 'registry'}
      {#if registryState === 'error'}
        <div
          class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]"
        >
          <div class="text-sm text-red-400 mb-2">Failed to load registry</div>
          <div class="text-xs text-text-muted font-mono mb-4 max-w-md break-words">
            {registryError ?? 'Unknown error'}
          </div>
          <button
            type="button"
            onclick={loadRegistry}
            class="px-4 py-2 rounded-md border border-accent-cyan text-accent-cyan text-sm font-semibold hover:bg-accent-cyan hover:text-bg-deep transition min-h-[40px]"
          >
            Retry
          </button>
        </div>
      {:else if showRegistrySkeleton}
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {#each Array(6) as _, i (i)}
            <div
              class="rounded-lg border border-border-subtle bg-bg-surface p-4 min-h-[180px] animate-pulse"
            >
              <div class="h-4 w-1/3 bg-border-subtle rounded mb-3"></div>
              <div class="h-3 w-full bg-border-subtle rounded mb-2"></div>
              <div class="h-3 w-4/5 bg-border-subtle rounded mb-6"></div>
            </div>
          {/each}
        </div>
      {:else if registry.length === 0}
        <div
          class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]"
        >
          <div class="text-sm text-text-primary mb-1">Registry is empty</div>
          <div class="text-xs text-text-muted mb-4">
            No extensions available. Reload the catalog.
          </div>
          <button
            type="button"
            onclick={loadRegistry}
            class="px-4 py-2 rounded-md border border-accent-cyan text-accent-cyan text-sm font-semibold hover:bg-accent-cyan hover:text-bg-deep transition min-h-[40px]"
          >
            Retry
          </button>
        </div>
      {:else if filteredRegistry.length === 0}
        <div
          class="surface p-10 flex flex-col items-center justify-center text-center min-h-[280px]"
        >
          <div class="text-sm text-text-primary mb-1">No matching extensions</div>
          <div class="text-xs text-text-muted">
            {#if debouncedQuery.trim().length > 0}
              No registry entries match «<span class="text-text-primary">{debouncedQuery}</span>».
            {:else}
              No registry entries match the filters
            {/if}
            <button
              type="button"
              onclick={clearFilters}
              class="text-accent-cyan underline decoration-dotted hover:decoration-solid ml-1"
              >Clear</button
            >
          </div>
        </div>
      {:else}
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 pb-4">
          {#each filteredRegistry as ext (ext.name)}
            <!-- See installed-tab wrapper above for rationale. -->
            <div
              class="contents"
              data-extension-card={ext.name}
              data-extension-focused={focusedName === ext.name ? 'true' : 'false'}
            >
              <ExtensionCard
                extension={ext}
                variant="registry"
                busy={busyNames.has(ext.name)}
                onInstall={handleInstall}
              />
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</section>

{#if setupTarget}
  {#key setupTarget.name}
    <SetupDrawer extension={setupTarget} onClose={closeSetup} onSaved={handleSetupSaved} />
  {/key}
{/if}

<style>
  :global([data-extension-active='true'] button[title='Deactivate']) {
    display: none;
  }

  :global([data-extension-focused='true'] > *) {
    border-color: color-mix(in srgb, var(--v2-accent) 85%, transparent) !important;
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--v2-accent) 45%, transparent),
      0 0 0 6px color-mix(in srgb, var(--v2-accent) 12%, transparent);
  }
</style>
