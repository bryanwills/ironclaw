<script lang="ts">
  // Editable user-message bubble (R69, lane B9).
  //
  // Hovers a pencil icon over the user bubble; clicking swaps the rendered
  // MarkdownView for a textarea pre-filled with the message content. The
  // user edits + presses Cmd+Enter (or "Save & resend") to commit. The
  // commit handler is owned by the chat surface (`+page.svelte` →
  // `handleBubbleEdit`) which truncates the thread at this message and
  // re-sends the edited content — the wikipedia-style "rewrite history
  // in place" semantics, distinct from R19b's Branch (forks fresh thread).
  //
  // Scope:
  //   - User messages ONLY. The assistant bubble path in `+page.svelte`
  //     never mounts this component.
  //   - View mode renders the message through MarkdownView so the bubble
  //     keeps parity with the surrounding chat (inline image syntax,
  //     code blocks, etc.).
  //   - Edit mode renders a plain textarea. We use `font-sans` to drop
  //     any inherited mono-style coming from a parent surface — edits
  //     are prose, not code.
  //
  // Keyboard contract on the textarea:
  //   - Esc → cancel + revert to view mode.
  //   - Cmd/Ctrl + Enter → submit (when the Save button would be enabled).
  //   - Plain Enter inserts a newline as usual.

  import { tick } from 'svelte';
  import type { Message } from '$lib/api/types';
  import MarkdownView from './LazyMarkdownView.svelte';

  interface Props {
    msg: Message;
    onEditSubmit: (msgId: string, newContent: string) => void | Promise<void>;
    disabled?: boolean;
  }

  let { msg, onEditSubmit, disabled = false }: Props = $props();

  let editing = $state(false);
  // Initial draft / sentinel are populated from the first prop value in
  // the effect below. Initializing the `$state` rune with `msg.content`
  // directly would lock the component to the FIRST `msg` it ever saw —
  // Svelte 5 captures the literal at compile time, hence the empty seed.
  let draft = $state('');
  let busy = $state(false);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  // Track which message id this component last reset against. When the
  // parent rebinds the bubble to a different message (e.g. thread reload
  // remaps optimistic local ids → server ids) we drop edit state so a
  // stale draft can't leak into the new message. Doing this via a
  // sentinel — rather than a reactive `$effect` watching `msg.id` —
  // avoids the runes pitfall where assigning to a $state inside an
  // effect that read the same value would loop. `null` seed forces the
  // first run to hydrate from props (handles initial mount too).
  let lastResetId = $state<string | null>(null);
  $effect(() => {
    if (msg.id !== lastResetId) {
      editing = false;
      draft = msg.content;
      busy = false;
      lastResetId = msg.id;
    }
  });

  const canSave = $derived(draft.trim().length > 0 && draft.trim() !== msg.content && !busy);

  async function startEdit() {
    if (disabled) return;
    draft = msg.content;
    editing = true;
    await tick();
    if (textareaEl) {
      textareaEl.focus();
      // Cursor at end so the common "tweak the last sentence" edit
      // doesn't require a manual click into the text.
      textareaEl.setSelectionRange(textareaEl.value.length, textareaEl.value.length);
    }
  }

  function cancelEdit() {
    editing = false;
    draft = msg.content;
    busy = false;
  }

  async function commitEdit() {
    if (!canSave) return;
    busy = true;
    try {
      await onEditSubmit(msg.id, draft.trim());
      // The parent typically unmounts the bubble (history rewrite drops
      // the old message), but if it doesn't we still fall back to view
      // mode so the textarea isn't left visible holding a now-stale draft.
      editing = false;
    } finally {
      busy = false;
    }
  }

  function onTextareaKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void commitEdit();
    }
  }
</script>

{#if editing}
  <div class="flex flex-col gap-2 w-full">
    <label class="sr-only" for="editable-bubble-textarea-{msg.id}">Edit message</label>
    <textarea
      id="editable-bubble-textarea-{msg.id}"
      bind:this={textareaEl}
      bind:value={draft}
      onkeydown={onTextareaKeyDown}
      rows="4"
      spellcheck="true"
      autocomplete="off"
      class="w-full bg-bg-deep border border-accent-cyan/40 rounded-md px-3 py-2 text-sm font-sans text-text-primary focus:outline-none focus:border-accent-cyan transition-colors resize-y min-h-[80px]"
    ></textarea>
    <div class="flex items-center justify-end gap-2">
      <button
        type="button"
        onclick={cancelEdit}
        disabled={busy}
        class="text-xs text-text-muted hover:text-text-primary transition-colors px-3 py-1.5 rounded-md min-h-[32px] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Cancel
      </button>
      <button
        type="button"
        onclick={() => void commitEdit()}
        disabled={!canSave}
        class="text-xs font-semibold px-3 py-1.5 rounded-md bg-accent-cyan text-bg-deep hover:brightness-110 transition min-h-[32px] disabled:opacity-40 disabled:cursor-not-allowed"
        aria-label="Save edit and resend"
      >
        {busy ? 'Sending…' : 'Save & resend'}
      </button>
    </div>
  </div>
{:else}
  <div class="group relative">
    <MarkdownView markdown={msg.content} />
    {#if !disabled}
      <button
        type="button"
        onclick={startEdit}
        class="absolute -top-1.5 -right-1.5 inline-flex items-center justify-center w-6 h-6 rounded text-text-muted bg-bg-deep/80 border border-border-subtle hover:text-accent-cyan hover:border-accent-cyan/50 transition-all opacity-0 group-hover:opacity-100 focus:opacity-100"
        aria-label="Edit message"
        title="Edit and resend"
      >
        <!-- Pencil glyph — not in Icon.svelte's set today; inline so we
             don't have to grow that union for a single use site. -->
        <svg
          viewBox="0 0 24 24"
          class="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
        </svg>
      </button>
    {/if}
  </div>
{/if}
