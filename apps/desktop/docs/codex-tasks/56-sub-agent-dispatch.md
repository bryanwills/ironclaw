# R56 — Sub-agent dispatch wire (Engine v2 `/api/v1/tasks`)

**Lane**: A5 (codex)
**Branch**: `codex/r56-sub-agent-dispatch`
**Depends on**: nothing — but VERIFY the gateway endpoint exists
before doing the impl (see "Probe" below).

## Context

The elite move that Claude Code popularized: delegate sub-tasks to
background agents from inside a chat. User right-clicks an assistant
message → "Delegate as task" → a sub-agent picks up the message,
runs to completion, posts the result back into the thread. The user
keeps chatting in foreground while the background agent crunches.

The Engine v2 `/api/v1/tasks` family was scaffolded in R10-api and
the missions surface lives at `/missions`, but the wire for
"dispatch a single ad-hoc task and stream its result" is missing.

This task ships the wire only. UI (right-click handler + result
chip in the chat surface) lands in B4 (R57, claude) on top of this
store.

## Owned files (exclusive write access)

- `src/lib/api/ironclaw.ts` — APPEND new methods only. Do not modify
  existing methods. Insert at the end of the class before the closing
  brace.
- `src/lib/api/types.ts` — APPEND new types only.
- `src/lib/stores/sub-agents.svelte.ts` — NEW store.
- `src/lib/stores/sub-agents.test.ts` — NEW tests.

## Forbidden files

- Any route.
- Any component.
- Any other store (specifically `messages.svelte.ts`, `threads.svelte.ts`,
  `missions.svelte.ts` — they have their own lanes).
- All Rust.

## Probe

Verify against baremetal3 (tunnel on 18789, token in env):

```bash
TOKEN="62c807bdfa3d40fa7b3b0d141c38e5a6edc0d8839669678c293c9497e821bc3f"
URL="http://127.0.0.1:18789"

# 1. Does /api/v1/tasks accept POST?
curl -sS -w "\n%{http_code}\n" -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"echo hello","priority":"normal"}' \
  "$URL/api/v1/tasks"

# 2. Does /api/v1/tasks/<id> exist?
curl -sS -w "\n%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "$URL/api/v1/tasks/<id>"

# 3. Streaming events on /api/v1/tasks/<id>/events?
curl -sS -H "Authorization: Bearer $TOKEN" "$URL/api/v1/tasks/<id>/events"
```

If any of these return 404 / 405: the task is BLOCKED. Action: open
an upstream issue at github.com/nearai/ironclaw with the contract
below and STOP. Do not invent the wire.

Expected wire contract (subject to gateway reality):

```
POST /api/v1/tasks
  body: { prompt: string, priority?: "low"|"normal"|"high",
          parent_thread_id?: string, model?: string }
  resp: 201 { id: "task_...", status: "queued", created_at: "..." }

GET /api/v1/tasks/<id>
  resp: 200 {
    id, status: "queued"|"running"|"succeeded"|"failed",
    created_at, started_at?, finished_at?,
    prompt, result?: string, error?: string
  }

GET /api/v1/tasks/<id>/events  (SSE)
  events: task.started, task.progress (data: {text}),
          task.completed (data: {result}), task.failed (data: {error})
```

## Type additions — `src/lib/api/types.ts`

```ts
export interface SubAgentTask {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  prompt: string;
  result?: string;
  error?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  parent_thread_id?: string;
  model?: string;
}

export interface SubAgentDispatchInput {
  prompt: string;
  priority?: 'low' | 'normal' | 'high';
  parentThreadId?: string;
  model?: string;
}

export type SubAgentEvent =
  | { type: 'started'; taskId: string }
  | { type: 'progress'; taskId: string; text: string }
  | { type: 'completed'; taskId: string; result: string }
  | { type: 'failed'; taskId: string; error: string };
```

## Client additions — `src/lib/api/ironclaw.ts`

```ts
async dispatchSubAgent(input: SubAgentDispatchInput): Promise<SubAgentTask> {
  const url = `${this.baseUrl}/api/v1/tasks`;
  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
    },
    body: JSON.stringify({
      prompt: input.prompt,
      priority: input.priority ?? 'normal',
      parent_thread_id: input.parentThreadId,
      model: input.model
    })
  });
  if (!res.ok) throw new Error(`dispatchSubAgent ${res.status}`);
  return (await res.json()) as SubAgentTask;
}

async getSubAgentTask(id: string): Promise<SubAgentTask> {
  const url = `${this.baseUrl}/api/v1/tasks/${id}`;
  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}
  });
  if (!res.ok) throw new Error(`getSubAgentTask ${res.status}`);
  return (await res.json()) as SubAgentTask;
}

async *streamSubAgentEvents(
  id: string,
  signal?: AbortSignal
): AsyncIterable<SubAgentEvent> {
  const url = `${this.baseUrl}/api/v1/tasks/${id}/events`;
  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    headers: {
      Accept: 'text/event-stream',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
    },
    signal
  });
  if (!res.ok || !res.body) {
    throw new Error(`streamSubAgentEvents ${res.status}`);
  }
  for await (const ev of parseSseStream<SubAgentEvent>(res.body)) {
    yield ev;
  }
}

async cancelSubAgentTask(id: string): Promise<void> {
  const url = `${this.baseUrl}/api/v1/tasks/${id}/cancel`;
  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`cancelSubAgentTask ${res.status}`);
  }
}
```

## Store spec — `src/lib/stores/sub-agents.svelte.ts`

```ts
// Active sub-agent tasks per parent thread. Each task streams its own
// events; the store fans them out via $state so the UI can react.
//
// Lifecycle:
//   - dispatch({prompt, parentThreadId}): creates a task on the gateway,
//     starts an SSE stream, returns the task id.
//   - cancel(id): aborts the stream + tells the gateway to cancel.
//   - forThread(tid): the current tasks for a thread (queued + running
//     + recently completed).
//
// Storage: in-memory only. R62 (IndexedDB cache, claude) may layer
// persistence later.

import type {
  IronClawClient
} from '$lib/api/ironclaw';
import type {
  SubAgentDispatchInput,
  SubAgentTask
} from '$lib/api/types';
import { connection } from './connection.svelte';

interface TaskRecord {
  task: SubAgentTask;
  abort: AbortController;
  progressText: string;
}

class SubAgentsStore {
  private byId = $state<Record<string, TaskRecord>>({});

  async dispatch(input: SubAgentDispatchInput): Promise<string> {
    const client = connection.client;
    if (!client) throw new Error('Not connected');
    const task = await client.dispatchSubAgent(input);
    const abort = new AbortController();
    this.byId[task.id] = { task, abort, progressText: '' };
    void this.attachStream(client, task.id, abort);
    return task.id;
  }

  cancel(id: string): void {
    const rec = this.byId[id];
    if (!rec) return;
    rec.abort.abort();
    void connection.client?.cancelSubAgentTask(id);
  }

  forThread(tid: string): SubAgentTask[] {
    return Object.values(this.byId)
      .filter((r) => r.task.parent_thread_id === tid)
      .map((r) => r.task);
  }

  progressFor(id: string): string {
    return this.byId[id]?.progressText ?? '';
  }

  // Walk an SSE event stream from the gateway and patch local state.
  private async attachStream(
    client: IronClawClient,
    id: string,
    abort: AbortController
  ): Promise<void> {
    try {
      for await (const ev of client.streamSubAgentEvents(id, abort.signal)) {
        const rec = this.byId[id];
        if (!rec) return;
        if (ev.type === 'started') {
          rec.task = { ...rec.task, status: 'running', started_at: new Date().toISOString() };
        } else if (ev.type === 'progress') {
          rec.progressText += ev.text;
        } else if (ev.type === 'completed') {
          rec.task = {
            ...rec.task,
            status: 'succeeded',
            result: ev.result,
            finished_at: new Date().toISOString()
          };
        } else if (ev.type === 'failed') {
          rec.task = {
            ...rec.task,
            status: 'failed',
            error: ev.error,
            finished_at: new Date().toISOString()
          };
        }
        this.byId[id] = rec;
      }
    } catch (err) {
      const rec = this.byId[id];
      if (rec) {
        rec.task = {
          ...rec.task,
          status: 'failed',
          error: (err as Error).message,
          finished_at: new Date().toISOString()
        };
        this.byId[id] = rec;
      }
    }
  }
}

export const subAgents = new SubAgentsStore();
```

## Acceptance

1. `npm run check` → 0 errors.
2. `npm run test` → all green. Cases:
   - `dispatch()` calls the client + records the task.
   - SSE `progress` events concatenate to `progressText`.
   - `completed` event flips status to `succeeded` and stores result.
   - `cancel()` aborts the stream and calls `cancelSubAgentTask`.
3. Manual: in devtools console (dev build),
   ```js
   const id = await window._stores.subAgents.dispatch({
     prompt: 'list the files in /etc',
     parentThreadId: 'thr_demo'
   });
   // wait
   console.log(window._stores.subAgents.forThread('thr_demo'));
   ```
   Should see the task transition queued → running → succeeded with a
   non-empty `result` string.

## Out of scope

- Any UI for sub-agents (that's B4, R57, claude).
- Persisting tasks across app restarts (R62 will layer IDB cache).
- Cross-window sync of sub-agent state (deferred — tasks are
  per-window for now).

## Notes

- The `parseSseStream<T>` helper is already exported from
  `ironclaw.ts`. Reuse it.
- `loadTauriFetch()` is also already there.
- If the cancel endpoint doesn't exist, the lane should still aim for
  `streamSubAgentEvents.signal.abort()` to be sufficient — the gateway
  will see the connection drop and (per the spec) cancel automatically.
