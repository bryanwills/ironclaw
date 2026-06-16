<script lang="ts" module>
  /**
   * Playground shell — sidebar list + main body.
   *
   * The page (`+page.svelte`) owns the story registry (component + meta
   * pairs) and passes them down via the `stories` prop. The shell stays
   * structural: it picks the active story by id, renders the sidebar
   * with title + description, and mounts the chosen story component in
   * the main panel.
   *
   * Stories own their own controls layout (right rail inside the story).
   * This keeps each story self-contained — adding a new prop doesn't
   * require touching the shell.
   */

  import type { Component } from 'svelte';

  export interface StoryEntry {
    /** Stable id used as the URL hash and lookup key. */
    id: string;
    /** Story metadata mirrored off each story file's `meta` export. */
    title: string;
    description: string;
    /** The story component itself — mounted in the main panel. */
    Story: Component;
  }
</script>

<script lang="ts">
  interface Props {
    stories: StoryEntry[];
    /** Currently-selected story id. Bound by the parent so URL hash and
     *  state stay in sync. */
    activeId: string;
    onSelect: (id: string) => void;
  }

  let { stories, activeId, onSelect }: Props = $props();

  const activeStory = $derived(stories.find((s) => s.id === activeId) ?? stories[0]);
</script>

<!-- The playground renders inside the root layout's <main> element, which
     already provides a flex-1 scroll container with a pt-8 inset and the
     app's left sidebar to the side. We fill the full available height so
     the playground's own sidebar (component list) reads as the primary
     navigation for this surface. -->
<div class="flex h-[calc(100vh-2.75rem)] bg-bg-base text-text-primary overflow-hidden">
  <!-- Sidebar — replaces the normal app sidebar for this route. -->
  <aside class="w-64 shrink-0 bg-bg-deep border-r border-border-subtle flex flex-col">
    <div class="px-4 py-4 border-b border-border-subtle">
      <div class="text-[10px] uppercase tracking-widest text-accent-cyan font-semibold">Dev</div>
      <div class="text-sm font-semibold text-text-primary mt-0.5">Component playground</div>
      <div class="text-[11px] text-text-muted/70 mt-1 leading-snug">
        {stories.length} stories. Hidden from prod nav.
      </div>
    </div>

    <nav class="flex-1 overflow-y-auto py-2">
      {#each stories as story (story.id)}
        {@const active = story.id === activeStory?.id}
        <button
          type="button"
          onclick={() => onSelect(story.id)}
          class="w-full text-left px-4 py-2 transition-colors border-l-2"
          class:border-accent-cyan={active}
          class:border-transparent={!active}
          class:bg-bg-surface={active}
          class:text-text-primary={active}
          class:text-text-muted={!active}
          class:hover:bg-bg-surface={true}
          class:hover:text-text-primary={true}
        >
          <div class="text-sm font-medium">{story.title}</div>
          <div class="text-[10px] text-text-muted/70 mt-0.5 truncate">
            {story.description}
          </div>
        </button>
      {/each}
    </nav>

    <div
      class="px-4 py-3 border-t border-border-subtle text-[10px] text-text-muted/70 font-mono leading-snug"
    >
      <div>route: /dev/playground</div>
      <div class="mt-0.5">guarded: <span class="text-accent-cyan">import.meta.env.DEV</span></div>
    </div>
  </aside>

  <!-- Main panel — the chosen story owns its own layout (preview + controls). -->
  <main class="flex-1 overflow-hidden">
    <div class="h-full px-6 py-6">
      {#if activeStory}
        {@const StoryComponent = activeStory.Story}
        <StoryComponent />
      {:else}
        <div class="text-text-muted text-sm">No story selected.</div>
      {/if}
    </div>
  </main>
</div>
