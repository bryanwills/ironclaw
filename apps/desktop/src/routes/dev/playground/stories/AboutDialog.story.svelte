<script lang="ts" module>
  export const meta = {
    title: 'AboutDialog',
    description: 'About panel — version, gateway info, profile, system, links'
  };
</script>

<script lang="ts">
  // AboutDialog tries to fetch live gateway info via connection.client on
  // open. In the playground we don't have (or want) a connected gateway,
  // so the dialog will render its "Not connected to a gateway." fallback
  // — which is the most representative offline state.
  //
  // We render the dialog locally rather than via aboutStore so the
  // playground doesn't fight the root-layout instance for body-scroll
  // lock state.
  import AboutDialog from '$lib/components/AboutDialog.svelte';

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
        Opens with stub gateway state (no connection) so the dialog renders its "Not connected to a
        gateway." fallback path. The version line still resolves via Tauri's <code
          class="bg-bg-deep px-1 rounded">app.getVersion()</code
        >
        when running under Tauri, or falls back to "dev" in the browser.
      </p>
      <div class="flex gap-2">
        <button
          type="button"
          onclick={() => (open = true)}
          class="px-3 py-2 rounded-md bg-accent-cyan text-bg-deep text-xs font-semibold hover:brightness-110 transition"
        >
          Open About
        </button>
        <button
          type="button"
          onclick={() => (open = false)}
          class="px-3 py-2 rounded-md border border-border-subtle text-text-muted hover:text-text-primary text-xs transition"
        >
          Close
        </button>
      </div>
    </section>

    <section>
      <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold">
        Example
      </h2>
      <pre
        class="bg-bg-deep border border-border-subtle rounded-md p-3 text-xs font-mono text-text-primary overflow-x-auto"><code
          >{`import { aboutStore } from '$lib/stores/about.svelte';
aboutStore.show();
// or pass open/onclose directly:
<AboutDialog open={open} onclose={() => open = false} />`}</code
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
      Gateway and profile sections reflect the live connection store. In the playground that's "Not
      connected" — to see populated state, open from the production app via Cmd+K → "About IronClaw
      Desktop".
    </p>
  </aside>
</div>

<AboutDialog {open} onclose={() => (open = false)} />
