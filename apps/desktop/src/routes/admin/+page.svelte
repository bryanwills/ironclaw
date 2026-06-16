<script lang="ts">
  // /admin — admin-only surface for the active IronClaw profile.
  //
  // Three tabs: Tool Policy (per-tool 3-way allow/prompt/deny editor),
  // System Prompt (admin-scoped SYSTEM.md), and Usage (the 30-day cost
  // dashboard + per-<user, model> breakdown). All three require the
  // active profile's bearer to carry the admin role; the gateway returns
  // 401/403 otherwise and each editor surfaces a clear message instead
  // of a stack trace.
  //
  // Visibility: this route is mounted unconditionally, but the sidebar
  // entry + Cmd+7 shortcut + a redirect-out guard in `+layout.svelte`
  // collectively gate it behind `settings.adminMode`. Reaching the URL
  // directly with adminMode off still bounces to /settings on next tick.

  import { onDestroy, onMount, type Component } from 'svelte';
  import { connection } from '$lib/stores/connection.svelte';
  import { surfaceRefresh } from '$lib/stores/surface-refresh.svelte';

  type Tab = 'tool-policy' | 'system-prompt' | 'usage';
  let activeTab = $state<Tab>('tool-policy');
  let ToolPolicyEditor = $state<Component<any> | null>(null);
  let SystemPromptEditor = $state<Component<any> | null>(null);
  let UsageDashboard = $state<Component<any> | null>(null);

  // The profile-name header mirrors what Settings shows so the admin
  // surface obviously inherits "whatever profile is active right now".
  // It's not a chooser — switching profiles still lives in the sidebar.
  const profileName = $derived(connection.activeProfile?.name ?? '—');

  // Token that gates the active tab's #key block. Bumping this forces
  // Svelte to unmount and re-mount the editor component, which triggers
  // its onMount-driven data load. Used by the layout-level Cmd+R hook
  // so a refresh re-fetches the active tab without us reaching into
  // each editor's internals.
  let refreshToken = $state(0);

  onMount(async () => {
    const [toolPolicyModule, systemPromptModule, usageModule] = await Promise.all([
      import('./ToolPolicyEditor.svelte'),
      import('./SystemPromptEditor.svelte'),
      import('./UsageDashboard.svelte')
    ]);
    ToolPolicyEditor = toolPolicyModule.default;
    SystemPromptEditor = systemPromptModule.default;
    UsageDashboard = usageModule.default;

    surfaceRefresh.register(async () => {
      refreshToken++;
    });
  });

  onDestroy(() => surfaceRefresh.unregister());
</script>

<section class="p-8 h-full flex flex-col overflow-hidden">
  <header class="mb-5 flex items-baseline justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold text-text-primary">Admin</h1>
      <p class="text-text-muted text-sm mt-1">
        Multi-tenant gateway controls. Active profile:
        <span class="text-text-primary font-mono">{profileName}</span>.
      </p>
    </div>
  </header>

  <!-- Tabs. Matches the Extensions surface visual treatment so the user
       picks up the pattern across admin-flavored surfaces. -->
  <div
    class="mb-5 flex items-center gap-1 border-b border-border-subtle"
    role="tablist"
    aria-label="Admin sections"
  >
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === 'tool-policy'}
      onclick={() => (activeTab = 'tool-policy')}
      class="px-4 py-2 text-sm font-medium border-b-2 -mb-px transition"
      class:border-accent-cyan={activeTab === 'tool-policy'}
      class:text-accent-cyan={activeTab === 'tool-policy'}
      class:border-transparent={activeTab !== 'tool-policy'}
      class:text-text-muted={activeTab !== 'tool-policy'}
      class:hover:text-text-primary={activeTab !== 'tool-policy'}
    >
      Tool policy
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === 'system-prompt'}
      onclick={() => (activeTab = 'system-prompt')}
      class="px-4 py-2 text-sm font-medium border-b-2 -mb-px transition"
      class:border-accent-cyan={activeTab === 'system-prompt'}
      class:text-accent-cyan={activeTab === 'system-prompt'}
      class:border-transparent={activeTab !== 'system-prompt'}
      class:text-text-muted={activeTab !== 'system-prompt'}
      class:hover:text-text-primary={activeTab !== 'system-prompt'}
    >
      System prompt
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === 'usage'}
      onclick={() => (activeTab = 'usage')}
      class="px-4 py-2 text-sm font-medium border-b-2 -mb-px transition"
      class:border-accent-cyan={activeTab === 'usage'}
      class:text-accent-cyan={activeTab === 'usage'}
      class:border-transparent={activeTab !== 'usage'}
      class:text-text-muted={activeTab !== 'usage'}
      class:hover:text-text-primary={activeTab !== 'usage'}
    >
      Usage
    </button>
  </div>

  <!-- Body. All three editors render full-height inside the flex container.
       Mounted via #if rather than just toggling visibility so each
       editor re-runs its load when the user re-enters the tab — that
       picks up server-side edits between visits without a manual refresh.
       Usage also relies on the unmount path to clear its 60s poll timer.
       The {#key} wrapper bumps on Cmd+R so the active editor remounts
       and re-runs its onMount-driven load. -->
  {#key refreshToken}
    {#if activeTab === 'tool-policy'}
      <ToolPolicyEditor />
    {:else if activeTab === 'system-prompt'}
      <SystemPromptEditor />
    {:else}
      <UsageDashboard />
    {/if}
  {/key}
</section>
