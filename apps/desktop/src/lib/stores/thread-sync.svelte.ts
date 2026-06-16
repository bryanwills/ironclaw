// Background thread-list sync. Long-polls the gateway for changes and
// broadcasts them to other windows via BroadcastChannel. Per-window: one loop,
// one timer, one channel.

import type { IronClawClient } from '$lib/api/ironclaw';
import type { Thread } from '$lib/api/types';
import { connection } from './connection.svelte';
import { threads } from './threads.svelte';

interface SyncOptions {
  intervalMs?: number;
  maxBackoffMs?: number;
}

interface ChangedMessage {
  type: 'threads-changed';
  changed: Thread[];
}

interface DeletedMessage {
  type: 'threads-deleted';
  ids: string[];
}

type SyncMessage = ChangedMessage | DeletedMessage;
type Subscriber = (msg: SyncMessage) => void;

const CHANNEL = 'ironclaw-thread-sync';
const FALLBACK_INTERVAL_MS = 30_000;

type ThreadStoreWithSyncMethods = typeof threads & {
  mergeUpdates?: (updated: Thread[]) => void;
  removeMany?: (ids: string[]) => void;
};

export class ThreadSyncStore {
  private running = false;
  private since = 0;
  private channel: BroadcastChannel | null = null;
  private backoffMs = 1_000;
  private abortController: AbortController | null = null;
  private subscribers = new Set<Subscriber>();
  private fallbackMode = false;
  private fallbackSnapshot = new Map<string, string>();

  start(options: SyncOptions = {}): void {
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
    if (this.running) return;
    this.running = true;
    this.channel = new BroadcastChannel(CHANNEL);
    this.channel.onmessage = (ev) => this.handleBroadcast(ev.data as SyncMessage);
    this.since = Date.now() - 60_000;
    void this.loop(options);
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    this.channel?.close();
    this.channel = null;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private async loop(options: SyncOptions): Promise<void> {
    const maxBackoff = options.maxBackoffMs ?? 60_000;
    while (this.running) {
      const client = connection.client;
      if (!client) {
        await this.sleep(2_000);
        continue;
      }
      try {
        const result = await this.pollOnce(client);
        if (result.changed.length > 0) {
          this.dispatch({ type: 'threads-changed', changed: result.changed });
        }
        if (result.deleted.length > 0) {
          this.dispatch({ type: 'threads-deleted', ids: result.deleted });
        }
        this.since = result.nextSince;
        this.backoffMs = 1_000;
        await this.sleep(this.fallbackMode ? FALLBACK_INTERVAL_MS : (options.intervalMs ?? 2_000));
      } catch (err) {
        if (!this.running) return;
        const msg = (err as Error).message;
        if (msg.includes('401') || msg.includes('403')) {
          this.running = false;
          return;
        }
        this.backoffMs = Math.min(this.backoffMs * 2, maxBackoff);
        await this.sleep(this.backoffMs);
      }
    }
  }

  private async pollOnce(client: IronClawClient): Promise<{
    changed: Thread[];
    deleted: string[];
    nextSince: number;
  }> {
    if (this.fallbackMode) return this.pollFullThreadList(client);

    this.abortController = new AbortController();
    try {
      return await client.pollThreadChanges(this.since, this.abortController.signal);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('404') || msg.includes('405')) {
        this.fallbackMode = true;
        return this.pollFullThreadList(client);
      }
      throw err;
    }
  }

  private async pollFullThreadList(client: IronClawClient): Promise<{
    changed: Thread[];
    deleted: string[];
    nextSince: number;
  }> {
    this.abortController = new AbortController();
    const next = await client.listThreads(this.abortController.signal);
    const changed: Thread[] = [];
    const nextSnapshot = new Map<string, string>();

    for (const thread of next) {
      const encoded = JSON.stringify(thread);
      nextSnapshot.set(thread.id, encoded);
      if (this.fallbackSnapshot.get(thread.id) !== encoded) changed.push(thread);
    }

    const deleted = [...this.fallbackSnapshot.keys()].filter((id) => !nextSnapshot.has(id));
    this.fallbackSnapshot = nextSnapshot;
    return { changed, deleted, nextSince: Date.now() };
  }

  private dispatch(msg: SyncMessage): void {
    this.handleBroadcast(msg);
    this.channel?.postMessage(msg);
  }

  private handleBroadcast(msg: SyncMessage): void {
    if (!msg || typeof msg !== 'object') return;
    const store = threads as ThreadStoreWithSyncMethods;
    if (msg.type === 'threads-changed') {
      if (typeof store.mergeUpdates === 'function') {
        store.mergeUpdates(msg.changed);
      } else {
        const updated = new Map(msg.changed.map((t) => [t.id, t]));
        const merged = store.threads.map((t) => updated.get(t.id) ?? t);
        const existing = new Set(store.threads.map((t) => t.id));
        store.threads = [...merged, ...msg.changed.filter((t) => !existing.has(t.id))];
      }
    } else if (msg.type === 'threads-deleted') {
      if (typeof store.removeMany === 'function') {
        store.removeMany(msg.ids);
      } else {
        const deleted = new Set(msg.ids);
        store.threads = store.threads.filter((t) => !deleted.has(t.id));
        if (store.currentId && deleted.has(store.currentId)) store.currentId = null;
      }
    } else {
      return;
    }

    for (const fn of this.subscribers) fn(msg);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.abortController = new AbortController();
      const t = setTimeout(resolve, ms);
      this.abortController.signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

export const threadSync = new ThreadSyncStore();
