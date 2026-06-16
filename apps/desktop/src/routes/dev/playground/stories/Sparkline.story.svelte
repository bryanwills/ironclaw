<script lang="ts" module>
  export const meta = {
    title: 'Sparkline',
    description: 'Inline-SVG sparkline primitive (line / bars / area)'
  };
</script>

<script lang="ts">
  import Sparkline from '$lib/components/Sparkline.svelte';

  // CSV-parsed series. We tolerate whitespace and skip non-numeric tokens
  // so the operator can paste raw numbers from logs without grooming.
  let dataText = $state('3, 5, 2, 8, 6, 12, 9, 14, 11, 18');
  let variant = $state<'line' | 'bars' | 'area'>('line');
  let width = $state(240);
  let height = $state(64);
  let color = $state('#4ca7e6');
  let showValue = $state(true);
  let thresholdText = $state('');

  const data = $derived.by<number[]>(() => {
    return dataText
      .split(/[,\s]+/u)
      .map((s) => Number.parseFloat(s.trim()))
      .filter((n) => Number.isFinite(n));
  });

  const threshold = $derived.by<number | undefined>(() => {
    const t = Number.parseFloat(thresholdText.trim());
    return Number.isFinite(t) ? t : undefined;
  });

  const snippet = $derived(
    `<Sparkline data={[${data.join(', ')}]} variant="${variant}" width={${width}} height={${height}} color="${color}" showValue={${showValue}}${threshold !== undefined ? ` threshold={${threshold}}` : ''} />`
  );
</script>

<div class="grid grid-cols-[1fr_280px] gap-6 h-full">
  <div class="space-y-6 overflow-y-auto pr-2">
    <header>
      <h1 class="text-xl font-semibold text-text-primary">{meta.title}</h1>
      <p class="text-sm text-text-muted mt-1">{meta.description}</p>
    </header>

    <section class="surface p-10 flex items-center justify-center min-h-[180px]">
      <Sparkline {data} {variant} {width} {height} {color} {showValue} {threshold} />
    </section>

    <section class="space-y-2">
      <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold">
        Parsed data ({data.length} points)
      </h2>
      <div
        class="bg-bg-deep border border-border-subtle rounded p-2 font-mono text-[10px] text-text-muted break-all"
      >
        [{data.join(', ')}]
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
      <span class="block text-text-muted mb-1">Data (CSV → numbers)</span>
      <textarea
        bind:value={dataText}
        rows="3"
        class="w-full bg-bg-deep border border-border-subtle rounded-md px-2 py-1.5 text-text-primary font-mono text-[11px]"
      ></textarea>
    </label>

    <label class="block">
      <span class="block text-text-muted mb-1">Variant</span>
      <select
        bind:value={variant}
        class="w-full bg-bg-deep border border-border-subtle rounded-md px-2 py-1.5 text-text-primary font-mono"
      >
        <option value="line">line</option>
        <option value="bars">bars</option>
        <option value="area">area</option>
      </select>
    </label>

    <label class="block">
      <span class="block text-text-muted mb-1">Width: {width}px</span>
      <input type="range" min="40" max="600" bind:value={width} class="w-full accent-accent-cyan" />
    </label>

    <label class="block">
      <span class="block text-text-muted mb-1">Height: {height}px</span>
      <input
        type="range"
        min="16"
        max="160"
        bind:value={height}
        class="w-full accent-accent-cyan"
      />
    </label>

    <label class="block">
      <span class="block text-text-muted mb-1">Color</span>
      <input
        type="color"
        bind:value={color}
        class="w-full h-8 bg-bg-deep border border-border-subtle rounded cursor-pointer"
      />
      <span class="block mt-1 font-mono text-text-muted">{color}</span>
    </label>

    <label class="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" bind:checked={showValue} class="accent-accent-cyan" />
      <span class="text-text-muted">showValue</span>
    </label>

    <label class="block">
      <span class="block text-text-muted mb-1">Threshold (optional)</span>
      <input
        type="text"
        bind:value={thresholdText}
        placeholder="e.g. 10"
        class="w-full bg-bg-deep border border-border-subtle rounded-md px-2 py-1.5 text-text-primary font-mono text-[11px]"
      />
    </label>
  </aside>
</div>
