// Unit tests for the per-thread MessageStore. Scoped to the PURE state methods
// (no idb-cache / connection.client I/O): the streaming-chunk cumulative-vs-
// append heuristic, tool start/result attach (reversed-walk + standalone
// fallback), the commit-assistant empty-buffer bail, optimistic user append,
// and the failed-meta lifecycle. loadHistory/loadMoreHistory (which hit idb +
// the gateway client) are out of scope here.

import { describe, expect, it, beforeEach } from 'vitest';
import { messages } from '$lib/stores/messages.svelte';

const T = 'thread-1';

beforeEach(() => {
  // Reset the singleton's per-thread $state for isolation between tests.
  messages.byThread = {};
  messages.streaming = {};
  messages.tools = {};
  messages.streamingActive = {};
  messages.errors = {};
  messages.meta = {};
});

describe('MessageStore streaming buffer', () => {
  it('replaces the buffer when a delta cumulatively extends it', () => {
    messages.beginStream(T);
    messages.appendStreamingChunk(T, 'Hel');
    messages.appendStreamingChunk(T, 'Hello world'); // prefix-extension → replace
    expect(messages.getStreaming(T)).toBe('Hello world');
  });

  it('appends when a delta does not extend the current buffer', () => {
    messages.appendStreamingChunk(T, 'abc');
    messages.appendStreamingChunk(T, 'xyz'); // not a prefix-extension → append
    expect(messages.getStreaming(T)).toBe('abcxyz');
  });
});

describe('MessageStore tool tracking', () => {
  it('attaches a result to the most recent matching open call', () => {
    messages.recordToolStart(T, 'search', { q: 'a' });
    messages.recordToolResult(T, 'search', { hits: 3 });
    const tools = messages.getTools(T);
    expect(tools).toHaveLength(1);
    expect(tools[0].done).toBe(true);
    expect(tools[0].result).toEqual({ hits: 3 });
  });

  it('records a standalone result entry when there is no open matching call', () => {
    messages.recordToolResult(T, 'orphan', { ok: true });
    const tools = messages.getTools(T);
    expect(tools).toHaveLength(1);
    expect(tools[0].done).toBe(true);
    expect(tools[0].args).toBeUndefined();
  });
});

describe('MessageStore commit + optimistic append', () => {
  it('bails without appending when the streaming buffer is empty/whitespace', () => {
    messages.beginStream(T);
    messages.appendStreamingChunk(T, '   ');
    messages.commitAssistantMessage(T);
    expect(messages.get(T)).toHaveLength(0);
    expect(messages.isStreaming(T)).toBe(false);
  });

  it('commits a non-empty buffer as an assistant message and clears the buffer', () => {
    messages.beginStream(T);
    messages.appendStreamingChunk(T, 'final answer');
    messages.commitAssistantMessage(T);
    const msgs = messages.get(T);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toBe('final answer');
    expect(messages.getStreaming(T)).toBe('');
  });

  it('appends an optimistic user message with a local- id', () => {
    const id = messages.appendUserMessage(T, 'hi');
    expect(id.startsWith('local-')).toBe(true);
    expect(messages.get(T)[0].content).toBe('hi');
  });
});

describe('MessageStore failed-meta lifecycle', () => {
  it('marks, clears failed meta and removes a message', () => {
    const id = messages.appendUserMessage(T, 'oops');
    messages.markFailed(id, 'oops');
    expect(messages.getMeta(id).failed).toBe(true);
    messages.clearFailed(id);
    expect(messages.getMeta(id).failed).toBeUndefined();
    messages.removeMessage(T, id);
    expect(messages.get(T)).toHaveLength(0);
  });
});
