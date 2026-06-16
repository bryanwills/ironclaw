# R54 — Background thread sync via long-poll

**Lane**: A4 (codex)
**Branch**: `codex/r54-thread-sync-longpoll`
**Depends on**: nothing

## Context

Right now, threads only refresh when the user navigates between them
or clicks the refresh button. If the user has IronClaw running in two
windows (multi-profile) or another client is touching a thread (e.g.
a routine ran), the second window is stale until the user reloads.

This task adds a background long-poll loop that watches for thread
list changes and dispatches updates via `BroadcastChannel` so every
window/route sees the new state without a manual refresh.

## Owned files (exclusive write access)

- `src/lib/stores/thread-sync.svelte.ts` — NEW store. Owns the
  long-poll loop and its lifecycle.
- `src/lib/stores/thread-sync.test.ts` — NEW tests.
- `src/routes/+layout.svelte` — append 3 lines that mount the store
  on layout init + tear down on destroy. **Do not touch anything
  else in this file.**

## Forbidden files

- All other stores.
- All components.
- All routes except the +layout.svelte three-line addition.
- All Rust.

## Wire contract

`GET /api/chat/threads/poll?since=<unix-ms>` (verify against
baremetal3 18789, token in `~/.config/ironclaw-desktop` or staged
fallback). Returns:

```json
{
  "changed": [
    { "id": "thr_...", "updated_at": "2026-...", "title": "...", "turn_count": 4 },
    ...
  ],
  "deleted": ["thr_..."],
  "next_since": 1737045613452
}
```

If the endpoint does NOT exist on the gateway (probe with `curl -s -o
/dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN"
http://127.0.0.1:18789/api/chat/threads/poll?since=0`), the task is
BLOCKED. In that case:

1. Stop work.
2. Update this brief in place with a note: "Wire blocked — endpoint
   not implemented upstream as of 2026-05-28."
3. Open an upstream issue at github.com/nearai/ironclaw with the
   contract above and link it.
4. Implement a degraded fallback: poll `/api/chat/threads` (full list)
   every 30s, diff client-side, dispatch the same broadcast events.
   This is wasteful but works.

## Store spec — `thread-sync.svelte.ts`

```ts
// Background thread-list sync. Long-polls the gateway for changes
// and broadcasts them to other windows via BroadcastChannel. Per-
// window: one loop, one timer, one channel.
//
// Lifecycle:
//   - start(): kicks off the loop. Idempotent.
//   - stop(): cancels in-flight fetch + halts the loop.
//   - subscribe(fn): receive events for this window.
//
// Broadcast channel name: `ironclaw-thread-sync`. Messages:
//   { type: 'threads-changed', changed: ThreadSummary[] }
//   { type: 'threads-deleted', ids: string[] }
//
// Backoff: on network failure, exponential up to 60s. On 401/403,
// give up (the user needs to re-auth; let the connection store
// surface that).

import { browser } from '$app/environment';
import type { IronClawClient } from '$lib/api/ironclaw';
import { connection } from './connection.svelte';
import { threads } from './threads.svelte';
import type { Thread } from '$lib/api/types';

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

const CHANNEL = 'ironclaw-thread-sync';

class ThreadSyncStore {
  private running = false;
  private since = 0;
  private channel: BroadcastChannel | null = null;
  private backoffMs = 1_000;
  private abortController: AbortController | null = null;

  start(options: SyncOptions = {}): void {
    if (!browser) return;
    if (this.running) return;
    this.running = true;
    this.channel = new BroadcastChannel(CHANNEL);
    this.channel.onmessage = (ev) => this.handleBroadcast(ev.data as SyncMessage);
    this.since = Date.now() - 60_000; // initial: last minute
    void this.loop(options);
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.channel?.close();
    this.channel = null;
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
        await this.sleep(options.intervalMs ?? 2_000);
      } catch (err) {
        if (!this.running) return;
        // Auth failures are terminal — let the connection store handle re-auth.
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
    // Replace with a real client method once added.
    return client.pollThreadChanges(this.since);
  }

  private dispatch(msg: SyncMessage): void {
    this.handleBroadcast(msg);
    this.channel?.postMessage(msg);
  }

  private handleBroadcast(msg: SyncMessage): void {
    if (msg.type === 'threads-changed') {
      // Merge into the threads store. The store should expose a
      // `mergeUpdates(updated: Thread[]): void` method — add it
      // there in a separate registration PR if it doesn't exist.
      threads.mergeUpdates(msg.changed);
    } else if (msg.type === 'threads-deleted') {
      threads.removeMany(msg.ids);
    }
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
```

If `threads.mergeUpdates` / `threads.removeMany` don't exist, open a
mini registration PR adding them BEFORE doing this lane. That
registration PR must be tiny: add the two methods to the existing
`threads.svelte.ts` store, no behavior change, dropping straight
through to the existing private state.

## `IronClawClient` additions

Add to `src/lib/api/ironclaw.ts`:

```ts
async pollThreadChanges(since: number): Promise<{
  changed: Thread[];
  deleted: string[];
  nextSince: number;
}> {
  const url = `${this.baseUrl}/api/chat/threads/poll?since=${since}`;
  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}
  });
  if (!res.ok) throw new Error(`pollThreadChanges ${res.status}`);
  const body = await res.json();
  return {
    changed: body.changed ?? [],
    deleted: body.deleted ?? [],
    nextSince: body.next_since ?? Date.now()
  };
}
```

## Layout integration

`src/routes/+layout.svelte`, append inside the existing `onMount`:

```ts
threadSync.start({ intervalMs: 3_000 });
```

And in `onDestroy` (or the cleanup returned from `onMount`):

```ts
threadSync.stop();
```

## Acceptance

1. `npm run check` → 0 errors.
2. `npm run test` → all green. New cases:
   - `start()` registers a BroadcastChannel listener.
   - `stop()` cancels the in-flight fetch.
   - On `401`, the loop terminates.
   - On a 5xx, the loop backs off exponentially.
   - Two windows: one window's `dispatch` triggers the other window's
     `threads.mergeUpdates` (mock `BroadcastChannel` in the test).
3. Manual: open two app windows (Cmd+N in the running app), modify a
   thread title via curl, both windows update within 3 seconds.

## Out of scope

- Per-thread message-level sync (that's a future task —
  `/api/chat/threads/<id>/poll`).
- SSE-based push (when the gateway supports it, we'll replace this
  loop with an EventSource through the Tauri http plugin).
- Persisting `since` across app restarts.

## Notes

- The store is window-singleton. BroadcastChannel handles cross-window
  fan-out at the OS layer; we don't need a separate session store.
- AbortController is used both to cancel sleep AND any in-flight
  fetch — the helper `sleep` re-allocates the controller per sleep so
  abort doesn't leak.
- Backoff resets on success.
