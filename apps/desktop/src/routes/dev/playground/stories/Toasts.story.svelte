<script lang="ts" module>
  export const meta = {
    title: 'Toasts',
    description: 'Trigger info / success / error toasts via the global store'
  };
</script>

<script lang="ts">
  // The Toasts viewport is mounted at the layout level. We deliberately
  // do NOT mount a second one here — both would render every toast in
  // the global queue (visible duplication).
  import { toasts } from '$lib/stores/toasts.svelte';

  let customMessage = $state('Hello from the playground');

  function fire(kind: 'info' | 'success' | 'error') {
    toasts.show(customMessage || 'Toast message', kind);
  }

  function fireMany() {
    toasts.show('Stack #1 — info', 'info');
    setTimeout(() => toasts.show('Stack #2 — success', 'success'), 250);
    setTimeout(() => toasts.show('Stack #3 — error', 'error'), 500);
  }

  const snippet = `import { toasts } from '$lib/stores/toasts.svelte';
toasts.show('Saved.', 'success');
toasts.show('Could not connect.', 'error');
toasts.show('Reloading…', 'info');`;
</script>

<div class="grid grid-cols-[1fr_280px] gap-6 h-full">
  <div class="space-y-6 overflow-y-auto pr-2">
    <header>
      <h1 class="text-xl font-semibold text-text-primary">{meta.title}</h1>
      <p class="text-sm text-text-muted mt-1">{meta.description}</p>
    </header>

    <section class="surface p-6 space-y-3 min-h-[180px]">
      <p class="text-xs text-text-muted">
        Toasts auto-dismiss after 3.5s. Click X to dismiss manually. The viewport is mounted at the
        root layout; the playground re-mounts a sibling viewport here so toasts render even on
        bare-shell routes.
      </p>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          onclick={() => fire('info')}
          class="px-3 py-2 rounded-md border border-accent-gold/60 text-accent-gold text-xs font-mono uppercase tracking-widest hover:bg-accent-gold/10 transition-colors"
        >
          Fire info
        </button>
        <button
          type="button"
          onclick={() => fire('success')}
          class="px-3 py-2 rounded-md border border-positive/60 text-positive text-xs font-mono uppercase tracking-widest hover:bg-positive-soft transition-colors"
        >
          Fire success
        </button>
        <button
          type="button"
          onclick={() => fire('error')}
          class="px-3 py-2 rounded-md border border-danger/60 text-danger text-xs font-mono uppercase tracking-widest hover:bg-danger-soft transition-colors"
        >
          Fire error
        </button>
        <button
          type="button"
          onclick={fireMany}
          class="px-3 py-2 rounded-md border border-border-subtle text-text-muted hover:text-text-primary text-xs font-mono uppercase tracking-widest transition-colors"
        >
          Fire 3 staggered
        </button>
        <button
          type="button"
          onclick={() => toasts.clear()}
          class="px-3 py-2 rounded-md border border-border-subtle text-text-muted hover:text-text-primary text-xs font-mono uppercase tracking-widest transition-colors"
        >
          Clear all
        </button>
      </div>
    </section>

    <section>
      <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold">
        Example
      </h2>
      <pre
        class="bg-bg-deep border border-border-subtle rounded-md p-3 text-xs font-mono text-text-primary overflow-x-auto"><code
          >{snippet}</code
        ></pre>
    </section>
  </div>

  <aside class="border-l border-border-subtle pl-4 space-y-4 text-xs overflow-y-auto">
    <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold">Controls</h2>

    <label class="block">
      <span class="block text-text-muted mb-1">Message</span>
      <input
        type="text"
        bind:value={customMessage}
        class="w-full bg-bg-deep border border-border-subtle rounded-md px-2 py-1.5 text-text-primary font-mono text-[11px]"
      />
    </label>

    <p class="text-[10px] text-text-muted/70 leading-snug pt-2">
      Toasts render in the root layout's viewport (top-right). Each toast auto-dismisses after 3.5s.
    </p>
  </aside>
</div>
