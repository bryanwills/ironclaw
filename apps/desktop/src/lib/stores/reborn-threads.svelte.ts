// IronClaw Reborn (WebChat v2) thread list store.
//
// The v1 chat surface lists threads via the v1 gateway (`threads.svelte.ts`).
// On a Reborn v2 backend those endpoints don't exist, so v2 chat was
// "new-conversation only" — you couldn't browse or resume past Reborn threads.
// This store lists them via `listThreadsV2` and tracks the active selection so
// a v2 thread rail can drive `RebornChatPanel`.
//
// v2 exposes list + create only (no rename/delete in the WebChat v2 contract),
// so this store deliberately offers browse / resume / select / optimistic
// insert — not rename or delete. The IronClaw client is injected (defaulting to
// `connection.client`) so it is unit-testable without the connection store.

import { connection } from './connection.svelte';
import type { IronClawClient } from '$lib/api/ironclaw';
import {
  threadsFromListResponse,
  type ListThreadsResponse,
  type ThreadSummary
} from '$lib/api/reborn';

/** How many threads to pull per page. */
export const REBORN_THREADS_PAGE_SIZE = 30;

function cursorOf(resp: ListThreadsResponse | null | undefined): string | null {
  return resp?.next_cursor ?? resp?.cursor ?? null;
}

export class RebornThreadStore {
  /** Threads, most-recent first (server order is trusted). */
  threads = $state<ThreadSummary[]>([]);
  /** Currently-selected thread id, or null for the unsent "new" slot. */
  currentId = $state<string | null>(null);
  /** Pagination cursor for `loadMore`; null when fully drained. */
  nextCursor = $state<string | null>(null);
  isLoading = $state(false);

  constructor(private getClient: () => IronClawClient | null = () => connection.client) {}

  /** True when more pages remain. */
  get hasMore(): boolean {
    return this.nextCursor !== null && this.nextCursor !== '';
  }

  /**
   * (Re)load the first page. Resilient — a transport failure leaves an empty
   * list rather than throwing out of the UI effect that calls this.
   */
  async load(): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    this.isLoading = true;
    try {
      const resp = await client.listThreadsV2({ limit: REBORN_THREADS_PAGE_SIZE });
      this.threads = threadsFromListResponse(resp);
      this.nextCursor = cursorOf(resp);
    } catch (err) {
      console.warn('[reborn-threads] load failed', err);
      this.threads = [];
      this.nextCursor = null;
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Append the next page (deduped by thread_id). No-op when drained or when a
   * load is already in flight (the `isLoading` guard collapses rapid clicks
   * into a single request). Resilient — a transport failure is swallowed and
   * leaves the already-loaded threads and cursor intact, so the next call can
   * retry the same page rather than dropping out of the UI as an unhandled
   * rejection.
   */
  async loadMore(): Promise<void> {
    const client = this.getClient();
    if (!client || !this.hasMore || this.isLoading) return;
    this.isLoading = true;
    try {
      const resp = await client.listThreadsV2({
        limit: REBORN_THREADS_PAGE_SIZE,
        cursor: this.nextCursor as string
      });
      const more = threadsFromListResponse(resp);
      const seen = new Set(this.threads.map((t) => t.thread_id));
      this.threads = [
        ...this.threads,
        ...more.filter((t) => t.thread_id && !seen.has(t.thread_id))
      ];
      this.nextCursor = cursorOf(resp);
    } catch (err) {
      console.warn('[reborn-threads] loadMore failed', err);
    } finally {
      this.isLoading = false;
    }
  }

  /** Set the active thread (null = the new-conversation slot). */
  select(id: string | null): void {
    this.currentId = id;
  }

  /**
   * Optimistically surface a freshly-created/seen thread at the top so it
   * appears immediately (e.g. after a first send creates it) without waiting
   * for a full reload. De-duplicated by thread_id.
   */
  upsert(thread: ThreadSummary): void {
    if (!thread.thread_id) return;
    if (this.threads.some((t) => t.thread_id === thread.thread_id)) return;
    this.threads = [thread, ...this.threads];
  }
}

/** App-wide singleton bound to the live connection client. */
export const rebornThreads = new RebornThreadStore();
