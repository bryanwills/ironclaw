<script lang="ts">
  // R81 (lane W4): Streams — activity feed across the workspace.
  //
  // Cards for: recent threads (chat), recently-run routines (briefings),
  // and recently-used skills. Filter chips collapse the feed by kind.
  // Click a thread card to jump to /?thread=id; the rest go to their
  // home routes.

  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { connection } from '$lib/stores/connection.svelte';
  import { streams, type StreamEvent, type StreamEventKind } from '$lib/stores/streams.svelte';
  import { surfaceRefresh } from '$lib/stores/surface-refresh.svelte';
  import { relativeTime } from '$lib/util/format-time';

  onMount(async () => {
    if (!connection.client) await connection.init();
    await streams.load();
    surfaceRefresh.register(async () => {
      await streams.load();
    });
  });

  onDestroy(() => surfaceRefresh.unregister());

  const filterChips: Array<{ kind: StreamEventKind | 'all'; label: string }> = [
    { kind: 'all', label: 'All' },
    { kind: 'chat', label: 'Chats' },
    { kind: 'briefing', label: 'Briefings' },
    { kind: 'skill', label: 'Skills' }
  ];

  function onCardClick(event: StreamEvent): void {
    if (event.thread_id) {
      goto(`/chat?thread=${encodeURIComponent(event.thread_id)}`);
      return;
    }
    if (event.kind === 'briefing') {
      goto('/routines');
      return;
    }
    if (event.kind === 'skill') {
      goto('/skills');
      return;
    }
  }

  function kindColor(kind: StreamEventKind): string {
    switch (kind) {
      case 'chat':
        return 'border-accent-cyan/40 text-accent-cyan';
      case 'briefing':
        return 'border-emerald-400/30 text-emerald-300';
      case 'skill':
        return 'border-amber-400/30 text-amber-300';
      default:
        return 'border-border-subtle text-text-muted';
    }
  }

  function formatTime(iso: string): string {
    // Keep the "—" sentinel for missing/zero timestamps; defer the rest to
    // the canonical relativeTime util (R93) — richer buckets (w/mo/y).
    const t = Date.parse(iso);
    if (Number.isNaN(t) || t === 0) return '—';
    return relativeTime(t);
  }
</script>

<svelte:head><title>Streams · IronClaw</title></svelte:head>

<div class="p-6 h-full overflow-auto">
  <header class="mb-6">
    <h1 class="text-2xl font-medium text-text-primary">Streams</h1>
    <p class="text-sm text-text-muted mt-1">Activity across your workspace</p>
  </header>

  <div class="flex items-center gap-2 mb-4 flex-wrap">
    {#each filterChips as chip (chip.kind)}
      <button
        type="button"
        aria-pressed={streams.filter === chip.kind}
        onclick={() => streams.setFilter(chip.kind)}
        class="px-3 py-1 rounded-full text-xs border transition-colors
               {streams.filter === chip.kind
          ? 'border-accent-cyan text-accent-cyan bg-accent-cyan/10'
          : 'border-border-subtle text-text-muted hover:text-text-primary'}"
      >
        {chip.label}
      </button>
    {/each}
  </div>

  {#if streams.loading && streams.events.length === 0}
    <div class="text-sm text-text-muted">Loading activity…</div>
  {:else if streams.error}
    <div class="text-sm text-red-300">{streams.error}</div>
  {:else if streams.filtered().length === 0}
    <div class="text-sm text-text-muted py-8 text-center">
      {streams.filter === 'all'
        ? 'No activity yet. Chats, skills, and routines appear here.'
        : `No ${streams.filter} events`}
    </div>
  {:else}
    <div class="flex flex-col gap-2 max-w-3xl">
      {#each streams.filtered() as event (event.id)}
        <button
          type="button"
          onclick={() => onCardClick(event)}
          class="text-left rounded-lg border border-border-subtle bg-bg-deep/40
                 hover:border-accent-cyan/40 hover:bg-bg-deep/60 transition-colors
                 px-4 py-3"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span
                  class="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase border {kindColor(
                    event.kind
                  )}"
                >
                  {event.kind}
                </span>
                <span class="text-sm font-medium text-text-primary truncate">{event.title}</span>
              </div>
              <div class="text-xs text-text-muted line-clamp-2">{event.preview}</div>
            </div>
            <div class="shrink-0 text-[10px] text-text-muted font-mono">
              {formatTime(event.occurred_at)}
            </div>
          </div>
        </button>
      {/each}
    </div>
  {/if}
</div>
