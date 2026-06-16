// Unit tests for the pure IronClaw Reborn WebChat v2 core (api/reborn.ts):
// idempotency key, timeline→message + tool-card mappers, the projection-item
// reducer, the event-envelope reducer, and the response normalizers. All pure
// — no I/O — so these lock in the migration's hardest logic deterministically.

import { describe, expect, it, vi } from 'vitest';
import {
  clientActionId,
  toolStatusFromActivityStatus,
  isTerminalToolStatus,
  toolCardFromPreview,
  toolCardFromActivity,
  messagesFromTimeline,
  recordsFromTimeline,
  threadsFromListResponse,
  initialChatState,
  applyProjectionItems,
  reduceEvent,
  type ThreadMessageRecord,
  type ProjectionItem
} from './reborn';

describe('clientActionId', () => {
  it('returns a non-empty token and is reasonably unique', () => {
    const a = clientActionId();
    const b = clientActionId();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it('falls back to a unique, non-zero token when Web Crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    try {
      const a = clientActionId();
      const b = clientActionId();
      expect(a.length).toBeGreaterThan(0);
      expect(a).not.toMatch(/^0+$/); // not the old all-zero constant
      expect(a).not.toBe(b); // still unique per call
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('tool status helpers', () => {
  it('maps activity status to card status', () => {
    expect(toolStatusFromActivityStatus('completed')).toBe('success');
    expect(toolStatusFromActivityStatus('failed')).toBe('error');
    expect(toolStatusFromActivityStatus('killed')).toBe('error');
    expect(toolStatusFromActivityStatus('running')).toBe('running');
    expect(toolStatusFromActivityStatus('started')).toBe('running');
    expect(toolStatusFromActivityStatus(undefined)).toBe('running');
  });

  it('recognizes terminal tool statuses', () => {
    expect(isTerminalToolStatus('success')).toBe(true);
    expect(isTerminalToolStatus('error')).toBe(true);
    expect(isTerminalToolStatus('running')).toBe(false);
  });
});

describe('toolCardFromPreview', () => {
  it('maps a successful preview, surfacing the output preview', () => {
    const card = toolCardFromPreview({
      invocation_id: 'inv1',
      capability_id: 'builtin.http',
      title: 'HTTP fetch',
      subtitle: 'GET example.com',
      status: 'completed',
      input_summary: '{"url":"…"}',
      output_preview: '<html>',
      result_ref: 'ref://1',
      truncated: true,
      output_bytes: 1234,
      output_kind: 'text'
    });
    expect(card).toMatchObject({
      invocationId: 'inv1',
      callId: 'inv1',
      toolName: 'HTTP fetch',
      toolStatus: 'success',
      toolDetail: 'GET example.com',
      toolParameters: '{"url":"…"}',
      toolResultPreview: '<html>',
      toolError: null,
      resultRef: 'ref://1',
      truncated: true,
      outputBytes: 1234,
      outputKind: 'text'
    });
  });

  it('routes failure text to toolError and suppresses the result preview', () => {
    const card = toolCardFromPreview({
      invocation_id: 'inv2',
      capability_id: 'builtin.shell',
      status: 'failed',
      output_summary: 'exit code 1'
    });
    expect(card.toolStatus).toBe('error');
    expect(card.toolResultPreview).toBeNull();
    expect(card.toolError).toBe('exit code 1');
    expect(card.toolName).toBe('builtin.shell'); // falls back to capability_id
  });
});

describe('toolCardFromActivity', () => {
  it('produces a sparse running card from a lifecycle frame', () => {
    const card = toolCardFromActivity({
      invocation_id: 'inv3',
      capability_id: 'builtin.time',
      status: 'running'
    });
    expect(card).toMatchObject({
      invocationId: 'inv3',
      toolName: 'builtin.time',
      toolStatus: 'running',
      toolParameters: null,
      toolResultPreview: null
    });
  });
});

function rec(over: Partial<ThreadMessageRecord> = {}): ThreadMessageRecord {
  return { kind: 'assistant', message_id: 'm1', content: 'hi', sequence: 1, ...over };
}

describe('messagesFromTimeline', () => {
  it('maps user/assistant/system records to bubbles with mapped roles', () => {
    const out = messagesFromTimeline([
      rec({ kind: 'user', message_id: 'u1', content: 'hello' }),
      rec({ kind: 'assistant_message', message_id: 'a1', content: 'hi there' }),
      rec({ kind: 'system', message_id: 's1', content: 'note' })
    ]);
    expect(out.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi there'],
      ['system', 'note']
    ]);
    expect(out[0].id).toBe('msg-u1');
  });

  it('skips tool_result_reference and renders capability_display_preview as a tool card', () => {
    const preview = JSON.stringify({
      invocation_id: 'inv9',
      title: 'Reader',
      status: 'completed',
      output_preview: 'ok'
    });
    const out = messagesFromTimeline([
      rec({ kind: 'tool_result_reference', message_id: 'r1', content: 'ignored' }),
      rec({ kind: 'capability_display_preview', message_id: 'c1', content: preview })
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'tool-inv9',
      role: 'tool_activity',
      toolName: 'Reader',
      toolStatus: 'success'
    });
  });

  it('falls back to actor_id heuristic for unknown kinds and dedupes by id', () => {
    const out = messagesFromTimeline([
      rec({ kind: 'weird', message_id: 'm1', actor_id: 'user-1', content: 'a' }),
      rec({ kind: 'weird', message_id: 'm1', actor_id: 'user-1', content: 'dupe' })
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });

  it('appends still-pending optimistic messages not already seen', () => {
    const out = messagesFromTimeline(
      [rec({ message_id: 'a1' })],
      [{ id: 'pending-1', role: 'user', content: 'queued' }]
    );
    expect(out.at(-1)).toMatchObject({ id: 'pending-1', content: 'queued' });
  });
});

describe('response normalizers', () => {
  it('threadsFromListResponse tolerates threads/items/legacy ids/empty', () => {
    expect(threadsFromListResponse({ threads: [{ thread_id: 't1' }] })).toHaveLength(1);
    expect(threadsFromListResponse({ items: [{ thread_id: 't2' }] })).toHaveLength(1);
    expect(
      threadsFromListResponse({ threads: [{ id: 'legacy-t3', title: 'Legacy', turn_count: 19 }] })
    ).toEqual([
      expect.objectContaining({
        thread_id: 'legacy-t3',
        message_count: 19,
        title: 'Legacy'
      })
    ]);
    expect(threadsFromListResponse([{ id: 'raw-t4' }])).toEqual([
      expect.objectContaining({ thread_id: 'raw-t4' })
    ]);
    expect(threadsFromListResponse({})).toEqual([]);
    expect(threadsFromListResponse(null)).toEqual([]);
  });

  it('recordsFromTimeline tolerates records/messages/items/raw array/empty', () => {
    expect(recordsFromTimeline({ records: [rec()] })).toHaveLength(1);
    expect(recordsFromTimeline({ messages: [rec()] })).toHaveLength(1);
    expect(recordsFromTimeline({ items: [rec({ message_id: 'item' })] })).toHaveLength(1);
    expect(recordsFromTimeline({ timeline: [rec({ message_id: 'tl' })] })).toHaveLength(1);
    expect(recordsFromTimeline([rec({ message_id: 'raw' })])).toHaveLength(1);
    expect(recordsFromTimeline(null)).toEqual([]);
  });
});

describe('applyProjectionItems', () => {
  it('a running run_status marks processing and records the active run', () => {
    const next = applyProjectionItems(
      initialChatState(),
      [{ run_status: { run_id: 'r1', status: 'running' } }],
      't1'
    );
    expect(next.isProcessing).toBe(true);
    expect(next.activeRun).toEqual({ runId: 'r1', threadId: 't1', status: 'running' });
    expect(next.latestRunId).toBe('r1');
    expect(next.refetchTimeline).toBe(false);
  });

  it('a terminal success raises refetchTimeline once and dedupes by run id', () => {
    const items: ProjectionItem[] = [{ run_status: { run_id: 'r1', status: 'completed' } }];
    const first = applyProjectionItems(initialChatState(), items, 't1');
    expect(first.isProcessing).toBe(false);
    expect(first.refetchTimeline).toBe(true);
    expect(first.completedRuns).toEqual(['r1']);
    // Replays of the same terminal projection must not re-trigger a refetch.
    const second = applyProjectionItems(first, items, 't1');
    expect(second.refetchTimeline).toBe(false);
  });

  it('a failed run_status appends a single error bubble (deduped on replay)', () => {
    const items: ProjectionItem[] = [{ run_status: { run_id: 'r2', status: 'failed' } }];
    const first = applyProjectionItems(initialChatState(), items, 't1');
    const errs = first.messages.filter((m) => m.role === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].id).toBe('err-r2');
    const second = applyProjectionItems(first, items, 't1');
    expect(second.messages.filter((m) => m.role === 'error')).toHaveLength(1);
  });

  it('a text item upserts an assistant bubble keyed by item id', () => {
    const afterFirst = applyProjectionItems(
      initialChatState(),
      [{ text: { id: 'x', body: 'partial' } }],
      't1'
    );
    expect(afterFirst.messages).toEqual([
      expect.objectContaining({ id: 'text-x', role: 'assistant', content: 'partial' })
    ]);
    const afterSecond = applyProjectionItems(
      afterFirst,
      [{ text: { id: 'x', body: 'final' } }],
      't1'
    );
    expect(afterSecond.messages).toHaveLength(1);
    expect(afterSecond.messages[0].content).toBe('final');
  });

  it('correlates a gate to the active run, skipping it when no run is active', () => {
    const noRun = applyProjectionItems(
      initialChatState(),
      [{ gate: { gate_ref: 'g1', headline: 'Approve?' } }],
      't1'
    );
    expect(noRun.pendingGate).toBeNull();
    const withRun = applyProjectionItems(
      initialChatState(),
      [
        { run_status: { run_id: 'r9', status: 'running' } },
        { gate: { gate_ref: 'g1', headline: 'Approve?' } }
      ],
      't1'
    );
    expect(withRun.pendingGate).toEqual({
      kind: 'gate',
      runId: 'r9',
      gateRef: 'g1',
      headline: 'Approve?',
      body: ''
    });
  });

  it('renders a skill_activation as a system bubble', () => {
    const next = applyProjectionItems(
      initialChatState(),
      [{ skill_activation: { id: 'sa1', skill_names: ['research'], feedback: ['loaded'] } }],
      't1'
    );
    const sys = next.messages.find((m) => m.id === 'skill-sa1');
    expect(sys?.role).toBe('system');
    expect(sys?.content).toContain('Skill activated: research');
    expect(sys?.content).toContain('loaded');
  });
});

describe('reduceEvent', () => {
  it('accepted sets the active run and processing', () => {
    const next = reduceEvent(
      initialChatState(),
      { type: 'accepted', frame: { ack: { run_id: 'r1', status: 'queued' } } },
      't1'
    );
    expect(next.activeRun).toEqual({ runId: 'r1', threadId: 't1', status: 'queued' });
    expect(next.isProcessing).toBe(true);
  });

  it('final_reply appends an assistant message and stops processing', () => {
    const next = reduceEvent(
      initialChatState(),
      {
        type: 'final_reply',
        frame: { reply: { turn_run_id: 'r1', text: 'done', generated_at: '2026-05-29T12:00:00Z' } }
      },
      't1'
    );
    expect(next.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'done',
      turnRunId: 'r1'
    });
    expect(next.isProcessing).toBe(false);
  });

  it('final_reply dedups a replayed frame with the same turn_run_id (upsert, not append)', () => {
    let state = reduceEvent(
      initialChatState(),
      { type: 'final_reply', frame: { reply: { turn_run_id: 'r1', text: 'answer' } } },
      't1'
    );
    // Reconnect / SSE replay re-delivers the same turn_run_id.
    state = reduceEvent(
      state,
      { type: 'final_reply', frame: { reply: { turn_run_id: 'r1', text: 'answer (replayed)' } } },
      't1'
    );
    const replies = state.messages.filter((m) => m.role === 'assistant' && m.turnRunId === 'r1');
    expect(replies).toHaveLength(1); // not duplicated
    expect(replies[0].content).toBe('answer (replayed)'); // upsert replaced in place
  });

  it('final_reply keeps distinct turn_run_ids as separate messages', () => {
    let state = reduceEvent(
      initialChatState(),
      { type: 'final_reply', frame: { reply: { turn_run_id: 'r1', text: 'first' } } },
      't1'
    );
    state = reduceEvent(
      state,
      { type: 'final_reply', frame: { reply: { turn_run_id: 'r2', text: 'second' } } },
      't1'
    );
    const replies = state.messages.filter((m) => m.role === 'assistant');
    expect(replies.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('delegates projection_update to applyProjectionItems', () => {
    const next = reduceEvent(
      initialChatState(),
      {
        type: 'projection_update',
        frame: { state: { items: [{ run_status: { run_id: 'r1', status: 'completed' } }] } }
      },
      't1'
    );
    expect(next.refetchTimeline).toBe(true);
  });

  it('ignores keep_alive and malformed envelopes', () => {
    const base = initialChatState();
    expect(reduceEvent(base, { type: 'keep_alive', frame: {} }, 't1').messages).toEqual([]);
    expect(reduceEvent(base, {}, 't1')).toMatchObject({ messages: [] });
  });

  it('cancelled clears the gate, run, and processing', () => {
    const prev = {
      ...initialChatState(),
      isProcessing: true,
      activeRun: { runId: 'r1', threadId: 't1', status: 'running' }
    };
    const next = reduceEvent(prev, { type: 'cancelled', frame: {} }, 't1');
    expect(next.isProcessing).toBe(false);
    expect(next.activeRun).toBeNull();
    expect(next.pendingGate).toBeNull();
  });

  it('typed gate event sets pendingGate + awaiting_gate run, stops processing', () => {
    const next = reduceEvent(
      { ...initialChatState(), isProcessing: true },
      {
        type: 'gate',
        frame: { prompt: { turn_run_id: 'r1', gate_ref: 'g1', headline: 'Approve?', body: 'why' } }
      },
      't1'
    );
    expect(next.pendingGate).toEqual({
      kind: 'gate',
      runId: 'r1',
      gateRef: 'g1',
      headline: 'Approve?',
      body: 'why'
    });
    expect(next.activeRun).toEqual({ runId: 'r1', threadId: 't1', status: 'awaiting_gate' });
    expect(next.isProcessing).toBe(false);
  });

  it('auth_required maps auth_request_ref → gateRef and carries provider/account', () => {
    const next = reduceEvent(
      initialChatState(),
      {
        type: 'auth_required',
        frame: { prompt: { turn_run_id: 'r1', auth_request_ref: 'a1', account_label: 'me@host' } }
      },
      't1'
    );
    expect(next.pendingGate).toMatchObject({
      kind: 'auth_required',
      runId: 'r1',
      gateRef: 'a1',
      provider: 'github', // default when prompt.provider absent
      accountLabel: 'me@host'
    });
  });

  it('correlates a typed gate without turn_run_id to the latest run, else skips', () => {
    const correlated = reduceEvent(
      { ...initialChatState(), latestRunId: 'r5' },
      { type: 'gate', frame: { prompt: { gate_ref: 'g9' } } },
      't1'
    );
    expect(correlated.pendingGate).toMatchObject({ runId: 'r5', gateRef: 'g9' });
    // No run known anywhere → unusable gate is skipped.
    const skipped = reduceEvent(
      initialChatState(),
      { type: 'gate', frame: { prompt: { gate_ref: 'g9' } } },
      't1'
    );
    expect(skipped.pendingGate).toBeNull();
  });
});
