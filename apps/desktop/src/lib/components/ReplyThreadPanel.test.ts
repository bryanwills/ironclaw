// Render smoke tests for ReplyThreadPanel.svelte (R80 — Slack-style reply
// thread side panel). Props-driven (parentMessage / parentThreadId /
// onClose); reads the replyThreads store. We spy the store methods and stub
// the heavy MarkdownView child. onMount calls load()/markRead() — both spied
// so there's no IPC.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('./MarkdownView.svelte', () => ({ default: () => null }));

import ReplyThreadPanel from './ReplyThreadPanel.svelte';
import { replyThreads } from '$lib/stores/reply-threads.svelte';
import type { Message } from '$lib/api/types';

type ForParent = ReturnType<typeof replyThreads.forParent>;

function parent(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'parent text',
    created_at: '2026-05-29T10:00:00Z',
    ...over
  } as Message;
}

function slotWith(replies: unknown[]): ForParent {
  return { replies } as unknown as ForParent;
}

beforeEach(() => {
  vi.spyOn(replyThreads, 'load').mockResolvedValue(undefined);
  vi.spyOn(replyThreads, 'markRead').mockImplementation(() => {});
  vi.spyOn(replyThreads, 'post').mockResolvedValue(undefined as never);
  vi.spyOn(replyThreads, 'forParent').mockReturnValue(null);
});

afterEach(() => vi.restoreAllMocks());

const closeBtn = (c: HTMLElement) => c.querySelector('button[aria-label="Close reply thread"]')!;

describe('ReplyThreadPanel component', () => {
  it('shows the empty state + parent preview when there are no replies', async () => {
    const { container } = render(ReplyThreadPanel, {
      props: { parentMessage: parent(), parentThreadId: 't1', onClose: vi.fn() }
    });
    await tick();
    expect(container.textContent).toContain('No replies yet');
    expect(container.textContent).toContain('parent text');
    expect(closeBtn(container)).toBeTruthy();
  });

  it('renders existing replies (role + no empty-state)', async () => {
    vi.mocked(replyThreads.forParent).mockReturnValue(
      slotWith([{ id: 'r1', role: 'user', content: 'a reply', created_at: '2026-05-29T10:01:00Z' }])
    );
    const { container } = render(ReplyThreadPanel, {
      props: { parentMessage: parent(), parentThreadId: 't1', onClose: vi.fn() }
    });
    await tick();
    expect(container.textContent).not.toContain('No replies yet');
    expect(container.textContent).toContain('user');
  });

  it('lazy-loads + marks read on mount', async () => {
    render(ReplyThreadPanel, {
      props: { parentMessage: parent({ id: 'mX' }), parentThreadId: 'tX', onClose: vi.fn() }
    });
    await tick();
    await Promise.resolve();
    expect(replyThreads.load).toHaveBeenCalledWith('mX', 'tX');
    expect(replyThreads.markRead).toHaveBeenCalledWith('mX');
  });

  it('the close button fires onClose', async () => {
    const onClose = vi.fn();
    const { container } = render(ReplyThreadPanel, {
      props: { parentMessage: parent(), parentThreadId: 't1', onClose }
    });
    await tick();
    await act(async () => {
      await fireEvent.click(closeBtn(container));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Send is gated on draft content and posts the reply', async () => {
    const { container } = render(ReplyThreadPanel, {
      props: { parentMessage: parent({ id: 'mZ' }), parentThreadId: 'tZ', onClose: vi.fn() }
    });
    await tick();
    const send = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Send')
    ) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      await fireEvent.input(textarea, { target: { value: 'my reply' } });
    });
    expect(send.disabled).toBe(false);

    await act(async () => {
      await fireEvent.click(send);
    });
    expect(replyThreads.post).toHaveBeenCalledWith('mZ', 'tZ', 'my reply');
  });

  it('truncates a long parent preview with an ellipsis', async () => {
    const { container } = render(ReplyThreadPanel, {
      props: {
        parentMessage: parent({ content: 'x'.repeat(100) }),
        parentThreadId: 't1',
        onClose: vi.fn()
      }
    });
    await tick();
    expect(container.textContent).toContain('…');
  });
});
