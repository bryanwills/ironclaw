// IronClaw Reborn WebChat v2 chat controller.
//
// This is the v2 counterpart to `messages.svelte.ts` (the v1 chat store). It
// is deliberately a separate module: the v1 store carries a lot of
// v1-specific logic (Responses-API delta streaming, retry, draft persistence)
// that does not apply to the projection-driven v2 model, and keeping them
// apart means the live v1 path is untouched by the migration. The chat
// surface selects between them on `connection.apiVersion`.
//
// All the hard logic (DTO mapping, the timeline→message mapper, the
// projection/event reducer, the refetch-on-terminal-success rule) lives in
// the pure `$lib/api/reborn` core and is unit-tested there. This controller
// is the thin stateful orchestration on top: it owns the reactive
// `RebornChatState`, drives the SSE stream into `reduceEvent`, and refetches
// the timeline when a run terminally succeeds (Reborn does not stream
// assistant replies — they land in the thread timeline).
//
// The IronClaw client is injected via a getter (defaulting to
// `connection.client`) so tests can drive the controller with a mock client
// without standing up the connection store.

import { connection } from './connection.svelte';
import type { IronClawClient } from '$lib/api/ironclaw';
import type { AttachmentInput } from '$lib/api/types';
import { composeInstructions } from '$lib/util/prompt-instructions';
import {
  clientActionId,
  initialChatState,
  isFailedRunStatus,
  isSuccessfulRunStatus,
  messagesFromTimeline,
  recordsFromTimeline,
  reduceEvent,
  upsertRunFailureMessage,
  type GateResolution,
  type RebornChatState,
  type RebornMessage,
  type RebornRunStateResponse,
  type ThreadMessageRecord
} from '$lib/api/reborn';
import { perThreadPrompts } from './per-thread-prompts.svelte';

/** How many timeline records to pull per page. */
export const REBORN_TIMELINE_LIMIT = 50;
const RUN_STATE_POLL_DELAYS_MS = [300, 700, 1200, 2000, 3200, 5000];
const MISSING_ASSISTANT_REPLY_MESSAGE =
  'IronClaw accepted this turn, but no assistant result arrived from Reborn yet. The stream or run state did not report a completed reply. Your message and attachments are still preserved in this thread.';

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('name' in err)) return false;
  return (err as { name?: unknown }).name === 'AbortError';
}

function normalizedMessageContent(content: string | undefined): string {
  return (content ?? '').replace(/\s+/g, ' ').trim();
}

function isUserTimelineRecord(record: ThreadMessageRecord): boolean {
  return record.kind === 'user' || record.kind === 'user_message';
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

function upsertMissingAssistantReply(messages: RebornMessage[], key: string): RebornMessage[] {
  const id = `missing-assistant-${key}`;
  if (messages.some((message) => message.id === id)) return messages;
  return [
    ...messages,
    {
      id,
      role: 'error',
      content: MISSING_ASSISTANT_REPLY_MESSAGE,
      timestamp: new Date().toISOString()
    }
  ];
}

function hasAssistantForRun(messages: RebornMessage[], runId: string): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      (!message.turnRunId || message.turnRunId === runId) &&
      normalizedMessageContent(message.content)
  );
}

export class RebornChatController {
  /** The full reducer state. Reassigned (immutably) on every event so Svelte
   *  reactivity fires; components read `rebornChat.state.messages` etc. */
  state = $state<RebornChatState>(initialChatState());

  /** Thread this controller is currently bound to. */
  threadId = $state<string | null>(null);

  /** User-visible stream failure state; aborts are expected and never surface. */
  streamError = $state<string | null>(null);

  /** User-visible timeline/history load failure. */
  timelineError = $state<string | null>(null);

  /** Optimistic user bubbles not yet confirmed by a timeline refetch. Kept
   *  separate from `state.messages` so a timeline reload can re-append the
   *  ones the server hasn't surfaced yet (mirrors the SPA's pendingMessages). */
  private pending: RebornMessage[] = [];
  private pendingSeq = 1;

  /** Aborts the live SSE stream on teardown / thread switch. */
  private abort: AbortController | null = null;
  private pollingRuns = new Set<string>();

  constructor(private getClient: () => IronClawClient | null = () => connection.client) {}

  /**
   * Timeline rows can lag just behind run completion. Reborn should never make
   * a sent user bubble disappear during that gap, but it also shouldn't show a
   * duplicate once the server row lands. Reconcile by content against user
   * timeline records; unmatched pending messages stay visible.
   */
  private reconcilePendingWithTimeline(records: ThreadMessageRecord[]): void {
    const confirmedUserMessages = new Map<string, number>();
    for (const record of records) {
      if (!isUserTimelineRecord(record)) continue;
      const key = normalizedMessageContent(record.content);
      if (!key) continue;
      confirmedUserMessages.set(key, (confirmedUserMessages.get(key) ?? 0) + 1);
    }

    this.pending = this.pending.filter((pending) => {
      if (pending.role !== 'user') return true;
      const key = normalizedMessageContent(pending.content);
      const count = confirmedUserMessages.get(key) ?? 0;
      if (!key || count <= 0) return true;
      confirmedUserMessages.set(key, count - 1);
      return false;
    });
  }

  /** Reset to a clean state (e.g. when switching threads or starting a new
   *  chat). Clears the bound thread so a subsequent `send()` doesn't post into
   *  the thread we just left — callers bind the next thread via `openStream`
   *  / `loadTimeline` / an explicit `send(content, threadId)`. */
  reset(messages: RebornMessage[] = []): void {
    this.closeStream();
    this.pending = [];
    this.threadId = null;
    this.streamError = null;
    this.timelineError = null;
    this.pollingRuns.clear();
    this.state = initialChatState(messages);
  }

  /**
   * Ensure a thread is bound, creating one when none exists yet, and return
   * its id. Lets the caller open the SSE stream BEFORE the first `send()` so
   * early run events (accepted / gate / terminal success) aren't missed in the
   * window between posting and subscribing. Returns null only when no client
   * is configured.
   */
  async ensureThread(threadIdOpt?: string): Promise<string | null> {
    const client = this.getClient();
    if (!client) return null;
    let threadId = threadIdOpt || this.threadId;
    if (!threadId) {
      const created = await client.createThreadV2();
      threadId = created?.thread?.thread_id ?? null;
      if (!threadId) throw new Error('createThreadV2 returned no thread_id');
    }
    this.threadId = threadId;
    return threadId;
  }

  /**
   * Load (or reload) the thread timeline and project it into messages. Keeps
   * any still-pending optimistic bubbles appended so an in-flight user message
   * doesn't vanish between send and the server-side row appearing.
   */
  async loadTimeline(threadId: string): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    // Viewing a thread's timeline binds us to it, so a later resolveGate /
    // cancel / send targets the right thread even without openStream.
    this.threadId = threadId;
    this.timelineError = null;
    try {
      const resp = await client.fetchTimelineV2(threadId, { limit: REBORN_TIMELINE_LIMIT });
      // Generation guard: if the user switched threads while this fetch was in
      // flight, `this.threadId` has moved on — drop the stale result rather than
      // overwriting the newly-selected thread's messages.
      if (this.threadId !== threadId) return;
      const records = recordsFromTimeline(resp);
      this.reconcilePendingWithTimeline(records);
      this.state = { ...this.state, messages: messagesFromTimeline(records, this.pending) };
    } catch (err) {
      // A timeline fetch can 404 (e.g. a thread id from another backend, or a
      // not-yet-created thread). That's not fatal — treat it as an empty
      // thread rather than letting the rejection bubble out of the UI effect.
      // Same generation guard: ignore a stale failure for a thread we left.
      if (this.threadId !== threadId) return;
      console.warn('[reborn-chat] loadTimeline failed', err);
      this.timelineError = 'Could not load messages for this conversation.';
      this.state = { ...this.state, messages: messagesFromTimeline([], this.pending) };
    }
  }

  /** Retry the currently-bound timeline after a history load failure. */
  async retryTimeline(): Promise<void> {
    if (!this.threadId) return;
    await this.loadTimeline(this.threadId);
  }

  /**
   * Send a user message. Creates a thread first when none is bound yet (v2
   * SendMessage requires a thread id — the facade won't implicitly create
   * one). Pushes an optimistic user bubble immediately, then records the
   * active run from the response. On failure the optimistic bubble is marked
   * errored and removed from the pending set.
   */
  async send(
    content: string,
    threadIdOpt?: string,
    attachments: AttachmentInput[] = []
  ): Promise<void> {
    this.streamError = null;
    this.timelineError = null;
    const client = this.getClient();
    if (!client) throw new Error('no IronClaw client configured');

    let threadId = threadIdOpt || this.threadId;
    if (!threadId) {
      const created = await client.createThreadV2();
      threadId = created?.thread?.thread_id ?? null;
      if (!threadId) throw new Error('createThreadV2 returned no thread_id');
    }
    // Bind for both the explicit-id and freshly-created paths so a later
    // resolveGate / cancel targets this thread, not a stale one.
    this.threadId = threadId;

    const optimisticId = `pending-${this.pendingSeq++}`;
    const bubble: RebornMessage = {
      id: optimisticId,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      isOptimistic: true
    };
    this.pending = [...this.pending, bubble];
    this.state = {
      ...this.state,
      messages: [...this.state.messages, bubble],
      isProcessing: true,
      pendingGate: null
    };

    try {
      const instructions = composeInstructions(perThreadPrompts.get(threadId), {
        hasAttachments: attachments.length > 0
      });
      const resp = await client.sendMessageV2(threadId, content, attachments, instructions);
      if (resp?.run_id) {
        const runThreadId = resp.thread_id || threadId;
        this.state = {
          ...this.state,
          activeRun: {
            runId: resp.run_id,
            threadId: runThreadId,
            status: resp.status || null
          },
          latestRunId: resp.run_id
        };
        this.startRunPolling(runThreadId, resp.run_id);
      }
    } catch (err) {
      this.pending = this.pending.filter((m) => m.id !== optimisticId);
      this.state = {
        ...this.state,
        isProcessing: false,
        messages: this.state.messages.map((m) =>
          m.id === optimisticId
            ? { ...m, isOptimistic: false, status: 'error', error: (err as Error).message }
            : m
        )
      };
      throw err;
    }
  }

  /**
   * Open the live SSE stream for a thread and fold each envelope into state
   * via `reduceEvent`. When a run terminally succeeds the reducer raises
   * `refetchTimeline`; we then clear pending optimistic bubbles (the server
   * now owns the user message) and reload the timeline so the assistant reply
   * becomes visible. Safe to call repeatedly — supersedes any prior stream.
   */
  async openStream(threadId: string): Promise<void> {
    this.closeStream();
    this.streamError = null;
    const client = this.getClient();
    if (!client) return;
    this.threadId = threadId;
    const ctrl = new AbortController();
    this.abort = ctrl;
    try {
      for await (const envelope of client.streamWebChatV2Events(threadId, {
        signal: ctrl.signal
      })) {
        // Stop folding events once this stream is superseded — either aborted
        // on teardown, or the controller re-bound to a different thread.
        if (ctrl.signal.aborted || this.threadId !== threadId) break;
        const next = reduceEvent(this.state, envelope, threadId);
        this.state = next;
        if (next.activeRun?.runId && next.activeRun.threadId === threadId) {
          this.startRunPolling(threadId, next.activeRun.runId);
        }
        if (next.refetchTimeline) {
          await this.loadTimeline(threadId);
        }
      }
    } catch (err) {
      // AbortError on teardown is expected; surface anything else.
      if (!ctrl.signal.aborted && !isAbortError(err)) {
        this.streamError = 'Lost connection to the chat stream. Retry to reconnect.';
        console.warn('[reborn-chat] event stream error', err);
      }
    }
  }

  /** Reopen the current thread stream after a surfaced transport failure. */
  async retryStream(): Promise<void> {
    const threadId = this.threadId;
    if (!threadId) return;
    this.streamError = null;
    await this.openStream(threadId);
  }

  /** Tear down the live stream (thread switch / unmount). */
  closeStream(): void {
    this.abort?.abort();
    this.abort = null;
  }

  private startRunPolling(threadId: string, runId: string): void {
    const key = `${threadId}\n${runId}`;
    if (this.pollingRuns.has(key)) return;
    this.pollingRuns.add(key);
    void this.pollRunUntilTerminal(threadId, runId).finally(() => {
      this.pollingRuns.delete(key);
    });
  }

  private async pollRunUntilTerminal(threadId: string, runId: string): Promise<void> {
    const client = this.getClient();
    if (!client) return;

    for (const delay of RUN_STATE_POLL_DELAYS_MS) {
      await wait(delay);
      if (this.threadId !== threadId) return;

      await this.loadTimeline(threadId);
      if (this.threadId !== threadId) return;
      if (hasAssistantForRun(this.state.messages, runId)) {
        this.state = { ...this.state, isProcessing: false, activeRun: null };
        return;
      }

      const runState = await this.readRunState(client, threadId, runId);
      if (!runState) continue;
      if (isSuccessfulRunStatus(runState.status)) {
        await this.loadTimeline(threadId);
        if (this.threadId === threadId) {
          this.state = { ...this.state, isProcessing: false, activeRun: null };
        }
        return;
      }
      if (isFailedRunStatus(runState.status)) {
        await this.loadTimeline(threadId);
        if (this.threadId !== threadId) return;
        this.state = {
          ...this.state,
          messages: upsertRunFailureMessage(this.state.messages, runId, runState),
          pendingGate: null,
          isProcessing: false,
          activeRun: null
        };
        return;
      }
    }

    if (this.threadId !== threadId) return;
    this.state = {
      ...this.state,
      messages: upsertMissingAssistantReply(this.state.messages, runId),
      isProcessing: false,
      activeRun: null
    };
  }

  private async readRunState(
    client: IronClawClient,
    threadId: string,
    runId: string
  ): Promise<RebornRunStateResponse | null> {
    try {
      return await client.getRunStateV2(threadId, runId);
    } catch (err) {
      console.warn('[reborn-chat] run state poll failed', err);
      return null;
    }
  }

  /**
   * Resolve the currently-pending gate. Reads runId/gateRef off the live
   * `pendingGate` so callers don't have to plumb them through. Clears the
   * gate and re-enters processing on success.
   */
  async resolveGate(
    resolution: GateResolution,
    opts: { always?: boolean; credentialRef?: string } = {}
  ): Promise<void> {
    const client = this.getClient();
    const gate = this.state.pendingGate;
    if (!client || !gate) return;
    if (!gate.runId || !gate.gateRef) {
      throw new Error('resolveGate requires a pending gate with runId and gateRef');
    }
    const threadId = this.threadId;
    if (!threadId) throw new Error('resolveGate requires a bound thread');
    await client.resolveGateV2(threadId, gate.runId, gate.gateRef, resolution, opts);
    this.state = { ...this.state, pendingGate: null, isProcessing: true };
  }

  /** Cancel the active run. */
  async cancel(reason?: string): Promise<void> {
    const client = this.getClient();
    const runId = this.state.activeRun?.runId;
    const threadId = this.threadId;
    if (!client || !runId || !threadId) return;
    try {
      await client.cancelRunV2(threadId, runId, reason);
    } finally {
      this.state = { ...this.state, isProcessing: false };
    }
  }
}

/** App-wide singleton bound to the live connection client. */
export const rebornChat = new RebornChatController();
