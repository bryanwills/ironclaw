<script lang="ts">
  // Component playground (dev-only). Storybook-lite: each component in
  // src/lib/components/ has a sibling .story.svelte that owns its own
  // preview + controls + code snippet. The shell renders the sidebar
  // list and mounts whichever story is active.
  //
  // Gating:
  //   - `import.meta.env.DEV` is true under `vite dev` and false in
  //     production builds. On mount we check the flag; non-DEV visitors
  //     are redirected to / with a toast. The Command Palette gates its
  //     own action on the same flag so the entry point isn't even
  //     surfaced in production.
  //   - The static adapter still ships the route in `build/dev/...` but
  //     the runtime redirect means nobody can land on it. We accept the
  //     ~few-KB cost in exchange for keeping the build pipeline
  //     unchanged (no dynamic include/exclude in svelte.config.js).
  //
  // The active story is keyed by URL hash so a bookmark like
  // `/dev/playground#sparkline` lands on the right story. Bidirectional:
  // selecting a story in the sidebar updates the hash.

  import { onMount, type Component } from 'svelte';
  import { goto } from '$app/navigation';
  import { toasts } from '$lib/stores/toasts.svelte';

  import type { StoryEntry } from './PlaygroundShell.svelte';

  // Story imports. Each .story.svelte module exports `meta` and the
  // default Svelte component. We collate them into a single registry
  // here so the shell stays component-agnostic.

  // Registry. Order here is the order in the sidebar. Ids are stable
  // slugs used in the URL hash.
  let PlaygroundShell = $state<Component<any> | null>(null);
  let STORIES = $state<StoryEntry[]>([]);

  // Active id lives in state and is synced bidirectionally with the URL
  // hash. The default falls through to the first story when the hash is
  // empty or matches no registered id.
  let activeId = $state<string>('icon');
  let allowed = $state<boolean>(false);

  function readHash(): string {
    if (typeof window === 'undefined') return '';
    return window.location.hash.replace(/^#/, '') || '';
  }

  function pickInitialId(): string {
    const hash = readHash();
    if (hash && STORIES.some((s) => s.id === hash)) return hash;
    return STORIES[0].id;
  }

  function onSelect(id: string): void {
    activeId = id;
    if (typeof window !== 'undefined') {
      // history.replaceState avoids polluting the back stack while
      // navigating between stories. The hash is the source of truth for
      // deep links.
      try {
        history.replaceState(null, '', `#${id}`);
      } catch {
        // ignore — replaceState can throw in sandboxed contexts.
      }
    }
  }

  // Listen for back/forward navigation so the sidebar selection follows
  // the URL hash.
  function onHashChange() {
    const next = readHash();
    if (next && STORIES.some((s) => s.id === next)) activeId = next;
  }

  onMount(() => {
    // Dev-mode guard. Vite's `import.meta.env.DEV` is true under `vite
    // dev` and false in production builds. A redirect + toast is the
    // simplest contract: non-DEV visitors land on / with a visible hint
    // rather than an unexplained empty screen.
    if (!import.meta.env.DEV) {
      toasts.show('Playground is dev-only.', 'info');
      void goto('/chat');
      return;
    }
    let mounted = true;
    void (async () => {
      const [
        shellModule,
        iconModule,
        maskedValueModule,
        sparklineModule,
        toastsModule,
        markdownViewModule,
        cronPreviewModule,
        newProfileModalModule,
        lightboxModalModule,
        aboutDialogModule,
        presetsModalModule,
        tokenSourceBadgeModule,
        toolFlowPanelModule
      ] = await Promise.all([
        import('./PlaygroundShell.svelte'),
        import('./stories/Icon.story.svelte'),
        import('./stories/MaskedValue.story.svelte'),
        import('./stories/Sparkline.story.svelte'),
        import('./stories/Toasts.story.svelte'),
        import('./stories/MarkdownView.story.svelte'),
        import('./stories/CronPreview.story.svelte'),
        import('./stories/NewProfileModal.story.svelte'),
        import('./stories/LightboxModal.story.svelte'),
        import('./stories/AboutDialog.story.svelte'),
        import('./stories/PresetsModal.story.svelte'),
        import('./stories/TokenSourceBadge.story.svelte'),
        import('./stories/ToolFlowPanel.story.svelte')
      ]);
      if (!mounted) return;

      PlaygroundShell = shellModule.default;
      STORIES = [
        {
          id: 'icon',
          title: iconModule.meta.title,
          description: iconModule.meta.description,
          Story: iconModule.default
        },
        {
          id: 'masked-value',
          title: maskedValueModule.meta.title,
          description: maskedValueModule.meta.description,
          Story: maskedValueModule.default
        },
        {
          id: 'sparkline',
          title: sparklineModule.meta.title,
          description: sparklineModule.meta.description,
          Story: sparklineModule.default
        },
        {
          id: 'toasts',
          title: toastsModule.meta.title,
          description: toastsModule.meta.description,
          Story: toastsModule.default
        },
        {
          id: 'markdown-view',
          title: markdownViewModule.meta.title,
          description: markdownViewModule.meta.description,
          Story: markdownViewModule.default
        },
        {
          id: 'cron-preview',
          title: cronPreviewModule.meta.title,
          description: cronPreviewModule.meta.description,
          Story: cronPreviewModule.default
        },
        {
          id: 'new-profile-modal',
          title: newProfileModalModule.meta.title,
          description: newProfileModalModule.meta.description,
          Story: newProfileModalModule.default
        },
        {
          id: 'lightbox-modal',
          title: lightboxModalModule.meta.title,
          description: lightboxModalModule.meta.description,
          Story: lightboxModalModule.default
        },
        {
          id: 'about-dialog',
          title: aboutDialogModule.meta.title,
          description: aboutDialogModule.meta.description,
          Story: aboutDialogModule.default
        },
        {
          id: 'presets-modal',
          title: presetsModalModule.meta.title,
          description: presetsModalModule.meta.description,
          Story: presetsModalModule.default
        },
        {
          id: 'token-source-badge',
          title: tokenSourceBadgeModule.meta.title,
          description: tokenSourceBadgeModule.meta.description,
          Story: tokenSourceBadgeModule.default
        },
        {
          id: 'tool-flow-panel',
          title: toolFlowPanelModule.meta.title,
          description: toolFlowPanelModule.meta.description,
          Story: toolFlowPanelModule.default
        }
      ];
      allowed = true;
      activeId = pickInitialId();
      window.addEventListener('hashchange', onHashChange);
    })();
    return () => {
      mounted = false;
      window.removeEventListener('hashchange', onHashChange);
    };
  });
</script>

<svelte:head>
  <title>Component playground — IronClaw Desktop (dev)</title>
</svelte:head>

{#if allowed}
  <PlaygroundShell stories={STORIES} {activeId} {onSelect} />
{:else}
  <!-- Brief blank state while the dev-mode check runs. The redirect path
       fires synchronously inside onMount so this rarely paints. -->
  <div
    class="h-screen w-screen flex items-center justify-center bg-bg-base text-text-muted text-sm"
  >
    Checking dev mode…
  </div>
{/if}
