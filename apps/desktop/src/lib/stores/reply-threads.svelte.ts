// Reply-threads keyed by parent message id. Each entry is a thin list of
// messages plus an unread counter that the UI can clear when the thread panel
// opens.
//
// Storage is in-memory. The IDB cache (R62) can persist later by keying on
// `parent_message_id` once that store is wired.

import type { AttachmentInput, Message, ReplyThread, ReplyThreadStreamEvent } from '$lib/api/types';
import { connection } from './connection.svelte';

class ReplyThreadsStore {
  private byParent = $state<Record<string, ReplyThread>>({});

  async load(parentMessageId: string, parentThreadId: string): Promise<void> {
    const client = connection.client;
    if (!client) return;
    const replies = await client.listReplyThread(parentMessageId);
    this.byParent[parentMessageId] = {
      parent_message_id: parentMessageId,
      parent_thread_id: parentThreadId,
      replies,
      unread_count: 0,
      last_updated_at: new Date().toISOString()
    };
  }

  async post(
    parentMessageId: string,
    parentThreadId: string,
    content: string,
    attachments?: AttachmentInput[]
  ): Promise<void> {
    const client = connection.client;
    if (!client) throw new Error('Not connected');
    this.ensure(parentMessageId, parentThreadId);
    const optimistic: Message = {
      id: `local-${Date.now()}`,
      role: 'user',
      content,
      created_at: new Date().toISOString()
    };
    this.appendReply(parentMessageId, optimistic);
    const { message_id } = await client.postReplyThread(
      parentMessageId,
      parentThreadId,
      content,
      attachments
    );
    const slot = this.byParent[parentMessageId];
    if (slot) {
      slot.replies = slot.replies.map((r) =>
        r.id === optimistic.id ? { ...r, id: message_id } : r
      );
      slot.last_updated_at = new Date().toISOString();
    }
  }

  /** Called by the thread-events SSE consumer when a reply event fires. */
  handleEvent(ev: ReplyThreadStreamEvent): void {
    const slot = this.byParent[ev.parent_message_id];
    if (!slot) return;
    if (ev.type === 'reply.completed' && ev.message) {
      const existing = slot.replies.findIndex(
        (r) => r.id === ev.message?.id || r.id === ev.reply_id
      );
      if (existing >= 0) {
        const next = slot.replies.slice();
        next[existing] = ev.message;
        slot.replies = next;
      } else {
        this.appendReply(ev.parent_message_id, ev.message);
      }
      slot.unread_count += 1;
      slot.last_updated_at = new Date().toISOString();
    } else if (ev.type === 'reply.delta' && ev.delta) {
      let last = slot.replies[slot.replies.length - 1];
      if (!last || last.id !== ev.reply_id) {
        last = {
          id: ev.reply_id,
          role: 'assistant',
          content: '',
          created_at: new Date().toISOString()
        };
        slot.replies = [...slot.replies, last];
      }
      last.content += ev.delta;
      slot.replies = [...slot.replies.slice(0, -1), last];
      slot.last_updated_at = new Date().toISOString();
    }
  }

  markRead(parentMessageId: string): void {
    const slot = this.byParent[parentMessageId];
    if (slot) slot.unread_count = 0;
  }

  forParent(parentMessageId: string): ReplyThread | null {
    return this.byParent[parentMessageId] ?? null;
  }

  unreadCount(parentMessageId: string): number {
    return this.byParent[parentMessageId]?.unread_count ?? 0;
  }

  private ensure(parentMessageId: string, parentThreadId: string): void {
    if (this.byParent[parentMessageId]) return;
    this.byParent[parentMessageId] = {
      parent_message_id: parentMessageId,
      parent_thread_id: parentThreadId,
      replies: [],
      unread_count: 0,
      last_updated_at: new Date().toISOString()
    };
  }

  private appendReply(parentMessageId: string, msg: Message): void {
    const slot = this.byParent[parentMessageId];
    if (slot) {
      slot.replies = [...slot.replies, msg];
      slot.last_updated_at = new Date().toISOString();
    }
  }
}

export const replyThreads = new ReplyThreadsStore();

if (typeof window !== 'undefined') {
  const win = window as Window & { _stores?: Record<string, unknown> };
  win._stores = { ...(win._stores ?? {}), replyThreads };
}
