import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubAgentUnsupportedError } from '$lib/api/types';

// Mock the connection store so we can inject a fake client.
const fakeClient = {
  dispatchSubAgent: vi.fn(),
  getSubAgentTask: vi.fn(),
  streamSubAgentEvents: vi.fn(),
  cancelSubAgentTask: vi.fn(async () => undefined)
};

vi.mock('./connection.svelte', () => ({
  connection: {
    get client() {
      return fakeClient;
    }
  }
}));

import { subAgents } from './sub-agents.svelte';

function makeTask(overrides = {}) {
  return {
    id: 't1',
    status: 'queued' as const,
    prompt: 'do the thing',
    created_at: new Date().toISOString(),
    parent_thread_id: 'thr-1',
    ...overrides
  };
}

// An async iterable that yields the given events then ends.
function eventStream(events: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  subAgents.unsupported = false;
});

afterEach(() => {
  // Drop any recorded tasks so forThread() is clean between cases.
  for (const t of subAgents.all()) {
    subAgents.cancel(t.id);
  }
});

describe('subAgents store', () => {
  it('dispatch records the task + returns its id', async () => {
    fakeClient.dispatchSubAgent.mockResolvedValueOnce(makeTask());
    fakeClient.streamSubAgentEvents.mockReturnValueOnce(eventStream([]));
    const id = await subAgents.dispatch({ prompt: 'do the thing', parentThreadId: 'thr-1' });
    expect(id).toBe('t1');
    expect(subAgents.forThread('thr-1').map((t) => t.id)).toContain('t1');
  });

  it('dispatch sets unsupported + returns null on SubAgentUnsupportedError', async () => {
    fakeClient.dispatchSubAgent.mockRejectedValueOnce(new SubAgentUnsupportedError());
    const id = await subAgents.dispatch({ prompt: 'x', parentThreadId: 'thr-2' });
    expect(id).toBeNull();
    expect(subAgents.unsupported).toBe(true);
  });

  it('progress events accumulate into progressText', async () => {
    fakeClient.dispatchSubAgent.mockResolvedValueOnce(
      makeTask({ id: 't3', parent_thread_id: 'thr-3' })
    );
    fakeClient.streamSubAgentEvents.mockReturnValueOnce(
      eventStream([
        { type: 'started', taskId: 't3' },
        { type: 'progress', taskId: 't3', text: 'hello ' },
        { type: 'progress', taskId: 't3', text: 'world' }
      ])
    );
    await subAgents.dispatch({ prompt: 'x', parentThreadId: 'thr-3' });
    // Let the stream microtasks drain.
    await new Promise((r) => setTimeout(r, 10));
    expect(subAgents.progressFor('t3')).toBe('hello world');
  });

  it('completed event flips status to succeeded with result', async () => {
    fakeClient.dispatchSubAgent.mockResolvedValueOnce(
      makeTask({ id: 't4', parent_thread_id: 'thr-4' })
    );
    fakeClient.streamSubAgentEvents.mockReturnValueOnce(
      eventStream([{ type: 'completed', taskId: 't4', result: 'the answer' }])
    );
    await subAgents.dispatch({ prompt: 'x', parentThreadId: 'thr-4' });
    await new Promise((r) => setTimeout(r, 10));
    const task = subAgents.forThread('thr-4').find((t) => t.id === 't4');
    expect(task?.status).toBe('succeeded');
    expect(task?.result).toBe('the answer');
  });

  it('cancel marks the task cancelled + calls the client', async () => {
    fakeClient.dispatchSubAgent.mockResolvedValueOnce(
      makeTask({ id: 't5', parent_thread_id: 'thr-5' })
    );
    fakeClient.streamSubAgentEvents.mockReturnValueOnce(eventStream([]));
    await subAgents.dispatch({ prompt: 'x', parentThreadId: 'thr-5' });
    subAgents.cancel('t5');
    expect(fakeClient.cancelSubAgentTask).toHaveBeenCalledWith('t5');
    const task = subAgents.forThread('thr-5').find((t) => t.id === 't5');
    expect(task?.status).toBe('cancelled');
  });

  it('forThread filters by parent thread', async () => {
    fakeClient.dispatchSubAgent.mockResolvedValueOnce(makeTask({ id: 'a', parent_thread_id: 'X' }));
    fakeClient.streamSubAgentEvents.mockReturnValue(eventStream([]));
    await subAgents.dispatch({ prompt: 'x', parentThreadId: 'X' });
    fakeClient.dispatchSubAgent.mockResolvedValueOnce(makeTask({ id: 'b', parent_thread_id: 'Y' }));
    await subAgents.dispatch({ prompt: 'y', parentThreadId: 'Y' });
    expect(subAgents.forThread('X').map((t) => t.id)).toEqual(['a']);
    expect(subAgents.forThread('Y').map((t) => t.id)).toEqual(['b']);
  });
});
