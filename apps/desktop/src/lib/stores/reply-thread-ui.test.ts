// Unit tests for the reply-thread UI-state singleton (R80 — tracks which
// message's reply panel the chat surface is currently showing). Pure rune
// store, no deps beyond the Message type; we drive it through open/close and
// reset the shared singleton between tests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replyThreadUI } from './reply-thread-ui.svelte';
import type { Message } from '$lib/api/types';

function msg(over: Partial<Message> = {}): Message {
  return { id: 'm1', role: 'user', content: 'hi', created_at: '2026-05-01T00:00:00Z', ...over };
}

beforeEach(() => replyThreadUI.close());
afterEach(() => replyThreadUI.close());

describe('replyThreadUI store', () => {
  it('starts closed', () => {
    expect(replyThreadUI.openParent).toBeNull();
    expect(replyThreadUI.openThreadId).toBeNull();
    expect(replyThreadUI.isOpen()).toBe(false);
  });

  it('open() records the parent message and thread id', () => {
    // Note: objects assigned to $state are read back as reactive Proxies, so
    // assert on a field rather than reference identity (toBe would fail).
    replyThreadUI.open(msg({ id: 'p1' }), 't1');
    expect(replyThreadUI.openParent?.id).toBe('p1');
    expect(replyThreadUI.openThreadId).toBe('t1');
    expect(replyThreadUI.isOpen()).toBe(true);
  });

  it('open() overwrites a previously open panel', () => {
    replyThreadUI.open(msg({ id: 'p1' }), 't1');
    replyThreadUI.open(msg({ id: 'p2' }), 't2');
    expect(replyThreadUI.openParent?.id).toBe('p2');
    expect(replyThreadUI.openThreadId).toBe('t2');
  });

  it('close() clears the open panel', () => {
    replyThreadUI.open(msg(), 't1');
    replyThreadUI.close();
    expect(replyThreadUI.openParent).toBeNull();
    expect(replyThreadUI.openThreadId).toBeNull();
    expect(replyThreadUI.isOpen()).toBe(false);
  });
});
