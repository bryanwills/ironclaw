<script lang="ts">
  // ActiveRoutinesTile — dashboard widget showing the next routines to
  // fire (or currently running).
  //
  // Data source: `client.listRoutines()`. We filter to enabled
  // routines, sort by `next_run` ascending (running shows on top with
  // a "running" badge if a future server populates `running` state),
  // and slice to 3. Refresh once on mount; the dashboard isn't a
  // poller — the user can click "View all →" to land on the
  // /routines surface which DOES poll.
  //
  // Empty state distinguishes "no routines defined" from "no routines
  // enabled" so the user knows whether to create one or just toggle
  // an existing one.

  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { connection } from '$lib/stores/connection.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import type { Routine } from '$lib/api/types';

  let routines = $state<Routine[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let didFail = false;

  async function load() {
    if (!connection.client) {
      loading = false;
      return;
    }
    loading = true;
    loadError = null;
    try {
      routines = await connection.client.listRoutines();
    } catch (err) {
      loadError = (err as Error).message;
      // One-shot toast — we don't want a noisy retry loop if the
      // gateway is wedged. The inline strip remains so the user can
      // try again from the dashboard or via the Routines page.
      if (!didFail) {
        toasts.show(`Failed to load routines: ${(err as Error).message}`, 'error');
        didFail = true;
      }
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  // Enabled routines first, sorted by next_run ascending (soonest
  // first). Disabled rows are filtered out — the brief asks for
  // "active" routines, not the full inventory.
  const upcoming = $derived(
    routines
      .filter((r) => r.enabled)
      .sort((a, b) => {
        const ta = a.next_run ? Date.parse(a.next_run) : Number.MAX_SAFE_INTEGER;
        const tb = b.next_run ? Date.parse(b.next_run) : Number.MAX_SAFE_INTEGER;
        return ta - tb;
      })
      .slice(0, 3)
  );

  function fmtNext(iso?: string | null): string {
    if (!iso) return 'unscheduled';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return 'unscheduled';
    const delta = t - Date.now();
    if (delta < 0) return 'overdue';
    if (delta < 60_000) return 'in <1m';
    if (delta < 3_600_000) return `in ${Math.floor(delta / 60_000)}m`;
    if (delta < 86_400_000) return `in ${Math.floor(delta / 3_600_000)}h`;
    return `in ${Math.floor(delta / 86_400_000)}d`;
  }

  function openRoutine(id: string) {
    void goto(`/routines?id=${encodeURIComponent(id)}`);
  }
</script>

{#if loadError && upcoming.length === 0}
  <p class="text-xs text-danger" data-testid="active-routines-error">
    Couldn't load routines. {loadError}
  </p>
{:else if loading}
  <ul class="space-y-2" aria-busy="true" data-testid="active-routines-skeleton">
    {#each Array(3) as _, i (i)}
      <li class="h-10 rounded-md bg-bg-base/60"></li>
    {/each}
  </ul>
{:else if routines.length === 0}
  <p class="text-xs text-text-muted">No routines yet.</p>
{:else if upcoming.length === 0}
  <p class="text-xs text-text-muted">All routines disabled.</p>
{:else}
  <ul class="space-y-1.5" data-testid="active-routines-list">
    {#each upcoming as routine (routine.id)}
      <li>
        <button
          type="button"
          onclick={() => openRoutine(routine.id)}
          class="w-full min-h-[44px] text-left px-2.5 py-2 rounded-md hover:bg-bg-base/60 transition-colors flex items-center gap-2"
        >
          <span class="flex-1 truncate text-sm text-text-primary">{routine.name}</span>
          <span class="shrink-0 text-[10px] font-mono text-text-muted">
            {routine.schedule}
          </span>
          <span class="shrink-0 text-[10px] font-mono text-accent-cyan">
            {fmtNext(routine.next_run)}
          </span>
        </button>
      </li>
    {/each}
  </ul>
{/if}
