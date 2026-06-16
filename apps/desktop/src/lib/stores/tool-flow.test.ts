// Tests for the per-thread tool-flow ledger. The store is a $state
// singleton, so each case resets `byThread` and the private `seq`
// counter so observations don't leak between tests.
//
// We cover the documented contract:
//   - message_start clears the thread's ledger
//   - tool_call appends a pending row
//   - tool_result flips the matching most-recent pending row to done
//   - tool_result with no matching pending is a no-op (forward-compat)
//   - forThread returns isolated lists per threadId
//   - latency timestamps are recorded on start + completion
//   - irrelevant events (content_delta, message_end) are ignored
//   - clear() drops a single thread without touching peers

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toolFlow } from './tool-flow.svelte';
import type { ChatEvent } from '$lib/api/types';

function resetStore() {
  toolFlow.byThread = {};
  // `seq` is private — cast through unknown to reset it so id
  // generation is predictable across tests.
  (toolFlow as unknown as { seq: number }).seq = 0;
}

describe('tool-flow store', () => {
  beforeEach(() => {
    resetStore();
  });

  it('record(message_start) clears the thread ledger', () => {
    // Seed two pending rows on the thread.
    toolFlow.record('t1', { type: 'tool_call', name: 'search', args: { q: 'foo' } });
    toolFlow.record('t1', { type: 'tool_call', name: 'browse', args: { url: 'a' } });
    expect(toolFlow.forThread('t1')).toHaveLength(2);

    // A `message_start` event resets the ledger.
    toolFlow.record('t1', {
      type: 'message_start',
      thread_id: 't1',
      message_id: 'm1'
    });
    expect(toolFlow.forThread('t1')).toHaveLength(0);
  });

  it('record(tool_call) appends a pending entry with start timestamp', () => {
    const before = Date.now();
    toolFlow.record('t1', {
      type: 'tool_call',
      name: 'search',
      args: { query: 'svelte 5' }
    });
    const after = Date.now();

    const rows = toolFlow.forThread('t1');
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.name).toBe('search');
    expect(row.status).toBe('pending');
    expect(row.args).toEqual({ query: 'svelte 5' });
    expect(row.result).toBeUndefined();
    expect(row.completedAt).toBeUndefined();
    expect(row.startedAt).toBeGreaterThanOrEqual(before);
    expect(row.startedAt).toBeLessThanOrEqual(after);
    // Id format reads `<name>-<startedAt>-<seq>` so the renderer can key
    // collapse state stably across status changes.
    expect(row.id.startsWith('search-')).toBe(true);
  });

  it('record(tool_result) flips the most recent pending entry of that name to done', () => {
    // Mix two pending calls: one we want to flip, plus a same-name pair
    // to exercise the "most recent" selection rule.
    toolFlow.record('t1', { type: 'tool_call', name: 'search', args: { q: 'first' } });
    toolFlow.record('t1', { type: 'tool_call', name: 'browse', args: { url: 'a' } });
    toolFlow.record('t1', { type: 'tool_call', name: 'search', args: { q: 'second' } });

    toolFlow.record('t1', {
      type: 'tool_result',
      name: 'search',
      result: { hits: ['x', 'y'] }
    });

    const rows = toolFlow.forThread('t1');
    expect(rows).toHaveLength(3);
    // The MOST RECENT `search` call (last one in the array) flipped to
    // done. The earlier `search` stays pending.
    const [first, browse, third] = rows;
    expect(first.name).toBe('search');
    expect(first.status).toBe('pending');
    expect(browse.name).toBe('browse');
    expect(browse.status).toBe('pending');
    expect(third.name).toBe('search');
    expect(third.status).toBe('done');
    expect(third.result).toEqual({ hits: ['x', 'y'] });
    expect(third.completedAt).toBeGreaterThanOrEqual(third.startedAt);
  });

  it('record(tool_result) with no matching pending is a no-op (forward-compat)', () => {
    // No pending row at all — must not throw or insert a phantom entry.
    toolFlow.record('t1', { type: 'tool_result', name: 'orphan', result: { ok: true } });
    expect(toolFlow.forThread('t1')).toHaveLength(0);

    // A pending row exists, but the result names a different tool —
    // also a no-op (the result doesn't claim this row).
    toolFlow.record('t1', { type: 'tool_call', name: 'search', args: { q: 'x' } });
    toolFlow.record('t1', { type: 'tool_result', name: 'browse', result: { ok: true } });
    const rows = toolFlow.forThread('t1');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
  });

  it('forThread returns isolated lists per threadId', () => {
    toolFlow.record('alpha', { type: 'tool_call', name: 'a-tool', args: {} });
    toolFlow.record('beta', { type: 'tool_call', name: 'b-tool', args: {} });
    toolFlow.record('beta', { type: 'tool_call', name: 'b-tool-2', args: {} });

    const alphaRows = toolFlow.forThread('alpha');
    const betaRows = toolFlow.forThread('beta');
    expect(alphaRows).toHaveLength(1);
    expect(betaRows).toHaveLength(2);
    expect(alphaRows[0].name).toBe('a-tool');
    expect(betaRows.map((r) => r.name)).toEqual(['b-tool', 'b-tool-2']);

    // Clearing one thread leaves the other untouched.
    toolFlow.clear('alpha');
    expect(toolFlow.forThread('alpha')).toHaveLength(0);
    expect(toolFlow.forThread('beta')).toHaveLength(2);

    // Unknown thread id reads as empty array, not undefined.
    expect(toolFlow.forThread('does-not-exist')).toEqual([]);
  });

  it('ignores chat events unrelated to tool flow (content_delta, message_end, error)', () => {
    toolFlow.record('t1', { type: 'tool_call', name: 'search', args: { q: 'x' } });
    const baseline = toolFlow.forThread('t1');

    const ignored: ChatEvent[] = [
      { type: 'content_delta', delta: 'partial text' },
      { type: 'tool_call_delta', arguments_delta: '"q":' },
      { type: 'message_end', finish_reason: 'stop' },
      { type: 'error', message: 'stream blew up' }
    ];
    for (const ev of ignored) toolFlow.record('t1', ev);

    // The ledger is unchanged — none of those events should mutate the
    // pending row.
    const after = toolFlow.forThread('t1');
    expect(after).toEqual(baseline);
  });

  it('records monotonically increasing completedAt for fast back-to-back results', () => {
    // The latency badge relies on completedAt - startedAt being
    // non-negative. Even when tool_call and tool_result land in the same
    // millisecond, we must keep the invariant.
    const calls = ['a', 'b', 'c'];
    for (const name of calls) {
      toolFlow.record('t1', { type: 'tool_call', name, args: {} });
    }
    for (const name of calls) {
      toolFlow.record('t1', { type: 'tool_result', name, result: { name } });
    }
    const rows = toolFlow.forThread('t1');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe('done');
      expect(row.completedAt).toBeDefined();
      // Per the JSDoc on the latency badge — always non-negative.
      expect(row.completedAt as number).toBeGreaterThanOrEqual(row.startedAt);
    }
  });

  it('does not record when threadId is empty', () => {
    // Defensive: a falsy threadId would otherwise create a `''` keyed
    // bucket that would persist across "real" thread switches.
    toolFlow.record('', { type: 'tool_call', name: 'noop', args: {} });
    expect(Object.keys(toolFlow.byThread)).toHaveLength(0);
    // Clearing empty id is also a no-op.
    toolFlow.clear('');
    expect(Object.keys(toolFlow.byThread)).toHaveLength(0);
  });

  it('clear is idempotent and does not affect other threads', () => {
    toolFlow.record('t1', { type: 'tool_call', name: 'x', args: {} });
    toolFlow.record('t2', { type: 'tool_call', name: 'y', args: {} });
    toolFlow.clear('t1');
    toolFlow.clear('t1'); // second call is a no-op
    expect(toolFlow.forThread('t1')).toHaveLength(0);
    expect(toolFlow.forThread('t2')).toHaveLength(1);
    // Clearing a thread that was never recorded is also a no-op.
    expect(() => toolFlow.clear('never-existed')).not.toThrow();
  });
});

// Re-export to keep vi-unused-import noise out of dev-builds when tests
// are filtered. Vitest's tree-shaking is conservative here.
void vi;
