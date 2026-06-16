<script lang="ts">
  // R83 (lane B5 / W6 lite): Model presence strip for the Council surface.
  //
  // Renders a compact pill per selected provider showing its current
  // state — `pending`, `streaming`, `done`, `error`. Color + a pulsing
  // dot for `streaming` so the user can see at a glance which models
  // are working vs done.
  //
  // Consumes the existing `council` store's `runs[]` — no behavior
  // change needed in the store itself. The Council route mounts this
  // above the column grid.

  interface RunLike {
    /** Display name of the provider/model (e.g. "Claude 4", "Gemini Pro"). */
    label?: string;
    providerId: string;
    status: 'pending' | 'streaming' | 'done' | 'error';
    latencyMs?: number | null;
    error?: string;
  }

  interface Props {
    runs: RunLike[];
  }

  let { runs }: Props = $props();

  function statusLabel(s: RunLike['status']): string {
    switch (s) {
      case 'pending':
        return 'queued';
      case 'streaming':
        return 'thinking';
      case 'done':
        return 'ready';
      case 'error':
        return 'failed';
    }
  }

  function ringColor(s: RunLike['status']): string {
    switch (s) {
      case 'pending':
        return 'bg-text-muted';
      case 'streaming':
        return 'bg-accent-cyan';
      case 'done':
        return 'bg-emerald-400';
      case 'error':
        return 'bg-red-400';
    }
  }
</script>

{#if runs.length > 0}
  <div class="flex flex-wrap gap-2 mb-4" aria-label="Model presence">
    {#each runs as run (run.providerId)}
      <div
        class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full
               text-xs border bg-bg-deep/60
               {run.status === 'streaming'
          ? 'border-accent-cyan/40'
          : run.status === 'done'
            ? 'border-emerald-400/30'
            : run.status === 'error'
              ? 'border-red-400/30'
              : 'border-border-subtle'}"
        role="status"
        aria-live={run.status === 'streaming' ? 'polite' : 'off'}
        title={run.error ?? `${run.label ?? run.providerId} · ${statusLabel(run.status)}`}
      >
        <span class="relative w-2 h-2 rounded-full {ringColor(run.status)}" aria-hidden="true">
          {#if run.status === 'streaming'}
            <span class="absolute inset-0 rounded-full bg-accent-cyan animate-ping opacity-70"
            ></span>
          {/if}
        </span>
        <span class="font-medium text-text-primary">{run.label ?? run.providerId}</span>
        <span class="text-text-muted">·</span>
        <span
          class="lowercase
                 {run.status === 'streaming'
            ? 'text-accent-cyan'
            : run.status === 'done'
              ? 'text-emerald-300'
              : run.status === 'error'
                ? 'text-red-300'
                : 'text-text-muted'}"
        >
          {statusLabel(run.status)}
        </span>
        {#if typeof run.latencyMs === 'number' && run.status === 'done'}
          <span class="font-mono text-[10px] text-text-muted">
            {(run.latencyMs / 1000).toFixed(1)}s
          </span>
        {/if}
      </div>
    {/each}
  </div>
{/if}
