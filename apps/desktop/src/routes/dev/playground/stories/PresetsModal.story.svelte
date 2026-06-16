<script lang="ts" module>
  export const meta = {
    title: 'PresetsModal',
    description: 'Workspace presets list — save / rename / delete / apply'
  };
</script>

<script lang="ts">
  // PresetsModal binds to the live `presets` + `presetsModal` runes from
  // $lib/stores/presets.svelte. Saving here writes a real entry to
  // localStorage and the entry persists across the playground session.
  //
  // The actual <PresetsModal /> instance is mounted at the root layout
  // and reads from the same singleton — toggling visibility from here
  // shows the layout's instance. We deliberately do NOT mount a second
  // one inside the story because both would render simultaneously
  // (twin backdrops, broken focus).
  import { onMount } from 'svelte';
  import { presets, presetsModal } from '$lib/stores/presets.svelte';

  // Hydrate so the modal's first render sees any saved entries from
  // earlier sessions. presets.init() is idempotent.
  onMount(() => {
    presets.init();
  });

  function openList() {
    presetsModal.show();
  }
  function openSave() {
    presetsModal.show('save');
  }
  function close() {
    presetsModal.close();
  }
</script>

<div class="grid grid-cols-[1fr_280px] gap-6 h-full">
  <div class="space-y-6 overflow-y-auto pr-2">
    <header>
      <h1 class="text-xl font-semibold text-text-primary">{meta.title}</h1>
      <p class="text-sm text-text-muted mt-1">{meta.description}</p>
    </header>

    <section class="surface p-6 space-y-3 min-h-[180px]">
      <p class="text-xs text-text-muted">
        Backed by the live <code class="bg-bg-deep px-1 rounded">presets</code>
        store. Saving here writes a real entry to localStorage (key:
        <code class="bg-bg-deep px-1 rounded">ironclaw-presets</code>). The "open and focus save"
        path mirrors what the palette's "Save current as preset…" action does.
      </p>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          onclick={openList}
          class="px-3 py-2 rounded-md bg-accent-cyan text-bg-deep text-xs font-semibold hover:brightness-110 transition"
        >
          Open list
        </button>
        <button
          type="button"
          onclick={openSave}
          class="px-3 py-2 rounded-md border border-accent-cyan/40 text-accent-cyan text-xs font-mono uppercase tracking-widest hover:bg-accent-cyan/10 transition"
        >
          Open + focus save
        </button>
        <button
          type="button"
          onclick={close}
          class="px-3 py-2 rounded-md border border-border-subtle text-text-muted hover:text-text-primary text-xs transition"
        >
          Close
        </button>
      </div>
      <div class="text-[10px] font-mono text-text-muted/70 pt-2">
        presets.count = <span class="text-accent-cyan">{presets.presets.length}</span>
        · open = <span class="text-accent-cyan">{presetsModal.open}</span>
      </div>
    </section>

    <section>
      <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold">
        Example
      </h2>
      <pre
        class="bg-bg-deep border border-border-subtle rounded-md p-3 text-xs font-mono text-text-primary overflow-x-auto"><code
          >{`import { presetsModal } from '$lib/stores/presets.svelte';
presetsModal.show();        // open list, focus first apply
presetsModal.show('save');  // open list, focus save input`}</code
        ></pre>
    </section>
  </div>

  <aside class="border-l border-border-subtle pl-4 space-y-4 text-xs overflow-y-auto">
    <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold">Controls</h2>

    <p class="text-text-muted leading-snug">
      Both buttons toggle the same singleton modal. The "focus save" variant pre-routes focus to the
      name input instead of the first apply button.
    </p>

    <p class="text-[10px] text-text-muted/70 leading-snug pt-2">
      Heads-up: applying a preset triggers a real navigation. Apply with caution while in the
      playground.
    </p>
  </aside>
</div>
