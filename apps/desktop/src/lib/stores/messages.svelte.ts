// Per-thread message history + in-flight streaming buffer.
//
// Keyed by thread id so switching threads in the sidebar keeps each
// conversation's scroll state and history isolated. The chat page feeds SSE
// `content_delta` events into `appendStreamingChunk`, then calls
// `commitAssistantMessage` once the stream ends.

import type { Message } from '$lib/api/types';
import { getMessages, putMessages } from '$lib/util/idb-cache';
import { connection } from './connection.svelte';

/**
 * A tool invocation surfaced alongside an in-flight assistant message. We
 * track these so the right-rail inspector can render the timeline; once the
 * server starts persisting tool turns we'll fold them into Message history.
 */
export interface ToolInvocation {
  id: string;
  name: string;
  args: unknown;
  result?: unknown;
  /** True once a `tool_result` has been observed for this name. */
  done: boolean;
}

/**
 * UI-only metadata layered on top of a `Message`. Kept separate from the
 * wire type (`$lib/api/types`) so we don't fork the API surface — the chat
 * route reads `failed` to render the retry affordance on the optimistic
 * user-message row when a send or stream fails.
 */
export interface MessageMeta {
  failed?: boolean;
  /** Original content used to retry; same as `message.content` today but
   *  preserved separately in case the optimistic row is mutated. */
  retryContent?: string;
}

/**
 * Default page size for paginated history loads. Originally 50; trimmed to 30
 * so the initial mount renders a smaller bubble subtree, which materially
 * helps during streaming (every token re-renders the message list — fewer
 * nodes = fewer diff comparisons per frame). The lazy-load on scroll-up
 * fetches subsequent pages of the same size.
 */
export const HISTORY_PAGE_SIZE = 30;

class MessageStore {
  /** Confirmed history per thread, in chronological order. */
  byThread = $state<Record<string, Message[]>>({});

  /**
   * In-flight assistant text per thread. The gateway today emits
   * `text_response` events with the FULL content rather than deltas, so each
   * chunk overwrites the buffer; once delta-streaming lands server-side this
   * becomes additive. See normalizeEvent() in ironclaw.ts.
   */
  streaming = $state<Record<string, string>>({});

  /** Tool calls observed in the current stream, per thread. */
  tools = $state<Record<string, ToolInvocation[]>>({});

  /** True while we hold an open SSE stream for the thread. */
  streamingActive = $state<Record<string, boolean>>({});

  /** Last error surfaced from the stream, per thread. */
  errors = $state<Record<string, string | null>>({});

  /**
   * UI-only metadata keyed by message id. Used today to mark the optimistic
   * user-message row as failed so the chat surface can render a retry
   * affordance. Cleared on successful retry or thread reload.
   */
  meta = $state<Record<string, MessageMeta>>({});

  loading = $state<boolean>(false);

  /**
   * True while a `loadMoreHistory` fetch is in flight for the thread. Drives
   * the "Loading older messages…" indicator in the chat UI and gates further
   * scroll-up triggers so we don't fire the same page twice.
   */
  loadingMore = $state<Record<string, boolean>>({});

  /**
   * True once the server has returned fewer than `HISTORY_PAGE_SIZE` rows for
   * a thread — there are no older messages left to fetch. The chat UI checks
   * this to stop firing `loadMoreHistory` and to hide the loading indicator.
   */
  noMoreHistory = $state<Record<string, boolean>>({});

  /** True when the visible history came from IndexedDB before a server refresh. */
  cached = $state<Record<string, boolean>>({});

  get(threadId: string): Message[] {
    return this.byThread[threadId] ?? [];
  }

  getStreaming(threadId: string): string {
    return this.streaming[threadId] ?? '';
  }

  getTools(threadId: string): ToolInvocation[] {
    return this.tools[threadId] ?? [];
  }

  isStreaming(threadId: string): boolean {
    return !!this.streamingActive[threadId];
  }

  getError(threadId: string): string | null {
    return this.errors[threadId] ?? null;
  }

  /** Read UI metadata for a single message (failure state, retry payload). */
  getMeta(messageId: string): MessageMeta {
    return this.meta[messageId] ?? {};
  }

  /** True while the next page of older history is being fetched. */
  isLoadingMore(threadId: string): boolean {
    return !!this.loadingMore[threadId];
  }

  /** True once we've established there are no further pages to load. */
  hasNoMoreHistory(threadId: string): boolean {
    return !!this.noMoreHistory[threadId];
  }

  /** True when the current thread history is a stale IndexedDB snapshot. */
  isCached(threadId: string): boolean {
    return !!this.cached[threadId];
  }

  /**
   * Load the most recent page of a thread's history. Replaces any existing
   * cached history for the thread — the typical entry point on thread
   * selection. `opts.limit` defaults to HISTORY_PAGE_SIZE; `opts.offset`
   * defaults to 0. The `noMoreHistory` flag is reset on this call so a
   * thread can be navigated away from and back without sticking on a
   * stale terminal state.
   */
  async loadHistory(
    threadId: string,
    opts: { limit?: number; offset?: number } = {}
  ): Promise<void> {
    if (!threadId) return;
    const limit = opts.limit ?? HISTORY_PAGE_SIZE;
    const offset = opts.offset ?? 0;
    let hydratedFromCache = false;
    if (offset === 0) {
      const cached = (await getMessages(threadId)) as Message[] | null;
      if (cached) {
        hydratedFromCache = true;
        this.byThread = { ...this.byThread, [threadId]: cached };
        this.cached = { ...this.cached, [threadId]: true };
        this.errors = { ...this.errors, [threadId]: null };
        this.noMoreHistory = {
          ...this.noMoreHistory,
          [threadId]: cached.length < limit
        };
      }
    }
    if (!connection.client) return;
    this.loading = true;
    try {
      const msgs = await connection.client.getHistory(threadId, limit, offset);
      // Prune meta entries whose message ids aren't in the new history. The
      // server-confirmed rows replace any optimistic locals, so any leftover
      // `local-*` meta is no longer addressable. We intentionally don't carry
      // forward `failed` flags across a successful reload — the source of
      // truth is the server.
      const keep = new Set(msgs.map((m) => m.id));
      const nextMeta: Record<string, MessageMeta> = {};
      for (const [id, entry] of Object.entries(this.meta)) {
        if (keep.has(id)) nextMeta[id] = entry;
      }
      this.meta = nextMeta;
      this.byThread = { ...this.byThread, [threadId]: msgs };
      this.cached = { ...this.cached, [threadId]: false };
      this.errors = { ...this.errors, [threadId]: null };
      // If the first page already returned fewer rows than requested the
      // thread is fully loaded; remember that so we don't poke /history
      // again on every scroll-up.
      this.noMoreHistory = {
        ...this.noMoreHistory,
        [threadId]: msgs.length < limit
      };
      if (offset === 0) {
        await putMessages(threadId, msgs);
      }
    } catch (err) {
      if (hydratedFromCache) return;
      this.errors = { ...this.errors, [threadId]: (err as Error).message };
    } finally {
      this.loading = false;
    }
  }

  /**
   * Prepend the next page of older messages to the thread. Caller is
   * responsible for preserving scroll position around the prepend (measure
   * scrollHeight before, adjust scrollTop by the delta after) — this method
   * only mutates the store. No-op once `noMoreHistory[threadId]` is true or
   * while a load is already in flight.
   *
   * Returns the number of messages added so the caller can decide whether
   * to suppress its UI indicator on a zero-result page.
   */
  async loadMoreHistory(threadId: string): Promise<number> {
    if (!connection.client || !threadId) return 0;
    if (this.loadingMore[threadId]) return 0;
    if (this.noMoreHistory[threadId]) return 0;
    const existing = this.byThread[threadId] ?? [];
    const limit = HISTORY_PAGE_SIZE;
    const offset = existing.length;
    this.loadingMore = { ...this.loadingMore, [threadId]: true };
    try {
      const older = await connection.client.getHistory(threadId, limit, offset);
      if (older.length === 0) {
        this.noMoreHistory = { ...this.noMoreHistory, [threadId]: true };
        return 0;
      }
      // Dedupe by id — if the gateway happens to return overlap (e.g. a new
      // message landed mid-paginate and shifted offsets) we don't want to
      // double-render those rows.
      const seen = new Set(existing.map((m) => m.id));
      const fresh = older.filter((m) => !seen.has(m.id));
      // Older messages come first chronologically, then existing.
      this.byThread = {
        ...this.byThread,
        [threadId]: [...fresh, ...existing]
      };
      // Short page → no more to load.
      if (older.length < limit) {
        this.noMoreHistory = { ...this.noMoreHistory, [threadId]: true };
      }
      return fresh.length;
    } catch (err) {
      this.errors = { ...this.errors, [threadId]: (err as Error).message };
      return 0;
    } finally {
      this.loadingMore = { ...this.loadingMore, [threadId]: false };
    }
  }

  /**
   * Optimistically append a user message before the server confirms via
   * /api/chat/send. The eventual reload via loadHistory() reconciles ids.
   * Returns the local id so callers can attach metadata (e.g. mark as failed
   * for the retry affordance).
   */
  appendUserMessage(threadId: string, content: string): string {
    const existing = this.byThread[threadId] ?? [];
    const id = `local-${Date.now()}`;
    const optimistic: Message = {
      id,
      role: 'user',
      content,
      created_at: new Date().toISOString()
    };
    this.byThread = { ...this.byThread, [threadId]: [...existing, optimistic] };
    return id;
  }

  /**
   * Mark an optimistic user-message as failed and stash the original content
   * for a future retry. The chat surface reads this to render a "Failed to
   * send" subtitle and a Retry button on the bubble.
   */
  markFailed(messageId: string, content: string): void {
    this.meta = {
      ...this.meta,
      [messageId]: { ...(this.meta[messageId] ?? {}), failed: true, retryContent: content }
    };
  }

  /** Clear the failed flag (e.g. on a successful retry). */
  clearFailed(messageId: string): void {
    if (!this.meta[messageId]) return;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { [messageId]: _drop, ...rest } = this.meta;
    this.meta = rest;
  }

  /**
   * Remove a single message from a thread by id. Used during retry to drop
   * the previous optimistic failed row before appending the fresh attempt,
   * so we don't end up with two copies of the same user content.
   */
  removeMessage(threadId: string, messageId: string): void {
    const existing = this.byThread[threadId];
    if (!existing) return;
    this.byThread = {
      ...this.byThread,
      [threadId]: existing.filter((m) => m.id !== messageId)
    };
    if (this.meta[messageId]) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [messageId]: _drop, ...rest } = this.meta;
      this.meta = rest;
    }
  }

  beginStream(threadId: string): void {
    this.streaming = { ...this.streaming, [threadId]: '' };
    this.tools = { ...this.tools, [threadId]: [] };
    this.errors = { ...this.errors, [threadId]: null };
    this.streamingActive = { ...this.streamingActive, [threadId]: true };
  }

  /**
   * Apply an SSE content_delta. Today the gateway sends full content per
   * event, so we replace the buffer; the call site keeps this future-proof
   * by checking event shape — for now we overwrite to avoid duplication.
   */
  appendStreamingChunk(threadId: string, delta: string): void {
    // Heuristic: if the new delta is strictly longer and starts with the
    // existing buffer, treat it as cumulative (replace). Otherwise append.
    // Today's gateway is single-shot full-content so the replace path wins.
    const current = this.streaming[threadId] ?? '';
    let next: string;
    if (delta.startsWith(current) && delta.length >= current.length) {
      next = delta;
    } else {
      next = current + delta;
    }
    this.streaming = { ...this.streaming, [threadId]: next };
  }

  recordToolStart(threadId: string, name: string, args: unknown): void {
    const existing = this.tools[threadId] ?? [];
    const id = `${name}-${Date.now()}-${existing.length}`;
    this.tools = {
      ...this.tools,
      [threadId]: [...existing, { id, name, args, done: false }]
    };
  }

  recordToolResult(threadId: string, name: string, result: unknown): void {
    const existing = this.tools[threadId] ?? [];
    // Attach to the most-recent matching call that hasn't been completed.
    let attached = false;
    const next = [...existing]
      .reverse()
      .map((t) => {
        if (!attached && !t.done && t.name === name) {
          attached = true;
          return { ...t, result, done: true };
        }
        return t;
      })
      .reverse();
    if (!attached) {
      // No matching open call; record as a standalone result entry.
      next.push({
        id: `${name}-result-${Date.now()}`,
        name,
        args: undefined,
        result,
        done: true
      });
    }
    this.tools = { ...this.tools, [threadId]: next };
  }

  setError(threadId: string, message: string): void {
    this.errors = { ...this.errors, [threadId]: message };
  }

  /**
   * Flush the streaming buffer into a confirmed assistant message. Should be
   * followed by loadHistory() to pick up the canonical server-side row.
   */
  commitAssistantMessage(threadId: string): void {
    const content = this.streaming[threadId] ?? '';
    this.streamingActive = { ...this.streamingActive, [threadId]: false };
    if (!content.trim()) {
      // Nothing streamed — clear and bail.
      this.streaming = { ...this.streaming, [threadId]: '' };
      return;
    }
    const existing = this.byThread[threadId] ?? [];
    const msg: Message = {
      id: `local-asst-${Date.now()}`,
      role: 'assistant',
      content,
      created_at: new Date().toISOString()
    };
    this.byThread = { ...this.byThread, [threadId]: [...existing, msg] };
    this.streaming = { ...this.streaming, [threadId]: '' };
  }

  /**
   * Abort path: end the stream without committing the partial buffer (we
   * still keep whatever the user already saw, but stop marking it pending).
   */
  endStream(threadId: string): void {
    this.streamingActive = { ...this.streamingActive, [threadId]: false };
  }
}

export const messages = new MessageStore();
