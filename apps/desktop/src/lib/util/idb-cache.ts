// Tiny IndexedDB wrapper for thread-scoped message persistence.
//
// Schema: one ObjectStore per concern. Right now: `messages` keyed by
// thread_id with value `{ thread_id, updated_at, messages: Message[] }`.

const DB_NAME = 'ironclaw-cache';
const DB_VERSION = 1;
const MESSAGES_STORE = 'messages';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }

  dbPromise = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        db.createObjectStore(MESSAGES_STORE, { keyPath: 'thread_id' });
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
  await new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(MESSAGES_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
      tx.objectStore(MESSAGES_STORE).put({
        thread_id: threadId,
        updated_at: Date.now(),
        messages
      });
    } catch {
      resolve();
    }
  });
}

export async function getMessages(threadId: string): Promise<unknown[] | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(MESSAGES_STORE, 'readonly');
      const req = tx.objectStore(MESSAGES_STORE).get(threadId);
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const val = req.result as CachedThreadMessages | undefined;
        resolve(val?.messages ?? null);
      };
    } catch {
      resolve(null);
    }
  });
}

export async function deleteMessages(threadId: string): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(MESSAGES_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
      tx.objectStore(MESSAGES_STORE).delete(threadId);
    } catch {
      resolve();
    }
  });
}

export async function listCachedThreadIds(): Promise<string[]> {
  const db = await open();
  if (!db) return [];
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(MESSAGES_STORE, 'readonly');
      const req = tx.objectStore(MESSAGES_STORE).getAllKeys();
      req.onerror = () => resolve([]);
      req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
    } catch {
      resolve([]);
    }
  });
}
