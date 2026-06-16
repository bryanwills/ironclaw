# R62 — IndexedDB message cache for offline reads

**Lane**: A9 (codex)
**Branch**: `codex/r62-idb-message-cache`
**Depends on**: nothing

## Context

Right now, if the gateway is unreachable (SSH tunnel drops, network
hiccup, app reopened on a plane), every thread shows "Loading…" and
nothing renders. We have the message data in the messages store at
runtime; persisting it to IndexedDB means the user gets last-seen
content immediately even when offline, and the network refresh
hydrates over the top when it returns.

## Owned files (exclusive write access)

- `src/lib/util/idb-cache.ts` — NEW: thin IDB wrapper.
- `src/lib/util/idb-cache.test.ts` — NEW: vitest with `fake-indexeddb`.
- `src/lib/stores/messages.svelte.ts` — wrap read paths only. Do not
  modify the streaming or write logic.
- `package.json` — add `fake-indexeddb` as devDep for tests. No runtime
  deps (IDB is a browser primitive).

## Forbidden files

- Other stores.
- Components.
- Routes.
- Rust.

## Wire contract

None — pure client-side persistence.

## Spec — `src/lib/util/idb-cache.ts`

```ts
// Tiny IndexedDB wrapper for thread-scoped message persistence.
//
// Schema: one ObjectStore per concern. Right now: `messages` keyed by
// thread_id with value `{ thread_id, updated_at, messages: Message[] }`.
//
// Keep the API surface narrow — caller doesn't see the DB lifecycle.
// All functions degrade to no-op (and return defaults) when IDB is
// unavailable (older browsers, vitest without polyfill, Tauri WKWebView
// in some configs).

const DB_NAME = 'ironclaw-cache';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => resolve(null);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('messages')) {
        db.createObjectStore('messages', { keyPath: 'thread_id' });
      }
    };
  });
  return dbPromise;
}

export interface CachedThreadMessages {
  thread_id: string;
  updated_at: number;
  messages: unknown[];
}

export async function putMessages(threadId: string, messages: unknown[]): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore('messages').put({
      thread_id: threadId,
      updated_at: Date.now(),
      messages
    });
  });
}

export async function getMessages(threadId: string): Promise<unknown[] | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction('messages', 'readonly');
    const req = tx.objectStore('messages').get(threadId);
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const val = req.result as CachedThreadMessages | undefined;
      resolve(val?.messages ?? null);
    };
  });
}

export async function deleteMessages(threadId: string): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore('messages').delete(threadId);
  });
}

export async function listCachedThreadIds(): Promise<string[]> {
  const db = await open();
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction('messages', 'readonly');
    const req = tx.objectStore('messages').getAllKeys();
    req.onerror = () => resolve([]);
    req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
  });
}
```

## `messages.svelte.ts` integration

Find the function that loads a thread's messages from the gateway
(probably named `loadHistory` or similar). Two-step:

1. BEFORE the gateway fetch, call `getMessages(threadId)`. If
   non-null, hydrate the store immediately. Mark as "cached" so the
   UI can show a stale-banner if appropriate.
2. AFTER a successful gateway fetch, call `putMessages(threadId, ...)`
   with the server's response.

DO NOT change the function signature. DO NOT modify the streaming
logic — incoming SSE events still mutate the in-memory state; the
cache is a snapshot, not a journal.

If the gateway fetch fails AND the cache returned something,
do NOT surface an error. The UI shows cached content with a stale
hint.

## Acceptance

1. `npm run check` → 0 errors.
2. `npm run test` → green. New cases (use `fake-indexeddb/auto`):
   - `putMessages` then `getMessages` round-trips.
   - `getMessages` returns null when nothing's cached.
   - `deleteMessages` removes the entry.
   - All operations no-op when `indexedDB` is undefined (assert no
     throw).
3. Manual: launch the bundled app, open a thread with messages, close
   the app, kill the SSH tunnel (`ssh -O exit your-ssh-host`),
   reopen the app, navigate to the same thread. Messages render
   from cache; status bar shows disconnected. Re-open the tunnel;
   the gateway fetch hydrates over the cache.

## Out of scope

- Per-message diff updates (we cache snapshots, not deltas).
- Cache eviction policy (LRU comes in a follow-up — for now
  unbounded; budget reality check at v0.3.0).
- Caching attachments (binary content via IDB is a different beast).
- Caching threads list itself (separate task).

## Notes

- Vitest needs `fake-indexeddb/auto` in `vitest.config.ts` setupFiles
  (or imported at the top of each test that uses it).
- `getAllKeys()` returns an `IDBValidKey[]` — map to string.
- Wrap every IDB call in a no-op fallback because Safari sometimes
  rejects the open in private browsing.
