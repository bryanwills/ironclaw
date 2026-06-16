<script lang="ts">
  // Right-rail visualizer for the per-thread tool-call ledger.
  //
  // The chat surface streams `tool_call` / `tool_result` events through
  // `toolFlow.record(threadId, ev)`; this panel reads `toolFlow.forThread(
  // threadId)` and renders a chronological card list. Each card pulses
  // cyan while pending, flips green on completion (with a latency badge),
  // and expands inline to show args + result via a zero-dep JSON
  // pretty-printer.
  //
  // The panel is meant to live in a 320px-wide column hidden below
  // Tailwind's xl breakpoint (1280px) — the parent owns the visibility
  // gate so this component just fills whatever width it's mounted at.
  //
  // Empty-state copy is intentionally very faint: when no tools have
  // been called this turn, the rail should read as "available but
  // quiet", not "broken". A bolder string here would draw the eye away
  // from the chat stream.
  //
  // Auto-scroll: the inner list is bound to a ref. Whenever the row
  // count grows, we tick a microtask and pin scrollTop to scrollHeight
  // so a new pending row drops into view without the user reaching for
  // the scrollbar. We deliberately scroll only on count GROWTH (not on
  // status flips) — flipping pending → done shouldn't yank the user.

  import { tick } from 'svelte';
  import { toolFlow, type ToolCall, type ToolCallStatus } from '$lib/stores/tool-flow.svelte';

  interface Props {
    /** Thread to render the ledger for. Falsy values render the empty
     *  state — the parent passes the active thread id; on the new-chat
     *  empty screen this is undefined and the panel just shows the
     *  baseline copy. */
    threadId: string | null | undefined;
  }

  const { threadId }: Props = $props();

  // Reactive read off the ledger. `toolFlow.byThread` is the $state
  // record; the function call here re-runs whenever any thread's bucket
  // is replaced. (We could short-circuit on the threadId not changing,
  // but the cost is one array lookup per render so it's not worth the
  // bookkeeping.)
  const calls = $derived<ToolCall[]>(threadId ? toolFlow.forThread(threadId) : []);
  const count = $derived(calls.length);

  // Per-row collapse state. Keyed on the row's stable id (see
  // `tool-flow.svelte.ts` — `<name>-<startedAt>-<seq>`), so toggling a
  // row keeps state across status flips. A fresh thread's empty record
  // means no leakage; switching threads just renders a different
  // ledger and the map is keyed by id, so stale entries don't render.
  let expanded = $state<Record<string, boolean>>({});

  function toggle(id: string): void {
    expanded = { ...expanded, [id]: !expanded[id] };
  }

  // Auto-scroll on row growth. We snapshot the previous count and only
  // pin to bottom when it strictly increases — a status flip (pending
  // → done) doesn't change `count`, so the user's scroll position is
  // preserved while they read an expanded card.
  let listEl = $state<HTMLDivElement | null>(null);
  let lastCount = 0;

  $effect(() => {
    const next = count;
    if (next <= lastCount) {
      lastCount = next;
      return;
    }
    lastCount = next;
    void tick().then(() => {
      if (!listEl) return;
      listEl.scrollTop = listEl.scrollHeight;
    });
  });

  // -- JSON pretty-printer (zero deps) --------------------------------------
  // The args/result payloads from the gateway are arbitrary JSON. We
  // stringify with two-space indent and render inside a <pre>. A bare
  // string passes through unwrapped so a single-line tool result like
  // "ok" doesn't show as `"ok"`. Undefined collapses to an em dash so
  // the "Args" / "Result" headers don't sit above empty space.
  function fmtJson(v: unknown): string {
    if (v === undefined) return '—';
    if (v === null) return 'null';
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      // Circular refs or non-serializable values land here. We don't
      // import a deep-cloner since args/result come from JSON-parsed SSE
      // payloads and shouldn't have cycles in practice — but the catch
      // keeps a malformed payload from blowing up the panel.
      return String(v);
    }
  }

  // -- Latency formatter -----------------------------------------------------
  // Sub-second latencies show in ms ("23ms"), one second and above in
  // tenths-precision seconds ("1.4s"). The cutoff is 1000ms so the badge
  // matches the way the brief described it. We return a placeholder for
  // pending rows so the badge slot keeps its visual weight (avoids a
  // layout shift when the row flips to done).
  function fmtLatency(call: ToolCall): string {
    if (call.completedAt === undefined) return '…';
    const ms = Math.max(0, call.completedAt - call.startedAt);
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  // -- Status pip styling ---------------------------------------------------
  // Pending: cyan, with the v2-breathe pulse from tailwind.config.js.
  // Done:    positive-green, no animation.
  // Error:   danger-red, no animation. (Reserved — the store doesn't
  //          surface this status today; included so the visual vocabulary
  //          is in place for the future `tool_error` event.)
  function pipClass(status: ToolCallStatus): string {
    switch (status) {
      case 'pending':
        return 'bg-accent-cyan animate-pulse';
      case 'done':
        return 'bg-positive';
      case 'error':
        return 'bg-danger';
    }
  }
</script>

<div class="h-full w-full flex flex-col">
  <!-- Header -->
  <div class="h-12 shrink-0 px-4 flex items-center justify-between border-b border-border-subtle">
    <span class="text-xs font-semibold text-text-primary uppercase tracking-wide">
      Tools called
    </span>
    {#if count > 0}
      <span
        class="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-accent-cyan/15 text-accent-cyan text-[10px] font-mono font-semibold"
        aria-label={`${count} tool call${count === 1 ? '' : 's'} in this turn`}
      >
        {count}
      </span>
    {/if}
  </div>

  <!-- Body. Scrolls when the list grows past the viewport; the auto-pin
       above keeps the latest row visible. -->
  <div bind:this={listEl} class="flex-1 overflow-y-auto p-3 space-y-2">
    {#if count === 0}
      <!-- Empty state. Very faint per the brief — visible if you look
           but not competing with the chat stream for attention. -->
      <div class="text-[11px] text-text-muted/40 italic px-1 pt-1 select-none">
        No tool calls yet.
      </div>
    {:else}
      {#each calls as call (call.id)}
        {@const open = !!expanded[call.id]}
        <!-- Inline ToolCard. Header row is a button (whole-row hit
             target); the args/result body slides in beneath when
             expanded. The expanded state survives status flips because
             the row id is stable across pending → done. -->
        <div class="rounded-md border border-border-subtle bg-bg-deep">
          <button
            type="button"
            onclick={() => toggle(call.id)}
            class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-surface transition-colors"
            aria-expanded={open}
            aria-label={`${call.name} ${call.status === 'pending' ? 'in progress' : call.status === 'done' ? 'completed' : 'errored'}`}
          >
            <span
              class={`w-1.5 h-1.5 rounded-full shrink-0 ${pipClass(call.status)}`}
              aria-hidden="true"
            ></span>
            <span class="text-xs font-mono text-text-primary truncate flex-1 min-w-0">
              {call.name}
            </span>
            <!-- Latency badge. Reserves space for both pending ('…')
                 and final values so the row doesn't reflow on flip. -->
            <span
              class="shrink-0 text-[10px] font-mono tabular-nums"
              class:text-text-muted={call.status === 'pending'}
              class:text-positive={call.status === 'done'}
              class:text-danger={call.status === 'error'}
              title={call.completedAt
                ? `Started ${new Date(call.startedAt).toLocaleTimeString()}, completed ${new Date(call.completedAt).toLocaleTimeString()}`
                : `Started ${new Date(call.startedAt).toLocaleTimeString()}`}
            >
              {fmtLatency(call)}
            </span>
            <svg
              viewBox="0 0 24 24"
              class="w-3 h-3 text-text-muted shrink-0 transition-transform"
              class:rotate-90={open}
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          {#if open}
            <div class="border-t border-border-subtle px-3 py-2 space-y-2">
              <!-- Args. Always rendered (every tool call has args, even
                   if `undefined` from the wire — fmtJson handles the
                   placeholder). -->
              <div>
                <div class="text-[10px] uppercase tracking-wider text-text-muted mb-1">Args</div>
                <pre
                  class="text-[11px] font-mono text-text-primary whitespace-pre-wrap break-all bg-bg-base/60 rounded p-2 overflow-x-auto">{fmtJson(
                    call.args
                  )}</pre>
              </div>
              <!-- Result. Only meaningful when the call has flipped to
                   done or error. While pending we render the explicit
                   "Running…" string so the user knows the panel is
                   alive, not stuck. -->
              {#if call.status === 'pending'}
                <div class="text-[11px] text-accent-cyan animate-pulse">Running…</div>
              {:else if call.status === 'error'}
                <div>
                  <div class="text-[10px] uppercase tracking-wider text-danger mb-1">Error</div>
                  <pre
                    class="text-[11px] font-mono text-danger whitespace-pre-wrap break-all bg-bg-base/60 rounded p-2 overflow-x-auto">{call.error ??
                      'Unknown error'}</pre>
                </div>
              {:else}
                <div>
                  <div class="text-[10px] uppercase tracking-wider text-text-muted mb-1">
                    Result
                  </div>
                  <pre
                    class="text-[11px] font-mono text-text-primary whitespace-pre-wrap break-all bg-bg-base/60 rounded p-2 overflow-x-auto">{fmtJson(
                      call.result
                    )}</pre>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>
