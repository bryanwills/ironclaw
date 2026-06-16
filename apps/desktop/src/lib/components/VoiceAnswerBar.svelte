<script lang="ts">
  // Voice answer mode UI. Two surfaces:
  //   1. A toggle button (rendered inline by the chat surface) — small
  //      speaker icon, color shifts when armed, click toggles.
  //   2. A speaking-status bar (this component) — visible only when the
  //      store says voice-answer mode is ON. Shows a "Speaking" label
  //      with a pulse animation and a Stop button. Hidden when off.
  //
  // The actual speak() invocation is the chat surface's job (it lives
  // closest to the stream completion). This bar only renders + reacts.

  import { voiceAnswer } from '$lib/stores/voice-answer.svelte';
  import Icon from './Icon.svelte';
</script>

{#if voiceAnswer.enabled}
  <div
    class="flex items-center gap-2 px-3 py-1.5 rounded-md border border-accent-cyan/30 bg-accent-cyan/5 text-xs"
    role="status"
    aria-live="polite"
  >
    <span
      class="relative w-2 h-2 rounded-full"
      class:bg-accent-cyan={voiceAnswer.speaking}
      class:bg-text-muted={!voiceAnswer.speaking}
      aria-hidden="true"
    >
      {#if voiceAnswer.speaking}
        <span class="absolute inset-0 rounded-full bg-accent-cyan animate-ping opacity-70"></span>
      {/if}
    </span>
    <span class="text-text-primary">
      {voiceAnswer.speaking ? 'Speaking…' : 'Voice answer on'}
    </span>
    {#if voiceAnswer.error}
      <span class="text-red-300/80 text-[10px]" title={voiceAnswer.error}>(error)</span>
    {/if}
    <button
      type="button"
      onclick={() => void voiceAnswer.stop()}
      class="ml-auto px-2 py-0.5 rounded text-text-muted hover:text-accent-cyan
             hover:bg-accent-cyan/10 transition-colors"
      title="Stop speaking"
      aria-label="Stop speaking"
    >
      Stop
    </button>
    <button
      type="button"
      onclick={() => voiceAnswer.setEnabled(false)}
      class="px-2 py-0.5 rounded text-text-muted hover:text-red-300 transition-colors"
      title="Turn off voice answer"
      aria-label="Turn off voice answer"
    >
      <Icon name="close" class="w-3 h-3" />
    </button>
  </div>
{/if}
