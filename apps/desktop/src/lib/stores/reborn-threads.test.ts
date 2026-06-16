// Tests for the Reborn v2 thread-list store. A mock client (no I/O) is
// injected; we cover load (+cursor/hasMore), load resilience, paginated
// loadMore (append + dedup), select, and optimistic upsert.

import { describe, expect, it, vi } from 'vitest';

import type { IronClawClient } from '$lib/api/ironclaw';
import { RebornThreadStore } from './reborn-threads.svelte';

function clientWith(impl: () => Promise<unknown>): IronClawClient {
  return { listThreadsV2: vi.fn(impl) } as unknown as IronClawClient;
}

describe('RebornThreadStore.load', () => {
  it('populates threads + cursor and reports hasMore', async () => {
    const client = clientWith(async () => ({
      threads: [{ thread_id: 't1' }, { thread_id: 't2' }],
      next_cursor: 'c1'
    }));
    const s = new RebornThreadStore(() => client);
    await s.load();
    expect(s.threads.map((t) => t.thread_id)).toEqual(['t1', 't2']);
    expect(s.nextCursor).toBe('c1');
    expect(s.hasMore).toBe(true);
    expect(s.isLoading).toBe(false);
  });

  it('is resilient: a transport failure leaves an empty list, not a throw', async () => {
    const client = clientWith(async () => {
      throw new Error('503');
    });
    const s = new RebornThreadStore(() => client);
    await s.load();
    expect(s.threads).toEqual([]);
    expect(s.nextCursor).toBeNull();
    expect(s.hasMore).toBe(false);
  });

  it('clears hasMore when the server returns no cursor', async () => {
    const client = clientWith(async () => ({ threads: [{ thread_id: 't1' }] }));
    const s = new RebornThreadStore(() => client);
    await s.load();
    expect(s.hasMore).toBe(false);
  });
});

describe('RebornThreadStore.loadMore', () => {
  it('appends the next page, dedupes by thread_id, and advances the cursor', async () => {
    let call = 0;
    const client = clientWith(async () => {
      call += 1;
      return call === 1
        ? { threads: [{ thread_id: 't1' }, { thread_id: 't2' }], next_cursor: 'c1' }
        : { threads: [{ thread_id: 't2' }, { thread_id: 't3' }], next_cursor: null };
    });
    const s = new RebornThreadStore(() => client);
    await s.load();
    await s.loadMore();
    expect(s.threads.map((t) => t.thread_id)).toEqual(['t1', 't2', 't3']);
    expect(s.hasMore).toBe(false);
  });

  it('no-ops when there is no cursor', async () => {
    const client = clientWith(async () => ({ threads: [{ thread_id: 't1' }] }));
    const s = new RebornThreadStore(() => client);
    await s.load();
    await s.loadMore();
    expect((client.listThreadsV2 as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('is resilient: a failed page leaves loaded threads + cursor intact (retryable, no throw)', async () => {
    let call = 0;
    const client = clientWith(async () => {
      call += 1;
      if (call === 1) return { threads: [{ thread_id: 't1' }], next_cursor: 'c1' };
      throw new Error('503'); // second page (loadMore) fails
    });
    const s = new RebornThreadStore(() => client);
    await s.load();
    await expect(s.loadMore()).resolves.toBeUndefined(); // swallowed, not thrown
    expect(s.threads.map((t) => t.thread_id)).toEqual(['t1']); // existing page kept
    expect(s.nextCursor).toBe('c1'); // cursor preserved → next call retries
    expect(s.hasMore).toBe(true);
    expect(s.isLoading).toBe(false);
  });

  it('guards against overlapping in-flight requests (rapid double-click → single page fetch)', async () => {
    // First page resolves immediately; the loadMore page is held open via a
    // deferred promise so two concurrent calls race the `isLoading` guard.
    let release!: (v: unknown) => void;
    const gate = new Promise((res) => {
      release = res;
    });
    let call = 0;
    const client = clientWith(async () => {
      call += 1;
      if (call === 1) return { threads: [{ thread_id: 't1' }], next_cursor: 'c1' };
      await gate;
      return { threads: [{ thread_id: 't2' }], next_cursor: null };
    });
    const s = new RebornThreadStore(() => client);
    await s.load();
    expect(call).toBe(1);

    const a = s.loadMore();
    const b = s.loadMore(); // second click while the first is still in flight
    expect(s.isLoading).toBe(true);
    release(null);
    await Promise.all([a, b]);

    // Only one network page was fetched despite two calls.
    expect(call).toBe(2);
    expect(s.threads.map((t) => t.thread_id)).toEqual(['t1', 't2']);
    expect(s.isLoading).toBe(false);
  });
});

describe('RebornThreadStore select / upsert', () => {
  it('select sets the current id', () => {
    const s = new RebornThreadStore(() => null);
    s.select('t9');
    expect(s.currentId).toBe('t9');
    s.select(null);
    expect(s.currentId).toBeNull();
  });

  it('upsert prepends a new thread and dedupes; ignores empty id', () => {
    const s = new RebornThreadStore(() => null);
    s.threads = [{ thread_id: 't1' }];
    s.upsert({ thread_id: 't2', title: 'New' });
    expect(s.threads.map((t) => t.thread_id)).toEqual(['t2', 't1']);
    s.upsert({ thread_id: 't1' }); // already present → no change
    expect(s.threads).toHaveLength(2);
    s.upsert({ thread_id: '' }); // empty → ignored
    expect(s.threads).toHaveLength(2);
  });
});
