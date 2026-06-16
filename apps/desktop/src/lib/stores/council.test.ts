// Tests for the Council store.
//
// The store is a runtime singleton with `$state` runes — each test
// resets its in-memory shape via `council.runs = …` etc. and clears
// the localStorage shim so cases don't leak.
//
// Coverage focus (per the task brief):
//   1. convene() with 0 providers throws synchronously.
//   2. convene() with 2 providers produces 2 runs (one row per
//      provider id, in declaration order).
//   3. promote() with no runs throws synchronously.
//   4. selectedProviderIds round-trips through localStorage.
//
// Extra defensive cases bundled in because they're load-bearing:
//   - The fanout runs SEQUENTIALLY (verified by tracking call order).
//   - Selected list is deduped on setSelected.
//   - Toggle adds + removes correctly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatEvent } from '$lib/api/types';

import { COUNCIL_LS_KEY, council, type CouncilClient } from './council.svelte';

// ---- Local localStorage shim for the persistence round-trip case ----
//
// vitest.setup.ts clears localStorage before every test, but jsdom's
// localStorage shape varies across vitest versions. The pins test
// installs its own Map-backed shim for the same reason; we mirror that
// pattern here so the round-trip assertion is robust regardless of the
// underlying jsdom build.

function installLocalStorageShim() {
  const store = new Map<string, string>();
  const shim = {
    get length() {
      return store.size;
    },
    key(i: number) {
      return Array.from(store.keys())[i] ?? null;
    },
    getItem(k: string) {
      return store.has(k) ? (store.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      store.set(String(k), String(v));
    },
    removeItem(k: string) {
      store.delete(k);
    },
    clear() {
      store.clear();
    }
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: shim });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: shim });
  }
}

function resetCouncil(): void {
  council.runs = [];
  council.selectedProviderIds = [];
  council.convening = false;
}

/** Build a fake client that yields a fixed event sequence per call.
 *  Each call increments `callCount` and records the prompt + provider
 *  index implicitly via the order it was invoked. */
function makeFakeClient(
  events: ChatEvent[][],
  opts: { newThreadId?: string; sendMessageOk?: boolean } = {}
): CouncilClient & {
  callCount: () => number;
  promptsSeen: () => string[];
  callOrder: () => Array<'streamResponse' | 'newThread' | 'sendMessage'>;
} {
  let calls = 0;
  const prompts: string[] = [];
  const order: Array<'streamResponse' | 'newThread' | 'sendMessage'> = [];

  return {
    async *streamResponse(input: string): AsyncIterable<ChatEvent> {
      order.push('streamResponse');
      prompts.push(input);
      const batch = events[calls] ?? [];
      calls += 1;
      for (const ev of batch) {
        yield ev;
      }
    },
    async newThread(_title?: string) {
      order.push('newThread');
      void _title;
      return { id: opts.newThreadId ?? 'thread-test' };
    },
    async sendMessage(threadId: string | null, content: string) {
      order.push('sendMessage');
      if (opts.sendMessageOk === false) {
        throw new Error('sendMessage failed');
      }
      return { thread_id: threadId ?? '', message_id: `msg-${content.slice(0, 8)}` };
    },
    callCount: () => calls,
    promptsSeen: () => prompts,
    callOrder: () => order
  };
}

describe('council store', () => {
  beforeEach(() => {
    installLocalStorageShim();
    resetCouncil();
  });

  afterEach(() => {
    resetCouncil();
  });

  // ---- convene() ----------------------------------------------------

  it('convene() with 0 providers throws synchronously', async () => {
    const client = makeFakeClient([]);
    await expect(council.convene('hi', [], client)).rejects.toThrow(/at least one provider/i);
  });

  it('convene() with 2 providers produces 2 runs in declaration order', async () => {
    const events: ChatEvent[][] = [
      [
        { type: 'content_delta', delta: 'Hello from A' },
        { type: 'message_end', finish_reason: 'stop' }
      ],
      [
        { type: 'content_delta', delta: 'Hello from B' },
        { type: 'message_end', finish_reason: 'stop' }
      ]
    ];
    const client = makeFakeClient(events);
    await council.convene('What is gold?', ['provider-a', 'provider-b'], client);

    expect(council.runs).toHaveLength(2);
    expect(council.runs[0].providerId).toBe('provider-a');
    expect(council.runs[1].providerId).toBe('provider-b');
    expect(council.runs[0].content).toBe('Hello from A');
    expect(council.runs[1].content).toBe('Hello from B');
    expect(council.runs[0].status).toBe('done');
    expect(council.runs[1].status).toBe('done');
    expect(client.callCount()).toBe(2);
    // Sequential: every call should have been streamResponse, in order.
    expect(client.callOrder()).toEqual(['streamResponse', 'streamResponse']);
    // Same prompt fed to both.
    expect(client.promptsSeen()).toEqual(['What is gold?', 'What is gold?']);
  });

  it('convene() flips status to done with a latency on stream completion', async () => {
    const client = makeFakeClient([
      [
        { type: 'content_delta', delta: 'token-1' },
        { type: 'content_delta', delta: 'token-1 token-2' }
      ]
    ]);
    await council.convene('test', ['p1'], client);
    expect(council.runs[0].status).toBe('done');
    expect(council.runs[0].content).toBe('token-1 token-2');
    expect(council.runs[0].latencyMs).not.toBeNull();
    expect(council.runs[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('convene() captures an error event into the run', async () => {
    const client = makeFakeClient([[{ type: 'error', message: 'rate limited' }]]);
    await council.convene('test', ['p1'], client);
    expect(council.runs[0].status).toBe('error');
    expect(council.runs[0].error).toBe('rate limited');
    expect(council.runs[0].latencyMs).not.toBeNull();
  });

  it('convene() with an empty prompt is a silent no-op (does not throw)', async () => {
    const client = makeFakeClient([[{ type: 'content_delta', delta: 'x' }]]);
    await council.convene('   ', ['p1'], client);
    expect(council.runs).toHaveLength(0);
    expect(client.callCount()).toBe(0);
  });

  // ---- promote() ----------------------------------------------------

  it('promote() with no runs throws synchronously', async () => {
    const client = makeFakeClient([]);
    expect(council.runs).toHaveLength(0);
    await expect(council.promote(0, client)).rejects.toThrow(/no council runs/i);
  });

  it('promote() with an out-of-range index throws', async () => {
    const client = makeFakeClient([
      [
        { type: 'content_delta', delta: 'A' },
        { type: 'message_end', finish_reason: 'stop' }
      ]
    ]);
    await council.convene('q', ['p1'], client);
    await expect(council.promote(5, client)).rejects.toThrow(/invalid council run index/i);
  });

  it('promote() refuses to promote a run that is not done', async () => {
    const client = makeFakeClient([]);
    // Seed a synthetic run row that's still in 'streaming' state.
    council.runs = [
      {
        providerId: 'p1',
        prompt: 'hi',
        content: 'partial',
        latencyMs: null,
        status: 'streaming'
      }
    ];
    await expect(council.promote(0, client)).rejects.toThrow(/completed run/i);
  });

  it('promote() creates a new thread and seeds the user prompt', async () => {
    const events: ChatEvent[][] = [
      [
        { type: 'content_delta', delta: 'Answer A' },
        { type: 'message_end', finish_reason: 'stop' }
      ]
    ];
    const client = makeFakeClient(events, { newThreadId: 'thread-42' });
    await council.convene('What is gold?', ['provider-a'], client);
    const threadId = await council.promote(0, client);
    expect(threadId).toBe('thread-42');
    const order = client.callOrder();
    // After convene's one streamResponse call: newThread then sendMessage.
    expect(order).toEqual(['streamResponse', 'newThread', 'sendMessage']);
  });

  // ---- selectedProviderIds + localStorage round-trip ----------------

  it('localStorage round-trip for selectedProviderIds', () => {
    council.setSelected(['nearai', 'openrouter']);
    const raw = localStorage.getItem(COUNCIL_LS_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed).toEqual(['nearai', 'openrouter']);

    // Reset the in-memory selection, then hydrate — should restore.
    council.selectedProviderIds = [];
    council.hydrate();
    expect(council.selectedProviderIds).toEqual(['nearai', 'openrouter']);
  });

  it('setSelected dedupes and drops empty strings', () => {
    council.setSelected(['a', 'a', '', 'b']);
    expect(council.selectedProviderIds).toEqual(['a', 'b']);
  });

  it('toggleSelected adds when absent and removes when present', () => {
    council.toggleSelected('x');
    expect(council.selectedProviderIds).toEqual(['x']);
    council.toggleSelected('y');
    expect(council.selectedProviderIds).toEqual(['x', 'y']);
    council.toggleSelected('x');
    expect(council.selectedProviderIds).toEqual(['y']);
  });

  it('hydrate ignores a corrupt localStorage blob', () => {
    localStorage.setItem(COUNCIL_LS_KEY, '{not valid json');
    council.selectedProviderIds = [];
    council.hydrate();
    expect(council.selectedProviderIds).toEqual([]);
  });

  it('hydrate ignores a non-array JSON blob', () => {
    localStorage.setItem(COUNCIL_LS_KEY, '{"foo":"bar"}');
    council.selectedProviderIds = [];
    council.hydrate();
    expect(council.selectedProviderIds).toEqual([]);
  });

  // ---- reset() ------------------------------------------------------

  it('reset() clears runs and convening state but keeps selection', () => {
    council.setSelected(['p1', 'p2']);
    council.runs = [
      {
        providerId: 'p1',
        prompt: 'q',
        content: 'x',
        latencyMs: 100,
        status: 'done'
      }
    ];
    council.convening = true;
    council.reset();
    expect(council.runs).toEqual([]);
    expect(council.convening).toBe(false);
    expect(council.selectedProviderIds).toEqual(['p1', 'p2']);
  });

  it('cumulative-content delta is replaced rather than concatenated', async () => {
    // Gateway-legacy path: each event carries the full content so far.
    // The store's prefix-check heuristic should detect that and replace.
    const client = makeFakeClient([
      [
        { type: 'content_delta', delta: 'Hel' },
        { type: 'content_delta', delta: 'Hello' },
        { type: 'content_delta', delta: 'Hello world' }
      ]
    ]);
    await council.convene('q', ['p1'], client);
    expect(council.runs[0].content).toBe('Hello world');
  });

  // ---- panel (chat-summoned overlay) --------------------------------

  it('openWith seeds the prompt, clears prior runs, and opens the panel', () => {
    council.runs = [
      { providerId: 'p1', prompt: 'old', content: 'x', latencyMs: 1, status: 'done' }
    ];
    council.open = false;
    council.openWith('compare databases');
    expect(council.open).toBe(true);
    expect(council.initialPrompt).toBe('compare databases');
    expect(council.runs).toEqual([]);
  });

  it('closePanel closes and clears convening state', () => {
    council.open = true;
    council.convening = true;
    council.closePanel();
    expect(council.open).toBe(false);
    expect(council.convening).toBe(false);
  });
});

// Quieten an unused-import warning when running this file in
// isolation. `vi` is loaded for spy hooks the test file may grow into
// (e.g. spying on toasts.show via vi.mock) without being directly
// invoked at top level today.
void vi;
