<script lang="ts">
  // One column in the Council grid.
  //
  // Props:
  //   - `run`: a CouncilRun row from the council store. Drives every
  //     field rendered here (provider chip, streaming content, latency
  //     footer, error chip, promote button).
  //   - `providerName`: human-friendly display name resolved at the
  //     parent level from the gateway's provider catalog. Falls back
  //     to providerId at the parent if the catalog entry isn't
  //     resolvable (avoids a second store lookup inside this
  //     component).
  //   - `accentClass`: tailwind class fragment for the provider chip's
  //     accent color (e.g. `bg-accent-cyan/10 text-accent-cyan`). Picked
  //     per-provider by the parent so different rows read distinct on
  //     the grid.
  //   - `onPromote`: callback fired when the user clicks Promote. The
  //     parent owns the run's index so it can dispatch into the store's
  //     promote() method with the right argument.
  //
  // Layout: a single flex column inside the parent's CSS grid. Header
  // (provider chip), scrolling content body (MarkdownView), footer
  // (latency + Promote button). The body grows to fill — the column
  // height is governed by the parent's `min-h-0` cell so long answers
  // get their own scrollbar rather than blowing out the page.

  import type { CouncilRun } from '$lib/stores/council.svelte';
  import MarkdownView from '$lib/components/LazyMarkdownView.svelte';

  interface Props {
    run: CouncilRun;
    providerName: string;
    accentClass: string;
    onPromote?: () => void;
  }

  const { run, providerName, accentClass, onPromote }: Props = $props();

  // Render-time formatting for the latency footer. We keep this inline
  // (no shared util) because it's a single-purpose 4-line helper and
  // the rest of the surface doesn't need it.
  const latencyLabel = $derived.by<string | null>(() => {
    if (run.latencyMs === null) return null;
    if (run.latencyMs < 1000) return `${run.latencyMs} ms`;
    return `${(run.latencyMs / 1000).toFixed(1)}s`;
  });

  // Status-driven body helpers. Pending → spinner. Streaming → live
  // markdown of `content` (with a tiny pulse dot at the end). Done →
  // final markdown. Error → red callout.
  const showSpinner = $derived(run.status === 'pending');
  const showError = $derived(run.status === 'error');
  const promoteDisabled = $derived(run.status !== 'done' || !run.content.trim());
</script>

<div
  class="surface flex flex-col min-h-0 h-full border border-border-subtle rounded-md overflow-hidden"
  data-testid="council-column"
>
  <!-- Provider header chip + status pip. The chip color is parent-driven
       so two providers in the same session read as visually distinct;
       the pip color reflects the run's lifecycle state (cyan dot while
       streaming, green tick on done, red on error). -->
  <header
    class="flex items-center justify-between gap-2 px-3 py-2 border-b border-border-subtle bg-bg-surface/50"
  >
    <span
      class="px-2 py-0.5 rounded-md text-xs font-medium tracking-wide truncate {accentClass}"
      title={run.providerId}
    >
      {providerName}
    </span>
    <span class="flex items-center gap-1.5 shrink-0">
      {#if run.status === 'streaming'}
        <span class="w-2 h-2 rounded-full bg-accent-cyan animate-pulse" aria-label="Streaming"
        ></span>
        <span class="text-[10px] uppercase tracking-wider text-text-muted">live</span>
      {:else if run.status === 'pending'}
        <span class="w-2 h-2 rounded-full bg-text-muted/50" aria-label="Pending"></span>
        <span class="text-[10px] uppercase tracking-wider text-text-muted">waiting</span>
      {:else if run.status === 'done'}
        <span class="w-2 h-2 rounded-full bg-green-500" aria-label="Done"></span>
        <span class="text-[10px] uppercase tracking-wider text-text-muted">done</span>
      {:else if run.status === 'error'}
        <span class="w-2 h-2 rounded-full bg-red-500" aria-label="Error"></span>
        <span class="text-[10px] uppercase tracking-wider text-red-400">error</span>
      {/if}
    </span>
  </header>

  <!-- Body. Scrolls independently so the column height is governed by
       the parent's grid cell. Empty / pending states render a thin
       placeholder so the column doesn't collapse to zero height before
       the stream starts. -->
  <div class="flex-1 min-h-0 overflow-auto px-3 py-3 text-sm">
    {#if showSpinner}
      <div class="flex items-center gap-2 text-xs text-text-muted italic">
        <span
          class="w-3 h-3 border-2 border-text-muted/40 border-t-accent-cyan rounded-full animate-spin"
          aria-hidden="true"
        ></span>
        Waiting for {providerName}…
      </div>
    {:else if showError}
      <div class="text-xs text-red-400 font-mono whitespace-pre-wrap">
        {run.error ?? 'Unknown error'}
      </div>
    {:else if run.content.trim().length > 0}
      <MarkdownView markdown={run.content} />
    {:else}
      <div class="text-xs text-text-muted italic">
        {#if run.status === 'streaming'}
          Receiving first tokens…
        {:else}
          (empty response)
        {/if}
      </div>
    {/if}
  </div>

  <!-- Footer. Latency on the left (visible once a stream completes),
       Promote on the right. Promote is disabled until the run is done
       and has non-empty content — otherwise the user could promote a
       half-streamed answer (which would persist as a truncated
       assistant turn in the new thread). -->
  <footer
    class="flex items-center justify-between gap-2 px-3 py-2 border-t border-border-subtle bg-bg-surface/40"
  >
    <span class="text-[11px] font-mono text-text-muted truncate">
      {#if latencyLabel}
        Took {latencyLabel}
      {:else if run.status === 'streaming'}
        Streaming…
      {:else}
        &nbsp;
      {/if}
    </span>
    <button
      type="button"
      onclick={() => onPromote?.()}
      disabled={promoteDisabled}
      class="px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors min-h-[28px]"
      class:border-accent-cyan={!promoteDisabled}
      class:text-accent-cyan={!promoteDisabled}
      class:hover:bg-accent-cyan={!promoteDisabled}
      class:hover:text-bg-deep={!promoteDisabled}
      class:border-border-subtle={promoteDisabled}
      class:text-text-muted={promoteDisabled}
      class:opacity-50={promoteDisabled}
      class:cursor-not-allowed={promoteDisabled}
      title={promoteDisabled
        ? 'Wait for the response to finish before promoting.'
        : 'Create a new chat thread seeded with this response.'}
    >
      Promote
    </button>
  </footer>
</div>
