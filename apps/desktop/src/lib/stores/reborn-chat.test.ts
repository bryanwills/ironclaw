// Orchestration tests for the IronClaw Reborn v2 chat controller. The pure
// reducers/mappers are covered in `api/reborn.test.ts` and the transport in
// `api/reborn-transport.test.ts`; here we exercise the glue: thread
// auto-creation on first send, the optimistic user bubble, the send-failure
// path, the SSE→terminal-success→timeline-refetch wiring, gate resolution,
// and cancel. A mock client is injected via the controller's constructor
// getter so no connection store or real I/O is needed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IronClawClient } from '$lib/api/ironclaw';
import { perThreadPrompts } from './per-thread-prompts.svelte';
import { RebornChatController } from './reborn-chat.svelte';

async function* gen<T>(items: T[]): AsyncGenerator<T> {
  for (const it of items) yield it;
}

function mockClient(over: Record<string, unknown> = {}): IronClawClient {
  return {
    createThreadV2: vi.fn(async () => ({ thread: { thread_id: 't-new' } })),
    sendMessageV2: vi.fn(async () => ({ run_id: 'r1', thread_id: 't1', status: 'queued' })),
    fetchTimelineV2: vi.fn(async () => ({ records: [] })),
    getRunStateV2: vi.fn(async () => ({ run_id: 'r1', status: 'running' })),
    resolveGateV2: vi.fn(async () => undefined),
    cancelRunV2: vi.fn(async () => undefined),
    streamWebChatV2Events: vi.fn(() => gen([])),
    ...over
  } as unknown as IronClawClient;
}

describe('RebornChatController.send', () => {
  beforeEach(() => {
    perThreadPrompts.clear('t-prompt');
  });

  it('auto-creates a thread on first send, then posts the message', async () => {
    const client = mockClient();
    const c = new RebornChatController(() => client);
    await c.send('hi there');
    expect(client.createThreadV2).toHaveBeenCalledTimes(1);
    expect(c.threadId).toBe('t-new');
    expect(client.sendMessageV2).toHaveBeenCalledWith(
      't-new',
      'hi there',
      [],
      expect.stringContaining('IronClaw format contract.')
    );
    const userMsg = c.state.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('hi there');
    expect(c.state.activeRun?.runId).toBe('r1');
    expect(c.state.isProcessing).toBe(true);
  });

  it('skips thread creation when already bound', async () => {
    const client = mockClient();
    const c = new RebornChatController(() => client);
    c.threadId = 't1';
    await c.send('hello');
    expect(client.createThreadV2).not.toHaveBeenCalled();
    expect(client.sendMessageV2).toHaveBeenCalledWith(
      't1',
      'hello',
      [],
      expect.stringContaining('IronClaw format contract.')
    );
  });

  it('forwards attachments to the v2 transport', async () => {
    const client = mockClient();
    const c = new RebornChatController(() => client);
    c.threadId = 't1';
    await c.send('see attached', undefined, [
      { name: 'notes.md', mime_type: 'text/markdown', data_base64: 'IyBub3Rlcw==' }
    ]);
    expect(client.sendMessageV2).toHaveBeenCalledWith(
      't1',
      'see attached',
      [{ name: 'notes.md', mime_type: 'text/markdown', data_base64: 'IyBub3Rlcw==' }],
      expect.stringContaining('IronClaw format contract.')
    );
  });

  it('forwards redacted per-thread instructions on v2 sends', async () => {
    const client = mockClient();
    const c = new RebornChatController(() => client);
    c.threadId = 't-prompt';
    perThreadPrompts.set('t-prompt', 'Answer tersely with sk-agent-secret12345');

    await c.send('hello');

    expect(client.sendMessageV2).toHaveBeenCalledTimes(1);
    const [, , , instructions] = vi.mocked(client.sendMessageV2).mock.calls[0];
    expect(instructions).toContain('IronClaw format contract.');
    expect(instructions).toContain('Authority: user-configured behavior');
    expect(instructions).toContain('Answer tersely');
    expect(instructions).not.toContain('sk-agent-secret12345');
  });

  it('marks the optimistic bubble errored and stops processing on failure', async () => {
    const client = mockClient({
      sendMessageV2: vi.fn(async () => {
        throw new Error('boom');
      })
    });
    const c = new RebornChatController(() => client);
    c.threadId = 't1';
    await expect(c.send('hi')).rejects.toThrow('boom');
    const m = c.state.messages.find((x) => x.role === 'user');
    expect(m?.status).toBe('error');
    expect(m?.error).toBe('boom');
    expect(c.state.isProcessing).toBe(false);
  });

  it('polls run state after an accepted send and surfaces provider policy denial', async () => {
    vi.useFakeTimers();
    try {
      const client = mockClient({
        fetchTimelineV2: vi.fn(async () => ({
          records: [{ kind: 'user', message_id: 'u1', content: 'hello live assistant check' }]
        })),
        getRunStateV2: vi.fn(async () => ({
          run_id: 'r1',
          status: 'Failed',
          failure: { category: 'policy_denied' }
        }))
      });
      const c = new RebornChatController(() => client);
      c.threadId = 't1';

      await c.send('hello live assistant check');
      await vi.advanceTimersByTimeAsync(300);

      expect(client.getRunStateV2).toHaveBeenCalledWith('t1', 'r1');
      expect(c.state.messages.some((m) => m.content === 'hello live assistant check')).toBe(true);
      expect(
        c.state.messages.some((m) =>
          m.content?.includes('The selected model is not available for this account')
        )
      ).toBe(true);
      expect(c.state.isProcessing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RebornChatController.openStream', () => {
  it('refetches the timeline on terminal run success and surfaces the reply', async () => {
    const client = mockClient({
      streamWebChatV2Events: vi.fn(() =>
        gen([
          {
            type: 'projection_update',
            frame: { state: { items: [{ run_status: { run_id: 'r1', status: 'completed' } }] } }
          }
        ])
      ),
      fetchTimelineV2: vi.fn(async () => ({
        records: [
          { kind: 'user', message_id: 'u1', content: 'hi' },
          { kind: 'assistant', message_id: 'a1', content: 'hello back' }
        ]
      }))
    });
    const c = new RebornChatController(() => client);
    await c.openStream('t1');
    expect(client.fetchTimelineV2).toHaveBeenCalledWith('t1', { limit: 50 });
    expect(c.state.messages.some((m) => m.content === 'hello back')).toBe(true);
    expect(c.state.isProcessing).toBe(false);
  });

  it('keeps a sent user bubble visible when terminal refetch lags the user timeline row', async () => {
    const client = mockClient({
      streamWebChatV2Events: vi.fn(() =>
        gen([
          {
            type: 'projection_update',
            frame: { state: { items: [{ run_status: { run_id: 'r1', status: 'completed' } }] } }
          }
        ])
      ),
      fetchTimelineV2: vi.fn(async () => ({
        records: [{ kind: 'assistant', message_id: 'a1', content: 'hello back' }]
      }))
    });
    const c = new RebornChatController(() => client);
    c.threadId = 't1';

    await c.send('do not vanish');
    await c.openStream('t1');

    expect(c.state.messages.some((m) => m.role === 'user' && m.content === 'do not vanish')).toBe(
      true
    );
    expect(c.state.messages.some((m) => m.role === 'assistant' && m.content === 'hello back')).toBe(
      true
    );
  });

  it('does not duplicate a sent bubble once the timeline confirms it', async () => {
    const client = mockClient({
      streamWebChatV2Events: vi.fn(() =>
        gen([
          {
            type: 'projection_update',
            frame: { state: { items: [{ run_status: { run_id: 'r1', status: 'completed' } }] } }
          }
        ])
      ),
      fetchTimelineV2: vi.fn(async () => ({
        records: [
          { kind: 'user', message_id: 'u1', content: 'show once' },
          { kind: 'assistant', message_id: 'a1', content: 'ack' }
        ]
      }))
    });
    const c = new RebornChatController(() => client);
    c.threadId = 't1';

    await c.send('show once');
    await c.openStream('t1');

    const userCopies = c.state.messages.filter(
      (m) => m.role === 'user' && m.content === 'show once'
    );
    expect(userCopies).toHaveLength(1);
  });

  it('does not refetch while a run is merely running', async () => {
    const client = mockClient({
      streamWebChatV2Events: vi.fn(() =>
        gen([
          {
            type: 'projection_update',
            frame: { state: { items: [{ run_status: { run_id: 'r1', status: 'running' } }] } }
          }
        ])
      )
    });
    const c = new RebornChatController(() => client);
    await c.openStream('t1');
    expect(client.fetchTimelineV2).not.toHaveBeenCalled();
    expect(c.state.isProcessing).toBe(true);
  });
});

describe('RebornChatController.resolveGate / cancel', () => {
  let c: RebornChatController;
  let client: IronClawClient;

  beforeEach(() => {
    client = mockClient();
    c = new RebornChatController(() => client);
    c.threadId = 't1';
  });

  it('resolves the pending gate using its runId + gateRef, then clears it', async () => {
    c.state = {
      ...c.state,
      pendingGate: { kind: 'gate', runId: 'r1', gateRef: 'g1', headline: 'Approve?', body: '' }
    };
    await c.resolveGate('approved', { always: true });
    expect(client.resolveGateV2).toHaveBeenCalledWith('t1', 'r1', 'g1', 'approved', {
      always: true
    });
    expect(c.state.pendingGate).toBeNull();
    expect(c.state.isProcessing).toBe(true);
  });

  it('no-ops resolveGate when there is no pending gate', async () => {
    await c.resolveGate('approved');
    expect(client.resolveGateV2).not.toHaveBeenCalled();
  });

  it('cancels the active run and stops processing', async () => {
    c.state = { ...c.state, activeRun: { runId: 'r1', threadId: 't1', status: 'running' } };
    await c.cancel('user aborted');
    expect(client.cancelRunV2).toHaveBeenCalledWith('t1', 'r1', 'user aborted');
    expect(c.state.isProcessing).toBe(false);
  });
});

describe('RebornChatController.loadTimeline', () => {
  it('projects timeline records into render-ready messages', async () => {
    const client = mockClient({
      fetchTimelineV2: vi.fn(async () => ({
        records: [{ kind: 'user', message_id: 'u1', content: 'hey' }]
      }))
    });
    const c = new RebornChatController(() => client);
    await c.loadTimeline('t1');
    expect(c.state.messages[0]).toMatchObject({ role: 'user', content: 'hey' });
  });

  it('surfaces timeline load failures without pretending the thread is empty', async () => {
    const client = mockClient({
      fetchTimelineV2: vi.fn(async () => {
        throw new Error('timeline down');
      })
    });
    const c = new RebornChatController(() => client);
    await c.loadTimeline('t1');
    expect(c.timelineError).toBe('Could not load messages for this conversation.');
    expect(c.state.messages).toEqual([]);
  });

  it('drops a stale timeline result when the thread switched mid-fetch', async () => {
    let resolveOld: (v: unknown) => void = () => {};
    const oldPromise = new Promise((r) => {
      resolveOld = r;
    });
    const client = mockClient({
      fetchTimelineV2: vi.fn((id: string) =>
        id === 'old'
          ? oldPromise
          : Promise.resolve({ records: [{ kind: 'user', message_id: 'n1', content: 'new msg' }] })
      )
    });
    const c = new RebornChatController(() => client);
    const pOld = c.loadTimeline('old'); // awaits oldPromise; binds threadId='old'
    await c.loadTimeline('new'); // re-binds threadId='new'; projects the new timeline
    expect(c.state.messages.some((m) => m.content === 'new msg')).toBe(true);
    // The old fetch now resolves — but the controller has moved on.
    resolveOld({ records: [{ kind: 'user', message_id: 'o1', content: 'OLD msg' }] });
    await pOld;
    expect(c.threadId).toBe('new');
    expect(c.state.messages.some((m) => m.content === 'OLD msg')).toBe(false);
    expect(c.state.messages.some((m) => m.content === 'new msg')).toBe(true);
  });
});

describe('RebornChatController thread binding', () => {
  it('binds threadId from an explicit send id so cancel/resolveGate target it', async () => {
    const client = mockClient();
    const c = new RebornChatController(() => client);
    await c.send('hi', 'explicit-thread');
    expect(c.threadId).toBe('explicit-thread');
    expect(client.createThreadV2).not.toHaveBeenCalled();
    c.state = {
      ...c.state,
      activeRun: { runId: 'r1', threadId: 'explicit-thread', status: 'running' }
    };
    await c.cancel();
    expect(client.cancelRunV2).toHaveBeenCalledWith('explicit-thread', 'r1', undefined);
  });

  it('reset() clears the bound thread so a later send starts fresh', async () => {
    const client = mockClient();
    const c = new RebornChatController(() => client);
    c.threadId = 'old';
    c.reset();
    expect(c.threadId).toBeNull();
    await c.send('hi'); // no bound thread → must create a new one
    expect(client.createThreadV2).toHaveBeenCalledTimes(1);
    expect(c.threadId).toBe('t-new');
  });

  it('loadTimeline binds the thread it loaded', async () => {
    const client = mockClient();
    const c = new RebornChatController(() => client);
    await c.loadTimeline('t-loaded');
    expect(c.threadId).toBe('t-loaded');
  });
});

describe('RebornChatController.ensureThread', () => {
  it('creates and binds a thread when none is bound', async () => {
    const client = mockClient();
    const c = new RebornChatController(() => client);
    const id = await c.ensureThread();
    expect(client.createThreadV2).toHaveBeenCalledTimes(1);
    expect(id).toBe('t-new');
    expect(c.threadId).toBe('t-new');
  });

  it('returns the explicit/bound thread without creating one', async () => {
    const client = mockClient();
    const c = new RebornChatController(() => client);
    const id = await c.ensureThread('explicit');
    expect(client.createThreadV2).not.toHaveBeenCalled();
    expect(id).toBe('explicit');
    expect(c.threadId).toBe('explicit');
  });
});
