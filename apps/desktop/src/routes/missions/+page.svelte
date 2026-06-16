<script lang="ts">
  // Engine v2 missions surface.
  //
  // Three panes:
  //   1. Left rail (240px) — projects list. Includes a synthetic
  //      "All projects" row so the user can browse missions across
  //      every project. Each row shows the project name + the count
  //      of engine threads belonging to it.
  //   2. Center pane — missions list filtered to the selected project
  //      (or all). Cards show: name + clamped goal + status badge +
  //      cadence_description + thread_count.
  //   3. Right drawer (40% width) — MissionDetail panel, only when a
  //      mission is selected. Slides in over the center pane.
  //
  // Polling cadence: 30s background refresh + a manual Refresh button.
  // We don't pause polling when the drawer is open the way /jobs does —
  // missions data is far less chatty (handful of rows vs hundreds of
  // job events) and reordering under an open drawer here is fine since
  // selection is by id, not row index.

  import { onDestroy, onMount } from 'svelte';
  import type { EngineMission, EngineProject, EngineThread } from '$lib/api/types';
  import { connection } from '$lib/stores/connection.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { surfaceRefresh } from '$lib/stores/surface-refresh.svelte';
  import { createPollingRefresh } from '$lib/util/polling';
  let MissionDetail = $state<typeof import('./MissionDetail.svelte').default | null>(null);
  let ResizeHandle = $state<typeof import('$lib/components/ResizeHandle.svelte').default | null>(
    null
  );

  // ---- Projects-rail width (drag-to-resize) ---------------------------------
  //
  // Projects rail is user-resizable via a `ResizeHandle` strip between
  // the rail and the missions list. The right-side detail drawer renders
  // via `position: fixed` so it doesn't participate in this layout —
  // only the two-column main pane is in scope.
  //
  // Below `NARROW_VIEWPORT_PX` the handle disappears and the rail snaps
  // back to its default width.
  const PROJECTS_RAIL_DEFAULT = 240;
  const PROJECTS_RAIL_MIN = 200;
  const PROJECTS_RAIL_MAX = 400;
  const NARROW_VIEWPORT_PX = 900;
  const PROJECTS_RAIL_STORAGE_KEY = 'ironclaw-missions-projects-width';

  let projectsRailWidth = $state<number>(PROJECTS_RAIL_DEFAULT);
  let viewportWidth = $state<number>(typeof window === 'undefined' ? 1280 : window.innerWidth);
  const resizeEnabled = $derived(viewportWidth >= NARROW_VIEWPORT_PX);
  const effectiveProjectsRailWidth = $derived(
    resizeEnabled ? projectsRailWidth : PROJECTS_RAIL_DEFAULT
  );

  // 30s matches the brief. Faster than the sidebar's 60s badge poll so
  // the open surface stays fresh, slower than /jobs (15s) since
  // missions don't churn second-to-second.
  const POLL_INTERVAL_MS = 30_000;

  /** Synthetic "all" project id. Never collides with real UUIDs.
   *  Selecting this disables the project filter entirely. */
  const ALL_PROJECTS_ID = '__all__';

  let projects = $state<EngineProject[]>([]);
  let missions = $state<EngineMission[]>([]);
  let engineThreads = $state<EngineThread[]>([]);

  let selectedProjectId = $state<string>(ALL_PROJECTS_ID);
  let selectedMissionId = $state<string | null>(null);

  let initialLoad = $state(true);
  let refreshing = $state(false);
  let loadError = $state<string | null>(null);

  let missionsPoll: ReturnType<typeof createPollingRefresh> | null = null;

  /** The currently selected mission row (or null when the drawer is
   *  closed). We resolve from the in-memory list rather than calling
   *  getMission() so the drawer stays in sync with list refreshes. */
  const selectedMission = $derived<EngineMission | null>(
    selectedMissionId ? (missions.find((m) => m.id === selectedMissionId) ?? null) : null
  );

  /** Whether the synthetic "All projects" row is the active selection.
   *  Pulled out so the template doesn't need a misplaced {@const} inside
   *  the bare <ul> (svelte requires {@const} live inside an {#if} /
   *  {#each} / {#snippet} block). */
  const allProjectsSelected = $derived<boolean>(selectedProjectId === ALL_PROJECTS_ID);

  /** Missions filtered to the selected project. Note: the current wire
   *  doesn't always emit `project_id` on mission rows — when the field
   *  is missing on every row, filtering by a real project id would
   *  produce an empty list. To avoid surfacing what looks like a bug,
   *  if no mission has a `project_id` at all we return the full list
   *  even when a specific project is selected (the empty-state copy
   *  still spells out "No missions" if the underlying list is empty). */
  const filteredMissions = $derived.by<EngineMission[]>(() => {
    if (selectedProjectId === ALL_PROJECTS_ID) return missions;
    const anyHasProject = missions.some(
      (m) => typeof m.project_id === 'string' && m.project_id.length > 0
    );
    if (!anyHasProject) return missions;
    return missions.filter((m) => m.project_id === selectedProjectId);
  });

  /** Engine-thread count for a given project, used in the left rail.
   *  When a thread row omits `project_id` it's not counted toward any
   *  bucket (we don't have a sensible default). */
  function threadCountForProject(projectId: string): number {
    if (projectId === ALL_PROJECTS_ID) return engineThreads.length;
    return engineThreads.filter((t) => t.project_id === projectId).length;
  }

  /** Stable display name for a project row. Prefer `title` over `name`
   *  (slug) over the id. */
  function projectDisplayName(p: EngineProject): string {
    return p.title?.trim() || p.name?.trim() || p.id;
  }

  /** Mission display name follows the same convention as the drawer. */
  function missionDisplayName(m: EngineMission): string {
    return m.title?.trim() || m.name?.trim() || m.id;
  }

  /** Status palette per the brief:
   *    active     → cyan
   *    paused     → gold
   *    completed  → green
   *    failed     → red
   *    pending    → muted gray
   *    everything else → neutral border */
  function statusBadgeClass(status: string | undefined): string {
    const s = (status ?? '').toLowerCase();
    switch (s) {
      case 'active':
        return 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30';
      case 'paused':
        return 'bg-accent-gold/10 text-accent-gold border-accent-gold/30';
      case 'completed':
        return 'bg-green-500/10 text-green-400 border-green-500/30';
      case 'failed':
        return 'bg-red-500/10 text-red-400 border-red-500/30';
      case 'pending':
        return 'bg-text-muted/10 text-text-muted border-text-muted/30';
      default:
        return 'bg-bg-deep text-text-muted border-border-subtle';
    }
  }

  function selectProject(id: string): void {
    if (selectedProjectId === id) return;
    selectedProjectId = id;
    // Close the drawer when switching projects so the user isn't staring
    // at a mission detail that's no longer in the filtered list. The
    // drawer can be reopened with another click.
    selectedMissionId = null;
  }

  function selectMission(id: string): void {
    selectedMissionId = id;
  }

  function closeDetail(): void {
    selectedMissionId = null;
  }

  onMount(async () => {
    const [missionDetailModule, resizeHandleModule] = await Promise.all([
      import('./MissionDetail.svelte'),
      import('$lib/components/ResizeHandle.svelte')
    ]);
    MissionDetail = missionDetailModule.default;
    ResizeHandle = resizeHandleModule.default;

    void refresh();
    missionsPoll = createPollingRefresh(() => refresh({ silent: true }), POLL_INTERVAL_MS);
    missionsPoll.start();

    // Hydrate the projects-rail width from localStorage. ResizeHandle
    // also pushes the value back from its own mount, but we read here
    // so the first paint uses the persisted width.
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(PROJECTS_RAIL_STORAGE_KEY);
        const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
        if (Number.isFinite(parsed)) {
          projectsRailWidth = Math.min(Math.max(parsed, PROJECTS_RAIL_MIN), PROJECTS_RAIL_MAX);
        }
      }
    } catch {
      // ignore — defaults stand.
    }

    // Track viewport width so the resize handle drops out below the
    // narrow-viewport threshold.
    const onResize = () => {
      viewportWidth = window.innerWidth;
    };
    viewportWidth = window.innerWidth;
    window.addEventListener('resize', onResize);
    viewportResizeCleanup = () => window.removeEventListener('resize', onResize);

    // Surface refresh (Cmd+R): reload missions + projects together via
    // the existing refresh() (non-silent so the Refreshing… affordance
    // on the existing button label is visible for the same beat).
    surfaceRefresh.register(async () => {
      await refresh();
    });
  });

  /** Cleanup hook for the window resize listener wired in onMount. Stored
   *  on a module-local so onDestroy can release it alongside `pollTimer`. */
  let viewportResizeCleanup: (() => void) | null = null;

  onDestroy(() => {
    missionsPoll?.stop();
    if (viewportResizeCleanup) viewportResizeCleanup();
    surfaceRefresh.unregister();
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
      // Three independent lookups. Use allSettled so a missing
      // /api/engine/threads (older gateway) doesn't tank the missions
      // list. Failures fall through to the catch only if all three
      // throw the same upstream error.
      const [projectsRes, missionsRes, threadsRes] = await Promise.allSettled([
        client.listProjects(),
        client.listMissions(),
        client.listEngineThreads()
      ]);
      if (projectsRes.status === 'fulfilled') projects = projectsRes.value;
      if (missionsRes.status === 'fulfilled') missions = missionsRes.value;
      if (threadsRes.status === 'fulfilled') engineThreads = threadsRes.value;
      // Surface a load error only when every individual lookup failed —
      // otherwise the partial data is still useful and the error would
      // just clutter the page.
      const allFailed =
        projectsRes.status === 'rejected' &&
        missionsRes.status === 'rejected' &&
        threadsRes.status === 'rejected';
      loadError = allFailed
        ? ((projectsRes.reason as Error)?.message ?? 'Failed to load Engine v2 data')
        : null;
      if (!opts.silent && loadError !== null) {
        toasts.show(`Refresh failed: ${loadError}`, 'error');
      }
    } catch (err) {
      loadError = (err as Error).message;
      if (!opts.silent) toasts.show(`Refresh failed: ${loadError}`, 'error');
    } finally {
      refreshing = false;
      initialLoad = false;
    }
  }
</script>

<section class="p-8 h-full flex flex-col">
  <header class="mb-6 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold text-text-primary">Missions</h1>
      <p class="text-text-muted text-sm mt-1">
        Mission projects, runs, and the threads they generate.
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
    <!-- Disconnected guard. Mirrors /jobs so the off-network state reads
         the same across surfaces. -->
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
  {:else if initialLoad && projects.length === 0 && missions.length === 0 && !loadError}
    <div class="surface flex-1 flex items-center justify-center text-text-muted text-sm">
      Loading Engine v2 data…
    </div>
  {:else if loadError && projects.length === 0 && missions.length === 0}
    <div class="surface flex-1 flex flex-col items-center justify-center gap-2 p-8">
      <div class="text-sm text-red-400">Failed to load Engine v2 data</div>
      <div class="text-xs text-text-muted font-mono">{loadError}</div>
      <button
        type="button"
        onclick={() => void refresh()}
        class="mt-3 px-3 py-1.5 rounded-md border border-accent-cyan text-accent-cyan text-xs hover:bg-accent-cyan hover:text-bg-deep transition-colors"
      >
        Retry
      </button>
    </div>
  {:else}
    <!-- Three-pane body. Left rail width is user-resizable; center pane
         flexes to fill the rest. The right drawer renders absolutely
         over the center pane via MissionDetail's fixed positioning so it
         doesn't participate in this resize. The `gap-4` is unset in
         favor of an explicit gutter around the `ResizeHandle` so the
         handle's hover glow gets clean breathing room. -->
    <div class="flex-1 flex overflow-hidden">
      <!-- Left rail: projects. Includes an "All projects" pseudo-row so
           the user can clear the filter without a separate control.
           Width driven by `effectiveProjectsRailWidth`. -->
      <aside
        class="shrink-0 surface flex flex-col overflow-hidden"
        style="width: {effectiveProjectsRailWidth}px;"
        aria-label="Mission projects"
      >
        <header class="px-4 py-3 border-b border-border-subtle">
          <h2 class="text-xs font-semibold text-text-muted uppercase tracking-wide">Projects</h2>
        </header>
        {#if projects.length === 0}
          <div class="flex-1 p-4 text-xs text-text-muted italic">
            Enable Engine v2 in Settings, then create a project or run a mission.
          </div>
        {:else}
          <ul class="flex-1 overflow-auto py-2">
            <!-- "All projects" pseudo-row. Always present; selecting it
                 returns the unfiltered missions list. The `allProjectsSelected`
                 derived above keeps the class bindings readable without
                 a misplaced template {@const} (Svelte 5 requires {@const}
                 inside an {#if}/{#each}/{#snippet} block). -->
            <li>
              <button
                type="button"
                onclick={() => selectProject(ALL_PROJECTS_ID)}
                class="w-full flex items-center justify-between gap-2 px-4 py-2 text-xs transition-colors min-h-[36px]"
                class:bg-bg-deep={allProjectsSelected}
                class:text-text-primary={allProjectsSelected}
                class:border-l-2={allProjectsSelected}
                class:border-accent-cyan={allProjectsSelected}
                class:text-text-muted={!allProjectsSelected}
                class:hover:bg-bg-deep={!allProjectsSelected}
                class:hover:text-text-primary={!allProjectsSelected}
                aria-current={allProjectsSelected ? 'true' : undefined}
              >
                <span class="truncate">All projects</span>
                <span class="text-[10px] font-mono opacity-70">
                  {engineThreads.length}
                </span>
              </button>
            </li>

            {#each projects as project (project.id)}
              {@const isSelected = selectedProjectId === project.id}
              {@const threadCount = threadCountForProject(project.id)}
              <li>
                <button
                  type="button"
                  onclick={() => selectProject(project.id)}
                  class="w-full flex items-center justify-between gap-2 px-4 py-2 text-xs transition-colors min-h-[36px]"
                  class:bg-bg-deep={isSelected}
                  class:text-text-primary={isSelected}
                  class:border-l-2={isSelected}
                  class:border-accent-cyan={isSelected}
                  class:text-text-muted={!isSelected}
                  class:hover:bg-bg-deep={!isSelected}
                  class:hover:text-text-primary={!isSelected}
                  title={project.description ?? projectDisplayName(project)}
                  aria-current={isSelected ? 'true' : undefined}
                >
                  <span class="truncate">{projectDisplayName(project)}</span>
                  <span class="text-[10px] font-mono opacity-70">
                    {threadCount}
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </aside>

      <!-- Resize handle between projects rail and missions list. Mirrors
           the chat/knowledge pattern: 8px gutter on each side via mx so
           the cyan hover glow has breathing room without crowding the
           panes. Hidden below the narrow-viewport threshold. -->
      {#if resizeEnabled}
        <div class="flex items-stretch mx-2">
          <ResizeHandle
            min={PROJECTS_RAIL_MIN}
            max={PROJECTS_RAIL_MAX}
            defaultWidth={PROJECTS_RAIL_DEFAULT}
            storageKey={PROJECTS_RAIL_STORAGE_KEY}
            initialWidth={projectsRailWidth}
            onresize={(w) => (projectsRailWidth = w)}
          />
        </div>
      {:else}
        <!-- Spacer replacing the parent's prior gap-4 in the
             narrow-viewport (non-resizable) layout. -->
        <div class="w-4 shrink-0"></div>
      {/if}

      <!-- Center pane: missions list. Cards are click-to-open-drawer. -->
      <div class="flex-1 surface flex flex-col overflow-hidden">
        <header
          class="px-5 py-3 border-b border-border-subtle flex items-center justify-between gap-3"
        >
          <h2 class="text-xs font-semibold text-text-muted uppercase tracking-wide">
            Missions
            {#if filteredMissions.length > 0}
              <span class="text-text-primary normal-case">
                ({filteredMissions.length})
              </span>
            {/if}
          </h2>
        </header>

        {#if missions.length === 0}
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
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="4.5" />
              <line x1="12" y1="2" x2="12" y2="5" />
              <line x1="12" y1="19" x2="12" y2="22" />
              <line x1="2" y1="12" x2="5" y2="12" />
              <line x1="19" y1="12" x2="22" y2="12" />
            </svg>
            <div class="text-sm text-text-primary">No missions in this project.</div>
            <div class="text-xs text-text-muted max-w-md">
              Missions appear here once the gateway provisions them.
            </div>
          </div>
        {:else if filteredMissions.length === 0}
          <div class="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
            <div class="text-sm text-text-primary">No missions in this project.</div>
            <button
              type="button"
              onclick={() => selectProject(ALL_PROJECTS_ID)}
              class="mt-1 px-3 py-1.5 rounded-md border border-accent-cyan text-accent-cyan text-xs hover:bg-accent-cyan hover:text-bg-deep transition-colors"
            >
              Show all projects
            </button>
          </div>
        {:else}
          <ul class="flex-1 overflow-auto p-4 space-y-3">
            {#each filteredMissions as mission (mission.id)}
              {@const isSelected = selectedMissionId === mission.id}
              <li>
                <button
                  type="button"
                  onclick={() => selectMission(mission.id)}
                  class="w-full text-left bg-bg-deep border rounded-md p-4 transition-colors"
                  class:border-accent-cyan={isSelected}
                  class:border-border-subtle={!isSelected}
                  class:hover:border-accent-cyan={!isSelected}
                  aria-pressed={isSelected}
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0 flex-1">
                      <div class="text-sm font-semibold text-text-primary truncate">
                        {missionDisplayName(mission)}
                      </div>
                      {#if mission.goal && mission.goal.trim().length > 0}
                        <!-- 2-line goal clamp. We use inline `-webkit-box`
                             CSS (matching the pattern in ExtensionCard /
                             SkillCard) rather than Tailwind's `line-clamp-2`
                             utility — this project doesn't pull in the
                             `@tailwindcss/line-clamp` plugin, so the
                             utility class would be a silent no-op. -->
                        <p
                          class="mt-1 text-xs text-text-muted leading-relaxed overflow-hidden"
                          style="display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;"
                          title={mission.goal}
                        >
                          {mission.goal.trim()}
                        </p>
                      {/if}
                    </div>
                    <span
                      class="inline-block shrink-0 px-2 py-0.5 rounded text-[10px] uppercase tracking-wide border font-medium {statusBadgeClass(
                        mission.status
                      )}"
                    >
                      {mission.status ?? 'unknown'}
                    </span>
                  </div>

                  <div
                    class="mt-3 flex items-center justify-between gap-3 text-[11px] text-text-muted"
                  >
                    <span class="truncate" title={mission.cadence_description ?? ''}>
                      {#if mission.cadence_description}
                        {mission.cadence_description}
                      {:else if mission.cadence_type}
                        {mission.cadence_type}
                      {:else}
                        —
                      {/if}
                    </span>
                    <span class="shrink-0 font-mono">
                      {mission.thread_count ?? 0} threads
                    </span>
                  </div>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  {/if}
</section>

{#if selectedMission}
  <MissionDetail mission={selectedMission} threads={engineThreads} onclose={closeDetail} />
{/if}
