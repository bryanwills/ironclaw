<script lang="ts" module>
  export const meta = {
    title: 'CronPreview',
    description: 'Inline human-readable cron expression descriptor'
  };
</script>

<script lang="ts">
  import CronPreview from '$lib/components/CronPreview.svelte';

  let expr = $state('0 9 * * 1-5');

  // A small set of pre-canned expressions so a contributor can scan how
  // each pattern renders without re-typing.
  const PRESETS: { label: string; value: string }[] = [
    { label: 'Every weekday at 9 AM', value: '0 9 * * 1-5' },
    { label: 'Top of every hour', value: '0 * * * *' },
    { label: 'Daily at midnight', value: '0 0 * * *' },
    { label: 'Every 15 minutes', value: '*/15 * * * *' },
    { label: '@hourly alias', value: '@hourly' },
    { label: '@daily alias', value: '@daily' },
    { label: 'IronClaw shorthand', value: 'every 30s' },
    { label: 'Empty (renders nothing)', value: '' },
    { label: 'Invalid (red warning)', value: 'totally bogus' }
  ];

  const snippet = $derived(`<CronPreview expr="${expr}" />`);
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
      <div class="bg-bg-deep border border-border-subtle rounded p-4 min-h-[40px]">
        <CronPreview {expr} />
      </div>

      <div class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold pt-2">
        Preset gallery
      </div>
      <div class="space-y-2">
        {#each PRESETS as p (p.value)}
          <div
            class="bg-bg-deep border border-border-subtle rounded p-2 flex items-center justify-between gap-3"
          >
            <code class="font-mono text-[11px] text-text-muted shrink-0 min-w-[120px]">
              {p.value || '(empty)'}
            </code>
            <div class="flex-1 min-w-0">
              <CronPreview expr={p.value} />
            </div>
            <button
              type="button"
              onclick={() => (expr = p.value)}
              class="shrink-0 text-[10px] font-mono uppercase tracking-widest text-accent-cyan underline decoration-dotted hover:decoration-solid"
            >
              Try
            </button>
          </div>
        {/each}
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
      <span class="block text-text-muted mb-1">Cron expression</span>
      <input
        type="text"
        bind:value={expr}
        class="w-full bg-bg-deep border border-border-subtle rounded-md px-2 py-1.5 text-text-primary font-mono text-[11px]"
      />
    </label>

    <p class="text-[10px] text-text-muted/70 leading-snug">
      Supports 5-field cron, @aliases, and `every Ns/m/h/d` shorthand. Invalid inputs render a red
      warning; empty input renders nothing.
    </p>
  </aside>
</div>
