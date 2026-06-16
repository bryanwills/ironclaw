// Tests for the activity-stream store (R81 — client-side event aggregator).
// The store reads `connection.client` directly and federates threads +
// routines + skills into a timestamp-sorted feed. Rather than vi.mock the
// sibling connection.svelte module (which interferes with the rune
// transform), we override the real store's `client` getter per test so we
// can exercise both the no-client early return and the aggregate path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { streams, type StreamEvent } from './streams.svelte';
import { connection } from './connection.svelte';

function setClient(client: unknown): void {
  Object.defineProperty(connection, 'client', { configurable: true, get: () => client });
}

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    listThreads: vi.fn().mockResolvedValue([]),
    listRoutines: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn().mockResolvedValue([]),
    ...over
  };
}

function ev(over: Partial<StreamEvent> = {}): StreamEvent {
  return {
    id: 'e-' + Math.random().toString(16).slice(2),
    kind: 'chat',
    title: 'T',
    preview: '',
    occurred_at: new Date().toISOString(),
    ...over
  };
}

beforeEach(() => {
  streams.events = [];
  streams.loading = false;
  streams.error = null;
  streams.filter = 'all';
  setClient(null);
});

afterEach(() => {
  streams.events = [];
  streams.filter = 'all';
});

describe('streams — filter', () => {
  it('setFilter updates the filter', () => {
    streams.setFilter('skill');
    expect(streams.filter).toBe('skill');
  });

  it('filtered() returns all under "all", and narrows by kind otherwise', () => {
    streams.events = [ev({ kind: 'chat' }), ev({ kind: 'skill' }), ev({ kind: 'chat' })];
    streams.filter = 'all';
    expect(streams.filtered()).toHaveLength(3);
    streams.filter = 'chat';
    expect(streams.filtered()).toHaveLength(2);
    expect(streams.filtered().every((e) => e.kind === 'chat')).toBe(true);
  });
});

describe('streams — load', () => {
  it('no-ops when there is no connected client', async () => {
    const client = fakeClient();
    setClient(null);
    await streams.load();
    expect(streams.loading).toBe(false);
    expect(streams.events).toEqual([]);
    expect(client.listThreads).not.toHaveBeenCalled();
  });

  it('no-ops (does not double-fetch) when a load is already in flight', async () => {
    const client = fakeClient();
    setClient(client);
    streams.loading = true;
    await streams.load();
    expect(client.listThreads).not.toHaveBeenCalled();
  });

  it('aggregates the three sources and sorts newest-first with skills last', async () => {
    setClient(
      fakeClient({
        listThreads: vi.fn().mockResolvedValue([
          { id: 't1', title: 'Alpha', message_count: 3, updated_at: '2026-05-29T10:00:00Z' },
          { id: 't2', title: '', message_count: 1, updated_at: '2026-05-29T11:00:00Z' }
        ]),
        listRoutines: vi.fn().mockResolvedValue([
          {
            id: 'r1',
            name: 'Daily brief',
            enabled: true,
            last_run: '2026-05-29T09:00:00Z',
            next_run: '2026-05-30T08:00:00Z'
          },
          // No last_run → filtered out of the feed.
          { id: 'r2', name: 'Never ran', enabled: false, last_run: null, next_run: null }
        ]),
        listSkills: vi
          .fn()
          .mockResolvedValue([{ name: 'summarize', description: 'Summarize text' }])
      })
    );

    await streams.load();

    expect(streams.error).toBeNull();
    expect(streams.events.map((e) => e.id)).toEqual([
      'thread:t2', // 11:00
      'thread:t1', // 10:00
      'routine:r1', // 09:00
      'skill:summarize' // epoch-0 sentinel, sorts last
    ]);
    expect(streams.events.find((e) => e.id === 'thread:t2')?.title).toBe('(untitled thread)');
    expect(streams.events.find((e) => e.id === 'routine:r1')?.kind).toBe('briefing');
  });

  it('tolerates a failing source via allSettled (others still load)', async () => {
    setClient(
      fakeClient({
        listThreads: vi
          .fn()
          .mockResolvedValue([
            { id: 't1', title: 'Alpha', message_count: 1, updated_at: '2026-05-29T10:00:00Z' }
          ]),
        listRoutines: vi.fn().mockRejectedValue(new Error('routines 500')),
        listSkills: vi.fn().mockResolvedValue([{ name: 'summarize', description: '' }])
      })
    );

    await streams.load();

    expect(streams.error).toBeNull();
    const ids = streams.events.map((e) => e.id);
    expect(ids).toContain('thread:t1');
    expect(ids).toContain('skill:summarize');
    expect(ids.some((id) => id.startsWith('routine:'))).toBe(false);
  });
});
