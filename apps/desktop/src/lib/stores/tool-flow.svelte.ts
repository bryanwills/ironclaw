// Per-thread tool-call ledger for the right-rail flow visualizer.
//
// The chat surface today fires `messages.recordToolStart` /
// `messages.recordToolResult` so the inspector aside (toggled via the
// header tool-icon) can show args/results. That surface is opt-in and
// auto-collapses when no tools have been called yet — power users miss it
// until they discover the icon. The flow visualizer keeps the ledger
// visible at all times on widescreen (`xl` and up): when the assistant
// calls a tool mid-conversation, the right column lights up with a
// pending pip the instant the `tool_call` event fires and flips to done
// (with latency) on `tool_result`. This store owns that ledger,
// independent of the existing `messages.tools` collection so we can:
//
//   1. Track start/end timestamps for the latency badge (the existing
//      collection didn't, since it never needed to render duration).
//   2. Surface a stable identity per call so the UI can key collapse
//      state per row without recycling ids across resets.
//   3. Carry an explicit `pending | done | error` discriminator rather
//      than the implicit `done: boolean` on `ToolInvocation`, so a future
//      `tool_error` event drops in cleanly without a UI refactor.
//
// The ledger is cleared per thread on `message_start` so each assistant
// turn starts fresh — historical tool calls aren't surfaced (those live
// in the message history). Cross-thread isolation is guaranteed by
// keying the map on thread id; switching threads in the rail shows that
// thread's last turn's ledger without further wiring.

import type { ChatEvent } from '$lib/api/types';

/** Discrete lifecycle states a tool call moves through. `pending` is the
 *  default-after-create state; `done` is set when a matching tool_result
 *  lands; `error` is reserved for a future `tool_error` event — until the
 *  gateway emits one, no code path writes this. The union stays open so
 *  consumers can switch over all three without a TypeScript-narrowing
 *  cast when the wire eventually grows the error path. */
export type ToolCallStatus = 'pending' | 'done' | 'error';

/**
 * One tool call recorded against a thread. `args` and `result` are kept
 * opaque (`unknown`) because the gateway forwards arbitrary JSON from the
 * function-call schema — the UI renders them via JSON.stringify rather
 * than reading specific fields.
 */
export interface ToolCall {
  /** Stable identity for this call. Generated on `tool_call` so the same
   *  row keeps its key when the status flips to `done`. Format is
   *  `<name>-<startedAt>-<seq>`; not a UUID (no dep on crypto.randomUUID
   *  outside the Tauri webview) but unique enough within a thread's
   *  single turn. */
  id: string;
  /** Tool name from the gateway. Used to match a `tool_result` event back
   *  to the most-recent pending entry. */
  name: string;
  /** Arguments payload as the gateway sent it. May be any JSON shape;
   *  the UI defensively renders via `JSON.stringify(..., null, 2)`. */
  args: unknown;
  status: ToolCallStatus;
  /** Result payload from the matching `tool_result` event. Undefined
   *  while pending. */
  result?: unknown;
  /** Error message surfaced on a (future) `tool_error` event. Undefined
   *  on healthy paths. */
  error?: string;
  /** Epoch millis when the `tool_call` event landed. */
  startedAt: number;
  /** Epoch millis when the matching `tool_result` event landed; undefined
   *  while the call is still pending. */
  completedAt?: number;
}

class ToolFlowStore {
  /**
   * Per-thread tool-call ledger. Keyed on thread id so a focused thread's
   * ledger doesn't leak into a sibling. Each entry is a fresh array on
   * mutation (Svelte 5 reactivity hinges on identity comparison for
   * `$state` records, so we replace rather than mutate in place).
   */
  byThread = $state<Record<string, ToolCall[]>>({});

  /**
   * Monotonic per-store sequence used to disambiguate two calls of the
   * same name issued in the same millisecond. Reset on `clear()` so each
   * fresh turn starts from zero — keeps row ids predictable for tests.
   */
  private seq = 0;

  /**
   * Apply a single ChatEvent to the per-thread ledger. The mapping is:
   *
   *   - `message_start` → clear the thread's ledger (fresh turn).
   *   - `tool_call`     → append a pending row.
   *   - `tool_result`   → flip the most-recent matching pending row to
   *     `done`. If none matches, the event is dropped silently — this is
   *     the forward-compat path for a gateway that emits `tool_result`
   *     without a paired `tool_call` (e.g. a result echoed from history
   *     reconciliation).
   *
   * All other event types are ignored. The chat surface keeps wiring
   * `content_delta`, `tool_call_delta`, `message_end`, and `error` through
   * the existing pipelines — this store is strictly about the timeline of
   * tool invocations the user can see.
   */
  record(threadId: string, ev: ChatEvent): void {
    if (!threadId) return;
    switch (ev.type) {
      case 'message_start':
        this.clear(threadId);
        return;
      case 'tool_call':
        this.appendPending(threadId, ev.name, ev.args);
        return;
      case 'tool_result':
        this.flipToDone(threadId, ev.name, ev.result);
        return;
      // Forward-compat: ignore content_delta, tool_call_delta, message_end,
      // error. The latter two could in principle flip every pending row to
      // an error state, but the current contract is "ledger reflects what
      // the user can see actually happen" — a stream-level error doesn't
      // necessarily mean a specific tool failed.
      default:
        return;
    }
  }

  /** Reset a thread's ledger. Called explicitly when starting a new user
   *  turn so the previous turn's tool calls don't bleed into the new one,
   *  and implicitly by `record(message_start)`. */
  clear(threadId: string): void {
    if (!threadId) return;
    if (!(threadId in this.byThread)) return;
    const next = { ...this.byThread };
    delete next[threadId];
    this.byThread = next;
    // Reset the sequence so the first row of the next turn is predictable.
    // (Per-thread sequences would be tidier but the store is single-tenant
    // in practice — one turn streams at a time.)
    this.seq = 0;
  }

  /** Read the ledger for a thread. Returns an empty array (not undefined)
   *  for unknown threads so callers can iterate without a null check. */
  forThread(threadId: string): ToolCall[] {
    return this.byThread[threadId] ?? [];
  }

  // -- internal mutators ----------------------------------------------------

  /**
   * Append a pending row. Internal — `record()` is the public entry
   * point. Generates a stable id from `<name>-<startedAt>-<seq>` so two
   * sibling calls of the same tool name in the same millisecond don't
   * collide.
   */
  private appendPending(threadId: string, name: string, args: unknown): void {
    const startedAt = Date.now();
    const id = `${name}-${startedAt}-${this.seq++}`;
    const entry: ToolCall = {
      id,
      name,
      args,
      status: 'pending',
      startedAt
    };
    const existing = this.byThread[threadId] ?? [];
    this.byThread = {
      ...this.byThread,
      [threadId]: [...existing, entry]
    };
  }

  /**
   * Flip the most-recent matching pending row to `done`. Walks from the
   * tail of the array so a later `tool_call` of the same name with a
   * different arg payload doesn't get back-matched to an earlier
   * pending row. No-op if no matching pending row exists (forward-compat
   * for a gateway that emits a stray `tool_result`).
   */
  private flipToDone(threadId: string, name: string, result: unknown): void {
    const existing = this.byThread[threadId];
    if (!existing || existing.length === 0) return;
    // Walk from tail; the most-recent pending entry of this name wins.
    let foundIndex = -1;
    for (let i = existing.length - 1; i >= 0; i--) {
      const row = existing[i];
      if (row.name === name && row.status === 'pending') {
        foundIndex = i;
        break;
      }
    }
    if (foundIndex < 0) return;
    const completedAt = Date.now();
    const next = existing.slice();
    next[foundIndex] = {
      ...next[foundIndex],
      status: 'done',
      result,
      completedAt
    };
    this.byThread = { ...this.byThread, [threadId]: next };
  }
}

/** Singleton ledger — import this anywhere a surface needs to record or
 *  read tool-call activity for the current chat thread. */
export const toolFlow = new ToolFlowStore();
