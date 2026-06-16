<script lang="ts">
  // RecentThreadsTile — dashboard widget showing the 5 most-recently
  // updated chat threads.
  //
  // Data source: the shared `threads` store (sorted desc by
  // updated_at). If the user hasn't visited Chat yet the store is
  // empty, in which case we kick off a one-shot `refresh()` against
  // the gateway so the tile still has something to render. Failures
  // surface as an inline error strip + a one-time toast — the tile
  // stays visible so the user can retry from the dashboard.
  //
  // Per the brief the tile renders title + turn count + last-update
  // timestamp per row, plus a "View all →" footer linking to `/`.

  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { connection } from '$lib/stores/connection.svelte';
  import { threads } from '$lib/stores/threads.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';

  let loading = $state(false);
  let loadError = $state<string | null>(null);

  const recent = $derived(threads.sorted.slice(0, 5));

  onMount(async () => {
    // If the user hit /dashboard cold (no prior chat visit), kick off
    // a one-shot refresh. The store's own `loading` flag is gated on
    // the client, so we just delegate.
    if (threads.threads.length === 0 && connection.client) {
      loading = true;
      try {
        await threads.refresh();
      } catch (err) {
        loadError = (err as Error).message;
        toasts.show(`Failed to load threads: ${(err as Error).message}`, 'error');
      } finally {
        loading = false;
      }
    }
  });

  function fmtRelative(iso?: string | null): string {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const delta = Date.now() - t;
    if (delta < 60_000) return 'just now';
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
    const days = Math.floor(delta / 86_400_000);
    if (days < 30) return `${days}d ago`;
    return new Date(t).toLocaleDateString();
  }

  function openThread(id: string) {
    threads.selectThread(id);
    void goto('/chat');
  }
</script>

{#if loadError && recent.length === 0}
  <p class="text-xs text-danger" data-testid="recent-threads-error">
    Couldn't load threads. {loadError}
  </p>
{:else if loading && recent.length === 0}
  <!-- Skeleton placeholders. Three quiet rows so the layout
       footprint is stable while the request resolves. -->
  <ul class="space-y-2" aria-busy="true" data-testid="recent-threads-skeleton">
    {#each Array(3) as _, i (i)}
      <li class="h-10 rounded-md bg-bg-base/60"></li>
    {/each}
  </ul>
{:else if recent.length === 0}
  <p class="text-xs text-text-muted">No threads yet. Start a chat from the sidebar.</p>
{:else}
  <ul class="space-y-1.5" data-testid="recent-threads-list">
    {#each recent as thread (thread.id)}
      <li>
        <button
          type="button"
          onclick={() => openThread(thread.id)}
          class="w-full min-h-[44px] text-left px-2.5 py-2 rounded-md hover:bg-bg-base/60 transition-colors flex items-center gap-2"
        >
          <span class="flex-1 truncate text-sm text-text-primary">
            {thread.title || 'Untitled'}
          </span>
          <span class="shrink-0 text-[10px] font-mono text-text-muted">
            {thread.message_count ?? 0} turns
          </span>
          <span class="shrink-0 text-[10px] font-mono text-text-muted">
            {fmtRelative(thread.updated_at)}
          </span>
        </button>
      </li>
    {/each}
  </ul>
{/if}
