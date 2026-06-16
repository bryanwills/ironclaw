// R80 (lane W3) UI state: which message has its reply-thread panel
// currently open. Distinct from the data store (`reply-threads.svelte.ts`,
// R79) — the data store may hold multiple loaded threads in memory; this
// store just tracks which one the chat surface is currently SHOWING.

import type { Message } from '$lib/api/types';

class ReplyThreadUIStore {
  /** The parent message currently open in the reply panel, or null. */
  openParent = $state<Message | null>(null);
  /** The thread id the parent belongs to. */
  openThreadId = $state<string | null>(null);

  open(parent: Message, threadId: string): void {
    this.openParent = parent;
    this.openThreadId = threadId;
  }

  close(): void {
    this.openParent = null;
    this.openThreadId = null;
  }

  isOpen(): boolean {
    return this.openParent !== null;
  }
}

export const replyThreadUI = new ReplyThreadUIStore();
