<script lang="ts">
  // "The Desk" route — the proactive chief-of-staff home. Mounts the
  // self-contained RebornDeskPanel (the "Needs you" approval-gate inbox today;
  // the "while you were away" feed, open-loop commitments, and standing
  // routines land in following increments). The panel binds to the app-wide
  // RebornDesk singleton, so this route is a thin full-height wrapper.
  import RebornDeskPanel from '$lib/components/RebornDeskPanel.svelte';
  import GeneratedMissionsPanel from '$lib/components/GeneratedMissionsPanel.svelte';
</script>

<svelte:head>
  <title>The Desk · IronClaw</title>
</svelte:head>

<!-- Named region landmark: the Desk has no `<h1>` (its headings live inside
     RebornDeskPanel's card sections), so the surface root carries an
     accessible name for screen-reader navigation + the a11y sweep anchor. -->
<section class="h-full min-h-0 flex flex-col" aria-label="The Desk">
  <!-- Generative: the agent proposes actions from what just came in. Pinned on
       top; capped so it never crowds out the approval inbox below. -->
  <div class="shrink-0 max-h-[60%] overflow-y-auto border-b border-border-subtle p-4">
    <GeneratedMissionsPanel />
  </div>
  <!-- The existing "Needs you" approval inbox keeps its full height contract
       (flex-1 of the section, exactly as when it was the sole child). -->
  <div class="flex-1 min-h-0">
    <RebornDeskPanel />
  </div>
</section>
