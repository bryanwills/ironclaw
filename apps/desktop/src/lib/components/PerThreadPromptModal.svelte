<script lang="ts">
  // Per-thread system-prompt editor modal.
  //
  // Summoned from the chat-header kebab menu ("Custom system prompt…").
  // Lets the user attach a custom system prompt to ONE specific thread
  // — e.g. "you are a Spanish tutor" — without touching the
  // gateway-wide admin SYSTEM.md. The override is persisted via
  // `perThreadPrompts` and surfaced on the next outbound message via
  // the Responses-API `instructions` field (see `streamResponse` in
  // `$lib/api/ironclaw.ts`).
  //
  // Behaviour:
  //   - Centered overlay, 600px wide (clamped under viewport-2rem so
  //     a narrow window doesn't horizontally scroll).
  //   - Esc closes; click on backdrop closes; clicks inside the card
  //     do NOT bubble to the backdrop.
  //   - Textarea is pre-filled with the current override (blank when
  //     none exists). Monospace + 12 rows to match the prompt-editor
  //     vibe.
  //   - Character count + soft warning when length exceeds
  //     `MAX_PROMPT_CHARS`. We never truncate — the warning copy
  //     ("Long prompts may be truncated by the gateway") is the
  //     contract.
  //   - "Reset to default" is enabled only when an override exists.
  //   - Save persists the override and fires a toast; Reset clears
  //     and fires the inverse toast. Both close the modal and emit a
  //     `prompt-changed` event so the chat surface can pick up the
  //     new state without a hard reload.

  import { onMount, tick } from 'svelte';
  import { perThreadPrompts, MAX_PROMPT_CHARS } from '$lib/stores/per-thread-prompts.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';

  interface Props {
    open: boolean;
    threadId: string | null;
    threadTitle: string;
    onClose: () => void;
    onChanged?: () => void;
  }

  let { open = $bindable(), threadId, threadTitle, onClose, onChanged }: Props = $props();

  let draft = $state('');
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  // Whether the current thread carries an override at the moment the
  // modal opened. Used to gate the "Reset to default" button and to
  // distinguish "user opened the modal on a thread with an override
  // and saved it again" (Save toast) from "user cleared it" (Reset
  // toast). We snapshot on open so a Save→Reset within the same
  // session doesn't disable the button mid-click.
  let hadOverride = $state(false);

  // Char count is derived from the live textarea content. `length`
  // counts UTF-16 code units which is what `String.prototype.length`
  // and the gateway both use, so the warning kicks in at the same
  // threshold the gateway truncates at.
  const charCount = $derived(draft.length);
  const overLimit = $derived(charCount > MAX_PROMPT_CHARS);

  // Pre-fill the textarea when the modal opens. Done in an effect so
  // a parent toggling `open` true→false→true cycles cleanly without a
  // stale draft from the last session leaking through.
  $effect(() => {
    if (!open) return;
    if (!threadId) {
      // Defensive: parent should gate, but if `open=true && threadId=null`
      // slips through, render an empty draft rather than blowing up.
      draft = '';
      hadOverride = false;
      return;
    }
    const existing = perThreadPrompts.get(threadId);
    draft = existing ?? '';
    hadOverride = perThreadPrompts.hasOverride(threadId);
    // Focus the textarea once the DOM has settled. Microtask isn't
    // enough on the first paint — the modal node is created in the
    // same task.
    void (async () => {
      await tick();
      textareaEl?.focus();
      // Cursor at end so an existing prompt is easy to extend.
      textareaEl?.setSelectionRange(textareaEl.value.length, textareaEl.value.length);
    })();
  });

  // Window-level Esc handler so the modal closes even if focus
  // moved out of the textarea (e.g. user tabbed to the Save button).
  // Mirrors the NewProfileModal pattern.
  onMount(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  function handleSave() {
    if (!threadId) {
      onClose();
      return;
    }
    const trimmed = draft.trim();
    if (trimmed === '') {
      // Empty input = same intent as Reset. Route through clear() so
      // the toast copy + downstream state matches the user's expectation.
      handleReset();
      return;
    }
    perThreadPrompts.set(threadId, trimmed);
    toasts.show('Custom prompt saved.', 'success');
    onChanged?.();
    onClose();
  }

  function handleReset() {
    if (!threadId) {
      onClose();
      return;
    }
    if (perThreadPrompts.hasOverride(threadId)) {
      perThreadPrompts.clear(threadId);
      toasts.show('Reverted to the default prompt.', 'info');
      onChanged?.();
    }
    onClose();
  }
</script>

{#if open}
  <!-- Backdrop. Click anywhere outside the card to dismiss; keyboard
       activation on the backdrop also dismisses for accessibility. -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    onclick={onClose}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClose();
      }
    }}
    role="button"
    tabindex="-1"
    aria-label="Close custom system prompt dialog"
  >
    <!-- Card. stopPropagation so backdrop clicks inside the card don't dismiss. -->
    <div
      class="surface w-[min(600px,calc(100vw-2rem))] max-h-[calc(100vh-4rem)] flex flex-col p-6 space-y-4 border border-border-subtle"
      role="dialog"
      aria-modal="true"
      aria-labelledby="per-thread-prompt-title"
      aria-describedby="per-thread-prompt-subtitle"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      tabindex="-1"
    >
      <header class="space-y-1">
        <h2 id="per-thread-prompt-title" class="text-lg font-semibold text-text-primary">
          Custom system prompt for this thread
        </h2>
        <p id="per-thread-prompt-subtitle" class="text-xs text-text-muted truncate">
          {threadTitle || 'Untitled thread'}
        </p>
      </header>

      <div class="flex-1 min-h-0 flex flex-col gap-2">
        <label for="per-thread-prompt-textarea" class="sr-only"> Custom system prompt </label>
        <textarea
          id="per-thread-prompt-textarea"
          bind:this={textareaEl}
          bind:value={draft}
          rows="12"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          placeholder="You are a Spanish tutor. Reply only in Spanish…"
          class="w-full bg-bg-deep border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary focus:outline-none focus:border-accent-cyan transition-colors resize-y"
          class:border-accent-gold={overLimit}
        ></textarea>
        <div class="flex items-center justify-between gap-2 text-xs">
          <span class={overLimit ? 'text-accent-gold' : 'text-text-muted'} aria-live="polite">
            {charCount.toLocaleString()} / {MAX_PROMPT_CHARS.toLocaleString()} characters
          </span>
          {#if overLimit}
            <span class="text-accent-gold flex-shrink-0">
              Long prompts may be truncated by the gateway
            </span>
          {/if}
        </div>
      </div>

      <footer class="flex items-center justify-end gap-3 pt-1">
        <button
          type="button"
          onclick={onClose}
          class="text-sm text-text-muted hover:text-text-primary transition-colors min-h-[44px] px-3"
        >
          Cancel
        </button>
        <button
          type="button"
          onclick={handleReset}
          disabled={!hadOverride}
          class="text-sm text-text-primary hover:text-accent-cyan transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px] px-3"
        >
          Reset to default
        </button>
        <button
          type="button"
          onclick={handleSave}
          class="px-4 py-2 rounded-md bg-accent-cyan text-bg-deep text-sm font-semibold hover:brightness-110 transition min-h-[44px]"
        >
          Save
        </button>
      </footer>
    </div>
  </div>
{/if}
