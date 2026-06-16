import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thread } from '$lib/api/types';

const mocks = vi.hoisted(() => {
  const threads = {
    threads: [] as Thread[],
    currentId: null as string | null,
    mergeUpdates: vi.fn((updated: Thread[]) => {
      const byId = new Map(updated.map((t) => [t.id, t]));
      const existing = new Set(threads.threads.map((t) => t.id));
      threads.threads = [
        ...threads.threads.map((t) => byId.get(t.id) ?? t),
        ...updated.filter((t) => !existing.has(t.id))
      ];
    }),
    removeMany: vi.fn((ids: string[]) => {
      const deleted = new Set(ids);
      threads.threads = threads.threads.filter((t) => !deleted.has(t.id));
    })
  };

  return {
    connection: { client: null as null | Record<string, unknown> },
    threads
  };
});

vi.mock('./connection.svelte', () => ({ connection: mocks.connection }));
vi.mock('./threads.svelte', () => ({ threads: mocks.threads }));

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];

  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;

  constructor(readonly name: string) {
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    for (const channel of MockBroadcastChannel.instances) {
      if (channel === this || channel.closed || channel.name !== this.name) continue;
      channel.onmessage?.({ data } as MessageEvent);
    }
  }

  close(): void {
    this.closed = true;
  }
}

const openStores: Array<{ stop(): void }> = [];

function installBroadcastChannelMock(): void {
  MockBroadcastChannel.instances = [];
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    configurable: true,
    value: MockBroadcastChannel
  });
  Object.defineProperty(window, 'BroadcastChannel', {
    configurable: true,
    value: MockBroadcastChannel
  });
}

async function importFreshStore(): Promise<typeof import('./thread-sync.svelte')> {
  vi.resetModules();
  return import('./thread-sync.svelte');
}

function thread(id: string, updatedAt = '2026-05-28T00:00:00Z'): Thread {
  return {
    id,
    title: id,
    created_at: updatedAt,
    updated_at: updatedAt,
    message_count: 1
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('threadSync store', () => {
  beforeEach(() => {
    installBroadcastChannelMock();
    mocks.connection.client = null;
    mocks.threads.threads = [];
    mocks.threads.currentId = null;
    mocks.threads.mergeUpdates.mockClear();
    mocks.threads.removeMany.mockClear();
  });

  afterEach(() => {
    for (const store of openStores.splice(0)) store.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('start() registers a BroadcastChannel listener', async () => {
    const { ThreadSyncStore } = await importFreshStore();
    const store = new ThreadSyncStore();
    openStores.push(store);

    store.start();

    expect(MockBroadcastChannel.instances).toHaveLength(1);
    expect(MockBroadcastChannel.instances[0].name).toBe('ironclaw-thread-sync');
    expect(MockBroadcastChannel.instances[0].onmessage).toEqual(expect.any(Function));
  });

  it('stop() cancels the in-flight fetch', async () => {
    const { ThreadSyncStore } = await importFreshStore();
    let aborted = false;
    const pollThreadChanges = vi.fn(
      (_since: number, signal?: AbortSignal) =>
        new Promise(() => {
          signal?.addEventListener('abort', () => {
            aborted = signal.aborted;
          });
        })
    );
    mocks.connection.client = { pollThreadChanges };
    const store = new ThreadSyncStore();
    openStores.push(store);

    store.start();
    await vi.waitFor(() => expect(pollThreadChanges).toHaveBeenCalledTimes(1));
    store.stop();

    expect(aborted).toBe(true);
  });

  it('terminates the loop on 401', async () => {
    const { ThreadSyncStore } = await importFreshStore();
    const pollThreadChanges = vi.fn().mockRejectedValue(new Error('pollThreadChanges 401'));
    mocks.connection.client = { pollThreadChanges };
    const store = new ThreadSyncStore();
    openStores.push(store);

    store.start();

    await vi.waitFor(() => expect((store as unknown as { running: boolean }).running).toBe(false));
    expect(pollThreadChanges).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially on 5xx errors', async () => {
    vi.useFakeTimers();
    const { ThreadSyncStore } = await importFreshStore();
    const pollThreadChanges = vi
      .fn()
      .mockRejectedValueOnce(new Error('pollThreadChanges 500'))
      .mockReturnValue(new Promise(() => {}));
    mocks.connection.client = { pollThreadChanges };
    const store = new ThreadSyncStore();
    openStores.push(store);

    store.start({ maxBackoffMs: 60_000 });
    await flush();
    expect(pollThreadChanges).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(pollThreadChanges).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(pollThreadChanges).toHaveBeenCalledTimes(2);
  });

  it("fans one window's dispatch to another window", async () => {
    const { ThreadSyncStore } = await importFreshStore();
    const a = new ThreadSyncStore();
    const b = new ThreadSyncStore();
    openStores.push(a, b);
    const receivedByB = vi.fn();

    a.start();
    b.start();
    b.subscribe(receivedByB);
    mocks.threads.mergeUpdates.mockClear();

    (a as unknown as { dispatch(msg: unknown): void }).dispatch({
      type: 'threads-changed',
      changed: [thread('thr-1')]
    });

    expect(mocks.threads.mergeUpdates).toHaveBeenCalledTimes(2);
    expect(receivedByB).toHaveBeenCalledWith({
      type: 'threads-changed',
      changed: [thread('thr-1')]
    });
  });
});
