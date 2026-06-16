<script lang="ts">
  // Global command palette (Cmd+K). Centered overlay with backdrop blur,
  // grouped fuzzy-matched results across six surfaces:
  //   Recent, Navigate, Actions, Threads, Skills, Routines, Docs.
  //
  // Mounted once at the layout level so any route can summon it via
  // `palette.openPalette()` from `$lib/stores/shortcuts.svelte`.
  //
  // Loading strategy: data is fetched lazily the first time the palette
  // opens, then cached for the modal's lifetime (i.e. as long as the app
  // is running — there's no eviction). Threads are read from the existing
  // `threads` store only if already loaded; we never trigger a network
  // request for threads here. Skills / Routines / Docs hit
  // `connection.client` once and cache.
  //
  // Persistence:
  //   - Recent palette actions    → localStorage  `ironclaw-palette-recent`
  //   - Active section pill filter→ sessionStorage `ironclaw-palette-pill`
  // localStorage persists across launches; sessionStorage resets each app
  // launch (Tauri webview creates a fresh session per process), so the
  // pill state behaviour matches the spec.

  import { tick } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { goto } from '$app/navigation';
  import { connection } from '$lib/stores/connection.svelte';
  import { threads } from '$lib/stores/threads.svelte';
  import { palette } from '$lib/stores/shortcuts.svelte';
  import { globalSearch } from '$lib/stores/global-search.svelte';
  import { quickCapture } from '$lib/stores/quick-capture.svelte';
  import { threadSwitcher } from '$lib/stores/thread-switcher.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { aboutStore } from '$lib/stores/about.svelte';
  import { saveSettings } from '$lib/stores/settings.svelte';
  import { pins, type PinSurface } from '$lib/stores/pins.svelte';
  import { presetsModal } from '$lib/stores/presets.svelte';
  import { scoreMatch } from '$lib/util/command-score';
  import {
    composerInsert,
    templates,
    templatesModal,
    type PromptTemplate
  } from '$lib/stores/templates.svelte';
  import { surfaceRefresh } from '$lib/stores/surface-refresh.svelte';
  import { CONNECTOR_PACKS } from '$lib/data/connector-packs';
  import type { Extension, MemoryNode, Routine, Skill, Thread } from '$lib/api/types';

  // -- types ----------------------------------------------------------------

  type Category =
    | 'Pinned'
    | 'Recent'
    | 'Navigate'
    | 'Actions'
    | 'Threads'
    | 'Skills'
    | 'Routines'
    | 'Templates'
    | 'Docs';

  /** Icon key used for inline SVG rendering. Recent rows persist this so the
   *  saved row can render its own glyph without re-deriving from category. */
  type IconKey =
    | 'nav'
    | 'thread'
    | 'skill'
    | 'routine'
    | 'doc'
    | 'extension'
    | 'pin'
    | 'signin'
    | 'restart'
    | 'disconnect'
    | 'refresh'
    | 'eye'
    | 'tray'
    | 'profile'
    | 'bell'
    | 'copy'
    | 'logs'
    | 'info'
    | 'layers'
    | 'template';

  interface Item {
    id: string;
    category: Category;
    label: string;
    subtitle?: string;
    keybind?: string;
    icon: IconKey;
    /**
     * Optional verb keywords used to boost ranking when the user types one
     * of these (e.g. "sign", "restart", "copy"). Only set on Action items —
     * nav rows are already match-friendly via their label.
     */
    keywords?: string[];
    /** Called when the row is activated (Enter or click). */
    run: () => void;
    /** Optional route/applicability gate, kept in sync with sidebar visibility. */
    showWhen?: () => boolean;
  }

  /** Shape persisted to localStorage. Intentionally minimal — we re-derive
   *  the `run` closure at render time using `recentRunFor`. */
  interface RecentEntry {
    id: string;
    label: string;
    icon: IconKey;
    /** Original category, so the recent row can show its provenance.    */
    sourceCategory: Category;
    /** Stored so docs/threads/routines can reconstruct the navigation. */
    subtitle?: string;
  }

  // -- caches ---------------------------------------------------------------

  let skillsCache = $state<Skill[] | null>(null);
  let routinesCache = $state<Routine[] | null>(null);
  let docsCache = $state<MemoryNode[] | null>(null);
  /**
   * Extensions cache. Needed so the cross-surface Pinned section can
   * render a friendly display name for pinned extensions — the pin
   * store only holds the bare `extension.name` id. Loaded lazily on
   * first open like the other caches; failures fall back to showing
   * the raw id with no penalty to other categories.
   */
  let extensionsCache = $state<Extension[] | null>(null);

  let loadingSkills = $state(false);
  let loadingRoutines = $state(false);
  let loadingDocs = $state(false);
  let loadingExtensions = $state(false);

  // -- ui state -------------------------------------------------------------

  let query = $state('');
  let activeIndex = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);

  /** Active section-pill filter. 'All' shows every category; otherwise we
   *  scope `filtered` down to that single bucket. */
  type PillFilter =
    | 'All'
    | 'Pinned'
    | 'Nav'
    | 'Actions'
    | 'Threads'
    | 'Skills'
    | 'Routines'
    | 'Templates'
    | 'Docs';
  const PILL_KEYS: PillFilter[] = [
    'All',
    'Pinned',
    'Nav',
    'Actions',
    'Threads',
    'Skills',
    'Routines',
    'Templates',
    'Docs'
  ];
  let activePill = $state<PillFilter>(loadPillFilter());

  /** Persist pill filter to sessionStorage so it survives close/open within
   *  a session but resets each app launch. */
  $effect(() => {
    if (typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.setItem('ironclaw-palette-pill', activePill);
    } catch {
      // Quota or disabled storage — silently ignore; the pill still works
      // in-memory and just won't persist.
    }
  });

  function loadPillFilter(): PillFilter {
    if (typeof sessionStorage === 'undefined') return 'All';
    try {
      const raw = sessionStorage.getItem('ironclaw-palette-pill');
      if (raw && (PILL_KEYS as readonly string[]).includes(raw)) {
        return raw as PillFilter;
      }
    } catch {
      // ignore
    }
    return 'All';
  }

  /** `?` slide-down: keyboard shortcut help. Toggled while the search input
   *  is empty (so `?` typed mid-query is still searched). */
  let showHelp = $state(false);

  // -- recent items (localStorage) -----------------------------------------

  const RECENT_KEY = 'ironclaw-palette-recent';
  const RECENT_MAX = 8;

  let recent = $state<RecentEntry[]>(loadRecent());

  function loadRecent(): RecentEntry[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Defensive — only keep entries with the required shape, cap length.
      return parsed
        .filter(
          (e): e is RecentEntry =>
            typeof e === 'object' &&
            e !== null &&
            typeof e.id === 'string' &&
            typeof e.label === 'string' &&
            typeof e.icon === 'string'
        )
        .slice(0, RECENT_MAX);
    } catch {
      return [];
    }
  }

  function persistRecent(entries: RecentEntry[]) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(entries));
    } catch {
      // Quota / private mode / disabled — non-fatal.
    }
  }

  /**
   * Record an item as recently used. Moves an existing entry to the front
   * rather than duplicating, then caps the list at `RECENT_MAX`.
   * Recent rows themselves are NOT re-recorded (they're already the most
   * recent — recording would no-op anyway, but skipping avoids the write).
   */
  function recordRecent(item: Item) {
    if (item.category === 'Recent') return;
    const entry: RecentEntry = {
      id: item.id,
      label: item.label,
      icon: item.icon,
      sourceCategory: item.category,
      subtitle: item.subtitle
    };
    const filtered = recent.filter((e) => e.id !== entry.id);
    const next = [entry, ...filtered].slice(0, RECENT_MAX);
    recent = next;
    persistRecent(next);
  }

  /**
   * Reconstruct a recent entry's `run` closure. We re-use the live `run`
   * from the current item list when possible (handles re-derivation of
   * dynamic action state), and fall back to a category-keyed reconstruction
   * for navigation/threads/skills/routines/docs where the entry shape is
   * deterministic.
   */
  function recentRunFor(entry: RecentEntry): () => void {
    const live = allItemsByIdLookup[entry.id];
    if (live) return live.run;
    // Fall back to category-keyed reconstruction for entries whose source
    // data is currently absent (e.g. a thread the user no longer has
    // cached, or a doc that was deleted on the gateway). We don't try to
    // be clever — just route to the surface the item came from.
    switch (entry.sourceCategory) {
      case 'Navigate':
        return () => {
          const target = entry.id.replace(/^nav:/, '');
          if (target) void goto(target);
        };
      case 'Threads':
        return () => void goto('/chat');
      case 'Skills':
        return () => void goto('/skills');
      case 'Routines':
        return () => void goto('/routines');
      case 'Docs':
        return () => void goto('/knowledge');
      case 'Actions':
        // Actions are stateful — if the underlying state isn't applicable
        // (e.g. "Disconnect" recorded while connected, then re-attempted
        // while disconnected), surface a toast rather than silently failing.
        return () => toasts.show('Action unavailable in this state.', 'info');
      default:
        return () => {
          /* no-op */
        };
    }
  }

  // -- hardcoded nav --------------------------------------------------------
  // These never change at runtime; the keybinds match the layout shortcuts
  // exactly (see `src/routes/+layout.svelte`). Onboarding intentionally has
  // no shortcut — it's a first-run takeover.
  // Order + keybinds mirror the sidebar nav in `src/lib/components/Sidebar.svelte`
  // exactly: Today → Desk → Work → Streams → Chat → Canvas → Knowledge → Memory →
  // Skills → Routines → Jobs → Logs → Extensions → Missions → Settings, then
  // Onboarding (no shortcut — first-run takeover). Digit chords match
  // ROUTES_BY_DIGIT in the layout (Jobs took ⌘5, shifting Logs→⌘6,
  // Extensions→⌘7). Desk / Streams / Canvas have no digit slot. Missions is a
  // gated Engine-v2 surface, so the palette hides it under the same setting as
  // the sidebar instead of advertising a route that immediately bounces.
  const baseNavItems: Item[] = [
    {
      id: 'nav:/dashboard',
      category: 'Navigate',
      label: 'Today',
      subtitle: '/dashboard',
      keybind: '⌘0',
      icon: 'nav',
      run: () => void goto('/dashboard')
    },
    {
      id: 'nav:/desk',
      category: 'Navigate',
      label: 'The Desk',
      subtitle: '/desk',
      icon: 'nav',
      run: () => void goto('/desk')
    },
    {
      id: 'nav:/work',
      category: 'Navigate',
      label: 'Work',
      subtitle: '/work',
      icon: 'nav',
      run: () => void goto('/work')
    },
    {
      id: 'nav:/streams',
      category: 'Navigate',
      label: 'Streams',
      subtitle: '/streams',
      icon: 'nav',
      run: () => void goto('/streams')
    },
    {
      id: 'nav:/chat',
      category: 'Navigate',
      label: 'Chat',
      subtitle: '/chat',
      keybind: '⌘1',
      icon: 'nav',
      run: () => void goto('/chat')
    },
    {
      id: 'nav:/canvas',
      category: 'Navigate',
      label: 'Canvas',
      subtitle: '/canvas',
      icon: 'nav',
      run: () => void goto('/canvas')
    },
    {
      id: 'nav:/knowledge',
      category: 'Navigate',
      label: 'Knowledge',
      subtitle: '/knowledge',
      keybind: '⌘2',
      icon: 'nav',
      run: () => void goto('/knowledge')
    },
    {
      id: 'nav:/memory',
      category: 'Navigate',
      label: 'Memory',
      subtitle: '/memory',
      keybind: '⌘M',
      icon: 'nav',
      run: () => void goto('/memory')
    },
    {
      id: 'nav:/skills',
      category: 'Navigate',
      label: 'Skills',
      subtitle: '/skills',
      keybind: '⌘3',
      icon: 'nav',
      run: () => void goto('/skills')
    },
    {
      id: 'nav:/routines',
      category: 'Navigate',
      label: 'Routines',
      subtitle: '/routines',
      keybind: '⌘4',
      icon: 'nav',
      run: () => void goto('/routines')
    },
    {
      id: 'nav:/jobs',
      category: 'Navigate',
      label: 'Jobs',
      subtitle: '/jobs',
      keybind: '⌘5',
      icon: 'nav',
      run: () => void goto('/jobs')
    },
    {
      id: 'nav:/logs',
      category: 'Navigate',
      label: 'Logs',
      subtitle: '/logs',
      keybind: '⌘6',
      icon: 'nav',
      run: () => void goto('/logs')
    },
    {
      id: 'nav:/extensions',
      category: 'Navigate',
      label: 'Extensions',
      subtitle: '/extensions',
      keybind: '⌘7',
      icon: 'nav',
      run: () => void goto('/extensions')
    },
    {
      id: 'nav:/missions',
      category: 'Navigate',
      label: 'Missions',
      subtitle: '/missions',
      keybind: '⌘9',
      icon: 'nav',
      run: () => void goto('/missions'),
      showWhen: () => connection.settings.engineV2Enabled === true
    },
    {
      id: 'nav:/settings',
      category: 'Navigate',
      label: 'Settings',
      subtitle: '/settings',
      keybind: '⌘,',
      icon: 'nav',
      run: () => void goto('/settings')
    },
    {
      id: 'nav:/onboarding',
      category: 'Navigate',
      label: 'Onboarding',
      subtitle: '/onboarding',
      icon: 'nav',
      run: () => void goto('/onboarding')
    }
  ];
  const navItems = $derived<Item[]>(
    baseNavItems.filter((item) => !item.showWhen || item.showWhen())
  );

  // -- lifecycle ------------------------------------------------------------

  // Open-driven loading. The first time `palette.open` flips to true we
  // kick off the lazy fetches for skills/routines/docs in parallel. The
  // palette stays usable while they load — nav results are always there.
  $effect(() => {
    if (palette.open) {
      void onOpen();
    } else {
      // Reset transient state when closing so the next open is a blank slate.
      query = '';
      activeIndex = 0;
      showHelp = false;
    }
  });

  async function onOpen() {
    await tick();
    inputEl?.focus();

    if (!connection.client) return;

    if (skillsCache === null && !loadingSkills) {
      loadingSkills = true;
      try {
        skillsCache = await connection.client.listSkills();
      } catch (err) {
        toasts.show(`Failed to load skills: ${(err as Error).message}`, 'error');
        skillsCache = [];
      } finally {
        loadingSkills = false;
      }
    }
    if (routinesCache === null && !loadingRoutines) {
      loadingRoutines = true;
      try {
        routinesCache = await connection.client.listRoutines();
      } catch (err) {
        toasts.show(`Failed to load routines: ${(err as Error).message}`, 'error');
        routinesCache = [];
      } finally {
        loadingRoutines = false;
      }
    }
    if (docsCache === null && !loadingDocs) {
      loadingDocs = true;
      try {
        docsCache = await connection.client.listMemory();
      } catch (err) {
        toasts.show(`Failed to load docs: ${(err as Error).message}`, 'error');
        docsCache = [];
      } finally {
        loadingDocs = false;
      }
    }
    // Extensions cache is fed only to the cross-surface Pinned section
    // for label lookup — there's no top-level Extensions pill in the
    // palette yet, so failures are silent (the row falls back to the
    // raw id and still navigates correctly).
    if (extensionsCache === null && !loadingExtensions) {
      loadingExtensions = true;
      try {
        extensionsCache = await connection.client.listExtensions();
      } catch (err) {
        console.warn('palette: failed to load extensions for pin labels', err);
        extensionsCache = [];
      } finally {
        loadingExtensions = false;
      }
    }
  }

  // -- action handlers ------------------------------------------------------
  // Kept as functions on the script (rather than inlined in `actionItems`)
  // so the cyclomatic complexity stays out of the $derived block, and so
  // recordRecent can fire on the activate() path uniformly. Each runs
  // best-effort and toasts on failure.

  async function actSignIn() {
    const ok = await connection.startSidecar();
    if (ok) {
      toasts.show('Sidecar started. IronClaw is connecting.', 'info');
      void goto('/chat');
    }
    // startSidecar already surfaces sidecarError on failure; no extra toast.
  }

  async function actRestartSidecar() {
    try {
      await connection.stopSidecar();
    } catch (err) {
      console.warn('stopSidecar failed during restart', err);
    }
    const ok = await connection.startSidecar();
    if (ok) toasts.show('Sidecar restarted.', 'info');
  }

  function actDisconnect() {
    // No dedicated disconnect() on the connection store — we stop the poll
    // loop and flip status to 'disconnected' directly. The status field is
    // `$state` and public, so this is a sanctioned mutation; the next
    // `connection.refresh()` (manual or profile-switch) will re-attach.
    connection.stopPolling();
    connection.status = 'disconnected';
    toasts.show('Disconnected. Refresh to reconnect.', 'info');
  }

  async function actRefresh() {
    try {
      await connection.refresh();
      toasts.show('Connection refreshed.', 'success');
    } catch (err) {
      toasts.show(`Refresh failed: ${(err as Error).message}`, 'error');
    }
  }

  async function actToggleAdmin(next: boolean) {
    try {
      const draft = {
        ...$state.snapshot(connection.settings),
        adminMode: next
      };
      await saveSettings(draft);
      await connection.refresh();
      toasts.show(next ? 'Admin surfaces enabled.' : 'Admin surfaces hidden.', 'info');
    } catch (err) {
      toasts.show(`Save failed: ${(err as Error).message}`, 'error');
    }
  }

  async function actToggleTray(next: boolean) {
    try {
      const draft = {
        ...$state.snapshot(connection.settings),
        trayEnabled: next
      };
      await saveSettings(draft);
      try {
        await invoke('set_tray_visible', { visible: next });
      } catch (err) {
        // Non-fatal — the persisted value still wins on next launch.
        console.warn('set_tray_visible failed', err);
      }
      await connection.refresh();
      toasts.show(next ? 'Menu-bar icon shown.' : 'Menu-bar icon hidden.', 'info');
    } catch (err) {
      toasts.show(`Save failed: ${(err as Error).message}`, 'error');
    }
  }

  /**
   * Copy `window.location.href` to the clipboard. Surfaces a toast on
   * success or failure. Mirrors the layout-level helper so the Cmd+L
   * palette action takes the same code path as the global chord.
   * Kept distinct from `copyText` because the success toast wording
   * differs ("Link copied." vs "<label> copied to clipboard.") to
   * match the layout-level chord's UX exactly.
   */
  async function copyCurrentUrl(): Promise<void> {
    if (
      typeof window === 'undefined' ||
      typeof navigator === 'undefined' ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== 'function'
    ) {
      toasts.show('Copy failed', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(window.location.href);
      toasts.show('Link copied.', 'success');
    } catch {
      toasts.show('Copy failed', 'error');
    }
  }

  async function copyText(value: string, label: string, warn = false) {
    if (
      typeof navigator === 'undefined' ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== 'function'
    ) {
      toasts.show('Clipboard unavailable here.', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      if (warn) {
        toasts.show(`${label} copied — treat as a secret; do not paste anywhere public.`, 'info');
      } else {
        toasts.show(`${label} copied to clipboard.`, 'success');
      }
    } catch (err) {
      toasts.show(`Copy failed: ${(err as Error).message}`, 'error');
    }
  }

  function connectorSetupHref(focus: string): string {
    const params = new URLSearchParams({ focus });
    params.set('setup', '1');
    return `/extensions?${params.toString()}`;
  }

  function connectorAliasLabel(id: string): string {
    const aliases: Record<string, string> = {
      gmail: 'Gmail',
      google_calendar: 'Google Calendar',
      slack: 'Slack',
      slack_tool: 'Slack search',
      notion: 'Notion'
    };
    return (
      aliases[id] ??
      id
        .split(/[_-]+/)
        .filter(Boolean)
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join(' ')
    );
  }

  // -- actions (dynamic, applicability-gated) -------------------------------
  // We re-derive the action list every render so toggles reflect the
  // current state instantly. Each row is responsible for its own
  // applicability check; the $derived block just filters out null entries.

  const actionItems = $derived<Item[]>(
    (() => {
      const mode = connection.activeProfile?.mode;
      const sidecarRunning = connection.sidecarStatus === 'running';
      const connected = connection.status === 'connected';
      const admin = connection.settings.adminMode === true;
      const tray = connection.settings.trayEnabled !== false;
      const baseUrl = connection.baseUrl ?? '';
      const token = connection.token ?? '';

      const rows: Array<Item | null> = [
        ...CONNECTOR_PACKS.flatMap((pack) => {
          const core = pack.core_extensions ?? [pack.primary_extension_id];
          const packRow: Item = {
            id: `action:connect-pack:${pack.id}`,
            category: 'Actions' as const,
            label: `Connect ${pack.display_name}`,
            subtitle: pack.description,
            icon: 'extension' as const,
            keywords: [
              'connect',
              'connector',
              'setup',
              'workspace',
              'oauth',
              pack.id,
              pack.display_name,
              ...pack.extensions,
              ...pack.example_tasks
            ],
            run: () => void goto(connectorSetupHref(pack.primary_extension_id))
          };
          const coreRows = core.map<Item>((extensionId) => ({
            id: `action:connect-extension:${extensionId}`,
            category: 'Actions' as const,
            label: `Connect ${connectorAliasLabel(extensionId)}`,
            subtitle: `Set up ${pack.display_name}`,
            icon: 'extension' as const,
            keywords: [
              'connect',
              'connector',
              'setup',
              'workspace',
              'oauth',
              pack.id,
              pack.display_name,
              extensionId,
              connectorAliasLabel(extensionId)
            ],
            run: () => void goto(connectorSetupHref(extensionId))
          }));
          return [packRow, ...coreRows];
        }),
        // Reload current surface — Cmd+R chord. Closes the palette
        // first so the post-refresh toast lands cleanly. Falls through
        // silently when the active route hasn't registered a refresh
        // handler (rare; only between route transitions).
        {
          id: 'action:reload-surface',
          category: 'Actions' as const,
          label: 'Reload current surface',
          subtitle: 'Refetch data for this view',
          icon: 'refresh' as const,
          keywords: ['reload', 'refresh', 'refetch', 'surface', 'current', 'view'],
          keybind: '⌘R',
          run: () => {
            palette.closePalette();
            void surfaceRefresh.invoke().then((fired) => {
              if (fired) toasts.show('Refreshed.', 'info');
            });
          }
        },
        // Copy a link to this view — Cmd+L chord. Captures the full URL
        // including any deep-link query params or hash so the recipient
        // lands on the exact same view. Tauri owns the URL bar (it's
        // not user-visible), so this is the only way for the user to
        // grab the link to send to a teammate / paste into a doc.
        {
          id: 'action:copy-link',
          category: 'Actions' as const,
          label: 'Copy link to this view',
          subtitle: 'Includes query params and hash',
          icon: 'copy' as const,
          keywords: ['copy', 'link', 'url', 'deep', 'share', 'view'],
          keybind: '⌘L',
          run: () => {
            palette.closePalette();
            void copyCurrentUrl();
          }
        },
        // Cross-surface search — opens the GlobalSearch modal. Always
        // available; closes the palette first so the search modal lands
        // on a clean chrome (otherwise its backdrop sits underneath the
        // palette's). Keybind matches the layout-level shortcut.
        {
          id: 'action:search-everywhere',
          category: 'Actions' as const,
          label: 'Search everywhere',
          subtitle: 'Knowledge, threads, jobs, skills, routines, extensions',
          icon: 'eye' as const,
          keywords: [
            'search',
            'find',
            'everywhere',
            'global',
            'knowledge',
            'threads',
            'jobs',
            'skills',
            'routines',
            'extensions'
          ],
          keybind: '⌘⇧F',
          run: () => {
            palette.closePalette();
            globalSearch.show();
          }
        },
        // Quick thread switcher (Cmd+T). Discoverable from the palette so
        // users who don't yet know the chord can jump in here. Closes the
        // palette first so the switcher's backdrop lands on a clean chrome.
        // Reuses the `thread` icon for visual continuity with thread rows.
        {
          id: 'action:switch-thread',
          category: 'Actions' as const,
          label: 'Switch thread',
          subtitle: 'Jump to a conversation by title',
          icon: 'thread' as const,
          keywords: ['switch', 'thread', 'jump', 'chat', 'conversation'],
          keybind: '⌘T',
          run: () => {
            palette.closePalette();
            threadSwitcher.show();
          }
        },
        // Quick capture (Cmd+Shift+N). Drops a note into a dedicated
        // "Quick captures" thread without forcing navigation. Same
        // close-then-show ordering as the other modal-summon actions so
        // the overlay backdrop lands on a clean chrome. Icon reuses
        // `thread` — the destination IS a thread; the dedicated 'bolt'
        // glyph would be nice but lives in Icon.svelte's vocabulary, not
        // the palette's smaller IconKey enum.
        {
          id: 'action:quick-capture',
          category: 'Actions' as const,
          label: 'Quick capture',
          subtitle: 'New message to the Quick captures thread',
          icon: 'thread' as const,
          keywords: ['quick', 'capture', 'note', 'jot', 'inbox', 'thought', 'scratch'],
          keybind: '⌘⇧N',
          run: () => {
            palette.closePalette();
            quickCapture.show();
          }
        },
        // Sign in to NEAR.AI — local-mode only, sidecar offline path.
        mode === 'local' && !sidecarRunning
          ? {
              id: 'action:sign-in',
              category: 'Actions' as const,
              label: 'Sign in to NEAR.AI',
              subtitle: 'Start the local sidecar and open chat',
              icon: 'signin' as const,
              keywords: ['sign', 'login', 'auth', 'nearai', 'near'],
              run: () => void actSignIn()
            }
          : null,
        // Restart sidecar — local + sidecar already up.
        mode === 'local' && sidecarRunning
          ? {
              id: 'action:restart-sidecar',
              category: 'Actions' as const,
              label: 'Restart sidecar',
              subtitle: 'Stop and re-spawn the local IronClaw process',
              icon: 'restart' as const,
              keywords: ['restart', 'reboot', 'reload', 'sidecar'],
              run: () => void actRestartSidecar()
            }
          : null,
        // Disconnect — only when we're actually connected (so the row's
        // semantics make sense).
        connected
          ? {
              id: 'action:disconnect',
              category: 'Actions' as const,
              label: 'Disconnect',
              subtitle: 'Stop the health-poll loop and mark offline',
              icon: 'disconnect' as const,
              keywords: ['disconnect', 'offline', 'stop'],
              run: () => actDisconnect()
            }
          : null,
        // Refresh connection — always shown.
        {
          id: 'action:refresh',
          category: 'Actions' as const,
          label: 'Refresh connection',
          subtitle: 'Reload settings and re-ping the gateway',
          icon: 'refresh' as const,
          keywords: ['refresh', 'reload', 'reconnect', 'ping'],
          run: () => void actRefresh()
        },
        // Admin-surfaces toggle — label flips based on current state.
        {
          id: 'action:toggle-admin',
          category: 'Actions' as const,
          label: admin ? 'Hide admin surfaces' : 'Show admin surfaces',
          subtitle: admin ? 'Retract /admin route and Cmd+7' : 'Reveal /admin route and Cmd+7',
          icon: 'eye' as const,
          keywords: ['admin', 'toggle', 'show', 'hide'],
          run: () => void actToggleAdmin(!admin)
        },
        // Menu-bar icon toggle.
        {
          id: 'action:toggle-tray',
          category: 'Actions' as const,
          label: 'Toggle menu-bar icon',
          subtitle: tray ? 'Currently shown' : 'Currently hidden',
          icon: 'tray' as const,
          keywords: ['tray', 'menubar', 'menu', 'icon', 'toggle'],
          run: () => void actToggleTray(!tray)
        },
        // Settings deep-links.
        {
          id: 'action:settings-profiles',
          category: 'Actions' as const,
          label: 'Open settings → Profiles',
          subtitle: '/settings#profiles',
          icon: 'profile' as const,
          keywords: ['profile', 'profiles', 'settings'],
          run: () => void goto('/settings#profiles')
        },
        {
          id: 'action:settings-notifications',
          category: 'Actions' as const,
          label: 'Open settings → Notifications',
          subtitle: '/settings#notifications',
          icon: 'bell' as const,
          keywords: ['notifications', 'notify', 'alerts', 'settings'],
          // Anchored via id="notifications" + scroll-mt-6 on the surface
          // card in /settings.
          run: () => void goto('/settings#notifications')
        },
        // Copy actions — gated on having something to copy.
        baseUrl
          ? {
              id: 'action:copy-baseurl',
              category: 'Actions' as const,
              label: 'Copy gateway URL',
              subtitle: baseUrl,
              icon: 'copy' as const,
              keywords: ['copy', 'gateway', 'url', 'base'],
              run: () => void copyText(baseUrl, 'Gateway URL')
            }
          : null,
        token
          ? {
              id: 'action:copy-token',
              category: 'Actions' as const,
              label: 'Copy connection token',
              subtitle: 'Bearer token for the active profile',
              icon: 'copy' as const,
              keywords: ['copy', 'token', 'bearer', 'secret'],
              run: () => void copyText(token, 'Connection token', true)
            }
          : null,
        // Logs deep-link — duplicates Cmd+5 but discoverable via the palette.
        {
          id: 'action:open-logs',
          category: 'Actions' as const,
          label: 'Open logs',
          subtitle: '/logs',
          icon: 'logs' as const,
          keywords: ['logs', 'log', 'console', 'output'],
          run: () => void goto('/logs')
        },
        // About — opens the modal at the layout level. Always available.
        // Close the palette first so the modal lands on a clean chrome
        // (the palette would otherwise sit on top of the modal's backdrop).
        {
          id: 'action:about',
          category: 'Actions' as const,
          label: 'About IronClaw Desktop',
          subtitle: 'Version, gateway info, profile, system',
          icon: 'info' as const,
          keywords: ['about', 'version', 'info', 'help', 'credits'],
          run: () => {
            palette.closePalette();
            aboutStore.show();
          }
        },
        // Workspace presets — opens the modal at the layout level. Same
        // close-then-show ordering as the other modal-summon actions so
        // the overlay backdrop lands on a clean chrome. Keybind matches
        // the layout-level Cmd+Shift+P chord.
        {
          id: 'action:presets',
          category: 'Actions' as const,
          label: 'Workspace presets',
          subtitle: 'Save, apply, rename, or delete layout snapshots',
          icon: 'layers' as const,
          keywords: ['preset', 'presets', 'workspace', 'layout', 'snapshot', 'save', 'restore'],
          keybind: '⌘⇧P',
          run: () => {
            palette.closePalette();
            presetsModal.show();
          }
        },
        // Save-current-as-preset shortcut — opens the same modal but
        // pre-focuses the save input so the user types a name and hits
        // Enter. Distinct row so search by "save" / "snapshot" surfaces
        // the inline-save flow without the user picking the generic
        // presets entry first.
        {
          id: 'action:save-preset',
          category: 'Actions' as const,
          label: 'Save current workspace as preset…',
          subtitle: 'Capture route, thread, panel widths, sidebar state',
          icon: 'layers' as const,
          keywords: ['save', 'preset', 'snapshot', 'workspace', 'capture', 'layout'],
          run: () => {
            palette.closePalette();
            presetsModal.show('save');
          }
        },
        // Prompt templates — opens the modal at the layout level. Same
        // close-then-show ordering as the preset action. Keybind matches
        // the layout-level Cmd+Shift+T chord. Per-template entries also
        // appear under the Templates category section below so a user
        // can search for a specific template name and hit Enter without
        // picking this generic row first.
        {
          id: 'action:templates',
          category: 'Actions' as const,
          label: 'Prompt templates',
          subtitle: 'Manage and insert saved composer prompts',
          icon: 'template' as const,
          keywords: ['template', 'templates', 'prompt', 'composer', 'snippet', 'macro'],
          keybind: '⌘⇧T',
          run: () => {
            palette.closePalette();
            templatesModal.show();
          }
        },
        // Component playground — dev-only. Surfaced only when Vite's
        // `import.meta.env.DEV` is true so production builds never offer
        // the entry point. The route itself also enforces the guard via
        // a redirect, so a stale bookmark to `/dev/playground` in a prod
        // build bounces to `/` with a toast — but hiding the palette row
        // keeps the surface clean for non-contributor users.
        import.meta.env.DEV
          ? {
              id: 'action:open-playground',
              category: 'Actions' as const,
              label: 'Open component playground (dev)',
              subtitle: '/dev/playground — Storybook-lite for $lib/components',
              icon: 'layers' as const,
              keywords: ['playground', 'storybook', 'components', 'dev', 'stories', 'preview'],
              run: () => {
                palette.closePalette();
                void goto('/dev/playground');
              }
            }
          : null
      ];

      return rows.filter((r): r is Item => r !== null);
    })()
  );

  // -- items ----------------------------------------------------------------

  // Threads come from the in-memory store. We intentionally do NOT call
  // `threads.loadThreads()` here — only show what's already cached. If the
  // user hasn't visited the chat surface yet, this list is empty.
  const threadItems = $derived<Item[]>(
    threads.threads.map((t: Thread) => ({
      id: `thread:${t.id}`,
      category: 'Threads' as const,
      label: t.title || 'Untitled thread',
      subtitle: t.message_count
        ? `${t.message_count} message${t.message_count === 1 ? '' : 's'}`
        : 'Empty',
      icon: 'thread' as const,
      run: () => {
        threads.selectThread(t.id);
        void goto('/chat');
      }
    }))
  );

  /**
   * Map a pin surface to the icon glyph it should render in the
   * cross-surface Pinned section. Mirrors the per-surface category
   * icons (so a pinned skill looks like the skill row in the rest of
   * the palette) but routed through `IconKey` rather than `Category`.
   */
  function iconForSurface(surface: PinSurface): IconKey {
    switch (surface) {
      case 'skill':
        return 'skill';
      case 'routine':
        return 'routine';
      case 'knowledge':
        return 'doc';
      case 'thread':
        return 'thread';
      case 'extension':
        return 'extension';
      default:
        return 'pin';
    }
  }

  /** Human-readable surface label for the subtitle badge in the
   *  Pinned row. */
  function surfaceLabel(surface: PinSurface): string {
    switch (surface) {
      case 'skill':
        return 'Skill';
      case 'routine':
        return 'Routine';
      case 'knowledge':
        return 'Knowledge';
      case 'thread':
        return 'Thread';
      case 'extension':
        return 'Extension';
      default:
        return surface;
    }
  }

  /**
   * Cross-surface pinned items. Each entry in `pins.all()` becomes a
   * row that navigates to the source surface — using the same closures
   * the per-surface item factories above generate when the underlying
   * record is still loaded. When the cache hasn't loaded yet (or the
   * record is gone), the row still renders with the raw id as the
   * label and a fallback navigation to the source surface so the user
   * isn't stranded.
   *
   * Order: pins are emitted in `pins.all()` order, which iterates
   * surfaces in declaration order then pins within each surface in
   * insertion order. That gives a stable, predictable list across
   * renders without needing a secondary sort.
   */
  const pinnedItems = $derived<Item[]>(
    pins.all().map(({ surface, id }) => {
      const icon = iconForSurface(surface);
      const surfaceTag = surfaceLabel(surface);
      let label = id;
      let run: () => void = () => void goto('/chat');
      switch (surface) {
        case 'skill': {
          const s = skillsCache?.find((sk) => sk.name === id);
          label = s?.name ?? id;
          run = () => {
            const hint = s?.usage_hint ?? `/${id}`;
            composerInsert.push(hint);
            void goto('/chat');
          };
          break;
        }
        case 'routine': {
          const r = routinesCache?.find((rt) => rt.id === id);
          label = r?.name ?? id;
          run = () => void goto(`/routines?open=${encodeURIComponent(id)}`);
          break;
        }
        case 'knowledge': {
          label = id;
          run = () => void goto(`/knowledge?path=${encodeURIComponent(id)}`);
          break;
        }
        case 'thread': {
          const t = threads.threads.find((th) => th.id === id);
          label = t?.title || 'Untitled thread';
          run = () => {
            threads.selectThread(id);
            void goto('/chat');
          };
          break;
        }
        case 'extension': {
          const e = extensionsCache?.find((ext) => ext.name === id);
          label = e?.display_name ?? e?.name ?? id;
          run = () => void goto(`/extensions?focus=${encodeURIComponent(id)}`);
          break;
        }
      }
      return {
        id: `pinned:${surface}:${id}`,
        category: 'Pinned' as const,
        label,
        subtitle: surfaceTag,
        icon,
        run
      };
    })
  );

  const skillItems = $derived<Item[]>(
    (skillsCache ?? []).map((s) => ({
      id: `skill:${s.name}`,
      category: 'Skills' as const,
      label: s.name,
      subtitle: s.description || s.usage_hint || '',
      icon: 'skill' as const,
      run: () => {
        const hint = s.usage_hint ?? `/${s.name}`;
        void goto(`/?prefill=${encodeURIComponent(hint)}`);
      }
    }))
  );

  // `/routines/+page.svelte` reads `?open=<id>` on mount and opens the
  // matching detail panel (wired in R15a). It also strips the param from the
  // URL after consumption so a refresh doesn't re-trigger the open.
  const routineItems = $derived<Item[]>(
    (routinesCache ?? []).map((r) => ({
      id: `routine:${r.id}`,
      category: 'Routines' as const,
      label: r.name,
      subtitle: r.schedule || (r.enabled ? 'enabled' : 'disabled'),
      icon: 'routine' as const,
      run: () => {
        void goto(`/routines?open=${encodeURIComponent(r.id)}`);
      }
    }))
  );

  // `/knowledge/+page.svelte` reads `?path=<encoded>` on mount and selects
  // the matching tree node + opens the viewer (wired in R15a). Param is
  // stripped after consumption so a refresh doesn't re-trigger the select.
  const docItems = $derived<Item[]>(
    (docsCache ?? []).map((d) => ({
      id: `doc:${d.path}`,
      category: 'Docs' as const,
      label: d.path,
      subtitle: d.type === 'dir' ? 'folder' : 'file',
      icon: 'doc' as const,
      run: () => {
        void goto(`/knowledge?path=${encodeURIComponent(d.path)}`);
      }
    }))
  );

  /**
   * Per-template palette entries. Each saved template gets a row
   * prefixed "Template: <name>" so it's distinguishable from skills
   * and from the generic "Prompt templates" action above. Insertion
   * semantics mirror the modal's flow:
   *   - Template with no variables → push body straight to the
   *     composer bus and navigate to chat.
   *   - Template with variables    → open the templates modal scoped
   *     to that template so the user fills the inline variable-input
   *     view (same UX as picking from the modal directly).
   * Templates are read off the live store so the list reflects the
   * latest saves without a cache hop.
   */
  const templateItems = $derived<Item[]>(
    templates.templates.map((t: PromptTemplate) => ({
      id: `template:${t.id}`,
      category: 'Templates' as const,
      label: `Template: ${t.name}`,
      subtitle:
        t.variables.length > 0
          ? `${t.variables.length} variable${t.variables.length === 1 ? '' : 's'} · ${t.useCount} use${t.useCount === 1 ? '' : 's'}`
          : `${t.useCount} use${t.useCount === 1 ? '' : 's'}`,
      icon: 'template' as const,
      run: () => {
        if (t.variables.length > 0) {
          // Route into the modal so the user gets the variable-input
          // view rather than landing in a half-rendered prompt.
          templatesModal.show(t.id);
        } else {
          // No variables → drop the body straight into the composer
          // bus and navigate to chat. The chat page's $effect picks up
          // the bus on its next mount (or immediately if already on /).
          composerInsert.push(t.body, t.id);
          templates.recordUse(t.id);
          if (typeof window !== 'undefined' && window.location.pathname !== '/') {
            void goto('/chat');
          }
        }
      }
    }))
  );

  /** Everything searchable (excluding the Recent and Pinned virtual
   *  categories). Recent + Pinned rows live alongside but never
   *  participate in fuzzy ranking — they're rendered as static sections
   *  when the query is empty so the user can scan their explicit lists. */
  const allItems = $derived<Item[]>([
    ...navItems,
    ...actionItems,
    ...threadItems,
    ...skillItems,
    ...routineItems,
    ...templateItems,
    ...docItems
  ]);

  /** Recent-by-id lookup so `recentRunFor` can prefer the live closure when
   *  the item still exists in the current data set. */
  const allItemsByIdLookup = $derived<Record<string, Item>>(
    allItems.reduce<Record<string, Item>>((acc, item) => {
      acc[item.id] = item;
      return acc;
    }, {})
  );

  /** Recent items, hydrated into renderable `Item`s. Only shown when query
   *  is empty and pill is "All" (so a scoped search isn't drowned by the
   *  recent list). */
  const recentItems = $derived<Item[]>(
    recent
      .filter((e) => activePill === 'All')
      .map((e) => ({
        id: `recent:${e.id}`,
        category: 'Recent' as const,
        label: e.label,
        subtitle: e.subtitle,
        icon: e.icon,
        run: recentRunFor(e)
      }))
  );

  /** Recent-id membership set for the +0.5 score-bonus path. We compare on
   *  the underlying id (sans `recent:` prefix), so a "recently ran chat"
   *  boosts the live `nav:/` row too — not just the duplicate recent row. */
  const recentIdSet = $derived<Set<string>>(new Set(recent.map((e) => e.id)));

  // -- filter & rank --------------------------------------------------------

  /** Result limit. Anything past this slot is dropped after sorting. */
  const RESULT_CAP = 50;

  /** Map pill → category filter set. 'All' means no filter; the keys must
   *  match the category strings produced by the item factories above.
   *  'Pinned' is handled specially in `grouped` below — it's an opt-in
   *  view of the cross-surface pin list rather than a search filter,
   *  so we never let it through to ranking (the pinned rows always
   *  render at the top of `grouped` instead). */
  function pillCategoryAllowed(pill: PillFilter, cat: Category): boolean {
    if (pill === 'All') return true;
    if (pill === 'Pinned') return false; // ranked rows are hidden when scoping to pins
    if (pill === 'Nav') return cat === 'Navigate';
    return pill === cat;
  }

  const filtered = $derived<Item[]>(rankAndFilter(allItems, query, activePill));

  /** Results bucketed by category. Pinned + Recent hoist to the top
   *  when the user has no active query (so the user can scan their
   *  explicit lists / most-recent jumps); both are hidden once the
   *  user starts typing and replaced by ranked matches across the live
   *  categories. The 'Pinned' pill is special-cased to show ONLY the
   *  cross-surface pin list (no ranked rows) — letting the user open
   *  the palette and pivot straight to a favorites view. */
  const grouped = $derived.by<Array<{ category: Category; items: Item[] }>>(() => {
    const order: Category[] = [
      'Pinned',
      'Recent',
      'Navigate',
      'Actions',
      'Threads',
      'Skills',
      'Routines',
      'Templates',
      'Docs'
    ];
    const buckets = new Map<Category, Item[]>();

    // Pinned: render on empty query with the All pill, OR whenever the
    // Pinned pill is selected (regardless of query). When the pill is
    // active and a query is set we client-side filter the pinned rows
    // by label so the user can search within their pins.
    const pillIsPinned = activePill === 'Pinned';
    const showPinned =
      pinnedItems.length > 0 && ((query.trim() === '' && activePill === 'All') || pillIsPinned);
    if (showPinned) {
      const q = query.trim().toLowerCase();
      const pinnedSlice = q
        ? pinnedItems.filter(
            (p) => p.label.toLowerCase().includes(q) || (p.subtitle ?? '').toLowerCase().includes(q)
          )
        : pinnedItems;
      if (pinnedSlice.length > 0) {
        buckets.set('Pinned', pinnedSlice);
      }
    }

    // Recent: only when the user is on All with an empty query.
    if (query.trim() === '' && activePill === 'All' && recentItems.length > 0) {
      buckets.set('Recent', recentItems);
    }

    // Ranked categories: when the Pinned pill is active we deliberately
    // suppress these so the view stays a pure favorites list.
    if (!pillIsPinned) {
      for (const item of filtered) {
        const arr = buckets.get(item.category) ?? [];
        arr.push(item);
        buckets.set(item.category, arr);
      }
    }
    return order
      .filter((c) => (buckets.get(c) ?? []).length > 0)
      .map((c) => ({ category: c, items: buckets.get(c) ?? [] }));
  });

  // Flat ordered view used for keyboard navigation. Mirrors `grouped`
  // exactly so arrow-key index lines up with the row a user is looking at.
  const flat = $derived<Item[]>(grouped.flatMap((g) => g.items));

  // Clamp activeIndex into range whenever the result set shrinks beneath it.
  $effect(() => {
    if (activeIndex >= flat.length) {
      activeIndex = Math.max(0, flat.length - 1);
    }
  });

  // Keep the active row scrolled into view as the user arrows through.
  $effect(() => {
    void activeIndex;
    void tick().then(() => {
      const el = listEl?.querySelector(`[data-row-index="${activeIndex}"]`) as HTMLElement | null;
      el?.scrollIntoView({ block: 'nearest' });
    });
  });

  // -- handlers -------------------------------------------------------------

  function activate(item: Item) {
    // Resolve back to the live item when this is a Recent row so the
    // closure binds to current state (and we record the underlying id,
    // not the `recent:` wrapper, so future boosts work).
    if (item.category === 'Recent') {
      const baseId = item.id.replace(/^recent:/, '');
      const live = allItemsByIdLookup[baseId];
      if (live) {
        live.run();
        recordRecent(live);
        palette.closePalette();
        return;
      }
    }
    item.run();
    recordRecent(item);
    palette.closePalette();
  }

  function setPill(p: PillFilter) {
    activePill = p;
    activeIndex = 0;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (showHelp) {
        showHelp = false;
        return;
      }
      palette.closePalette();
      return;
    }
    // `?` toggles shortcut help — only when the search input is empty so
    // the user can still type `?` mid-query. The keyboard event fires on
    // the input itself, so we check its current value (`query`).
    if (e.key === '?' && query.trim() === '') {
      e.preventDefault();
      showHelp = !showHelp;
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flat.length > 0) activeIndex = (activeIndex + 1) % flat.length;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length > 0) activeIndex = activeIndex === 0 ? flat.length - 1 : activeIndex - 1;
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = flat[activeIndex];
      if (item) activate(item);
    }
  }

  function onBackdropClick(e: MouseEvent) {
    // Only close when the click lands on the backdrop itself, not on a
    // child that bubbled up.
    if (e.target === e.currentTarget) {
      palette.closePalette();
    }
  }

  // -- search ---------------------------------------------------------------
  // Subsequence + prefix/substring scoring. Higher score = better match.
  // We deliberately avoid a vendored fuzzy lib — the surface is small
  // (a few hundred items at most) and the scoring is easy to tune.
  //
  // Score scale (after boosts):
  //   - Exact full-token match           → 2000+ (top of list)
  //   - Prefix match                     → 1000 - excess
  //   - Substring match                  → 500 - offset
  //   - Subsequence match                → 100 - gaps
  //
  // Boost multipliers (applied after raw score):
  //   - Recent items                     → ×1.5 (the "+0.5" boost)
  //   - Action keyword match (verb hits) → small additive
  function rankAndFilter(items: Item[], q: string, pill: PillFilter): Item[] {
    const needle = q.trim().toLowerCase();
    // Scope by pill first so we don't waste scoring work on filtered-out
    // categories.
    const scoped = items.filter((item) => pillCategoryAllowed(pill, item.category));

    if (!needle) return scoped.slice(0, RESULT_CAP);

    const scored: Array<{ score: number; item: Item }> = [];
    for (const item of scoped) {
      const hay = item.label.toLowerCase();
      const sub = (item.subtitle ?? '').toLowerCase();

      // Exact full-token match — top of the list. We split on whitespace so
      // a typed token like "logs" exact-matches "Open logs" via the second
      // token (it's the strongest possible signal short of equality).
      let raw = 0;
      if (hay === needle) {
        raw = 2000;
      } else {
        const labelScore = scoreMatch(hay, needle);
        const subScore = scoreMatch(sub, needle);
        // Subtitle hits count for half — primary signal is the label.
        raw = Math.max(labelScore, subScore * 0.5);

        // Token-level exact match (e.g. "logs" matches the word "logs"
        // inside "Open logs"). Stronger than substring but weaker than a
        // whole-label exact match.
        if (raw > 0 && raw < 1500) {
          const tokens = hay.split(/\s+/);
          if (tokens.includes(needle)) raw = Math.max(raw, 1500);
        }
      }

      if (raw <= 0) continue;

      // Action keyword boost — additive so it nudges without overwhelming
      // a stronger label hit. Only fires when the typed needle matches one
      // of the action's verb keywords exactly.
      if (item.category === 'Actions' && item.keywords) {
        if (item.keywords.some((k) => k === needle || k.startsWith(needle))) {
          raw += 50;
        }
      }

      // Recent-items boost — the spec calls for "+0.5" which we interpret
      // on the normalized score scale as a 1.5× multiplier so recent items
      // float above same-tier siblings without crashing the ordering of
      // genuinely better matches.
      if (recentIdSet.has(item.id)) {
        raw = raw * 1.5;
      }

      scored.push({ score: raw, item });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, RESULT_CAP).map((s) => s.item);
  }

  // Tiered match scoring (`scoreMatch`) lives in $lib/util/command-score — a
  // tested pure helper (prefix > substring > subsequence). Callers pass
  // pre-lowercased strings.

  // Row-index lookup for click handlers — items are addressed by id but
  // keyboard nav is indexed, so we maintain a parallel map.
  const flatIndexById = $derived<Record<string, number>>(
    flat.reduce<Record<string, number>>((acc, item, i) => {
      acc[item.id] = i;
      return acc;
    }, {})
  );
</script>

{#if palette.open}
  <!-- Backdrop. Click-outside closes. svelte-a11y: this is a modal dialog,
       the input traps focus implicitly via autofocus + global listener. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[60] flex items-start justify-center pt-[10vh] bg-black/60 backdrop-blur-sm"
    onclick={onBackdropClick}
    role="presentation"
  >
    <div
      class="w-[640px] max-w-[92vw] h-[60vh] max-h-[680px] flex flex-col bg-bg-deep border border-accent-cyan/40 rounded-xl shadow-2xl overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <!-- Search input -->
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
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          bind:this={inputEl}
          bind:value={query}
          onkeydown={onKeyDown}
          type="text"
          placeholder="Search commands, threads, skills, docs… (? for shortcuts)"
          aria-label="Command palette search"
          class="flex-1 bg-transparent border-0 outline-none text-base font-medium text-text-primary placeholder:text-text-muted/60"
          spellcheck="false"
          autocomplete="off"
        />
        <kbd
          class="hidden sm:inline-block text-[10px] text-text-muted border border-border-subtle rounded px-1.5 py-0.5 font-mono"
        >
          ESC
        </kbd>
      </div>

      <!-- Section pills. Click to scope results; the active pill persists in
           sessionStorage so a user who scopes once stays scoped within the
           session, but a fresh app launch resets to "All". -->
      <div
        class="flex items-center gap-1.5 px-5 py-2 border-b border-border-subtle overflow-x-auto"
      >
        {#each PILL_KEYS as pill (pill)}
          {@const active = activePill === pill}
          <button
            type="button"
            onclick={() => setPill(pill)}
            class="px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide border transition shrink-0"
            class:bg-accent-cyan={active}
            class:text-bg-deep={active}
            class:border-accent-cyan={active}
            class:text-text-muted={!active}
            class:border-border-subtle={!active}
            class:hover:text-text-primary={!active}
            class:hover:border-text-muted={!active}
          >
            {pill}
          </button>
        {/each}
      </div>

      <!-- Shortcut help (slide-down). Press `?` to open while the input is
           empty; press `?` or Esc again to close. Renders inside the panel
           rather than as a modal so the user can still see search context. -->
      {#if showHelp}
        <div class="px-5 py-3 border-b border-border-subtle bg-bg-surface/40 text-xs space-y-1.5">
          <div class="text-[10px] uppercase tracking-widest text-text-muted/70 mb-1">
            Keyboard shortcuts
          </div>
          {#each [{ k: '⌘K', d: 'Open / close palette' }, { k: '⌘0', d: 'Today' }, { k: '⌘1', d: 'Chat' }, { k: '⌘2..7', d: 'Knowledge, Skills, Routines, Jobs, Logs, Extensions' }, { k: '⌘8', d: 'Admin (if enabled)' }, { k: '⌘9', d: 'Missions (if enabled)' }, { k: '⌘,', d: 'Open Settings' }, { k: '↑ / ↓', d: 'Navigate results' }, { k: '↵', d: 'Activate selection' }, { k: '?', d: 'Toggle this panel (when search is empty)' }, { k: 'Esc', d: 'Close panel / close palette' }] as row (row.k)}
            <div class="flex items-center gap-3">
              <kbd
                class="text-text-primary border border-border-subtle rounded px-1.5 py-0.5 min-w-[3.5rem] text-center shrink-0"
              >
                {row.k}
              </kbd>
              <span class="text-text-muted">{row.d}</span>
            </div>
          {/each}
        </div>
      {/if}

      <!-- Results -->
      <div bind:this={listEl} class="flex-1 overflow-y-auto py-2">
        {#if flat.length === 0}
          <div class="px-5 py-8 text-center text-sm text-text-muted">
            {#if loadingSkills || loadingRoutines || loadingDocs || loadingExtensions}
              Loading…
            {:else if activePill === 'Pinned' && pinnedItems.length === 0}
              <!-- Explicit empty-state for the Pinned pill so the user
                   knows the section is intentional, not a load failure. -->
              No pins yet. Star a skill, routine, thread, or extension to pin it.
            {:else if query.trim()}
              No matches for <span class="text-text-primary">{query}</span>
            {:else}
              No items.
            {/if}
          </div>
        {:else}
          {#each grouped as group (group.category)}
            <div class="mb-1">
              <!-- Pinned section header gets the gold accent so users can
                   scan past the (longer) ranked list and find their
                   cross-surface favorites quickly. -->
              <div
                class="px-5 pt-2 pb-1 text-[10px] font-mono uppercase tracking-widest"
                class:text-accent-gold={group.category === 'Pinned'}
                class:text-text-muted={group.category !== 'Pinned'}
                style={group.category !== 'Pinned' ? 'opacity:.7' : ''}
              >
                {group.category}
              </div>
              {#each group.items as item (item.id)}
                {@const idx = flatIndexById[item.id]}
                {@const active = idx === activeIndex}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  data-row-index={idx}
                  onclick={() => activate(item)}
                  onmouseenter={() => (activeIndex = idx)}
                  class="mx-2 px-3 py-2 rounded-md flex items-center gap-3 cursor-pointer border-l-2 transition-colors"
                  class:bg-bg-surface={active}
                  class:border-accent-cyan={active}
                  class:border-transparent={!active}
                  class:hover:bg-bg-surface={!active}
                >
                  <span class="text-text-muted shrink-0">
                    {#if item.icon === 'nav'}
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    {:else if item.icon === 'thread'}
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                    {:else if item.icon === 'skill'}
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path
                          d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
                        />
                      </svg>
                    {:else if item.icon === 'routine'}
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
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                    {:else if item.icon === 'doc'}
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                      </svg>
                    {:else if item.icon === 'signin'}
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                        <polyline points="10 17 15 12 10 7" />
                        <line x1="15" y1="12" x2="3" y2="12" />
                      </svg>
                    {:else if item.icon === 'restart'}
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M23 4v6h-6" />
                        <path d="M1 20v-6h6" />
                        <path
                          d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"
                        />
                      </svg>
                    {:else if item.icon === 'disconnect'}
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M9 12h6" />
                        <path d="M9 6h6a6 6 0 0 1 0 12H9" />
                        <line x1="3" y1="6" x2="21" y2="18" />
                      </svg>
                    {:else if item.icon === 'refresh'}
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
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                      </svg>
                    {:else if item.icon === 'eye'}
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    {:else if item.icon === 'tray'}
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <rect x="2" y="3" width="20" height="14" rx="2" />
                        <line x1="2" y1="20" x2="22" y2="20" />
                      </svg>
                    {:else if item.icon === 'profile'}
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                      </svg>
                    {:else if item.icon === 'bell'}
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                      </svg>
                    {:else if item.icon === 'copy'}
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    {:else if item.icon === 'logs'}
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <polyline points="4 17 10 11 4 5" />
                        <line x1="12" y1="19" x2="20" y2="19" />
                      </svg>
                    {:else if item.icon === 'info'}
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
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                    {:else if item.icon === 'extension'}
                      <!-- Puzzle-piece glyph for the cross-surface Pinned
                           row when the pinned id resolves to an extension. -->
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path
                          d="M20.5 11h-4V7a3 3 0 0 0-3-3 3 3 0 0 0-3 3v4H3.5v3a2 2 0 0 0 2 2h1.5a1 1 0 1 1 0 4H3.5v3h13a2 2 0 0 0 2-2v-3a2 2 0 0 0 2 2 2 2 0 0 0 0-4 2 2 0 0 0-2 2v-3h2v-3a2 2 0 0 0-2-2Z"
                        />
                      </svg>
                    {:else if item.icon === 'pin'}
                      <!-- Star glyph for the cross-surface Pinned section
                           header and for any unknown pinned-surface fallback. -->
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="currentColor"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <polygon
                          points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
                        />
                      </svg>
                    {:else if item.icon === 'layers'}
                      <!-- Stacked-rect glyph for workspace presets — a
                           layered layout suggests the snapshot/restore
                           shape better than the generic 'tray' rectangle. -->
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <polygon points="12 2 2 7 12 12 22 7 12 2" />
                        <polyline points="2 17 12 22 22 17" />
                        <polyline points="2 12 12 17 22 12" />
                      </svg>
                    {:else if item.icon === 'template'}
                      <!-- File-with-text glyph for prompt templates —
                           reads as a reusable snippet without competing
                           with the doc / skill / layers vocabulary. -->
                      <svg
                        viewBox="0 0 24 24"
                        class="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="8" y1="13" x2="16" y2="13" />
                        <line x1="8" y1="17" x2="14" y2="17" />
                      </svg>
                    {/if}
                  </span>
                  <span class="flex-1 min-w-0">
                    <span
                      class="text-sm truncate block"
                      class:text-text-primary={active}
                      class:text-text-muted={!active}
                    >
                      {item.label}
                    </span>
                    {#if item.subtitle}
                      <span class="text-xs text-text-muted/70 truncate block">
                        {item.subtitle}
                      </span>
                    {/if}
                  </span>
                  {#if item.keybind}
                    <kbd
                      class="text-[10px] text-text-muted border border-border-subtle rounded px-1.5 py-0.5 font-mono shrink-0"
                    >
                      {item.keybind}
                    </kbd>
                  {/if}
                </div>
              {/each}
            </div>
          {/each}
        {/if}
      </div>

      <!-- Footer hint strip -->
      <div
        class="px-5 py-2 border-t border-border-subtle flex items-center gap-4 text-[10px] text-text-muted/70"
      >
        <span><kbd class="text-text-muted">↑ ↓</kbd> navigate</span>
        <span><kbd class="text-text-muted">↵</kbd> select</span>
        <span><kbd class="text-text-muted">?</kbd> shortcuts</span>
        <span><kbd class="text-text-muted">esc</kbd> close</span>
      </div>
    </div>
  </div>
{/if}
