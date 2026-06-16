<script lang="ts" module>
  export const meta = {
    title: 'MaskedValue',
    description: 'Inline masked secret renderer with click-to-reveal'
  };
</script>

<script lang="ts">
  import MaskedValue from '$lib/components/MaskedValue.svelte';

  // Default value contains a synthetic Bearer token so the redactor has
  // something to match — passing a plain string would render unchanged.
  let value = $state('Authorization: Bearer sk-agent-abc123def456ghi789jklmno0987654321');
  let preserveTips = $state(false);
  let locked = $state(false);

  const snippet = $derived(
    `<MaskedValue value="${value.length > 40 ? value.slice(0, 40) + '…' : value}" redactOptions={{ preserveTips: ${preserveTips} }} locked={${locked}} />`
  );
</script>

<div class="grid grid-cols-[1fr_280px] gap-6 h-full">
  <div class="space-y-6 overflow-y-auto pr-2">
    <header>
      <h1 class="text-xl font-semibold text-text-primary">{meta.title}</h1>
      <p class="text-sm text-text-muted mt-1">{meta.description}</p>
    </header>

    <section class="surface p-6 space-y-4 min-h-[180px]">
      <div class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold">
        Live preview
      </div>
      <div class="bg-bg-deep border border-border-subtle rounded p-4">
        <MaskedValue {value} redactOptions={{ preserveTips }} {locked} />
      </div>

      <!-- Reveal/hide demo: a second instance to show that reveal state is
           per-instance (toggling the one above leaves this one masked). -->
      <div class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold pt-2">
        Sibling instance (proves reveal is per-instance, not global)
      </div>
      <div class="bg-bg-deep border border-border-subtle rounded p-4">
        <MaskedValue {value} redactOptions={{ preserveTips }} {locked} />
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
      <span class="block text-text-muted mb-1">Value</span>
      <textarea
        bind:value
        rows="4"
        class="w-full bg-bg-deep border border-border-subtle rounded-md px-2 py-1.5 text-text-primary font-mono text-[11px] leading-snug"
      ></textarea>
    </label>

    <label class="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" bind:checked={preserveTips} class="accent-accent-cyan" />
      <span class="text-text-muted">preserveTips</span>
    </label>

    <label class="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" bind:checked={locked} class="accent-accent-cyan" />
      <span class="text-text-muted">locked (hide reveal toggle)</span>
    </label>

    <p class="text-[10px] text-text-muted/70 leading-snug pt-2">
      Tip: click the eye icon to reveal. Each instance owns its reveal state.
    </p>
  </aside>
</div>
