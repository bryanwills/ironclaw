import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DB_NAME = 'ironclaw-cache';
let cache: typeof import('./idb-cache');

async function deleteDb(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
  });
}

describe('idb-cache', () => {
  beforeEach(async () => {
    vi.resetModules();
    await deleteDb(DB_NAME);
    cache = await import('./idb-cache');
  });

  afterEach(async () => {
    await deleteDb(DB_NAME);
  });

  it('round-trips thread messages', async () => {
    const messages = [
      { id: 'm1', role: 'user', content: 'hello', created_at: '2026-05-28T00:00:00Z' },
      { id: 'm2', role: 'assistant', content: 'hi', created_at: '2026-05-28T00:00:01Z' }
    ];

    await cache.putMessages('thread-1', messages);

    await expect(cache.getMessages('thread-1')).resolves.toEqual(messages);
    await expect(cache.listCachedThreadIds()).resolves.toEqual(['thread-1']);
  });

  it('returns null when nothing is cached', async () => {
    await expect(cache.getMessages('missing-thread')).resolves.toBeNull();
  });

  it('deletes cached messages', async () => {
    await cache.putMessages('thread-1', [{ id: 'm1', content: 'cached' }]);

    await cache.deleteMessages('thread-1');

    await expect(cache.getMessages('thread-1')).resolves.toBeNull();
    await expect(cache.listCachedThreadIds()).resolves.toEqual([]);
  });

  it('no-ops when indexedDB is unavailable', async () => {
    const originalIndexedDb = globalThis.indexedDB;
    Reflect.deleteProperty(globalThis, 'indexedDB');

    try {
      vi.resetModules();
      const cache = await import('./idb-cache');

      await expect(cache.putMessages('thread-1', [{ id: 'm1' }])).resolves.toBeUndefined();
      await expect(cache.getMessages('thread-1')).resolves.toBeNull();
      await expect(cache.deleteMessages('thread-1')).resolves.toBeUndefined();
      await expect(cache.listCachedThreadIds()).resolves.toEqual([]);
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: originalIndexedDb,
        writable: true
      });
    }
  });
});
