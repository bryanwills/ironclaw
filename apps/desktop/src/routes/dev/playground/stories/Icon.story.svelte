<script lang="ts" module>
  // Story metadata. Surfaced in the playground sidebar via a static import
  // on the page side; the story component itself owns layout (preview +
  // controls + code snippet) so the shell stays a thin frame.
  export const meta = {
    title: 'Icon',
    description: '31-glyph inline SVG icon set, currentColor stroke'
  };
</script>

<script lang="ts">
  import Icon, { type IconName } from '$lib/components/Icon.svelte';

  // All 31 names live in the IconName union in `Icon.svelte`. The dropdown
  // mirrors the union exactly — adding a new icon requires bumping both
  // lists, which is fine for v1 (no codegen).
  const ALL_NAMES: IconName[] = [
    'attach',
    'bolt',
    'check',
    'chat',
    'chevron',
    'close',
    'clock',
    'copy',
    'download',
    'file',
    'flag',
    'folder',
    'info',
    'layers',
    'list',
    'lock',
    'logout',
    'moon',
    'plug',
    'plus',
    'pulse',
    'search',
    'send',
    'settings',
    'shield',
    'spark',
    'sun',
    'tool',
    'trash',
    'upload',
    'warning',
    'x'
  ];

  let name = $state<IconName>('chat');
  let color = $state('#4ca7e6');
  let size = $state(32);
  let strokeWidth = $state(1.7);

  const snippet = $derived(`<Icon name="${name}" strokeWidth={${strokeWidth}} class="w-8 h-8" />`);
</script>

<div class="grid grid-cols-[1fr_280px] gap-6 h-full">
  <!-- Preview + snippet column -->
  <div class="space-y-6 overflow-y-auto pr-2">
    <header>
      <h1 class="text-xl font-semibold text-text-primary">{meta.title}</h1>
      <p class="text-sm text-text-muted mt-1">{meta.description}</p>
    </header>

    <section class="surface p-10 flex items-center justify-center min-h-[180px]">
      <span style="color: {color}; width: {size}px; height: {size}px; display: inline-flex;">
        <Icon {name} {strokeWidth} class="w-full h-full" />
      </span>
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

  <!-- Controls column. The shell reserves a 280px right column; the story
       owns its own controls so adding props doesn't require shell changes. -->
  <aside class="border-l border-border-subtle pl-4 space-y-4 text-xs overflow-y-auto">
    <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold">Controls</h2>

    <label class="block">
      <span class="block text-text-muted mb-1">Name</span>
      <select
        bind:value={name}
        class="w-full bg-bg-deep border border-border-subtle rounded-md px-2 py-1.5 text-text-primary font-mono"
      >
        {#each ALL_NAMES as n (n)}
          <option value={n}>{n}</option>
        {/each}
      </select>
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

    <label class="block">
      <span class="block text-text-muted mb-1">Size: {size}px</span>
      <input type="range" min="12" max="96" bind:value={size} class="w-full accent-accent-cyan" />
    </label>

    <label class="block">
      <span class="block text-text-muted mb-1">Stroke width: {strokeWidth}</span>
      <input
        type="range"
        min="0.5"
        max="3"
        step="0.1"
        bind:value={strokeWidth}
        class="w-full accent-accent-cyan"
      />
    </label>
  </aside>
</div>
