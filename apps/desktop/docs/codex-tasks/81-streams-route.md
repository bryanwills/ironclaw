# R81 — Streams (activity feed) route

**Lane**: W4 (codex)
**Branch**: `codex/r81-streams-route`
**Depends on**: nothing

## Context

A unified activity feed for the workspace. Every event that produced
output — a briefing posted, a watcher triggered, a research job
completed, a skill ran, a knowledge doc updated, a council debate
resolved — shows up here as a card.

Filter chips (All / Briefings / Watchers / Chats / Research / Skills).
Cards have: icon, title, preview, source count, timestamp, "Ask
follow-up" CTA that drops the card's context into the composer of a
new chat thread.

Mounts at `/streams`. Sidebar gets a new "Streams" entry between
"Today" (the dashboard) and "Chat".

## Owned files

- `src/routes/streams/+page.svelte` — NEW.
- `src/routes/streams/StreamCard.svelte` — NEW.
- `src/lib/stores/streams.svelte.ts` — NEW.
- `src/lib/stores/streams.test.ts` — NEW.
- `src/lib/api/ironclaw.ts` — APPEND only: `listStreamEvents`.
- `src/lib/api/types.ts` — APPEND only.
- `src/lib/components/Sidebar.svelte` — append the new nav item ONLY.
  Exactly 4 lines max. Find the existing items array; add one entry
  between Chat and Council with `shortcut: '⌘2'` (and bump Chat's
  shortcut to ⌘3, Council to ⌘4 — see anti-collision note).

## Forbidden

- Other routes.
- Other stores.
- Other components.
- Rust.

## Anti-collision

The Sidebar.svelte shortcut renumbering is shared territory with W1
(Dashboard). Coordinate: W1 lands the Today entry first with the
shortcut bumps; W4 then adds Streams without touching shortcuts.

If W1 hasn't landed when this PR opens, open a "shortcut reservation"
registration PR FIRST that adds the empty entries and bumps the
shortcuts, get it merged, then build the streams feature on top.

## Probe

```bash
TOKEN="62c807bdfa3d40fa7b3b0d141c38e5a6edc0d8839669678c293c9497e821bc3f"
URL="http://127.0.0.1:18789"

# 1. Unified activity feed?
curl -sS -w "\n%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "$URL/api/activity?limit=50"

# 2. Or per-source aggregations?
curl -sS -H "Authorization: Bearer $TOKEN" "$URL/api/jobs/summary" | head -50
curl -sS -H "Authorization: Bearer $TOKEN" "$URL/api/routines/summary" | head -50
```

If `/api/activity` exists, use it. If not, the lane builds a
client-side aggregator that fans out to:
- `/api/jobs/summary` (background jobs)
- `/api/routines/summary` (scheduled briefings)
- `/api/chat/threads?limit=20` (recent threads)
- `/api/memory/recent` (recent knowledge writes — verify exists)

and merges by timestamp.

## Type additions

```ts
export type StreamEventKind =
  | 'briefing'
  | 'watcher'
  | 'chat'
  | 'research'
  | 'skill'
  | 'knowledge'
  | 'council';

export interface StreamEvent {
  id: string;
  kind: StreamEventKind;
  title: string;
  preview: string;
  source_count?: number;
  thread_id?: string;
  occurred_at: string;
  payload?: Record<string, unknown>;
}
```

## Client additions

```ts
async listStreamEvents(options: {
  limit?: number;
  cursor?: string;
  kinds?: StreamEventKind[];
} = {}): Promise<{ events: StreamEvent[]; nextCursor?: string }> {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.kinds?.length) params.set('kinds', options.kinds.join(','));
  const url = `${this.baseUrl}/api/activity?${params}`;
  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}
  });
  if (!res.ok) {
    if (res.status === 404) {
      return await this.fallbackStreamEvents(options);
    }
    throw new Error(`listStreamEvents ${res.status}`);
  }
  const body = await res.json();
  return {
    events: body.events ?? [],
    nextCursor: body.next_cursor
  };
}

// Client-side aggregator if /api/activity isn't there.
private async fallbackStreamEvents(options: {
  limit?: number;
  kinds?: StreamEventKind[];
}): Promise<{ events: StreamEvent[] }> {
  const limit = options.limit ?? 50;
  const [jobs, routines, threads] = await Promise.all([
    this.getJobsSummary().catch(() => ({ recent: [] })),
    this.getRoutinesSummary().catch(() => ({ recent_runs: [] })),
    this.listThreads().catch(() => [])
  ]);
  const events: StreamEvent[] = [];
  // Map each source to StreamEvent — see acceptance for the shape
  // requirements. Sort by occurred_at desc, take `limit`.
  // (Codex: fill in the field mappings based on each surface's
  // existing types in src/lib/api/types.ts.)
  return { events: events.slice(0, limit) };
}
```

## Store spec

```ts
// Activity stream: paginated card list, filter chips, refresh.
//
// Storage: in-memory list + cursor.

import { connection } from './connection.svelte';
import type { StreamEvent, StreamEventKind } from '$lib/api/types';

class StreamsStore {
  events = $state<StreamEvent[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  filter = $state<StreamEventKind | 'all'>('all');
  private cursor: string | null = null;
  private hasMore = $state(true);

  async load(reset = false): Promise<void> {
    if (this.loading) return;
    if (!this.hasMore && !reset) return;
    const client = connection.client;
    if (!client) return;
    this.loading = true;
    this.error = null;
    try {
      const opts: Parameters<typeof client.listStreamEvents>[0] = {
        limit: 50,
        cursor: reset ? undefined : (this.cursor ?? undefined),
        kinds: this.filter === 'all' ? undefined : [this.filter]
      };
      const result = await client.listStreamEvents(opts);
      this.events = reset ? result.events : [...this.events, ...result.events];
      this.cursor = result.nextCursor ?? null;
      this.hasMore = !!result.nextCursor;
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
    }
  }

  setFilter(filter: StreamEventKind | 'all'): void {
    this.filter = filter;
    this.cursor = null;
    this.hasMore = true;
    void this.load(true);
  }
}

export const streams = new StreamsStore();
```

## Route spec — `src/routes/streams/+page.svelte`

Standard pattern: header with filter chips + refresh; virtualized
list of `<StreamCard>` cards; infinite scroll on bottom.

Filter chips: All / Briefings / Watchers / Chats / Research / Skills /
Knowledge / Council. Active chip stays accent-cyan; others muted.

Card layout (`StreamCard.svelte`):
```
[icon] [title]                              [N sources] [time]
       [preview — 2 lines, ellipsis]
                                            [Ask follow-up →]
```

Click on the card body navigates to the underlying surface
(`/chat?thread=<thr>` or `/jobs?id=<id>` etc.). The "Ask follow-up"
CTA navigates to `/chat?new=1&seed=<encoded payload>`.

Use the existing `MarkdownView` (truncated) for the preview body.

## Acceptance

1. `npm run check` → 0 errors.
2. `npm run test` → green. Tests:
   - `load()` populates events.
   - `setFilter()` resets cursor and triggers reload.
   - Pagination: a second `load()` with `cursor` set appends not
     replaces.
3. Manual:
   - Navigate to `/streams`. Cards from at least 3 source kinds render.
   - Filter chip "Watchers" hides others.
   - "Ask follow-up" lands in `/chat` with the composer pre-filled.
   - Bundle: route chunk ≤80 KB gzipped (the card list is heavy on
     virtualization deps).

## Out of scope

- Real-time push (R54's thread-sync long-poll could be extended later
  to dispatch stream events — defer).
- Card-level actions beyond "Ask follow-up" (no delete, no pin —
  those need design).
- Per-source deep-linking back into the source surface is OK; cards
  showing "preview" should not require fetching the full payload.
