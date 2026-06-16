<script lang="ts">
  // Top-of-layout banner driven by the global `updater` store. Renders
  // when an update is available, while it's downloading/installing, or
  // when the last check errored — hidden in idle / up-to-date states so
  // the chrome stays quiet on a healthy launch.
  //
  // Polish (2026-05):
  //   - Release notes expand inline below the banner instead of a modal.
  //     The notes string ships markdown straight from the GitHub release;
  //     we route it through the shared MarkdownView so headings, lists,
  //     and code fences render. Panel is capped at ~50vh with overflow-y
  //     scroll so a chatty release doesn't crowd the rest of the chrome.
  //   - "Skip this version" sits beside "Later". Skipping persists the
  //     version string via the store so auto-checks for that exact
  //     version stay silent; a future newer version surfaces normally.
  //   - Touch targets stay >= 32px tall in the banner row (the launcher
  //     chrome is dense by necessity); the link buttons stay underline-on
  //     hover so they read as secondary actions.

  import { updater } from '$lib/stores/updater.svelte';
  import MarkdownView from '$lib/components/MarkdownView.svelte';

  let showNotes = $state(false);

  // Compose a short label for each non-idle state.
  const label = $derived.by(() => {
    switch (updater.status) {
      case 'available':
        return updater.update
          ? `IronClaw v${updater.update.version} is available`
          : 'Update available';
      case 'downloading':
        return updater.progress != null ? `Downloading ${updater.progress}%…` : 'Downloading…';
      case 'installing':
        return 'Installing. Restart to apply.';
      case 'error':
        return updater.error ?? 'Update failed';
      default:
        return '';
    }
  });

  // Render only when state is interesting. Idle / checking / up-to-date
  // stays out of the user's way.
  const visible = $derived(
    updater.status === 'available' ||
      updater.status === 'downloading' ||
      updater.status === 'installing' ||
      updater.status === 'error'
  );

  // Whether release notes exist to expand. Used to gate the "View release
  // notes" link AND collapse the panel on transitions away from the
  // available state (e.g. after a click on Install).
  const hasNotes = $derived(
    updater.status === 'available' &&
      !!updater.update?.notes &&
      updater.update.notes.trim().length > 0
  );

  // Collapse the notes panel whenever the banner stops showing the
  // available state (install starts, dismissal, etc.). Without this the
  // panel would linger if the user clicked Install with notes open.
  $effect(() => {
    if (!hasNotes && showNotes) showNotes = false;
  });

  async function onInstall() {
    showNotes = false;
    await updater.install();
  }

  function onLater() {
    showNotes = false;
    updater.dismiss();
  }

  function onSkip() {
    showNotes = false;
    updater.skipCurrent();
  }

  async function onRetry() {
    showNotes = false;
    await updater.check();
  }
</script>

{#if visible}
  <div
    class="w-full border-b text-xs flex items-center gap-3 px-4 py-2 z-30 relative"
    class:bg-bg-surface={updater.status !== 'error'}
    class:border-border-subtle={updater.status !== 'error'}
    class:text-text-primary={updater.status !== 'error'}
    class:bg-red-950={updater.status === 'error'}
    class:border-red-800={updater.status === 'error'}
    class:text-red-200={updater.status === 'error'}
    role="status"
  >
    <span class="flex-1 truncate" title={updater.error ?? undefined}>
      {label}
      {#if hasNotes}
        <button
          type="button"
          onclick={() => (showNotes = !showNotes)}
          class="ml-2 underline text-accent-cyan hover:brightness-110"
          aria-expanded={showNotes}
          aria-controls="updater-release-notes"
        >
          {showNotes ? 'Hide release notes' : 'View release notes'}
        </button>
      {/if}
    </span>

    {#if updater.status === 'downloading' && updater.progress != null}
      <!-- Linear progress bar -->
      <div class="w-32 h-1.5 bg-bg-deep rounded overflow-hidden">
        <div
          class="h-full bg-accent-cyan transition-[width] duration-150"
          style:width="{updater.progress}%"
        ></div>
      </div>
    {/if}

    {#if updater.status === 'available'}
      <button
        type="button"
        onclick={onInstall}
        class="px-3 py-1.5 rounded-md bg-accent-cyan text-bg-deep text-xs font-semibold hover:brightness-110 transition min-h-[32px]"
      >
        Install now
      </button>
      <button
        type="button"
        onclick={onLater}
        class="text-text-muted hover:text-text-primary transition-colors text-xs"
      >
        Later
      </button>
      <button
        type="button"
        onclick={onSkip}
        class="text-text-muted hover:text-text-primary transition-colors text-xs"
        title="Hide until a newer version ships"
      >
        Skip this version
      </button>
    {:else if updater.status === 'error'}
      <button
        type="button"
        onclick={onRetry}
        class="px-3 py-1.5 rounded-md border border-red-400 text-red-200 text-xs font-semibold hover:bg-red-900 transition min-h-[32px]"
      >
        Retry
      </button>
      <button
        type="button"
        onclick={onLater}
        class="text-red-300 hover:text-red-100 transition-colors text-xs"
      >
        Dismiss
      </button>
    {/if}
  </div>

  {#if showNotes && updater.update?.notes}
    <!-- Inline release-notes panel. Sits directly below the banner so the
         user can scan changelog without leaving the page. Capped at ~50vh
         with internal scrolling so a long release doesn't push the rest
         of the chrome out of view. -->
    <section
      id="updater-release-notes"
      class="w-full bg-bg-surface border-b border-border-subtle px-4 py-3 z-20 relative"
      aria-label="Release notes"
    >
      <header class="flex items-center justify-between mb-2">
        <h2 class="text-xs font-semibold text-text-primary">
          Release notes · v{updater.update.version}
        </h2>
        <button
          type="button"
          onclick={() => (showNotes = false)}
          class="text-text-muted hover:text-text-primary text-xs"
          aria-label="Collapse release notes"
        >
          Hide
        </button>
      </header>
      <div class="max-h-[50vh] overflow-y-auto pr-1 text-xs text-text-primary">
        <MarkdownView markdown={updater.update.notes} />
      </div>
    </section>
  {/if}
{/if}
