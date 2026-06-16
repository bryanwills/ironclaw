// Time-travel replay state per thread.
//
// loadFor(threadId) fetches the full event timeline (paginated) and stores
// it sorted by timestamp. cursor is the index into the timeline the user is
// currently scrubbed to. The chat-surface message renderer reads
// `eventsUpTo(threadId, cursor)` to decide which turns to show; turns past
// the cursor are hidden.
//
// In playback mode, `play()` advances the cursor at `playbackSpeed`x real
// time relative to event timestamps.

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

declare global {
  interface Window {
    _stores?: {
      replay?: typeof replay;
      [key: string]: unknown;
    };
  }
}

if (typeof window !== 'undefined') {
  const stores = (window._stores ??= {});
  stores.replay = replay;
}
