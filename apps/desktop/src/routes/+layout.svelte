<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Toasts from '$lib/components/Toasts.svelte';
  import UpdaterBanner from '$lib/components/UpdaterBanner.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import { connection } from '$lib/stores/connection.svelte';
  import { palette } from '$lib/stores/shortcuts.svelte';
  import { globalSearch } from '$lib/stores/global-search.svelte';
  import { threadSwitcher } from '$lib/stores/thread-switcher.svelte';
  // LANE B3 — Omnibar (R55)
  import { omnibar } from '$lib/stores/omnibar.svelte';
  import { quickCapture } from '$lib/stores/quick-capture.svelte';
  import { tray } from '$lib/stores/tray.svelte';
  import { updater } from '$lib/stores/updater.svelte';
  import { windowFocus } from '$lib/stores/window-focus.svelte';
  import { notifications } from '$lib/stores/notifications.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { threads } from '$lib/stores/threads.svelte';
  import { perThreadPrompts } from '$lib/stores/per-thread-prompts.svelte';
  import { PERSONAS } from '$lib/data/personas';
  import { openLoops } from '$lib/stores/open-loops.svelte';
  import { workItems } from '$lib/stores/work-items.svelte';
  import { aboutStore } from '$lib/stores/about.svelte';
  import { broadcast } from '$lib/stores/broadcast.svelte';
  import { pins } from '$lib/stores/pins.svelte';
  import { threadRename } from '$lib/stores/thread-rename.svelte';
  import { threadSync } from '$lib/stores/thread-sync.svelte';
  import { presets, presetsModal } from '$lib/stores/presets.svelte';
  import { templates, templatesModal } from '$lib/stores/templates.svelte';
  import { skillEditor } from '$lib/stores/skill-editor.svelte';
  // LANE B7 — Mini-mode (R64). Cmd+Shift+M opens a 320×400 floating
  // panel via a Tauri child window. Store is intentionally thin — see
  // `src/lib/stores/mini-mode.svelte.ts`.
  import { miniMode } from '$lib/stores/mini-mode.svelte';
  import { surfaceRefresh } from '$lib/stores/surface-refresh.svelte';
  import { telemetry } from '$lib/stores/telemetry.svelte';
  import { invoke } from '@tauri-apps/api/core';

  let { children } = $props();

  // Hide the sidebar (and the top padding it implies) on the full-screen
  // onboarding takeover. `page.url.pathname` from `$app/state` is reactive
  // under Svelte 5 runes, so this re-renders on navigation.
  const isOnboarding = $derived(page.url.pathname.startsWith('/onboarding'));

  let paletteSeen = $state(false);
  let globalSearchSeen = $state(false);
  let omnibarSeen = $state(false);
  let threadSwitcherSeen = $state(false);
  let quickCaptureSeen = $state(false);
  let presetsSeen = $state(false);
  let templatesSeen = $state(false);
  let aboutSeen = $state(false);

  const WATCH_SCHEDULER_INTERVAL_MS = 60_000;

  $effect(() => {
    if (!isOnboarding && palette.open) paletteSeen = true;
  });

  $effect(() => {
    if (!isOnboarding && globalSearch.open) globalSearchSeen = true;
  });

  $effect(() => {
    if (!isOnboarding && omnibar.open) omnibarSeen = true;
  });

  $effect(() => {
    if (!isOnboarding && threadSwitcher.open) threadSwitcherSeen = true;
  });

  $effect(() => {
    if (!isOnboarding && quickCapture.open) quickCaptureSeen = true;
  });

  $effect(() => {
    if (!isOnboarding && presetsModal.open) presetsSeen = true;
  });

  $effect(() => {
    if (!isOnboarding && templatesModal.open) templatesSeen = true;
  });

  $effect(() => {
    if (!isOnboarding && aboutStore.open) aboutSeen = true;
  });

  // ---- Bottom status bar (Cmd+/) --------------------------------------
  // Visibility is persisted in localStorage so the saved preference
  // survives reloads. We default to true on a fresh install — power
  // users coming to this feature for the first time should see the bar
  // before knowing the toggle exists. The localStorage read is guarded
  // for SSR safety even though `ssr = false` for this app, to keep the
  // module testable under jsdom.
  const STATUSBAR_VISIBLE_KEY = 'ironclaw-statusbar-visible';
  let statusBarVisible = $state(true);

  function loadStatusBarVisible(): boolean {
    if (typeof window === 'undefined' || !window.localStorage) return true;
    const raw = window.localStorage.getItem(STATUSBAR_VISIBLE_KEY);
    // Treat any non-`"false"` value (including unset) as visible. We
    // serialize the boolean directly so the key reads cleanly in
    // devtools.
    return raw !== 'false';
  }

  function persistStatusBarVisible(v: boolean): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      window.localStorage.setItem(STATUSBAR_VISIBLE_KEY, v ? 'true' : 'false');
    } catch {
      // Quota / private-mode failures are non-fatal.
    }
  }

  // First-run guard. We wait for `connection.init()` to load settings off
  // disk (it caches via `initialized`, so this is cheap on subsequent
  // mounts) and then redirect to /onboarding exactly once if the flag is
  // false. Tracked via `redirected` so navigating BACK to `/` after
  // skipping doesn't loop us through the wizard again in the same
  // session — once the user has been there (or finished it), we trust
  // settings.json as the source of truth.
  let redirected = $state(false);

  // Global keyboard shortcuts. Lives at the layout level so every route
  // gets them for free. The palette itself owns Escape + arrow keys; here
  // we only handle the open-or-jump shortcuts.
  //
  // Rules:
  //   - Cmd-combos (and Ctrl on non-Mac) always fire, even from inputs.
  //   - Bare letter keys (no modifier) are suppressed when focus is in a
  //     text-y element so the user can actually type.
  //   - Onboarding takes over the whole screen; we still allow the palette
  //     to open there so the user can navigate out if they get stuck, but
  //     the palette component itself is hidden via `showPalette` below.
  function isEditableTarget(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) return false;
    const tag = t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (t.isContentEditable) return true;
    return false;
  }

  /**
   * Copy `window.location.href` to the clipboard. Surfaces a toast on
   * success or failure. Pulled out of the keydown handler so the
   * command-palette action can call the same path without duplicating
   * the clipboard / toast logic.
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
      toasts.show('Link copied', 'success');
    } catch {
      toasts.show('Copy failed', 'error');
    }
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;

    // Bare keys: ignore when typing.
    if (!mod && isEditableTarget(e.target)) return;

    // Cmd+Shift+F → cross-surface global search. Must come BEFORE the bare
    // Cmd+K check so the Shift modifier disambiguates. Distinct from the
    // chat surface's Cmd+F (find-in-thread, no Shift) — that listener
    // lives in `src/routes/+page.svelte` and we deliberately don't
    // contend with it here. Onboarding is unaffected; the modal can still
    // be summoned and dismissed but the user typically has no client
    // connected yet — the modal renders an empty state and a toast.
    if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      globalSearch.toggle();
      return;
    }

    // Cmd+Shift+N → quick-capture overlay. Same shape as the global-search
    // chord above: Shift disambiguates from any bare Cmd+N intent (which is
    // unbound today) and the bare-key gate from above is bypassed because
    // `mod` is true. Suppressed on the onboarding takeover via the modal's
    // own render gate at the bottom of the layout — the toggle here is a
    // no-op render in that state.
    if (mod && e.shiftKey && e.key.toLowerCase() === 'n' && !isOnboarding) {
      e.preventDefault();
      quickCapture.toggle();
      return;
    }

    // Cmd+Shift+P → workspace presets modal. Mnemonic: P for Preset.
    // Shift disambiguates from any future bare Cmd+P intent (browser
    // print today, but the Tauri webview swallows that anyway — keeping
    // Shift for symmetry with the other modal chords). Onboarding gate
    // matches the quick-capture chord: the wizard owns the screen and
    // the user has no saved presets yet, so the modal's own render gate
    // at the bottom of the layout keeps the toggle a no-op.
    if (mod && e.shiftKey && e.key.toLowerCase() === 'p' && !isOnboarding) {
      e.preventDefault();
      presetsModal.toggle();
      return;
    }

    // Cmd+Shift+T → prompt-templates modal. Mnemonic: T for Template.
    // Distinct from the bare Cmd+T thread switcher (defined further
    // below): the Shift modifier disambiguates, and we run this
    // BEFORE the bare-Cmd+T branch so the Shift variant can't fall
    // through to the thread switcher. Onboarding gate matches the
    // preset/quick-capture chords — the wizard owns the screen and
    // the user has no saved templates yet, so the modal's own render
    // gate at the bottom of the layout keeps the toggle a no-op even
    // if invoked here.
    if (mod && e.shiftKey && e.key.toLowerCase() === 't' && !isOnboarding) {
      e.preventDefault();
      templatesModal.toggle();
      return;
    }

    // LANE B8 — skill editor (R65). Cmd+Shift+E. Onboarding gate matches
    // the other modal chords.
    if (mod && e.shiftKey && e.key.toLowerCase() === 'e' && !isOnboarding) {
      e.preventDefault();
      skillEditor.show();
      return;
    }

    // LANE B7 — Mini-mode (R64). Cmd+Shift+M opens a 320×400 floating
    // child window with the last 5 messages + a one-line composer.
    // Onboarding gate matches the other chord branches above.
    if (mod && e.shiftKey && e.key.toLowerCase() === 'm' && !isOnboarding) {
      e.preventDefault();
      void miniMode.toggle();
      return;
    }

    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      palette.togglePalette();
      return;
    }

    // LANE B3 — Omnibar: Cmd+Space (R55). Mnemonic: Space = the
    // negative-space "find anything" mode. Distinct from Cmd+K
    // (curated palette) and Cmd+T (thread switcher only). Onboarding
    // gate matches the other overlays — the wizard owns the screen
    // and the toggle is a no-op render at the bottom of the layout.
    if (mod && e.key === ' ' && !isOnboarding) {
      e.preventDefault();
      omnibar.toggle();
      return;
    }

    // Cmd+R → surface refresh. Each route registers a refresh closure on
    // mount via `surfaceRefresh.register(...)`; this handler invokes
    // whichever closure is currently registered. We deliberately do NOT
    // trap Cmd+Shift+R — the browser reserves that for a hard reload
    // (which in Tauri's webview is a no-op anyway, but the keystroke
    // shouldn't surface a confusing "Refreshed" toast either).
    //
    // Suppressed on the onboarding takeover so the wizard owns the
    // screen; the user has nothing to refresh until they finish setup.
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r' && !isOnboarding) {
      e.preventDefault();
      void surfaceRefresh.invoke().then((fired) => {
        if (fired) toasts.show('Refreshed', 'info');
      });
      return;
    }

    // Cmd+L → copy deep-link to the current view. Always copies the
    // full URL including search params and hash so a route that uses
    // ?path=, ?open=, ?focus=, or #section deep-links round-trips
    // through paste correctly. Tauri owns the URL bar (it's not user-
    // visible), so this chord doesn't conflict with anything native.
    //
    // Suppressed on the onboarding takeover for the same reason as
    // Cmd+R — the wizard URL isn't a meaningful deep-link target.
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l' && !isOnboarding) {
      e.preventDefault();
      void copyCurrentUrl();
      return;
    }

    // Cmd+T → quick thread switcher. Distinct from Cmd+K (palette: nav +
    // actions) and Cmd+Shift+F (global search): laser-focused on jumping
    // between existing chat threads. Suppressed on the onboarding takeover
    // — the wizard owns the screen and the user has no threads yet anyway.
    // We use `e.code === 'KeyT'` rather than `e.key` so the chord stays
    // stable under non-QWERTY layouts (Dvorak/Colemak users still get
    // Cmd+T on the physical T key).
    if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyT' && !isOnboarding) {
      e.preventDefault();
      threadSwitcher.toggle();
      return;
    }

    // Cmd-comma → settings (macOS convention).
    if (mod && e.key === ',') {
      e.preventDefault();
      void goto('/settings');
      return;
    }

    // Cmd+M → memory inspector. Mnemonic chord rather than a digit slot
    // because 1..9 are already full; the M-for-Memory mapping reads
    // better than carrying Council's "Cmd+0 also exists" pattern. Use
    // `e.code === 'KeyM'` so the chord stays stable under non-QWERTY
    // layouts (Dvorak/Colemak users still get Cmd+M on the physical M
    // key). Skipped on onboarding for the same reason as the other
    // route chords below — the wizard owns the screen until done.
    if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyM' && !isOnboarding) {
      e.preventDefault();
      void goto('/memory');
      return;
    }

    // Cmd+1..9 → top-level routes. Match by `e.key` so the digit is correct
    // across keyboard layouts; modifiers aren't required to interpret it.
    // Cmd+8 is gated on `settings.adminMode` and Cmd+9 on
    // `settings.engineV2Enabled` so the chord stays a no-op when the
    // corresponding surface isn't enabled — same visibility contract as
    // the sidebar rows.
    //
    // Note (2026-05-27): Jobs surface added at Cmd+5. Logs/Extensions/Admin
    // shifted down by one slot. Cmd+5 used to map to /logs — users who
    // press Cmd+5 expecting Logs will now hit Jobs; documented in the
    // changelog and the sidebar's shortcut hints render the new chord so
    // discoverability is intact.
    // Note (2026-05-27): Missions (Engine v2) added at Cmd+9, gated on
    // `settings.engineV2Enabled`. Slot 9 was previously unused so no
    // shortcut renumber was needed.
    if (mod && !e.shiftKey && !e.altKey) {
      const target = ROUTES_BY_DIGIT[e.key];
      if (target) {
        if (target === '/admin' && !connection.settings.adminMode) return;
        if (target === '/missions' && !connection.settings.engineV2Enabled) return;
        e.preventDefault();
        void goto(target);
      }
    }
  }

  const ROUTES_BY_DIGIT: Record<string, string> = {
    '0': '/dashboard',
    '1': '/chat',
    '2': '/knowledge',
    '3': '/skills',
    '4': '/routines',
    '5': '/jobs',
    '6': '/logs',
    '7': '/extensions',
    '8': '/admin',
    '9': '/missions'
  };

  // Hide-on-disable guard for /admin. If the user toggled adminMode off
  // (in /settings) while sitting on the admin route, kick them out to
  // /settings so they don't see a stranded page. Lives as a top-level
  // $effect so it reacts to BOTH adminMode flips and route changes (both
  // are tracked because they read from $state-backed sources).
  $effect(() => {
    if (connection.settings.adminMode === false && page.url.pathname.startsWith('/admin')) {
      void goto('/settings');
    }
  });

  // Window focus → mark unseen notifications as seen. When the user
  // surfaces the app (Cmd-Tab, clicking the dock, clicking the tray
  // icon) the badge count drops to 0 and the Rust tray clears the title.
  // Lives at the layout level so it's wired exactly once — the
  // notifications singleton is global, so this effect speaks for every
  // route. We push a badge update on the same edge to flush the cleared
  // count immediately rather than waiting for the next trigger.
  $effect(() => {
    if (windowFocus.focused) {
      notifications.markAllSeen();
      void notifications.pushBadge();
    }
  });

  // Same hide-on-disable guard for /missions (Engine v2 surface). When the
  // user flips `engineV2Enabled` off from /settings → Advanced while
  // sitting on the route, bounce them to /settings so they don't see a
  // stranded page.
  $effect(() => {
    if (
      connection.initialized &&
      connection.settings.engineV2Enabled !== true &&
      page.url.pathname.startsWith('/missions')
    ) {
      void goto('/settings');
    }
  });

  onMount(() => {
    // R63 (lane B6): stamp `data-platform` on <html> so the `.macos-only`
    // CSS rule can hide the title-bar drag strip on non-macOS targets.
    // Cheap navigator probe; runs once at mount; no re-stamp needed because
    // platform doesn't change at runtime.
    if (typeof navigator !== 'undefined') {
      const ua = (navigator.platform || navigator.userAgent || '').toLowerCase();
      const isMac = ua.includes('mac');
      document.documentElement.dataset.platform = isMac ? 'mac' : 'non-mac';
    }

    // Boot the focus tracker + hydrate notification prefs early so any
    // surface that fires a notification on first render (e.g. routine
    // completion catching up on poll #1) sees the user's saved toggles.
    windowFocus.init();
    notifications.hydrate();
    // Hydrate the cross-surface pin store. Cheap localStorage read, but
    // we want it done before any surface mounts so the first render
    // shows the user's saved pins without a flash of empty stars.
    pins.init();
    // Same shape for the local-only thread rename overlay — hydrate
    // before the chat surface mounts so renamed thread titles render
    // immediately instead of flashing the server's title on first paint.
    threadRename.init();
    // Open loops (tracked commitments, R100) — hydrate once so the daily
    // brief and its inline editor see the user's saved commitments without
    // a flash of empty state on first open.
    openLoops.init();
    // Work items own watches/receipts. Hydrate once in the shell so the
    // scheduler below can make proactive watches real even when the user
    // never visits Work first.
    workItems.hydrate();
    // Same shape for the workspace-presets store — hydrate once so the
    // first open of the modal (Cmd+Shift+P or palette action) sees the
    // user's saved list without a flash of empty state.
    presets.init();
    // Same shape for the prompt-templates store. First-run also seeds
    // a few sample templates so the modal's empty state is friendly
    // rather than a blank wall. Cheap localStorage read — wired here
    // so the slash autocomplete + palette + modal all see the same
    // hydrated list on first render.
    templates.init();
    // Wire the menu-bar tray listeners (Show window, Open settings,
    // Restart sidecar). Safe outside the Tauri webview — the store
    // detects that and no-ops.
    tray.init();
    // Open the cross-window state-sync channel so settings saved in
    // any window propagate to the others. Safe outside Tauri (and in
    // jsdom): no-ops when BroadcastChannel is unavailable. Paired
    // with `broadcast.teardown()` in the cleanup return below so
    // remounts (HMR, layout pivot) don't stack listeners.
    broadcast.init();
    // Hydrate the opt-in telemetry store. Off by default; init() reads
    // localStorage for the saved toggle + endpoint and arms the flush
    // timer if both are set. Safe outside Tauri — no IPC at boot.
    telemetry.init();
    // First boot of the session — fire one launch event so the
    // anonymous-usage counts have a baseline. Gated by telemetry's own
    // enabled/endpoint check so it's a no-op when the user has opted
    // out (or hasn't opted in yet).
    telemetry.recordEvent('app:launched');
    threadSync.start({ intervalMs: 3_000 });
    const watchScheduler = window.setInterval(() => {
      workItems.runDueWatches();
    }, WATCH_SCHEDULER_INTERVAL_MS);
    workItems.runDueWatches();

    // LANE B3 — Omnibar (R55). Register the baseline navigation
    // commands so an empty-query omnibar already has surfaces to
    // jump to. Done once at layout mount; cmd ids are stable so
    // re-registering is a noop on HMR.
    const navCommands: Array<{
      id: string;
      title: string;
      keywords?: string[];
      path: string;
    }> = [
      {
        id: 'go:today',
        title: 'Open Today',
        keywords: ['dashboard', 'home', 'tiles', 'widgets'],
        path: '/dashboard'
      },
      {
        id: 'go:desk',
        title: 'Open Desk',
        keywords: ['inbox', 'needs you', 'approvals', 'cards', 'chief of staff'],
        path: '/desk'
      },
      {
        id: 'go:work',
        title: 'Open Work',
        keywords: ['matters', 'work items', 'approvals', 'artifacts', 'watches'],
        path: '/work'
      },
      {
        id: 'go:streams',
        title: 'Open Streams',
        keywords: ['activity', 'feed', 'timeline', 'events'],
        path: '/streams'
      },
      {
        id: 'go:chat',
        title: 'Open Chat',
        keywords: ['threads', 'conversation'],
        path: '/chat'
      },
      {
        id: 'go:canvas',
        title: 'Open Canvas',
        keywords: ['spatial', 'board', 'research', 'nodes'],
        path: '/canvas'
      },
      {
        id: 'go:knowledge',
        title: 'Open Knowledge',
        keywords: ['docs', 'memory'],
        path: '/knowledge'
      },
      { id: 'go:memory', title: 'Open Memory', keywords: ['knowledge'], path: '/memory' },
      { id: 'go:skills', title: 'Open Skills', keywords: ['tools'], path: '/skills' },
      {
        id: 'go:ironhub',
        title: 'Browse IronHub',
        keywords: ['marketplace', 'install'],
        path: '/skills/ironhub'
      },
      {
        id: 'go:routines',
        title: 'Open Routines',
        keywords: ['cron', 'schedule'],
        path: '/routines'
      },
      { id: 'go:logs', title: 'Open Logs', path: '/logs' },
      {
        id: 'go:extensions',
        title: 'Open Extensions',
        keywords: ['mcp', 'integrations'],
        path: '/extensions'
      },
      { id: 'go:jobs', title: 'Open Jobs', keywords: ['queue', 'background'], path: '/jobs' },
      {
        id: 'go:missions',
        title: 'Open Missions',
        keywords: ['engine', 'projects', 'agent', 'v2'],
        path: '/missions'
      },
      {
        id: 'go:settings',
        title: 'Open Settings',
        keywords: ['preferences', 'config'],
        path: '/settings'
      }
    ];
    for (const cmd of navCommands) {
      omnibar.registerCommand({
        id: cmd.id,
        title: cmd.title,
        keywords: cmd.keywords,
        subtitle: cmd.path,
        action: () => goto(cmd.path)
      });
    }

    // Persona quick-starts — "Start thread as Chief of Staff" (+ other
    // built-in personas). Creates a fresh thread, applies the persona's
    // system prompt as a per-thread override (R43), then opens it. The
    // personas are in-repo + fully readable (src/lib/data/personas.ts).
    for (const persona of PERSONAS) {
      omnibar.registerCommand({
        id: `persona:${persona.id}`,
        title: `Start thread as ${persona.name}`,
        keywords: ['persona', 'mode', persona.id, 'chief', 'staff', 'assistant'],
        subtitle: persona.blurb,
        action: async () => {
          if (!connection.client) {
            toasts.show('Connect to IronClaw first', 'error');
            return;
          }
          const threadId = await threads.createThread(`${persona.name} session`);
          if (!threadId) {
            toasts.show("Couldn't create thread", 'error');
            return;
          }
          perThreadPrompts.set(threadId, persona.systemPrompt);
          await goto(`/chat?thread=${encodeURIComponent(threadId)}`);
          toasts.show(`Thread running as ${persona.name}`, 'success');
        }
      });
    }

    // "Brief me" (R101) — the Chief of Staff assembles a prioritized agenda
    // from recent threads + tracked open loops. The brief panel lives on the
    // chat route, so navigate there with `?brief=1`; the chat page fires the
    // generation once connected and strips the param.
    omnibar.registerCommand({
      id: 'brief:me',
      title: 'Brief me',
      keywords: ['brief', 'daily', 'agenda', 'morning', 'chief', 'staff', 'priorities', 'today'],
      subtitle: 'Agenda from recent threads and open loops',
      action: async () => {
        if (!connection.client) {
          toasts.show('Connect to IronClaw first', 'error');
          return;
        }
        await goto('/chat?brief=1');
      }
    });

    // "Triage my threads" (R104) — the Chief of Staff sorts recent threads
    // into Decision needed / FYI / Can handle. Same chat-route navigation +
    // deep-link pattern as the brief.
    omnibar.registerCommand({
      id: 'triage:threads',
      title: 'Triage my threads',
      keywords: ['triage', 'sort', 'decision', 'fyi', 'filter', 'chief', 'staff', 'inbox'],
      subtitle: 'Sort recent threads by what needs you',
      action: async () => {
        if (!connection.client) {
          toasts.show('Connect to IronClaw first', 'error');
          return;
        }
        await goto('/chat?triage=1');
      }
    });

    void connection.init().then(() => {
      // Last-resort escape hatch (R34d). If a previous wizard run failed
      // catastrophically (Skip threw, save_settings IPC errored, etc.) the
      // user can be stranded on /onboarding with `onboardingComplete: false`
      // forever — every relaunch lands them right back. The bypass key,
      // once set, short-circuits the redirect IN to the wizard so the user
      // can use the app while the underlying save path heals.
      //
      // Set by `skip()` in the wizard on error, by the CommandPalette's
      // "Reset onboarding bypass" action (TODO), or by the user via
      // devtools: `localStorage.setItem('ironclaw-onboarding-bypass', '1')`.
      // Cleared when the user finishes onboarding successfully.
      let bypass = false;
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          bypass = window.localStorage.getItem('ironclaw-onboarding-bypass') === '1';
        }
      } catch {
        // Quota / private-mode failures are non-fatal — proceed with the
        // normal redirect path.
      }

      const onOnboarding = page.url.pathname.startsWith('/onboarding');

      // Bug 1 (R34d): redirect OUT of /onboarding when settings.json says
      // the user is already done. Previously the guard was one-way —
      // it only sent users TO the wizard, never out — so a user who
      // landed on /onboarding for any reason (webview URL restore after
      // a Tauri crash, command-palette navigation, bypass armed earlier)
      // would see the wizard despite `onboardingComplete: true` on disk.
      // The escape-hatch bypass also takes effect here so a user with
      // a permanent bypass can ALSO be kicked out of /onboarding if the
      // route somehow loads.
      if (onOnboarding && (connection.settings.onboardingComplete || bypass)) {
        // Land on Today (the named home), matching the wizard's own
        // completion navigation — not Chat. Keeps every "you're already
        // onboarded" path converging on /dashboard.
        void goto('/dashboard');
        return;
      }

      if (bypass) return;

      if (!redirected && !connection.settings.onboardingComplete && !onOnboarding) {
        redirected = true;
        void goto('/onboarding');
      }
    });

    // Auto-check for updates once per launch — and then arm the cadence
    // timer for ongoing rechecks. We want the launch path quiet on
    // success AND on failure: an empty pubkey or transient network blip
    // should not splash a red banner on every launch. The manual check
    // in /settings still surfaces the error verbosely so the user can
    // debug there. Pattern: check, then dismiss on error.
    //
    // The cadence setting (never / launch / launch+6h / launch+1h) is
    // hydrated from localStorage on first read. `never` skips the launch
    // check entirely so a user who opted out stays opted out; the manual
    // button in Settings is the only way to trigger a check.
    updater.hydrate();
    if (updater.cadence !== 'never') {
      void updater.check({ respectSkip: true }).then(() => {
        if (updater.status === 'error') updater.dismiss();
        updater.armTimer();
      });
    }

    window.addEventListener('keydown', onWindowKeyDown);

    // Global last-resort net for async errors that escape both the
    // SvelteKit `handleError` hook (which only fires for load/render)
    // AND any per-call try/catch. We don't navigate or destroy state —
    // the route-level `+error.svelte` already handles catastrophic
    // render failures. Here we surface a toast, log to console, AND
    // persist a JSON-line entry to `app_data_dir/crashes.jsonl` via
    // the Rust crash log so post-mortem debugging has the same view
    // the user did. The Rust write + the optional telemetry event are
    // both wrapped in try/catch — crash reporting must never crash the
    // app it's reporting on.
    function recordCrashSafe(
      type: 'error' | 'rejection' | 'tauri-panic',
      message: string,
      stack: string | undefined
    ): void {
      // Snapshot context up front. `window.location.pathname` is the
      // current route; profile id comes from the live connection store;
      // user agent + app version are stable per session.
      const entry = {
        timestamp: new Date().toISOString(),
        type,
        message,
        stack,
        route: typeof window !== 'undefined' ? window.location.pathname : undefined,
        profileId: connection.activeProfile?.id,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        appVersion: '__APP_VERSION__'
      };
      // Best-effort persistence. The invoke is async but we don't await —
      // a crash handler shouldn't block the toast, and we have nothing
      // useful to do with a failed write here beyond the console log
      // we've already emitted. Outside Tauri (dev preview, tests) the
      // mocked invoke resolves to undefined, which is the right shape.
      try {
        void invoke('record_crash', { entry }).catch(() => {
          // Swallowed — the toast already told the user. A failed
          // crash-log write must not raise a new crash that loops us
          // back through these handlers.
        });
      } catch {
        // Defensive: synchronous throws (rare; missing global) shouldn't
        // bubble back to the caller.
      }
      // Mirror to the opt-in telemetry queue so post-launch usage
      // metrics include a crash count. We never put `stack` or
      // `message` on the wire — the telemetry event carries the `type`
      // only so counts can be charted without leaking content.
      try {
        telemetry.recordEvent('crash:captured', { type });
      } catch {
        // Same defensive swallow as the invoke path above.
      }
    }

    function onWindowError(e: ErrorEvent) {
      // eslint-disable-next-line no-console
      console.error('[ironclaw] window error:', e.error ?? e.message);
      toasts.show('Something failed. Check the console', 'error');
      const err = e.error instanceof Error ? e.error : null;
      recordCrashSafe('error', err?.message ?? e.message ?? 'Unknown window error', err?.stack);
    }
    function onUnhandledRejection(e: PromiseRejectionEvent) {
      // eslint-disable-next-line no-console
      console.error('[ironclaw] unhandled rejection:', e.reason);
      toasts.show('Something failed. Check the console', 'error');
      const reason = e.reason;
      const err = reason instanceof Error ? reason : null;
      // Reason can be anything (a thrown string, a plain object, …).
      // Normalise to a single message string so the crash entry's
      // `message` field stays load-bearing.
      const message =
        err?.message ?? (typeof reason === 'string' ? reason : JSON.stringify(reason ?? null));
      recordCrashSafe('rejection', message, err?.stack);
    }
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => {
      window.removeEventListener('keydown', onWindowKeyDown);
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      // Mirror of `broadcast.init()` above — close the channel and
      // detach the message listener so a layout remount (HMR, route
      // pivot in dev) does not stack handlers.
      broadcast.teardown();
      threadSync.stop();
      window.clearInterval(watchScheduler);
    };
  });
</script>

<div class="flex flex-col h-screen w-screen overflow-hidden">
  <!-- Updater banner spans the full width above the sidebar+main split.
       The banner itself returns null when status is idle / up-to-date,
       so this slot collapses cleanly in the common case. Hidden during
       the onboarding takeover so the wizard owns the chrome. -->
  {#if !isOnboarding}
    <UpdaterBanner />
  {/if}
  <!-- About dialog. Mounted at the root so any surface can summon it via
       `aboutStore.show()` (command palette, settings link, future Help
       menu). Renders nothing until `open` flips, so it's free when idle.
       Placed outside the onboarding guard so it stays reachable even on
       the wizard takeover if a future entry point fires while it's up. -->
  {#if !isOnboarding && aboutSeen}
    {#await import('$lib/components/AboutDialog.svelte') then M}
      <M.default open={aboutStore.open} onclose={() => aboutStore.close()} />
    {/await}
  {/if}
  <ConfirmDialog />

  <!-- LANE B6 — R63 title-bar drag region (macOS). With `titleBarStyle:
       Overlay` + `hiddenTitle: true`, the traffic lights sit OVER the
       webview at top-left. Without a `data-tauri-drag-region` strip,
       the empty area to the right of the buttons is dead — the user
       can't grab it to move the window. This thin strip restores the
       expected drag affordance without covering the buttons. Hidden
       outside macOS via the .macos-only utility (no-op on win/linux). -->
  {#if !isOnboarding}
    <div
      class="macos-titlebar-drag-strip macos-only"
      data-tauri-drag-region
      aria-hidden="true"
    ></div>
  {/if}

  <div class="flex flex-1 overflow-hidden">
    {#if !isOnboarding}
      <Sidebar />
    {/if}
    <main class="flex-1 overflow-auto" class:pt-8={!isOnboarding}>
      {@render children()}
    </main>
  </div>

  <!-- Slim bottom status bar. Sits in-flow below the sidebar+main split
       so it takes its own 28px of vertical real estate rather than
       overlaying scrolling content. Hidden on the onboarding takeover
       to match the rest of the chrome. Visibility (Cmd+/) is persisted
       in localStorage and hydrated on mount. -->
  {#if !isOnboarding}
    <StatusBar visible={statusBarVisible} />
  {/if}
</div>

<!-- Mounted once at the root so every route shares one toast viewport.
     Lives outside <main> so it floats over scrolling content. -->
<Toasts />

<!-- Command palette is rendered everywhere except the onboarding takeover.
     The store still allows toggling there, but the modal stays hidden so
     the wizard owns the whole screen. -->
{#if !isOnboarding && paletteSeen}
  {#await import('$lib/components/CommandPalette.svelte') then M}
    <M.default />
  {/await}
{/if}

<!-- Global cross-surface search (Cmd+Shift+F). Same onboarding gate as the
     palette — the wizard owns the whole screen, but the rune can still
     toggle (no-op render) so a stray shortcut press doesn't leak into the
     wizard's keyboard handlers. -->
{#if !isOnboarding && globalSearchSeen}
  {#await import('$lib/components/GlobalSearch.svelte') then M}
    <M.default />
  {/await}
{/if}

<!-- LANE B3 — Omnibar (Cmd+Space) (R55). Federated search + action
     launcher. Distinct from GlobalSearch (Cmd+Shift+F, surface-level
     hits in URL params) and CommandPalette (Cmd+K, curated actions).
     The omnibar covers content + commands in one overlay with fuzzy
     ranking. Onboarding gate matches the other overlays. -->
{#if !isOnboarding && omnibarSeen}
  {#await import('$lib/components/Omnibar.svelte') then M}
    <M.default />
  {/await}
{/if}

<!-- Quick thread switcher (Cmd+T). Laser-focused on jumping between chat
     threads — sibling to the palette and global search above. Same
     onboarding gate; the Cmd+T handler itself also short-circuits on the
     wizard, but the gate here keeps the DOM clean. -->
{#if !isOnboarding && threadSwitcherSeen}
  {#await import('$lib/components/ThreadSwitcher.svelte') then M}
    <M.default />
  {/await}
{/if}

<!-- Quick-capture overlay (Cmd+Shift+N). Drops a single message into a
     dedicated "Quick captures" thread without forcing navigation away
     from the current surface. Same onboarding gate as the other layout
     modals — the wizard owns the screen, and the user has no client
     wired yet. -->
{#if !isOnboarding && quickCaptureSeen}
  {#await import('$lib/components/QuickCapture.svelte') then M}
    <M.default />
  {/await}
{/if}

<!-- Workspace presets modal (Cmd+Shift+P). Captures the current layout
     (active route, selected thread, panel widths, sidebar collapsed,
     status bar visibility, tray badge toggle) under a user-given name
     for fast context-switching. Same onboarding gate as the other layout
     modals — there's no meaningful workspace to snapshot before the
     wizard completes. -->
{#if !isOnboarding && presetsSeen}
  {#await import('$lib/components/PresetsModal.svelte') then M}
    <M.default />
  {/await}
{/if}

<!-- Prompt templates modal (Cmd+Shift+T). Manages reusable prompt
     bodies that splice into the chat composer (immediately, or after
     a variable-input prompt for templates with {placeholders}).
     Same onboarding gate as the other layout modals. -->
{#if !isOnboarding && templatesSeen}
  {#await import('$lib/components/TemplatesModal.svelte') then M}
    <M.default />
  {/await}
{/if}
