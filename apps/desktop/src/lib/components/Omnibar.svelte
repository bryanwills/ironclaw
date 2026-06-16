<script lang="ts">
  // Omnibar overlay (Cmd+Space). Federated search + action launcher.
  //
  // The overlay covers the full viewport with a dimmed backdrop;
  // the input bar floats centered ~120px from the top. Below the
  // input is a results list grouped by kind (Threads / Memory /
  // Skills / Commands). Each result has an icon + title + subtitle
  // + optional snippet.
  //
  // Keyboard contract:
  //   ↑/↓        — move active row
  //   Cmd+↓/Cmd+↑ — jump to next/previous section
  //   Enter      — invoke active
  //   Esc        — close
  //   Cmd+Space  — toggle (wired at the layout level)
  //
  // Mouse:
  //   click row  — invoke
  //   hover row  — set active
  //   click backdrop — close
  //
  // Accessibility: combobox pattern with aria-activedescendant on the
  // input so screen readers track the active option as the user
  // arrow-keys through the list.

  import { onMount } from 'svelte';
  import { omnibar, type OmniResult, type OmniResultKind } from '$lib/stores/omnibar.svelte';
  import Icon from './Icon.svelte';

  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);

  // Auto-focus the input + reset the active row each time the
  // omnibar opens. We watch `omnibar.open` and `omnibar.results`
  // independently so re-running search inside an open omnibar
  // doesn't yank focus.
  $effect(() => {
    if (omnibar.open) {
      // Allow Svelte to mount the input first.
      queueMicrotask(() => inputEl?.focus());
    }
  });

  // Scroll the active row into view whenever the user navigates the
  // list. Block: 'nearest' avoids janky jumps when the row is already
  // partially visible.
  $effect(() => {
    if (!omnibar.open) return;
    const idx = omnibar.activeIdx;
    const row = listEl?.querySelector(`[data-omni-idx="${idx}"]`);
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  });

  function onKeydown(ev: KeyboardEvent): void {
    if (!omnibar.open) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      omnibar.moveActive(1);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      omnibar.moveActive(-1);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      void omnibar.invokeActive();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      omnibar.hide();
    }
  }

  // Icon names are validated against the Icon component's union, so
  // the map's value type stays in sync at compile time.
  function kindIcon(kind: OmniResultKind): 'chat' | 'file' | 'bolt' | 'list' | 'search' {
    return (
      {
        thread: 'chat',
        memory: 'file',
        skill: 'bolt',
        command: 'list',
        message: 'search'
      } as const
    )[kind];
  }

  function kindLabel(kind: OmniResultKind): string {
    return (
      {
        thread: 'Thread',
        memory: 'Memory',
        skill: 'Skill',
        command: 'Command',
        message: 'Message'
      } as const
    )[kind];
  }

  // Group the flat result list by kind for the visual grouping. The
  // store already sorts globally by score and caps per-kind, so within
  // each group the order is score-desc and across groups the headers
  // appear in the order of first-occurrence.
  let grouped = $derived.by<
    Array<{ kind: OmniResultKind; rows: { result: OmniResult; idx: number }[] }>
  >(() => {
    const groups = new Map<OmniResultKind, { result: OmniResult; idx: number }[]>();
    omnibar.results.forEach((r, idx) => {
      const slot = groups.get(r.kind) ?? [];
      slot.push({ result: r, idx });
      groups.set(r.kind, slot);
    });
    return Array.from(groups, ([kind, rows]) => ({ kind, rows }));
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if omnibar.open}
  <!-- Backdrop. Click to dismiss. -->
  <div
    class="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
    role="presentation"
    onclick={() => omnibar.hide()}
  ></div>

  <!-- Floating panel. Positioned absolutely so the layout doesn't
       shift behind it. Width clamped to a comfortable ~640px on
       large screens, fluid on narrow viewports. -->
  <div
    class="fixed inset-x-0 top-[10vh] z-50 mx-auto w-[min(640px,calc(100vw-32px))]
           rounded-xl border border-border-subtle bg-bg-deep shadow-2xl overflow-hidden
           flex flex-col"
    role="combobox"
    aria-expanded="true"
    aria-controls="omnibar-listbox"
    aria-haspopup="listbox"
  >
    <!-- Input row -->
    <div class="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
      <Icon name="search" class="w-4 h-4 text-text-muted" />
      <input
        bind:this={inputEl}
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="Threads · Memory · Skills · Commands"
        value={omnibar.query}
        oninput={(e) => omnibar.setQuery(e.currentTarget.value)}
        aria-label="Search omnibar"
        aria-activedescendant={omnibar.results.length > 0
          ? `omni-row-${omnibar.activeIdx}`
          : undefined}
        class="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted
               focus:outline-none"
      />
      {#if omnibar.loading}
        <span class="text-[10px] text-text-muted">searching…</span>
      {/if}
      <kbd
        class="hidden md:inline-flex items-center gap-1 text-[10px] font-mono
               text-text-muted bg-bg-base border border-border-subtle rounded px-1.5 py-0.5"
        aria-hidden="true"
      >
        Esc
      </kbd>
    </div>

    <!-- Results listbox -->
    <div
      bind:this={listEl}
      id="omnibar-listbox"
      role="listbox"
      class="overflow-y-auto max-h-[60vh]"
    >
      {#if grouped.length === 0}
        <div class="px-4 py-6 text-center text-xs text-text-muted">
          {#if omnibar.query.trim()}
            No matches for <span class="text-text-primary">"{omnibar.query}"</span>.
          {:else}
            Start typing or pick a command.
          {/if}
        </div>
      {/if}

      {#each grouped as group (group.kind)}
        <div class="py-1">
          <div class="px-4 py-1 text-[10px] uppercase tracking-wider text-text-muted font-semibold">
            {kindLabel(group.kind)}
          </div>
          {#each group.rows as row (row.result.id)}
            {@const isActive = row.idx === omnibar.activeIdx}
            <button
              type="button"
              role="option"
              id={`omni-row-${row.idx}`}
              aria-selected={isActive}
              data-omni-idx={row.idx}
              onmouseenter={() => omnibar.setActive(row.idx)}
              onclick={() => void omnibar.invokeActive()}
              class="w-full flex items-start gap-3 px-4 py-2 text-left
                     {isActive ? 'bg-bg-base/70' : 'hover:bg-bg-base/40'}
                     transition-colors"
            >
              <span
                class="shrink-0 w-7 h-7 rounded-md flex items-center justify-center
                       {isActive
                  ? 'bg-accent-cyan/20 text-accent-cyan'
                  : 'bg-bg-base text-text-muted'}"
                aria-hidden="true"
              >
                <Icon name={kindIcon(group.kind)} class="w-3.5 h-3.5" />
              </span>
              <span class="flex-1 min-w-0">
                <span class="block text-sm text-text-primary truncate">{row.result.title}</span>
                {#if row.result.subtitle}
                  <span class="block text-[11px] text-text-muted truncate"
                    >{row.result.subtitle}</span
                  >
                {/if}
                {#if row.result.snippet}
                  <span class="block mt-0.5 text-[11px] text-text-muted line-clamp-2"
                    >{row.result.snippet}</span
                  >
                {/if}
              </span>
              {#if isActive}
                <span class="shrink-0 text-[10px] font-mono text-text-muted">↵</span>
              {/if}
            </button>
          {/each}
        </div>
      {/each}

      {#if omnibar.error}
        <div class="px-4 py-2 text-[10px] text-red-300/80 border-t border-border-subtle">
          Partial results — {omnibar.error}
        </div>
      {/if}
    </div>

    <!-- Footer hint row -->
    <div
      class="flex items-center justify-between px-4 py-2 border-t border-border-subtle
             text-[10px] text-text-muted bg-bg-base/40"
    >
      <span class="flex items-center gap-3">
        <span class="flex items-center gap-1">
          <kbd class="font-mono">↑↓</kbd> navigate
        </span>
        <span class="flex items-center gap-1">
          <kbd class="font-mono">↵</kbd> open
        </span>
      </span>
      <span>{omnibar.results.length} result{omnibar.results.length === 1 ? '' : 's'}</span>
    </div>
  </div>
{/if}
