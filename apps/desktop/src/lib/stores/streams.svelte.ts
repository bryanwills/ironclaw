// R81 (lane W4): activity stream — federates recent events across the
// workspace. Sources today: threads (recent), routines (recent runs),
// skills (most-recently-used). Implementation pattern: client-side
// aggregator, since the gateway has no unified `/api/activity` endpoint
// (probed 2026-05-28, 404). Each source's loader hits its own existing
// endpoint and we merge by timestamp.

import type { IronClawClient } from '$lib/api/ironclaw';
import { connection } from './connection.svelte';

export type StreamEventKind =
  | 'chat'
  | 'briefing'
  | 'watcher'
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
  /** Empty when the source genuinely has no timestamp. */
  occurred_at: string;
  /** Free-form payload for kind-specific rendering (rarely used today). */
  payload?: Record<string, unknown>;
}

class StreamsStore {
  events = $state<StreamEvent[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  filter = $state<StreamEventKind | 'all'>('all');

  async load(): Promise<void> {
    const client = connection.client;
    if (!client) return;
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    try {
      const events = await aggregate(client);
      this.events = sortByOccurredDesc(events);
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
    }
  }

  setFilter(filter: StreamEventKind | 'all'): void {
    this.filter = filter;
  }

  filtered(): StreamEvent[] {
    if (this.filter === 'all') return this.events;
    return this.events.filter((e) => e.kind === this.filter);
  }
}

async function aggregate(client: IronClawClient): Promise<StreamEvent[]> {
  const results = await Promise.allSettled([
    fetchThreadEvents(client),
    fetchRoutineEvents(client),
    fetchSkillEvents(client)
  ]);
  const events: StreamEvent[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') events.push(...r.value);
  }
  return events;
}

async function fetchThreadEvents(client: IronClawClient): Promise<StreamEvent[]> {
  try {
    const threads = await client.listThreads();
    return threads.slice(0, 20).map((t) => ({
      id: `thread:${t.id}`,
      kind: 'chat' as const,
      title: t.title || '(untitled thread)',
      preview: `${t.message_count} turns`,
      thread_id: t.id,
      occurred_at: t.updated_at
    }));
  } catch {
    return [];
  }
}

async function fetchRoutineEvents(client: IronClawClient): Promise<StreamEvent[]> {
  try {
    const routines = await client.listRoutines();
    return routines
      .filter((r) => r.last_run)
      .slice(0, 10)
      .map((r) => ({
        id: `routine:${r.id}`,
        kind: 'briefing' as const,
        title: r.name,
        preview: r.enabled ? `next: ${r.next_run ?? '—'}` : 'disabled',
        occurred_at: r.last_run ?? r.next_run ?? new Date().toISOString()
      }));
  } catch {
    return [];
  }
}

async function fetchSkillEvents(client: IronClawClient): Promise<StreamEvent[]> {
  try {
    const skills = await client.listSkills();
    return skills.slice(0, 10).map((s) => ({
      id: `skill:${s.name}`,
      kind: 'skill' as const,
      title: s.name,
      preview: s.description?.slice(0, 100) ?? '',
      // Skills do not carry a real timestamp; leave it empty so the UI
      // renders no date instead of a fabricated epoch value.
      occurred_at: ''
    }));
  } catch {
    return [];
  }
}

function sortByOccurredDesc(events: StreamEvent[]): StreamEvent[] {
  return [...events].sort((a, b) => {
    const ta = timestampOrNull(a.occurred_at);
    const tb = timestampOrNull(b.occurred_at);
    if (ta === null && tb === null) return 0;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  });
}

function timestampOrNull(iso: string): number | null {
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export const streams = new StreamsStore();
