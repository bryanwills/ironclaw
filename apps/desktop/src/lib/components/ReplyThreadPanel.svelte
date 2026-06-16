<script lang="ts">
  // R80 (lane W3): Slack-style reply-thread panel.
  //
  // Mounted as a sliding side panel when the user clicks "Reply in
  // thread" on a chat bubble. Consumes the R79 reply-threads store —
  // loads existing replies via load(), shows them in a vertical
  // strip, and exposes a slim composer that calls post().
  //
  // The chat surface decides WHICH parent message is "open" via a
  // separate UI store (replyUI). This component just renders for the
  // given parent.

  import type { Message } from '$lib/api/types';
  import { replyThreads } from '$lib/stores/reply-threads.svelte';
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import MarkdownView from './LazyMarkdownView.svelte';

  interface Props {
    parentMessage: Message;
    parentThreadId: string;
    onClose: () => void;
  }

  let { parentMessage, parentThreadId, onClose }: Props = $props();

  const slot = $derived(replyThreads.forParent(parentMessage.id));
  const replies = $derived(slot?.replies ?? []);

  let draft = $state('');
  let sending = $state(false);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  onMount(async () => {
    // Lazy-load existing replies. Best-effort — if it fails the panel
    // shows the local-only state.
    await replyThreads.load(parentMessage.id, parentThreadId).catch(() => undefined);
    replyThreads.markRead(parentMessage.id);
    queueMicrotask(() => textareaEl?.focus());
  });

  async function onSend(): Promise<void> {
    const content = draft.trim();
    if (!content) return;
    sending = true;
    try {
      await replyThreads.post(parentMessage.id, parentThreadId, content);
      draft = '';
      queueMicrotask(() => textareaEl?.focus());
    } catch {
      // Toast surfaced upstream; keep the draft so the user can retry.
    } finally {
      sending = false;
    }
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      onClose();
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      void onSend();
    }
  }
</script>

<aside
  class="border-l border-border-subtle bg-bg-base/60 backdrop-blur-sm flex flex-col h-full w-[360px]"
  aria-label="Reply thread"
>
  <header class="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
    <div class="flex flex-col min-w-0">
      <span class="text-xs font-semibold text-text-primary">Thread</span>
      <span class="text-[10px] text-text-muted truncate max-w-[260px]">
        {parentMessage.content.slice(0, 60)}{parentMessage.content.length > 60 ? '…' : ''}
      </span>
    </div>
    <button
      type="button"
      onclick={onClose}
      class="shrink-0 w-7 h-7 rounded text-text-muted hover:text-red-300 hover:bg-red-500/10
             transition-colors flex items-center justify-center"
      aria-label="Close reply thread"
      title="Close (Esc)"
    >
      <Icon name="close" class="w-3 h-3" />
    </button>
  </header>

  <div class="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-3">
    {#if replies.length === 0}
      <div class="text-xs text-text-muted py-6 text-center">No replies yet.</div>
    {:else}
      {#each replies as reply (reply.id)}
        <div
          class="rounded-md border border-border-subtle bg-bg-deep/40 px-3 py-2
                 text-xs text-text-primary"
        >
          <div class="flex items-center gap-2 mb-1 text-[10px] text-text-muted">
            <span class="font-semibold uppercase">{reply.role}</span>
            <span>·</span>
            <span>{new Date(reply.created_at).toLocaleTimeString()}</span>
          </div>
          <MarkdownView markdown={reply.content} />
        </div>
      {/each}
    {/if}
  </div>

  <footer class="border-t border-border-subtle px-3 py-2 flex flex-col gap-2">
    <textarea
      bind:this={textareaEl}
      bind:value={draft}
      onkeydown={onKey}
      placeholder="Reply in thread…"
      class="w-full bg-bg-deep/60 border border-border-subtle rounded-md px-2 py-1.5
             text-xs text-text-primary placeholder:text-text-muted focus:outline-none
             focus:border-accent-cyan resize-none"
      rows="3"
      aria-label="Reply content"
    ></textarea>
    <div class="flex items-center justify-between">
      <span class="text-[10px] text-text-muted">Cmd+Enter to send</span>
      <button
        type="button"
        onclick={() => void onSend()}
        disabled={!draft.trim() || sending}
        class="px-3 py-1 rounded-md bg-accent-cyan text-bg-deep text-xs font-medium
               hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {sending ? 'Sending…' : 'Send'}
      </button>
    </div>
  </footer>
</aside>
