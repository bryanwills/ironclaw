<script lang="ts">
  // Time-travel replay bar (R58, lane B5).
  //
  // Sits at the bottom of the chat surface as a slim strip. Renders only
  // when the user has opened replay for the current thread; otherwise
  // collapses to nothing.
  //
  // Three controls:
  //   - Scrubber (range input) — drag to any event index 0..N
  //   - Play / Pause toggle
  //   - Speed picker (0.5×, 1×, 2×, 4×)
  //
  // The chat-surface message renderer consumes `replay.eventsUpTo(tid,
  // replay.cursor(tid))` and shows only events up to the cursor. When
  // cursor === events.length, the user is at "now" and the bar shows a
  // subtle muted state.

  import { replay } from '$lib/stores/replay.svelte';
  import { threads } from '$lib/stores/threads.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    /** Override the active thread (e.g. for a per-tab embed). Defaults
     *  to the current thread from the threads store. */
    threadId?: string;
    /** Called when the user clicks "Close replay" — parent should
     *  unmount the bar / restore normal navigation. */
    onClose?: () => void;
  }

  let { threadId, onClose }: Props = $props();

  const tid = $derived(threadId ?? threads.currentId ?? null);
  const events = $derived(tid ? replay.events(tid) : []);
  const cursor = $derived(tid ? replay.cursor(tid) : 0);
  const total = $derived(events.length);
  const playing = $derived(tid ? replay.isPlaying(tid) : false);
  const isLive = $derived(cursor === total);

  function fmtTime(): string {
    if (!tid || total === 0) return '0 / 0';
    return `${cursor} / ${total}`;
  }

  function fmtEventLabel(): string {
    if (!tid || cursor === 0) return 'before first event';
    const ev = events[cursor - 1];
    if (!ev) return '—';
    const kind = ev.kind.replace('_', ' ');
    const time = new Date(ev.ts).toLocaleTimeString();
    return `${kind} · ${time}`;
  }

  function togglePlay(): void {
    if (!tid) return;
    if (playing) replay.pause(tid);
    else replay.play(tid);
  }

  function onScrub(ev: Event): void {
    if (!tid) return;
    const target = ev.target as HTMLInputElement;
    const idx = Number(target.value);
    if (Number.isFinite(idx)) replay.scrubTo(tid, idx);
  }

  function setSpeed(s: number): void {
    replay.setSpeed(s);
  }

  function jumpToLive(): void {
    if (!tid) return;
    replay.scrubTo(tid, total);
  }
</script>

{#if tid && total > 0}
  <div
    class="border-t border-border-subtle bg-bg-base/70 backdrop-blur-sm px-4 py-2
           flex items-center gap-3 text-xs"
    role="region"
    aria-label="Time-travel replay controls"
  >
    <button
      type="button"
      onclick={togglePlay}
      class="shrink-0 w-7 h-7 rounded-md flex items-center justify-center
             text-text-primary hover:text-accent-cyan hover:bg-accent-cyan/10 transition-colors"
      aria-label={playing ? 'Pause replay' : 'Play replay'}
      title={playing ? 'Pause' : 'Play'}
    >
      {#if playing}
        <svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="currentColor" aria-hidden="true">
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
      {:else}
        <svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="currentColor" aria-hidden="true">
          <polygon points="6 4 20 12 6 20" />
        </svg>
      {/if}
    </button>

    <input
      type="range"
      min="0"
      max={total}
      value={cursor}
      oninput={onScrub}
      class="flex-1 accent-cyan-500 cursor-pointer"
      aria-label="Replay cursor"
      aria-valuenow={cursor}
      aria-valuemin={0}
      aria-valuemax={total}
    />

    <span class="shrink-0 font-mono text-[10px] text-text-muted min-w-[60px] text-right">
      {fmtTime()}
    </span>

    <div class="shrink-0 flex items-center gap-1">
      {#each [0.5, 1, 2, 4] as s (s)}
        <button
          type="button"
          onclick={() => setSpeed(s)}
          class="px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors
                 text-text-muted hover:text-accent-cyan hover:bg-accent-cyan/10"
          aria-label={`Set playback speed to ${s}x`}
          title={`${s}× playback`}
        >
          {s}×
        </button>
      {/each}
    </div>

    {#if !isLive}
      <button
        type="button"
        onclick={jumpToLive}
        class="shrink-0 px-2 py-0.5 rounded text-[10px] font-mono
               text-accent-cyan hover:bg-accent-cyan/10 transition-colors"
        title="Jump to live"
      >
        Live →
      </button>
    {/if}

    {#if onClose}
      <button
        type="button"
        onclick={onClose}
        class="shrink-0 w-6 h-6 rounded flex items-center justify-center
               text-text-muted hover:text-red-300 hover:bg-red-500/10 transition-colors"
        aria-label="Close replay"
        title="Close replay"
      >
        <Icon name="close" class="w-3 h-3" />
      </button>
    {/if}
  </div>
  <div class="px-4 py-1 text-[10px] text-text-muted bg-bg-base/40 truncate">
    {fmtEventLabel()}
  </div>
{/if}
