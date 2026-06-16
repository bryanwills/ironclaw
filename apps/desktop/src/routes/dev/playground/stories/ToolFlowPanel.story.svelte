<script lang="ts" module>
  export const meta = {
    title: 'ToolFlowPanel',
    description:
      'Right-rail visualizer for mid-conversation tool calls — empty, pending, and mixed-status states.'
  };
</script>

<script lang="ts">
  // Showcases the ToolFlowPanel in three orthogonal states by routing
  // the `toolFlow` singleton's ledger through three sibling thread ids
  // and mounting one panel per state.
  //
  // We use distinct thread ids per scenario so the story can render
  // all three simultaneously without one panel's state bleeding into
  // another via the shared singleton. The "Reset" control wipes
  // everything so a re-run starts from the same baseline.

  import ToolFlowPanel from '$lib/components/ToolFlowPanel.svelte';
  import { toolFlow } from '$lib/stores/tool-flow.svelte';

  const EMPTY_THREAD = 'story-empty';
  const PENDING_THREAD = 'story-pending';
  const MIXED_THREAD = 'story-mixed';

  /** Manually shape a row in the store. We bypass `record()` here so we
   *  can control startedAt/completedAt for predictable latency badges
   *  in the story (real chat would land timestamps via Date.now()). */
  function seed(): void {
    toolFlow.clear(EMPTY_THREAD);
    toolFlow.clear(PENDING_THREAD);
    toolFlow.clear(MIXED_THREAD);

    // -- Pending state (2 calls) --------------------------------------
    // Both rows stay in the cyan-pulse pending state. A real stream
    // would flip them on `tool_result`; we leave them open here so the
    // pulse animation is visible.
    toolFlow.byThread = {
      ...toolFlow.byThread,
      [PENDING_THREAD]: [
        {
          id: 'web_search-1-0',
          name: 'web_search',
          args: { query: 'svelte 5 runes', max_results: 5 },
          status: 'pending',
          startedAt: Date.now() - 400
        },
        {
          id: 'read_file-1-1',
          name: 'read_file',
          args: { path: '/src/lib/stores/tool-flow.svelte.ts' },
          status: 'pending',
          startedAt: Date.now() - 120
        }
      ],
      // -- Mixed state (4 calls: done, pending, done, error) ----------
      // Exercises every visual variant the card supports — the green
      // done badge with latency, the cyan pulsing pending row, the
      // expanded result body, and the red error pip + body.
      [MIXED_THREAD]: [
        {
          id: 'web_search-2-0',
          name: 'web_search',
          args: { query: 'tailwind xl breakpoint', max_results: 3 },
          status: 'done',
          result: {
            hits: [
              { title: 'Tailwind v3 breakpoints', url: 'https://tailwindcss.com/docs/breakpoints' },
              { title: 'Tailwind v4 changes', url: 'https://tailwindcss.com/blog/tailwindcss-v4' }
            ]
          },
          startedAt: Date.now() - 1700,
          completedAt: Date.now() - 1480
        },
        {
          id: 'read_file-2-1',
          name: 'read_file',
          args: { path: '/src/routes/+page.svelte' },
          status: 'pending',
          startedAt: Date.now() - 800
        },
        {
          id: 'grep-2-2',
          name: 'grep',
          args: { pattern: 'rightRailOpen', glob: 'src/**/*.svelte' },
          status: 'done',
          result: 'src/routes/+page.svelte:78\nsrc/routes/+page.svelte:1593',
          startedAt: Date.now() - 600,
          completedAt: Date.now() - 510
        },
        {
          id: 'write_file-2-3',
          name: 'write_file',
          args: { path: '/tmp/out.txt', content: '...' },
          status: 'error',
          error: 'Permission denied: /tmp/out.txt is read-only on this gateway',
          startedAt: Date.now() - 300,
          completedAt: Date.now() - 240
        }
      ]
    };
  }

  // Auto-seed on mount so the panel previews are interesting at first
  // paint. The "Reset" button re-runs the same seed so timestamps
  // (and therefore latency badges) refresh.
  $effect(() => {
    seed();
  });

  function addPending(): void {
    // Push another pending row into the pending panel so the user can
    // see how the auto-scroll behaves when the list grows beyond the
    // viewport.
    toolFlow.record(PENDING_THREAD, {
      type: 'tool_call',
      name: `extra_call_${Date.now() % 1000}`,
      args: { sample: true }
    });
  }

  function flipFirstPendingDone(): void {
    // Find the first pending row across both panels and flip it to
    // done via the public `record` path so the story exercises the
    // exact code the chat surface uses.
    for (const thread of [PENDING_THREAD, MIXED_THREAD]) {
      const rows = toolFlow.forThread(thread);
      const pending = rows.find((r) => r.status === 'pending');
      if (pending) {
        toolFlow.record(thread, {
          type: 'tool_result',
          name: pending.name,
          result: { simulated: true, completedAt: Date.now() }
        });
        return;
      }
    }
  }
</script>

<div class="grid grid-cols-[1fr_280px] gap-6 h-full">
  <div class="space-y-4 overflow-y-auto pr-2">
    <header>
      <h1 class="text-xl font-semibold text-text-primary">{meta.title}</h1>
      <p class="text-sm text-text-muted mt-1">{meta.description}</p>
    </header>

    <p class="text-xs text-text-muted">
      The visualizer is meant to live in a 320px-wide column inside the chat surface (hidden below
      Tailwind's xl breakpoint). Each preview below is one full-height instance, mounted at the
      target width.
    </p>

    <!-- Three side-by-side panels. Fixed widths mirror the chat surface;
         heights are bounded so the playground viewport stays usable. -->
    <div class="grid grid-cols-3 gap-4">
      <section class="space-y-2">
        <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold">
          Empty
        </h2>
        <div
          class="h-[420px] w-full border border-border-subtle rounded-md overflow-hidden bg-bg-base/40"
        >
          <ToolFlowPanel threadId={EMPTY_THREAD} />
        </div>
      </section>

      <section class="space-y-2">
        <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold">
          2 pending
        </h2>
        <div
          class="h-[420px] w-full border border-border-subtle rounded-md overflow-hidden bg-bg-base/40"
        >
          <ToolFlowPanel threadId={PENDING_THREAD} />
        </div>
      </section>

      <section class="space-y-2">
        <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold">
          4 mixed statuses
        </h2>
        <div
          class="h-[420px] w-full border border-border-subtle rounded-md overflow-hidden bg-bg-base/40"
        >
          <ToolFlowPanel threadId={MIXED_THREAD} />
        </div>
      </section>
    </div>

    <section>
      <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold">
        Example
      </h2>
      <pre
        class="bg-bg-deep border border-border-subtle rounded-md p-3 text-xs font-mono text-text-primary overflow-x-auto"><code
          >{`<ToolFlowPanel threadId={currentThreadId} />

// Wire events into the ledger:
import { toolFlow } from '$lib/stores/tool-flow.svelte';
for await (const ev of stream) {
  toolFlow.record(currentThreadId, ev);
  handleEvent(currentThreadId, ev);
}`}</code
        ></pre>
    </section>
  </div>

  <aside class="border-l border-border-subtle pl-4 space-y-4 text-xs overflow-y-auto">
    <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold">Controls</h2>

    <button
      type="button"
      onclick={seed}
      class="w-full px-3 py-2 rounded-md border border-accent-cyan/60 text-accent-cyan text-xs font-mono uppercase tracking-widest hover:bg-accent-cyan/10 transition-colors"
    >
      Re-seed
    </button>

    <button
      type="button"
      onclick={addPending}
      class="w-full px-3 py-2 rounded-md border border-accent-gold/60 text-accent-gold text-xs font-mono uppercase tracking-widest hover:bg-accent-gold/10 transition-colors"
    >
      Add pending row
    </button>

    <button
      type="button"
      onclick={flipFirstPendingDone}
      class="w-full px-3 py-2 rounded-md border border-positive/60 text-positive text-xs font-mono uppercase tracking-widest hover:bg-positive-soft transition-colors"
    >
      Flip first pending → done
    </button>

    <p class="text-[10px] text-text-muted/70 leading-snug pt-2">
      The panel renders the per-thread tool-call ledger from
      <code class="text-accent-cyan">$lib/stores/tool-flow.svelte</code>. Mid-conversation
      <code class="text-accent-cyan">tool_call</code> /
      <code class="text-accent-cyan">tool_result </code>
      events feed the store via <code class="text-accent-cyan">toolFlow.record(threadId, ev)</code>.
    </p>
  </aside>
</div>
