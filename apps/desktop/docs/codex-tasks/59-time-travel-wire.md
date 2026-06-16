# R59 — Time-travel replay events wire

**Lane**: A6 (codex)
**Branch**: `codex/r59-time-travel-wire`
**Depends on**: nothing — but probe first.

## Context

This is the killer feature: scrub backward through a conversation,
watch the assistant's tool calls + reasoning replay in slow motion.
Like a debugger for the model.

The data already exists on the gateway: every turn has its tool calls
+ messages recorded in `ironclaw.db`. The wire to expose them as a
time-ordered stream is what we need to build.

This task ships the wire only. The UI (scrub bar + replay panel
overlay) lands in B5 (R58, claude).

## Owned files (exclusive write access)

- `src/lib/api/ironclaw.ts` — APPEND only.
- `src/lib/api/types.ts` — APPEND only.
- `src/lib/stores/replay.svelte.ts` — NEW.
- `src/lib/stores/replay.test.ts` — NEW.

## Forbidden files

- All routes, components.
- All other stores.
- All Rust.

## Probe

```bash
TOKEN="62c807bdfa3d40fa7b3b0d141c38e5a6edc0d8839669678c293c9497e821bc3f"
URL="http://127.0.0.1:18789"
THR="$(curl -s -H "Authorization: Bearer $TOKEN" "$URL/api/chat/threads" | jq -r '.threads[0].id')"

# 1. Per-thread event timeline
curl -sS -w "\n%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "$URL/api/chat/threads/${THR}/events"

# 2. Per-turn event detail
curl -sS -w "\n%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "$URL/api/chat/threads/${THR}/turns/<turn_n>/events"
```

If 404, the lane is BLOCKED. File an upstream issue with this
contract:

```
GET /api/chat/threads/<id>/events
  query: ?since_ts=<unix>&limit=<n>
  resp: 200 {
    events: [
      { id, thread_id, turn_index, ts: "...", kind: "user_message"|"assistant_message"|
                                                "tool_call"|"tool_result"|"reasoning"|"error",
        actor: "user"|"assistant"|"tool",
        payload: { ... kind-specific ... } }
    ],
    next_since_ts: <unix>
  }
```

## Type additions

```ts
export type ReplayEventKind =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning'
  | 'error';

export interface ReplayEvent {
  id: string;
  thread_id: string;
  turn_index: number;
  ts: string;
  kind: ReplayEventKind;
  actor: 'user' | 'assistant' | 'tool';
  payload: Record<string, unknown>;
}
```

## Client additions

```ts
async getThreadEvents(threadId: string, sinceTs?: number, limit = 500): Promise<{
  events: ReplayEvent[];
  nextSinceTs: number;
}> {
  const params = new URLSearchParams();
  if (sinceTs) params.set('since_ts', String(sinceTs));
  params.set('limit', String(limit));
  const url = `${this.baseUrl}/api/chat/threads/${threadId}/events?${params}`;
  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}
  });
  if (!res.ok) throw new Error(`getThreadEvents ${res.status}`);
  const body = await res.json();
  return {
    events: body.events ?? [],
    nextSinceTs: body.next_since_ts ?? Date.now()
  };
}
```

## Store spec — `src/lib/stores/replay.svelte.ts`

```ts
// Time-travel replay state per thread.
//
// loadFor(threadId) fetches the full event timeline (paginated) and
// stores it sorted by timestamp. cursor is the index into the timeline
// the user is currently scrubbed to. The chat-surface message renderer
// (R58, claude) reads `eventsUpTo(threadId, cursor)` to decide which
// turns to show; turns past the cursor are hidden.
//
// In playback mode, `play()` advances the cursor at `playbackSpeed`x
// real time relative to event timestamps.

import { connection } from './connection.svelte';
import type { ReplayEvent } from '$lib/api/types';

class ReplayStore {
  private byThread = $state<Record<string, ReplayEvent[]>>({});
  private cursors = $state<Record<string, number>>({});
  private playing = $state<Record<string, boolean>>({});
  private playbackSpeed = $state(1);
  private playTimers: Record<string, ReturnType<typeof setTimeout>> = {};

  async loadFor(threadId: string): Promise<void> {
    const client = connection.client;
    if (!client) return;
    let cursor: number | undefined = undefined;
    const collected: ReplayEvent[] = [];
    for (let i = 0; i < 20; i++) {
      const { events, nextSinceTs } = await client.getThreadEvents(threadId, cursor);
      collected.push(...events);
      if (events.length === 0 || nextSinceTs <= (cursor ?? 0)) break;
      cursor = nextSinceTs;
    }
    collected.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    this.byThread[threadId] = collected;
    this.cursors[threadId] = collected.length;
  }

  events(threadId: string): ReplayEvent[] {
    return this.byThread[threadId] ?? [];
  }

  cursor(threadId: string): number {
    return this.cursors[threadId] ?? this.byThread[threadId]?.length ?? 0;
  }

  scrubTo(threadId: string, index: number): void {
    const total = this.byThread[threadId]?.length ?? 0;
    this.cursors[threadId] = Math.max(0, Math.min(total, index));
  }

  eventsUpTo(threadId: string, cursor: number): ReplayEvent[] {
    const all = this.byThread[threadId] ?? [];
    return all.slice(0, cursor);
  }

  isPlaying(threadId: string): boolean {
    return !!this.playing[threadId];
  }

  play(threadId: string): void {
    if (this.playing[threadId]) return;
    this.playing[threadId] = true;
    this.scheduleNext(threadId);
  }

  pause(threadId: string): void {
    this.playing[threadId] = false;
    const t = this.playTimers[threadId];
    if (t) {
      clearTimeout(t);
      delete this.playTimers[threadId];
    }
  }

  setSpeed(s: number): void {
    this.playbackSpeed = Math.max(0.25, Math.min(8, s));
  }

  private scheduleNext(threadId: string): void {
    if (!this.playing[threadId]) return;
    const events = this.byThread[threadId] ?? [];
    const i = this.cursors[threadId] ?? 0;
    if (i >= events.length) {
      this.playing[threadId] = false;
      return;
    }
    const current = events[i];
    const next = events[i + 1];
    const dt = next
      ? Math.max(100, new Date(next.ts).getTime() - new Date(current.ts).getTime())
      : 500;
    this.playTimers[threadId] = setTimeout(() => {
      this.cursors[threadId] = i + 1;
      this.scheduleNext(threadId);
    }, dt / this.playbackSpeed);
  }
}

export const replay = new ReplayStore();
```

## Acceptance

1. `npm run check` + `npm run test` → green.
2. New test cases:
   - `loadFor` paginates correctly when 2 batches are returned.
   - `scrubTo` clamps to [0, total].
   - `play()` advances the cursor at expected real-time deltas
     (use vitest fake timers).
   - `pause()` clears the timer.
3. Manual: open devtools console,
   ```js
   await window._stores.replay.loadFor('thr_demo');
   console.log(window._stores.replay.events('thr_demo').length);
   window._stores.replay.scrubTo('thr_demo', 3);
   ```

## Out of scope

- Any UI (B5, claude).
- Persisting playback state across reloads.
- Server-side event stream for new events while replaying.

## Notes

- The event payload is intentionally `Record<string, unknown>` — each
  `kind` has its own shape, decoded by the UI lane based on `kind`.
- `play()` plays event-relative time; with `playbackSpeed=1` it's
  approximately how the conversation actually happened.
- Clamp playback minimum delta to 100ms so very fast events don't
  blur into one frame.
