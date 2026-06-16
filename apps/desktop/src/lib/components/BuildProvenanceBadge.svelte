<script lang="ts">
  // Build provenance pill — surfaces whether the running .app is a
  // Developer-ID-signed public release, an ad-hoc-signed support build,
  // or an unsigned dev bundle. Shipped in v0.2.10 (R38) to make the
  // release-readiness story legible at a glance.
  //
  // Calls `build_provenance` once on mount. The state is build-time
  // determined so we don't need to poll.

  import { onMount } from 'svelte';
  import { getBuildProvenance, type BuildProvenance } from '$lib/stores/settings.svelte';

  interface Props {
    /** Forced provenance for playground / tests — when set, skips the IPC. */
    forced?: BuildProvenance;
  }

  let { forced = undefined }: Props = $props();
  let live = $state<BuildProvenance | 'loading' | 'absent'>('loading');

  // Reading `forced` inside the derived keeps the badge reactive to
  // parent-driven prop changes (the playground controls swap states).
  const data = $derived<BuildProvenance | 'loading' | 'absent'>(forced ?? live);

  onMount(() => {
    if (forced) return;
    void (async () => {
      const result = await getBuildProvenance();
      live = result ?? 'absent';
    })();
  });

  const STATES: Record<
    BuildProvenance['build_kind'],
    { label: string; chipClass: string; dotClass: string; title: string }
  > = {
    public: {
      label: 'Public release',
      chipClass: 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30',
      dotClass: 'bg-accent-cyan',
      title: 'Release build, no devtools. Developer-ID sign before distributing.'
    },
    support: {
      label: 'Support build',
      chipClass: 'bg-accent-gold/10 text-accent-gold border-accent-gold/30',
      dotClass: 'bg-accent-gold',
      title: 'Release build with dev-devtools enabled. Inspect available. Do not distribute.'
    },
    dev: {
      label: 'Dev',
      chipClass: 'bg-text-muted/10 text-text-muted border-text-muted/30',
      dotClass: 'bg-text-muted',
      title: 'Debug build. Not for distribution.'
    }
  };
</script>

{#if data === 'loading'}
  <span
    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-text-muted/10 text-text-muted/70 border border-text-muted/20"
    aria-label="Build provenance: loading"
  >
    <span class="w-1.5 h-1.5 rounded-full bg-text-muted/40 animate-pulse" aria-hidden="true"></span>
    …
  </span>
{:else if data === 'absent'}
  <span
    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-text-muted/10 text-text-muted border border-text-muted/30"
    title="Could not determine build provenance"
    aria-label="Build provenance: unknown"
  >
    <span class="w-1.5 h-1.5 rounded-full bg-text-muted/50" aria-hidden="true"></span>
    Unknown
  </span>
{:else}
  {@const info = STATES[data.build_kind]}
  <span
    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border {info.chipClass}"
    title="{info.title} (signing: {data.signing}, profile: {data.profile})"
    aria-label="Build kind: {info.label}"
    data-testid="build-provenance-badge"
    data-build-kind={data.build_kind}
    data-signing={data.signing}
  >
    <span class="w-1.5 h-1.5 rounded-full {info.dotClass}" aria-hidden="true"></span>
    {info.label}
  </span>
{/if}
