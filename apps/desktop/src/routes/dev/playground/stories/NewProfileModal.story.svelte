<script lang="ts" module>
  export const meta = {
    title: 'NewProfileModal',
    description: 'Backdrop + dialog card for adding a new gateway profile'
  };
</script>

<script lang="ts">
  // NewProfileModal commits a real profile to the settings store on
  // submit; we only mount it in "open" state so the contributor can poke
  // at the layout/keyboard behaviour without writing test data. Closing
  // here is harmless — the underlying store mutation only fires on
  // submit.
  import NewProfileModal from '$lib/components/NewProfileModal.svelte';

  let open = $state(false);
</script>

<div class="grid grid-cols-[1fr_280px] gap-6 h-full">
  <div class="space-y-6 overflow-y-auto pr-2">
    <header>
      <h1 class="text-xl font-semibold text-text-primary">{meta.title}</h1>
      <p class="text-sm text-text-muted mt-1">{meta.description}</p>
    </header>

    <section class="surface p-6 space-y-3 min-h-[180px]">
      <p class="text-xs text-text-muted">
        The modal binds to a real settings mutation. Submitting actually creates a profile (and
        navigates to /settings#profiles) — open it to inspect layout and keyboard behaviour, then
        click Cancel or hit Esc to dismiss without committing.
      </p>
      <div class="flex gap-2">
        <button
          type="button"
          onclick={() => (open = true)}
          class="px-3 py-2 rounded-md bg-accent-cyan text-bg-deep text-xs font-semibold hover:brightness-110 transition"
        >
          Open modal
        </button>
        <button
          type="button"
          onclick={() => (open = false)}
          class="px-3 py-2 rounded-md border border-border-subtle text-text-muted hover:text-text-primary text-xs transition"
        >
          Close
        </button>
      </div>
      <div class="text-[10px] font-mono text-text-muted/70 pt-2">
        state.open = <span class="text-accent-cyan">{open}</span>
      </div>
    </section>

    <section>
      <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold">
        Example
      </h2>
      <pre
        class="bg-bg-deep border border-border-subtle rounded-md p-3 text-xs font-mono text-text-primary overflow-x-auto"><code
          >{`<NewProfileModal bind:open onClose={() => open = false} />`}</code
        ></pre>
    </section>
  </div>

  <aside class="border-l border-border-subtle pl-4 space-y-4 text-xs overflow-y-auto">
    <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold">Controls</h2>

    <label class="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" bind:checked={open} class="accent-accent-cyan" />
      <span class="text-text-muted">open</span>
    </label>

    <p class="text-[10px] text-text-muted/70 leading-snug pt-2">
      Esc closes. Click backdrop closes. Submit commits to the real settings store (then navigates).
    </p>
  </aside>
</div>

<NewProfileModal bind:open onClose={() => (open = false)} />
