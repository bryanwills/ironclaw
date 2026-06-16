<script lang="ts" module>
  export const meta = {
    title: 'LightboxModal',
    description: 'Full-screen image preview with backdrop + Esc dismiss'
  };
</script>

<script lang="ts">
  import LightboxModal from '$lib/components/LightboxModal.svelte';

  // A few SVG data-URL samples so the story renders without a network
  // hop. The `src` prop accepts data:, blob:, or http(s) URLs.
  const SAMPLES: { label: string; src: string }[] = [
    {
      label: 'Cyan starburst (SVG, ~200×200)',
      src:
        'data:image/svg+xml;utf8,' +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
            <rect width="200" height="200" fill="#050810"/>
            <path d="M100 20 L120 90 L190 100 L120 110 L100 180 L80 110 L10 100 L80 90 Z" fill="#4ca7e6"/>
          </svg>`
        )
    },
    {
      label: 'Gold mesh (SVG, ~300×200)',
      src:
        'data:image/svg+xml;utf8,' +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200">
            <rect width="300" height="200" fill="#0a0f1e"/>
            <g stroke="#fbbf24" stroke-width="1" fill="none">
              <path d="M0 100 Q150 0 300 100 T300 200"/>
              <path d="M0 50 Q150 -50 300 50"/>
              <path d="M0 150 Q150 50 300 150"/>
            </g>
          </svg>`
        )
    },
    {
      label: 'Solid block (SVG, ~600×400)',
      src:
        'data:image/svg+xml;utf8,' +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" width="600" height="400">
            <rect width="600" height="400" fill="#121826"/>
            <text x="50%" y="50%" fill="#e5e7eb" text-anchor="middle" dominant-baseline="middle" font-family="SF Mono, Menlo, monospace" font-size="28">SAMPLE 600×400</text>
          </svg>`
        )
    }
  ];

  let open = $state(false);
  let pickedIndex = $state(0);
  const src = $derived(SAMPLES[pickedIndex]?.src ?? SAMPLES[0].src);
</script>

<div class="grid grid-cols-[1fr_280px] gap-6 h-full">
  <div class="space-y-6 overflow-y-auto pr-2">
    <header>
      <h1 class="text-xl font-semibold text-text-primary">{meta.title}</h1>
      <p class="text-sm text-text-muted mt-1">{meta.description}</p>
    </header>

    <section class="surface p-6 space-y-4 min-h-[180px]">
      <p class="text-xs text-text-muted">
        Renders the picked sample in a 90vw/90vh contained image. Backdrop click or Esc dismisses;
        the X button in the top-right also closes.
      </p>
      <div class="grid grid-cols-3 gap-3">
        {#each SAMPLES as sample, i (sample.src)}
          <button
            type="button"
            onclick={() => {
              pickedIndex = i;
              open = true;
            }}
            class="bg-bg-deep border border-border-subtle rounded p-2 hover:border-accent-cyan transition-colors text-left"
          >
            <!-- svelte-ignore a11y_img_redundant_alt -->
            <img src={sample.src} alt={sample.label} class="w-full h-24 object-contain" />
            <div class="text-[10px] text-text-muted mt-1">{sample.label}</div>
          </button>
        {/each}
      </div>
    </section>

    <section>
      <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 mb-2 font-semibold">
        Example
      </h2>
      <pre
        class="bg-bg-deep border border-border-subtle rounded-md p-3 text-xs font-mono text-text-primary overflow-x-auto"><code
          >{`<LightboxModal src={url} alt="preview" onClose={() => open = false} />`}</code
        ></pre>
    </section>
  </div>

  <aside class="border-l border-border-subtle pl-4 space-y-4 text-xs overflow-y-auto">
    <h2 class="text-[10px] uppercase tracking-widest text-text-muted/80 font-semibold">Controls</h2>

    <button
      type="button"
      onclick={() => (open = true)}
      class="w-full px-3 py-2 rounded-md bg-accent-cyan text-bg-deep text-xs font-semibold hover:brightness-110 transition"
    >
      Open lightbox
    </button>

    <label class="block">
      <span class="block text-text-muted mb-1">Picked sample</span>
      <select
        bind:value={pickedIndex}
        class="w-full bg-bg-deep border border-border-subtle rounded-md px-2 py-1.5 text-text-primary font-mono"
      >
        {#each SAMPLES as sample, i (sample.src)}
          <option value={i}>{sample.label}</option>
        {/each}
      </select>
    </label>

    <p class="text-[10px] text-text-muted/70 leading-snug pt-2">
      All samples are inline SVG data URLs — no network roundtrip.
    </p>
  </aside>
</div>

{#if open}
  <LightboxModal {src} alt="playground sample" onClose={() => (open = false)} />
{/if}
