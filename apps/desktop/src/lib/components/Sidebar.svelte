<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { invoke } from '@tauri-apps/api/core';
  import { connection, type ConnectionStatus } from '$lib/stores/connection.svelte';
  import { signIn } from '$lib/stores/sign-in.svelte';
  import { threads } from '$lib/stores/threads.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { updater } from '$lib/stores/updater.svelte';
  import NewProfileModal from '$lib/components/NewProfileModal.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import NearMark from '$lib/components/NearMark.svelte';
  import { reorderProfiles, resolveTint } from '$lib/stores/settings.svelte';
  import { rebornDesk } from '$lib/stores/reborn-desk.svelte';
  import { workItems } from '$lib/stores/work-items.svelte';

  // ---- Sidebar nav definition ------------------------------------------
  //
  // The Admin row sits between Extensions and Settings (the prompt's
  // "between Extensions and Logs" wording predates the post-Logs reorder
  // — Logs lives BEFORE Extensions in the current sidebar). Same end
  // result: it's just above Settings, after every other top-level surface,
  // and hidden until adminMode is on.
  //
  // `badgeKey` ties a nav row to one of the badge counters below; the
  // collapsed-state dot color is selected per-key too. Nav rows without
  // a `badgeKey` never show a badge.

  type BadgeKey =
    | 'desk'
    | 'work'
    | 'chat'
    | 'skills'
    | 'routines'
    | 'jobs'
    | 'extensions'
    | 'logs'
    | 'missions'
    | 'settings';

  type NavItem = {
    href: string;
    label: string;
    icon:
      | 'desk'
      | 'work'
      | 'chat'
      | 'knowledge'
      | 'memory'
      | 'logs'
      | 'routines'
      | 'jobs'
      | 'settings'
      | 'skills'
      | 'extensions'
      | 'missions'
      | 'admin'
      | 'canvas'
      | 'streams'
      | 'spark';
    /** Optional shortcut hint shown to the right of the label. Mirrors the
     *  global shortcuts wired in `src/routes/+layout.svelte`. */
    shortcut?: string;
    /** Drives the per-row badge in expanded mode and the corner dot in
     *  collapsed mode. Omit for rows that never show one. */
    badgeKey?: BadgeKey;
    /** If set, only render the item when this predicate returns true. Used
     *  to gate the Admin row behind `settings.adminMode`. */
    showWhen?: () => boolean;
  };

  const items: NavItem[] = [
    // Today (R77 / W1) — the named home, takes Cmd+0. A tile grid of live +
    // scheduled widgets per docs/WORKSPACE-OS.md; post-onboarding lands here
    // and it leads the nav as the "start here" surface.
    { href: '/dashboard', label: 'Today', icon: 'spark', shortcut: '⌘0' },
    // The Desk — the proactive chief-of-staff action inbox. A priority-sorted
    // feed of cards you act on, led by the "Needs you" approval-gate inbox
    // (Reborn v2). No digit shortcut (0..9 are taken); reached via the sidebar
    // + palette. Sits 2nd, beside Today, as the "what needs me right now" view.
    { href: '/desk', label: 'Desk', icon: 'desk', badgeKey: 'desk' },
    // Work is the durable matter spine: objective, dossier, approvals,
    // artifacts, and watches in one place. It sits beside Desk because Desk is
    // the interrupt inbox while Work is the ongoing command ledger.
    { href: '/work', label: 'Work', icon: 'work', badgeKey: 'work' },
    // Streams (R81) — the activity feed of what the agent has done / is doing
    // across every surface. No digit slot (0..9 taken); reached via the
    // sidebar + palette. Completes the chief-of-staff trio: Today / Desk /
    // Streams = "what's planned / what needs me / what happened".
    { href: '/streams', label: 'Streams', icon: 'streams' },
    { href: '/chat', label: 'Chat', icon: 'chat', shortcut: '⌘1', badgeKey: 'chat' },
    // Council is no longer a route — it's an in-chat overlay summoned from
    // the composer via `/council <prompt>`. (Removed from the nav.)
    // Canvas (R84 / W7). Research-mode spatial surface — no digit slot to
    // avoid renumbering the existing 1..9 muscle memory.
    { href: '/canvas', label: 'Canvas', icon: 'canvas' },
    { href: '/knowledge', label: 'Knowledge', icon: 'knowledge', shortcut: '⌘2' },
    // Memory sits between Knowledge and Skills as a sibling surface — same
    // backend (`/api/memory/*`), different mental model: flat card list of
    // what the agent has accumulated, vs Knowledge's hierarchical tree.
    // Cmd+M instead of a digit slot: 1..9 are full and the alphabetical
    // mnemonic (M for Memory) reads better than carrying the "Cmd+0 also
    // works" pattern Council uses.
    { href: '/memory', label: 'Memory', icon: 'memory', shortcut: '⌘M' },
    { href: '/skills', label: 'Skills', icon: 'skills', shortcut: '⌘3', badgeKey: 'skills' },
    {
      href: '/routines',
      label: 'Routines',
      icon: 'routines',
      shortcut: '⌘4',
      badgeKey: 'routines'
    },
    // Jobs sits between Routines and Logs — see CHANGELOG entry for the
    // shortcut renumber (Logs Cmd+5 → Cmd+6, Extensions Cmd+6 → Cmd+7,
    // Admin Cmd+7 → Cmd+8). Jobs takes Cmd+5.
    { href: '/jobs', label: 'Jobs', icon: 'jobs', shortcut: '⌘5', badgeKey: 'jobs' },
    { href: '/logs', label: 'Logs', icon: 'logs', shortcut: '⌘6' },
    {
      href: '/extensions',
      label: 'Extensions',
      icon: 'extensions',
      shortcut: '⌘7',
      badgeKey: 'extensions'
    },
    {
      href: '/admin',
      label: 'Admin',
      icon: 'admin',
      shortcut: '⌘8',
      // Read through the connection store so the row appears/disappears
      // reactively when the user toggles the setting (Svelte 5 runes
      // re-evaluate on every render).
      showWhen: () => connection.settings.adminMode === true
    },
    // Missions (Engine v2 surface). Gated behind `engineV2Enabled` so a
    // fresh install stays quiet — Engine v2 is still developer-facing.
    // Takes the next-available slot (⌘9) rather than renumbering Logs /
    // Extensions / Admin so muscle memory survives the addition. When
    // disabled the row vanishes and the Cmd+9 chord is a no-op (the
    // layout guards on the same flag).
    {
      href: '/missions',
      label: 'Missions',
      icon: 'missions',
      shortcut: '⌘9',
      badgeKey: 'missions',
      showWhen: () => connection.settings.engineV2Enabled === true
    },
    { href: '/settings', label: 'Settings', icon: 'settings', shortcut: '⌘,', badgeKey: 'settings' }
  ];

  /** Items visible right now. The Admin row is hidden when adminMode is
   *  off; everything else is always shown. */
  const visibleItems = $derived(items.filter((i) => !i.showWhen || i.showWhen()));

  const isActive = $derived((href: string) => {
    const path = page.url.pathname;
    if (href === '/') return path === '/';
    return path === href || path.startsWith(href + '/');
  });

  // ---- Sidebar collapse -------------------------------------------------
  //
  // Persisted under `ironclaw-sidebar-collapsed`. Hydrated from
  // localStorage in `onMount` so the SSR-rendered HTML always matches the
  // expanded default (no flash of mismatched layout). Width transitions
  // 200ms ease-out — the layout's flex parent reflows automatically since
  // `<main>` is `flex-1`.
  const COLLAPSE_STORAGE_KEY = 'ironclaw-sidebar-collapsed';

  let collapsed = $state<boolean>(false);

  function toggleCollapsed() {
    collapsed = !collapsed;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0');
      }
    } catch {
      // Quota / private-mode failures are non-fatal.
    }
    // Close the profile popover when collapsing — the chip shrinks to an
    // icon so the popover's left/right anchoring would clip.
    if (collapsed && popoverOpen) closePopover();
  }

  // ---- Profile dropdown state -------------------------------------------
  //
  // The dropdown lives above the connection-status pill. Click the chip to
  // toggle the popover; the popover lists every profile + a "+ New profile"
  // affordance + a "Manage profiles" link that scrolls to /settings#profiles.
  //
  // Popover is dismissed on:
  //   - Picking a profile.
  //   - Pressing Esc.
  //   - Clicking outside the chip+popover (window listener).

  let popoverOpen = $state(false);
  let newProfileModalOpen = $state(false);
  let chipRef: HTMLButtonElement | undefined = $state();
  let popoverRef: HTMLDivElement | undefined = $state();

  function togglePopover() {
    popoverOpen = !popoverOpen;
  }

  function closePopover() {
    popoverOpen = false;
  }

  /**
   * Pick a profile from the popover. Default click switches the current
   * window to that profile. Cmd-click (Ctrl on non-Mac) opens the
   * profile in a *new* window via the multi-window IPC — power-user
   * affordance for running two profiles side-by-side without churning
   * the active window's session. The popover closes either way so the
   * footprint matches the existing UX.
   */
  async function pickProfile(id: string, e?: MouseEvent | KeyboardEvent) {
    const isNewWindow = !!e && (e.metaKey || e.ctrlKey);
    closePopover();
    if (isNewWindow) {
      try {
        await invoke('open_profile_window', { profileId: id });
        const profile = connection.settings.profiles.find((p) => p.id === id);
        toasts.show(`Opened "${profile?.name ?? id}" in a new window`, 'info');
      } catch (err) {
        toasts.show(`Open window failed: ${(err as Error).message}`, 'error');
      }
      return;
    }
    if (id === connection.activeProfile.id) return;
    await connection.switchProfile(id);
  }

  function openNewProfile() {
    closePopover();
    newProfileModalOpen = true;
  }

  async function gotoManageProfiles() {
    closePopover();
    await goto('/settings#profiles');
  }

  // ---- Popover drag-and-drop -------------------------------------------
  //
  // Same gesture model as the Settings profile list, just tighter chrome
  // because the popover sits in the 224 px sidebar column. Only the small
  // grip glyph is `draggable`, so the row's click target (which pickProfile
  // owns, including cmd-click → open-in-new-window) stays untouched.
  //
  // Visual feedback:
  //   - Dragged row gets opacity 0.5.
  //   - Drop target gets a 2px cyan line at the insertion edge.
  //
  // On drop we compute the new id order and call `reorderProfiles`, which
  // validates + persists via `saveSettings` (which also broadcasts a
  // `settings-changed` to sibling windows via the BroadcastChannel bus).
  // The active profile stays where it is in the list — no auto-move.

  let draggedProfileId = $state<string | null>(null);
  let dropTargetProfileId = $state<string | null>(null);
  let dropPosition = $state<'before' | 'after' | null>(null);

  function onPopoverDragStart(e: DragEvent, profileId: string) {
    if (connection.settings.profiles.length <= 1) {
      e.preventDefault();
      return;
    }
    draggedProfileId = profileId;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', profileId);
      } catch {
        // Some webkit configs reject setData on certain origins —
        // non-fatal for the drag itself.
      }
    }
  }

  function onPopoverDragOver(e: DragEvent, profileId: string) {
    if (!draggedProfileId || draggedProfileId === profileId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const row = e.currentTarget as HTMLElement;
    const rect = row.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    dropTargetProfileId = profileId;
    dropPosition = e.clientY < midY ? 'before' : 'after';
  }

  function onPopoverDragLeave(e: DragEvent, profileId: string) {
    const target = e.currentTarget as HTMLElement;
    const related = e.relatedTarget as Node | null;
    if (related && target.contains(related)) return;
    if (dropTargetProfileId === profileId) {
      dropTargetProfileId = null;
      dropPosition = null;
    }
  }

  async function onPopoverDrop(e: DragEvent, profileId: string) {
    e.preventDefault();
    const draggedId = draggedProfileId;
    const targetPos = dropPosition;
    draggedProfileId = null;
    dropTargetProfileId = null;
    dropPosition = null;
    if (!draggedId || !targetPos || draggedId === profileId) return;
    const currentIds = connection.settings.profiles.map((p) => p.id);
    const withoutDragged = currentIds.filter((id) => id !== draggedId);
    const targetIdx = withoutDragged.indexOf(profileId);
    if (targetIdx === -1) return;
    const insertAt = targetPos === 'before' ? targetIdx : targetIdx + 1;
    const newOrder = [
      ...withoutDragged.slice(0, insertAt),
      draggedId,
      ...withoutDragged.slice(insertAt)
    ];
    try {
      await reorderProfiles(newOrder);
      // Cheap reload — no gateway reconnect, just refresh the settings
      // rune so the popover re-renders against the new order. Sibling
      // windows pick this up via the broadcast bus.
      await connection.reloadSettings();
    } catch (err) {
      toasts.show(`Reorder failed: ${(err as Error).message}`, 'error');
    }
  }

  function onPopoverDragEnd() {
    draggedProfileId = null;
    dropTargetProfileId = null;
    dropPosition = null;
  }

  // ---- Badge counters ---------------------------------------------------
  //
  // The Sidebar pulls live counts for Skills / Routines / Extensions via
  // the connection client. We do not want to hit the gateway on every
  // render, and we deliberately do not push these into shared stores
  // (per task constraints — sidebar may only read existing stores). A
  // 60s background poll, kicked off once a client is available, keeps the
  // numbers fresh enough for an at-a-glance indicator without becoming
  // chatty traffic.
  //
  // Threads count comes from the existing `threads` store, which the chat
  // page already populates / refreshes on send. We don't trigger an extra
  // fetch from here — if the user never visited Chat the badge stays 0,
  // which is the desired behavior (no spurious "you have N" with stale
  // counts pulled in the background).

  const BADGE_POLL_INTERVAL_MS = 60_000;

  let skillsCount = $state<number | null>(null);
  let routinesEnabled = $state<number | null>(null);
  let extensionsCount = $state<number | null>(null);
  /** Jobs badge — number of jobs currently in `in_progress` state. We do
   *  NOT badge `pending` or `stuck` so the count stays a useful "what's
   *  the agent doing RIGHT NOW" signal, matching the brief. */
  let jobsRunning = $state<number | null>(null);
  /** Missions badge — number of missions in `active` state. Mirrors the
   *  Jobs pattern (show the "what's live right now" count, not the total)
   *  so the badge is a useful glanceable signal rather than a static
   *  cardinality. Only polled when Engine v2 is enabled; otherwise stays
   *  null and the row is hidden anyway. */
  let missionsActive = $state<number | null>(null);

  let badgeTimer: ReturnType<typeof setInterval> | null = null;
  /** Tracks the last connection status we acted on so we don't re-fire
   *  the initial fetch every time `connection.client` re-derives. */
  let lastBadgeConnectionStatus: ConnectionStatus | null = null;

  async function refreshBadges(): Promise<void> {
    const client = connection.client;
    if (!client) {
      skillsCount = null;
      routinesEnabled = null;
      extensionsCount = null;
      jobsRunning = null;
      missionsActive = null;
      return;
    }
    // Each lookup is independent; failures are silent (the badge just stays
    // at its previous value or null). Bad-network blips shouldn't flash
    // numbers in/out of existence in the sidebar.
    //
    // The missions list endpoint is only probed when Engine v2 is enabled
    // on the active settings — older gateways return 404 here and we don't
    // want a 404 in the network tab on every poll for users who never
    // touched the toggle. We deliberately kick missions off in its own
    // `Promise.allSettled` so the core badge bundle keeps its precise
    // tuple typing — pushing onto a shared array forced TS to union the
    // four return shapes and rejected the heterogeneous push.
    const engineV2 = connection.settings.engineV2Enabled === true;
    const [skillsRes, routinesRes, extensionsRes, jobsRes] = await Promise.allSettled([
      client.listSkills(),
      client.routinesSummary(),
      client.listExtensions(),
      client.jobsSummary()
    ]);
    if (skillsRes.status === 'fulfilled') skillsCount = skillsRes.value.length;
    if (routinesRes.status === 'fulfilled') {
      routinesEnabled = routinesRes.value.enabled;
    }
    if (extensionsRes.status === 'fulfilled') extensionsCount = extensionsRes.value.length;
    if (jobsRes.status === 'fulfilled') jobsRunning = jobsRes.value.in_progress;
    if (engineV2) {
      const [missionsRes] = await Promise.allSettled([client.listMissions()]);
      if (missionsRes.status === 'fulfilled') {
        // Count missions whose `status` reads as "active" (case-insensitive)
        // — same vocabulary the badge palette uses. Other lifecycles
        // (paused / completed / failed / pending) aren't badged.
        missionsActive = missionsRes.value.filter(
          (m) => typeof m.status === 'string' && m.status.toLowerCase() === 'active'
        ).length;
      }
    } else {
      missionsActive = null;
    }
  }

  function startBadgePolling(): void {
    if (badgeTimer) return;
    badgeTimer = setInterval(() => {
      void refreshBadges();
    }, BADGE_POLL_INTERVAL_MS);
  }

  function stopBadgePolling(): void {
    if (badgeTimer) {
      clearInterval(badgeTimer);
      badgeTimer = null;
    }
  }

  // Reactive trigger: when the connection flips into 'connected', kick a
  // one-shot fetch + start the poller. On any other status, stop polling
  // and clear the cached counts so the sidebar doesn't show stale numbers
  // against a disconnected gateway.
  $effect(() => {
    const s = connection.status;
    if (s === lastBadgeConnectionStatus) return;
    lastBadgeConnectionStatus = s;
    if (s === 'connected') {
      void refreshBadges();
      startBadgePolling();
    } else {
      stopBadgePolling();
      skillsCount = null;
      routinesEnabled = null;
      extensionsCount = null;
      jobsRunning = null;
      missionsActive = null;
    }
  });

  /**
   * Chat badge — total thread count from the shared `threads` store. The
   * chat page is the only writer; if the user hasn't visited Chat the
   * store stays empty and we render nothing.
   *
   * TODO: surface unread / recent-activity count once the gateway exposes
   * a per-thread last-read marker. Until then total-threads is the
   * agreed-upon v1 stand-in.
   */
  const chatBadge = $derived<number | null>(
    threads.threads.length > 0 ? threads.threads.length : null
  );

  /**
   * Desk "Needs you" badge — the count of pending approval gates (the agent
   * paused and is waiting on a human decision). Gold = attention. Open loops
   * are deliberately NOT counted here so the badge stays a quiet "act now"
   * signal rather than always-on. Null when nothing is pending.
   */
  const deskBadge = $derived<number | null>(
    rebornDesk.gateCards.length > 0 ? rebornDesk.gateCards.length : null
  );

  const workAttention = $derived<boolean>(
    workItems.items.some(
      (item) =>
        item.status === 'waiting-approval' ||
        item.status === 'blocked' ||
        item.approvalBoundaries.some((gate) => gate.status === 'pending')
    )
  );

  const workBadge = $derived<number | null>(
    workItems.activeCount > 0 ? workItems.activeCount : null
  );

  /**
   * Routines badge — the count of enabled routines. The client does not
   * expose a real running count yet, so avoid implying live scheduler
   * state we cannot prove.
   */
  const routinesBadge = $derived.by<string | null>(() => {
    if (routinesEnabled === null) return null;
    if (routinesEnabled === 0) return null;
    return String(routinesEnabled);
  });

  const skillsBadge = $derived<number | null>(
    skillsCount !== null && skillsCount > 0 ? skillsCount : null
  );

  const extensionsBadge = $derived<number | null>(
    extensionsCount !== null && extensionsCount > 0 ? extensionsCount : null
  );

  /**
   * Jobs badge — number of in-progress background jobs. Hidden when zero so
   * the row stays quiet in the steady state ("the agent is idle"); the
   * collapsed-state corner dot stays cyan (informational) since a running
   * job isn't an error condition.
   */
  const jobsBadge = $derived<number | null>(
    jobsRunning !== null && jobsRunning > 0 ? jobsRunning : null
  );

  /**
   * Missions badge — number of active missions. Hidden when zero / null so
   * the row stays quiet when there's nothing live. The collapsed-state dot
   * is cyan (informational) since a live mission isn't an error condition.
   */
  const missionsBadge = $derived<number | null>(
    missionsActive !== null && missionsActive > 0 ? missionsActive : null
  );

  /**
   * Settings yellow dot — surfaces "needs attention" without piling text
   * into the row. Sources:
   *   - Local runner in a terminal error / unexpected exit state.
   *   - Updater in an error state (signature, network, etc).
   *
   * Hidden when neither condition holds, so the row stays quiet in the
   * common case.
   */
  const settingsNeedsAttention = $derived<boolean>(
    connection.sidecarStatus === 'error' ||
      connection.sidecarStatus === 'exited' ||
      updater.status === 'error'
  );

  onMount(() => {
    void connection.init();
    workItems.hydrate();

    // Hydrate collapsed state from localStorage. Defer to onMount so SSR
    // (if ever enabled) doesn't see a "1" before the browser has settled.
    try {
      if (typeof localStorage !== 'undefined') {
        collapsed = localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
      }
    } catch {
      // ignore
    }

    function onWindowClick(e: MouseEvent) {
      if (!popoverOpen) return;
      const t = e.target as Node | null;
      if (!t) return;
      if (chipRef?.contains(t)) return;
      if (popoverRef?.contains(t)) return;
      closePopover();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (popoverOpen && e.key === 'Escape') {
        e.preventDefault();
        closePopover();
      }
    }
    window.addEventListener('mousedown', onWindowClick);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onWindowClick);
      window.removeEventListener('keydown', onKeyDown);
      connection.stopPolling();
      stopBadgePolling();
    };
  });

  function pillLabel(s: ConnectionStatus): string {
    switch (s) {
      case 'connected':
        return 'Connected';
      case 'connecting':
        return 'Connecting…';
      case 'error':
        return 'Error';
      case 'disconnected':
      case 'idle':
      default:
        return 'Disconnected';
    }
  }

  /**
   * Compact account label shown below the connection pill when signed in.
   * Prefers `@<near-account>` over display name / user id so the most
   * specific identity surfaces. Returns null when there's nothing useful to
   * render — the row collapses entirely in that case to keep the sidebar
   * footer tidy.
   */
  const accountLabel = $derived.by<string | null>(() => {
    if (signIn.status !== 'signed-in' || !signIn.profile) return null;
    const p = signIn.profile;
    if (p.near_account) return `@${p.near_account}`;
    if (p.display_name) return p.display_name;
    if (p.user_id && p.user_id !== 'default') return p.user_id;
    return null;
  });

  // ---- Badge / dot helpers ---------------------------------------------
  //
  // `dotColorClass` picks a tailwind bg-* class per badge key so the
  // collapsed-state corner dot reads at a glance (cyan = informational
  // count, gold = attention, red = error). Keeps the row-level dot styling
  // out of the template.

  function dotColorClass(key: BadgeKey): string {
    switch (key) {
      // Desk gates are an "act now" attention signal → gold.
      case 'desk':
        return 'bg-accent-gold';
      case 'work':
        return workAttention ? 'bg-accent-gold' : 'bg-accent-cyan';
      case 'settings':
        return 'bg-accent-gold';
      // Jobs uses gold to match the "Running" tile on the /jobs page and
      // the Routines badge convention (gold = something in flight).
      case 'jobs':
        return 'bg-accent-gold';
      case 'chat':
      case 'skills':
      case 'routines':
      case 'extensions':
      case 'missions':
      default:
        return 'bg-accent-cyan';
    }
  }

  /**
   * True when the given badge has any payload (number/string for the
   * pills, boolean for the attention dots). Drives the collapsed-state
   * corner dot's visibility too.
   */
  function hasBadge(key: BadgeKey): boolean {
    switch (key) {
      case 'desk':
        return deskBadge !== null;
      case 'work':
        return workBadge !== null;
      case 'chat':
        return chatBadge !== null;
      case 'skills':
        return skillsBadge !== null;
      case 'routines':
        return routinesBadge !== null;
      case 'jobs':
        return jobsBadge !== null;
      case 'extensions':
        return extensionsBadge !== null;
      case 'missions':
        return missionsBadge !== null;
      case 'settings':
        return settingsNeedsAttention;
      default:
        return false;
    }
  }
</script>

<aside
  class="shrink-0 h-full bg-bg-deep/80 border-r border-border-subtle flex flex-col pt-10 transition-[width] duration-150 ease-out"
  class:w-56={!collapsed}
  class:w-14={collapsed}
>
  <!-- Brand. Collapses to just the wordmark glyph when narrow. The text
       label is hidden via `hidden`/`block` rather than `display: none`-vs-
       opacity tricks so the row height stays stable across the width
       transition. -->
  <div
    class="pb-5 flex items-center gap-2"
    class:px-5={!collapsed}
    class:px-0={collapsed}
    class:justify-center={collapsed}
  >
    <!-- Brand glyph + wordmark. Both bind to `--v2-accent` (rather than the
         Tailwind `text-accent-cyan` class) so the per-profile tint override
         in connection.svelte.ts repaints them when the active profile
         changes — the most visible signal of which profile owns this
         window. -->
    <NearMark size={24} class="shrink-0" style="color: var(--v2-accent);" />
    {#if !collapsed}
      <span class="text-lg font-semibold tracking-tight" style="color: var(--v2-accent);"
        >IronClaw</span
      >
    {/if}
  </div>

  <nav class="flex-1 space-y-1 overflow-y-auto" class:px-2={!collapsed} class:px-1={collapsed}>
    {#each visibleItems as item (item.href)}
      {@const active = isActive(item.href)}
      {@const showCornerDot = collapsed && item.badgeKey !== undefined && hasBadge(item.badgeKey)}
      {@const cornerDotClass = item.badgeKey ? dotColorClass(item.badgeKey) : 'bg-accent-cyan'}
      {#if item.href === '/knowledge' || item.href === '/jobs' || item.href === '/settings'}
        <div
          class="border-t border-border-subtle/70"
          class:mx-2={!collapsed}
          class:mx-3={collapsed}
          class:my-2={item.href !== '/settings'}
          class:mt-2={item.href === '/settings'}
          class:mb-1={item.href === '/settings'}
          aria-hidden="true"
        ></div>
      {/if}
      <a
        href={item.href}
        class="sidebar-nav-row group relative flex items-center rounded-md text-sm transition-[background-color,border-color,color,transform] duration-150 min-h-[44px] py-2 border {active
          ? 'border-accent-cyan bg-accent-cyan/10 text-accent-cyan font-medium'
          : 'border-transparent text-text-muted hover:bg-bg-surface/80 hover:text-text-primary'}"
        class:px-3={!collapsed}
        class:gap-2.5={!collapsed}
        class:px-0={collapsed}
        class:justify-center={collapsed}
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? item.label : undefined}
      >
        <span
          class="relative shrink-0 inline-flex h-5 w-5 items-center justify-center"
          class:text-accent-cyan={active}
        >
          {#if item.icon === 'spark'}
            <Icon name="spark" class="w-4 h-4" />
          {:else if item.icon === 'desk'}
            <!-- The Desk: shield glyph — "what needs you / what I'm guarding". -->
            <Icon name="shield" class="w-4 h-4" />
          {:else if item.icon === 'streams'}
            <!-- Streams: activity-feed glyph — three stacked rows each led by a
                 filled dot, reads as "a feed of events" at thumbnail size.
                 Deliberately distinct from the Logs 'pulse' glyph (Streams is
                 the cross-surface activity timeline, not the raw log tail). -->
            <svg
              viewBox="0 0 24 24"
              class="w-4 h-4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="5" cy="7" r="1.3" fill="currentColor" stroke="none" />
              <line x1="9" y1="7" x2="20" y2="7" />
              <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
              <line x1="9" y1="12" x2="20" y2="12" />
              <circle cx="5" cy="17" r="1.3" fill="currentColor" stroke="none" />
              <line x1="9" y1="17" x2="20" y2="17" />
            </svg>
          {:else if item.icon === 'chat'}
            <Icon name="chat" class="w-4 h-4" />
          {:else if item.icon === 'work'}
            <Icon name="list" class="w-4 h-4" />
          {:else if item.icon === 'knowledge'}
            <Icon name="folder" class="w-4 h-4" />
          {:else if item.icon === 'memory'}
            <!-- Memory glyph: stacked cards. Visually distinct from the
                 single-folder knowledge icon (which represents the on-disk
                 tree) — three offset rectangles read as "accumulated
                 entries" at thumbnail size. Inline SVG to match the rest
                 of the 1.7-stroke / currentColor icons in the set. -->
            <svg
              viewBox="0 0 24 24"
              class="w-4 h-4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="8" width="14" height="11" rx="1.5" />
              <path
                d="M7 8V6.5A1.5 1.5 0 0 1 8.5 5H19a1.5 1.5 0 0 1 1.5 1.5V17a1.5 1.5 0 0 1-1.5 1.5h-1.5"
              />
              <path d="M11 4.5V3.5A1 1 0 0 1 12 2.5h7a1 1 0 0 1 1 1V14" opacity="0.5" />
            </svg>
          {:else if item.icon === 'skills'}
            <Icon name="tool" class="w-4 h-4" />
          {:else if item.icon === 'extensions'}
            <!-- TODO: add 'puzzle-piece' to Icon component. No matching glyph
                 in the shared set yet — keeping inline as a fallback so the
                 row keeps its distinctive shape. -->
            <svg
              viewBox="0 0 24 24"
              class="w-4 h-4"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <!-- Puzzle piece glyph -->
              <path
                d="M19.4 7H17V4.6c0-.88-.72-1.6-1.6-1.6h-2.8c-.88 0-1.6.72-1.6 1.6V7H8.6C7.72 7 7 7.72 7 8.6v2.8h2.4c.88 0 1.6.72 1.6 1.6s-.72 1.6-1.6 1.6H7v2.8c0 .88.72 1.6 1.6 1.6h2.8v-2.4c0-.88.72-1.6 1.6-1.6s1.6.72 1.6 1.6V19h2.8c.88 0 1.6-.72 1.6-1.6V15h2.4c.88 0 1.6-.72 1.6-1.6v-2.8c0-.88-.72-1.6-1.6-1.6H21V8.6c0-.88-.72-1.6-1.6-1.6z"
              />
            </svg>
          {:else if item.icon === 'routines'}
            <Icon name="clock" class="w-4 h-4" />
          {:else if item.icon === 'jobs'}
            <Icon name="layers" class="w-4 h-4" />
          {:else if item.icon === 'canvas'}
            <Icon name="layers" class="w-4 h-4" />
          {:else if item.icon === 'logs'}
            <Icon name="pulse" class="w-4 h-4" />
          {:else if item.icon === 'admin'}
            <Icon name="shield" class="w-4 h-4" />
          {:else if item.icon === 'missions'}
            <!-- TODO: add 'target' (crosshair) to Icon component — semantically
                 closer than the flag glyph used here. Falling back to `flag`
                 from the shared set in the meantime. -->
            <Icon name="flag" class="w-4 h-4" />
          {:else if item.icon === 'settings'}
            <Icon name="settings" class="w-4 h-4" />
          {/if}

          <!-- Collapsed-state corner dot. Renders absolutely-positioned in
               the icon's top-right so it stacks regardless of icon shape.
               Hidden in expanded mode (the pill renders inline instead). -->
          {#if showCornerDot}
            <span
              class="absolute -top-0.5 -right-1 w-2 h-2 rounded-full ring-2 ring-bg-base {cornerDotClass}"
              aria-hidden="true"
            ></span>
          {/if}
        </span>

        {#if !collapsed}
          <span class="flex-1 truncate">{item.label}</span>

          <!-- Expanded-mode badges + dots. Three flavors:
               1. Numeric pill — Chat / Skills / Extensions.
               2. String pill — Routines.
               3. Attention dot — Settings (gold).
               All sit before the shortcut hint so the shortcut keeps its
               right-anchored column. -->
          {#if item.badgeKey === 'desk' && deskBadge !== null}
            <span class="sidebar-badge" aria-label="{deskBadge} awaiting your approval"
              >{deskBadge}</span
            >
          {:else if item.badgeKey === 'work' && workBadge !== null}
            <span class="sidebar-badge" aria-label="{workBadge} live work items">{workBadge}</span>
          {:else if item.badgeKey === 'chat' && chatBadge !== null}
            <span class="sidebar-badge" aria-label="{chatBadge} threads">{chatBadge}</span>
          {:else if item.badgeKey === 'skills' && skillsBadge !== null}
            <span class="sidebar-badge" aria-label="{skillsBadge} installed skills"
              >{skillsBadge}</span
            >
          {:else if item.badgeKey === 'routines' && routinesBadge !== null}
            <span class="sidebar-badge" aria-label="{routinesEnabled} enabled routines"
              >{routinesBadge}</span
            >
          {:else if item.badgeKey === 'jobs' && jobsBadge !== null}
            <span class="sidebar-badge" aria-label="{jobsBadge} jobs running">{jobsBadge}</span>
          {:else if item.badgeKey === 'extensions' && extensionsBadge !== null}
            <span class="sidebar-badge" aria-label="{extensionsBadge} installed extensions"
              >{extensionsBadge}</span
            >
          {:else if item.badgeKey === 'missions' && missionsBadge !== null}
            <span class="sidebar-badge" aria-label="{missionsBadge} active missions"
              >{missionsBadge}</span
            >
          {:else if item.badgeKey === 'settings' && settingsNeedsAttention}
            <span
              class="w-2 h-2 rounded-full bg-accent-gold"
              aria-label="settings need attention"
              title={updater.status === 'error' ? 'Updater error' : 'Runner needs attention'}
            ></span>
          {/if}

          {#if item.shortcut}
            <span
              class="text-[10px] font-mono opacity-60 tracking-wider shrink-0 rounded border border-border-subtle bg-bg-deep/60 px-1.5 py-px"
              aria-hidden="true"
            >
              {item.shortcut}
            </span>
          {/if}
        {:else}
          <!-- Collapsed-state tooltip. Pure CSS — fades in on row hover via
               the `.group-hover` selector wired in app.css. Anchored to the
               right edge so it pops out of the narrow column without
               getting clipped by the aside's overflow. -->
          <span class="sidebar-tooltip" role="tooltip">
            <span class="font-medium">{item.label}</span>
            {#if item.shortcut}
              <span class="ml-2 font-mono opacity-60">{item.shortcut}</span>
            {/if}
          </span>
        {/if}
      </a>
    {/each}
  </nav>

  <!-- Profile chip + popover. Sits above the connection-status pill so the
       eye scans profile → status from top to bottom. The chip is wrapped in
       `relative` so the popover can position itself just above using
       `absolute bottom-full`.
       Hidden entirely when collapsed (no horizontal room for a chip + name
       + chevron). The profile switcher is still reachable via the
       /settings page and the global shortcut. -->
  {#if !collapsed}
    <div class="px-3 pt-3 border-t border-border-subtle">
      <div class="relative">
        <button
          bind:this={chipRef}
          type="button"
          onclick={togglePopover}
          class="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs hover:bg-bg-surface/80 transition-colors min-h-[44px] border border-transparent {popoverOpen
            ? 'bg-accent-cyan/10'
            : ''}"
          class:border-accent-cyan={popoverOpen}
          aria-haspopup="listbox"
          aria-expanded={popoverOpen}
          title="Switch profile"
        >
          <!-- Profile glyph (stacked-disks) -->
          <svg
            viewBox="0 0 24 24"
            class="w-3.5 h-3.5 text-accent-cyan shrink-0"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          </svg>
          <span class="flex-1 text-left truncate text-text-primary">
            {connection.activeProfile.name}
          </span>
          <!-- Chevron rotates with popover state -->
          <svg
            viewBox="0 0 24 24"
            class="w-3 h-3 opacity-60 transition-transform shrink-0"
            class:rotate-180={popoverOpen}
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

        {#if popoverOpen}
          <!-- Popover. Anchored to the chip via `bottom-full + mb-1` so it
               grows upward — the sidebar bottom is already crowded by the
               status pill below. Width matches the chip (`left-0 right-0`)
               so it stays inside the 224px sidebar. -->
          <div
            bind:this={popoverRef}
            class="absolute left-0 right-0 bottom-full mb-1 z-40 surface border border-border-subtle p-1 shadow-xl bg-bg-deep"
            role="listbox"
            aria-label="Profiles"
          >
            {#each connection.settings.profiles as profile (profile.id)}
              {@const isActiveProfile = profile.id === connection.activeProfile.id}
              {@const profilePalette = resolveTint(profile.tint)}
              {@const isDragging = draggedProfileId === profile.id}
              {@const isDropTarget =
                dropTargetProfileId === profile.id && draggedProfileId !== profile.id}
              {@const canReorder = connection.settings.profiles.length > 1}
              <!-- Row wrapper hosts the drag handlers + opacity feedback.
                   The clickable button still owns the row's primary action
                   (switch / cmd-click → new window) — only the small grip
                   on the left is `draggable`, so picking up the row body
                   never accidentally starts a drag. -->
              <div
                class="relative flex items-center gap-1 rounded-md transition-opacity"
                class:opacity-50={isDragging}
                ondragover={(e) => onPopoverDragOver(e, profile.id)}
                ondragleave={(e) => onPopoverDragLeave(e, profile.id)}
                ondrop={(e) => void onPopoverDrop(e, profile.id)}
                role="presentation"
              >
                {#if isDropTarget && dropPosition === 'before'}
                  <span
                    class="absolute -top-0.5 left-1 right-1 h-0.5 bg-accent-cyan rounded-full pointer-events-none"
                    aria-hidden="true"
                  ></span>
                {/if}
                {#if isDropTarget && dropPosition === 'after'}
                  <span
                    class="absolute -bottom-0.5 left-1 right-1 h-0.5 bg-accent-cyan rounded-full pointer-events-none"
                    aria-hidden="true"
                  ></span>
                {/if}

                <!-- Tighter drag handle than Settings — 14×24 strip with a
                     mini grip glyph. Hidden when there's only one profile so
                     the column doesn't carry dead chrome. -->
                {#if canReorder}
                  <div
                    class="shrink-0 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-text-muted hover:text-accent-cyan hover:bg-bg-surface cursor-grab active:cursor-grabbing transition-colors"
                    draggable="true"
                    ondragstart={(e) => onPopoverDragStart(e, profile.id)}
                    ondragend={onPopoverDragEnd}
                    title="Drag to reorder"
                    aria-label="Drag to reorder {profile.name}"
                    role="button"
                    tabindex="-1"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      class="w-3 h-3.5"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <circle cx="9" cy="6" r="1.5" />
                      <circle cx="15" cy="6" r="1.5" />
                      <circle cx="9" cy="12" r="1.5" />
                      <circle cx="15" cy="12" r="1.5" />
                      <circle cx="9" cy="18" r="1.5" />
                      <circle cx="15" cy="18" r="1.5" />
                    </svg>
                  </div>
                {/if}

                <button
                  type="button"
                  onclick={(e) => void pickProfile(profile.id, e)}
                  title={isActiveProfile
                    ? 'Already active — Cmd+click to open in a new window'
                    : 'Click to switch, Cmd+click to open in a new window'}
                  class="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-2 rounded-md text-xs text-left hover:bg-bg-surface transition-colors min-h-[44px] {isActiveProfile
                    ? 'bg-accent-cyan/10'
                    : ''}"
                  role="option"
                  aria-selected={isActiveProfile}
                >
                  <!-- Tint dot — paints the profile's accent so multi-profile
                       users see at a glance which window will pick up which
                       palette. Inactive rows render a filled dot at the
                       profile's tint; the active row stacks a ring around the
                       same dot to double as a radio indicator without losing
                       the tint signal. -->
                  <span
                    class="w-3 h-3 rounded-full shrink-0 flex items-center justify-center"
                    class:ring-2={isActiveProfile}
                    style="background-color: {profilePalette.accent}; box-shadow: {isActiveProfile
                      ? `0 0 0 2px ${profilePalette.soft}`
                      : 'none'};"
                    aria-hidden="true"
                  ></span>
                  <span
                    class="flex-1 truncate"
                    class:text-text-primary={isActiveProfile}
                    class:text-text-muted={!isActiveProfile}
                  >
                    {profile.name}
                  </span>
                  <span
                    class="text-[9px] uppercase tracking-wider opacity-60 font-mono shrink-0"
                    aria-hidden="true"
                  >
                    {profile.mode === 'local' ? 'L' : 'R'}
                  </span>
                </button>
              </div>
            {/each}

            <div class="my-1 border-t border-border-subtle"></div>

            <button
              type="button"
              onclick={openNewProfile}
              class="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs text-left hover:bg-bg-surface text-accent-cyan transition-colors min-h-[44px]"
            >
              <svg
                viewBox="0 0 24 24"
                class="w-3.5 h-3.5 shrink-0"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span class="flex-1">New profile</span>
            </button>

            <button
              type="button"
              onclick={() => void gotoManageProfiles()}
              class="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs text-left hover:bg-bg-surface text-text-muted hover:text-text-primary transition-colors min-h-[44px]"
            >
              <svg
                viewBox="0 0 24 24"
                class="w-3.5 h-3.5 shrink-0"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path
                  d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
                />
              </svg>
              <span class="flex-1">Manage profiles</span>
            </button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Connection-status row. In expanded mode it's a labeled pill + the
       optional signed-in account tag below it. In collapsed mode it
       shrinks to just the dot, centered, with the status label in a
       hover tooltip (matching the nav-row treatment). -->
  <div
    class="border-t border-border-subtle"
    class:px-3={!collapsed}
    class:py-4={!collapsed}
    class:px-0={collapsed}
    class:py-3={collapsed}
  >
    {#if collapsed}
      <div
        class="sidebar-nav-row group relative flex items-center justify-center"
        title={connection.lastError ?? pillLabel(connection.status)}
      >
        <span
          class="w-2.5 h-2.5 rounded-full"
          class:bg-positive={connection.status === 'connected'}
          class:bg-accent-gold={connection.status === 'connecting'}
          class:bg-danger={connection.status === 'error' ||
            connection.status === 'disconnected' ||
            connection.status === 'idle'}
          aria-label={pillLabel(connection.status)}
        ></span>
        <span class="sidebar-tooltip" role="tooltip">
          <span class="font-medium">{pillLabel(connection.status)}</span>
        </span>
      </div>
    {:else}
      <div
        class="flex min-h-[44px] items-center gap-2 px-2.5 py-2 rounded-md text-xs bg-bg-surface/40"
        title={connection.lastError ?? undefined}
      >
        <span
          class="w-2 h-2 rounded-full"
          class:bg-positive={connection.status === 'connected'}
          class:bg-accent-gold={connection.status === 'connecting'}
          class:bg-danger={connection.status === 'error' ||
            connection.status === 'disconnected' ||
            connection.status === 'idle'}
        ></span>
        <span
          class:text-text-primary={connection.status === 'connected'}
          class:text-accent-gold={connection.status === 'connecting'}
          class:text-danger={connection.status === 'error'}
          class:text-text-muted={connection.status === 'disconnected' ||
            connection.status === 'idle'}
        >
          {pillLabel(connection.status)}
        </span>
      </div>
      {#if accountLabel}
        <!-- Signed-in identity tucked just below the connection pill so the
             eye scans profile → status → account top-to-bottom. Truncates on
             long account names to keep the sidebar footer from breaking out
             of its 224 px column. -->
        <div
          class="flex items-center gap-2 px-2 pb-0.5 text-[10px] font-mono text-text-muted truncate"
          title={accountLabel}
        >
          <svg
            viewBox="0 0 24 24"
            class="w-2.5 h-2.5 shrink-0 text-accent-cyan"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          <span class="truncate">{accountLabel}</span>
        </div>
      {/if}
    {/if}
  </div>

  <!-- Collapse toggle. Lives at the very bottom (below the profile chip +
       connection pill) so it's the last thing the eye lands on and never
       fights with the nav for attention. Icon flips direction with state
       so it always points "out" of the current edge. -->
  <div
    class="border-t border-border-subtle"
    class:px-2={!collapsed}
    class:px-1={collapsed}
    class:py-2={true}
  >
    <button
      type="button"
      onclick={toggleCollapsed}
      class="sidebar-nav-row group relative flex items-center w-full rounded-md text-xs text-text-muted hover:text-text-primary hover:bg-bg-surface transition-colors min-h-[44px]"
      class:justify-center={collapsed}
      class:gap-2={!collapsed}
      class:px-2={!collapsed}
      class:px-0={collapsed}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      <svg
        viewBox="0 0 24 24"
        class="w-3.5 h-3.5 shrink-0 transition-transform"
        class:rotate-180={collapsed}
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
      {#if !collapsed}
        <span class="flex-1 text-left">Collapse</span>
      {:else}
        <span class="sidebar-tooltip" role="tooltip">
          <span class="font-medium">Expand sidebar</span>
        </span>
      {/if}
    </button>
  </div>
</aside>

<NewProfileModal bind:open={newProfileModalOpen} onClose={() => (newProfileModalOpen = false)} />

<style>
  /* Badge pill — small mono number on a dark surface, deliberately muted
     so it doesn't compete with the row label. */
  :global(.sidebar-badge) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    padding: 0 0.375rem;
    height: 1.1rem;
    border-radius: 9999px;
    border: 1px solid var(--v2-border);
    background-color: var(--v2-accent-soft);
    color: var(--v2-accent-text);
    font-family: 'SF Mono', Menlo, monospace;
    font-size: 10px;
    line-height: 1;
    flex-shrink: 0;
  }

  /* Collapsed-state tooltip. Pure CSS — `.sidebar-nav-row` adds
     `position: relative` so the tooltip can pop out to the right via
     `left: calc(100% + 0.5rem)`. Stays hidden + non-interactive until the
     row receives :hover or :focus-visible, then fades in over 100ms. */
  :global(.sidebar-nav-row) {
    position: relative;
  }

  :global(.sidebar-tooltip) {
    position: absolute;
    left: calc(100% + 0.5rem);
    top: 50%;
    transform: translateY(-50%);
    z-index: 50;
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    background-color: var(--v2-canvas-strong);
    border: 1px solid var(--v2-accent);
    color: var(--v2-text-strong);
    font-size: 11px;
    line-height: 1.2;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--v2-dur-fast) var(--v2-ease-out);
  }

  :global(.sidebar-nav-row:hover) .sidebar-tooltip,
  :global(.sidebar-nav-row:focus-visible) .sidebar-tooltip,
  :global(.sidebar-nav-row:hover) :global(.sidebar-tooltip),
  :global(.sidebar-nav-row:focus-visible) :global(.sidebar-tooltip) {
    opacity: 1;
  }
</style>
