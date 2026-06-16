import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message, ReplyThread } from '$lib/api/types';

const mockConnection = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('./connection.svelte', () => ({
  connection: mockConnection
}));

import { replyThreads } from './reply-threads.svelte';

interface FakeReplyClient {
  listReplyThread: ReturnType<typeof vi.fn>;
  postReplyThread: ReturnType<typeof vi.fn>;
}

function setClient(client: FakeReplyClient | null): void {
  (mockConnection as { client: FakeReplyClient | null }).client = client;
}

function resetStore(): void {
  (replyThreads as unknown as { byParent: Record<string, ReplyThread> }).byParent = {};
}

function seedThread(parentMessageId = 'parent-1', parentThreadId = 'thread-1'): void {
  (replyThreads as unknown as { byParent: Record<string, ReplyThread> }).byParent = {
    [parentMessageId]: {
      parent_message_id: parentMessageId,
      parent_thread_id: parentThreadId,
      replies: [],
      unread_count: 0,
      last_updated_at: '2026-05-28T00:00:00.000Z'
    }
  };
}

describe('reply-threads store', () => {
  beforeEach(() => {
    resetStore();
    setClient(null);
  });

  afterEach(() => {
    resetStore();
    setClient(null);
  });

  it('post() records an optimistic reply, then patches its id when the server responds', async () => {
    let resolvePost: (value: { message_id: string }) => void = () => {};
    const postPromise = new Promise<{ message_id: string }>((resolve) => {
      resolvePost = resolve;
    });
    const client = {
      listReplyThread: vi.fn(),
      postReplyThread: vi.fn(() => postPromise)
    };
    setClient(client);

    const pending = replyThreads.post('parent-1', 'thread-1', 'hello reply');

    const optimistic = replyThreads.forParent('parent-1')?.replies[0];
    expect(optimistic).toMatchObject({
      role: 'user',
      content: 'hello reply'
    });
    expect(optimistic?.id.startsWith('local-')).toBe(true);
    expect(client.postReplyThread).toHaveBeenCalledWith(
      'parent-1',
      'thread-1',
      'hello reply',
      undefined
    );

    resolvePost({ message_id: 'server-reply-1' });
    await pending;

    expect(replyThreads.forParent('parent-1')?.replies).toEqual([
      expect.objectContaining({
        id: 'server-reply-1',
        role: 'user',
        content: 'hello reply'
      })
    ]);
  });

  it("handleEvent('reply.delta') appends to the in-progress reply", () => {
    seedThread();

    replyThreads.handleEvent({
      type: 'reply.delta',
      reply_id: 'assistant-reply-1',
      parent_message_id: 'parent-1',
      delta: 'Hello'
    });
    replyThreads.handleEvent({
      type: 'reply.delta',
      reply_id: 'assistant-reply-1',
      parent_message_id: 'parent-1',
      delta: ' there'
    });

    expect(replyThreads.forParent('parent-1')?.replies).toEqual([
      expect.objectContaining({
        id: 'assistant-reply-1',
        role: 'assistant',
        content: 'Hello there'
      })
    ]);
  });

  it("handleEvent('reply.completed') increments unread", () => {
    seedThread();
    const msg: Message = {
      id: 'assistant-reply-1',
      role: 'assistant',
      content: 'final answer',
      created_at: '2026-05-28T00:00:00.000Z'
    };

    replyThreads.handleEvent({
      type: 'reply.completed',
      reply_id: 'assistant-reply-1',
      parent_message_id: 'parent-1',
      message: msg
    });

    expect(replyThreads.unreadCount('parent-1')).toBe(1);
    expect(replyThreads.forParent('parent-1')?.replies).toEqual([msg]);
  });

  it('markRead zeros the counter', () => {
    seedThread();
    replyThreads.handleEvent({
      type: 'reply.completed',
      reply_id: 'assistant-reply-1',
      parent_message_id: 'parent-1',
      message: {
        id: 'assistant-reply-1',
        role: 'assistant',
        content: 'final answer',
        created_at: '2026-05-28T00:00:00.000Z'
      }
    });

    expect(replyThreads.unreadCount('parent-1')).toBe(1);
    replyThreads.markRead('parent-1');
    expect(replyThreads.unreadCount('parent-1')).toBe(0);
  });
});
