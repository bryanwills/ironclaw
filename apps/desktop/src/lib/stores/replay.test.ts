import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./connection.svelte', () => ({
  connection: { client: null as unknown }
}));

import type { ReplayEvent } from '$lib/api/types';
import { connection } from './connection.svelte';
import { replay } from './replay.svelte';

function event(id: string, ts: string, turnIndex = 0): ReplayEvent {
  return {
    id,
    thread_id: 'thr',
    turn_index: turnIndex,
    ts,
    kind: 'assistant_message',
    actor: 'assistant',
    payload: { text: id }
  };
}

function resetReplay() {
  const internals = replay as unknown as {
    byThread: Record<string, ReplayEvent[]>;
    cursors: Record<string, number>;
    playing: Record<string, boolean>;
    playbackSpeed: number;
    playTimers: Record<string, ReturnType<typeof setTimeout>>;
  };

  for (const timer of Object.values(internals.playTimers)) {
    clearTimeout(timer);
  }
  internals.byThread = {};
  internals.cursors = {};
  internals.playing = {};
  internals.playbackSpeed = 1;
  internals.playTimers = {};
  (connection as { client: unknown }).client = null;
}

function seed(threadId: string, events: ReplayEvent[]) {
  const internals = replay as unknown as {
    byThread: Record<string, ReplayEvent[]>;
    cursors: Record<string, number>;
  };
  internals.byThread[threadId] = events;
  internals.cursors[threadId] = events.length;
}

describe('replay store', () => {
  beforeEach(() => {
    resetReplay();
  });

  afterEach(() => {
    resetReplay();
    vi.useRealTimers();
  });

  it('loadFor paginates correctly when 2 batches are returned', async () => {
    const newer = event('newer', '2026-01-01T00:00:02.000Z', 1);
    const older = event('older', '2026-01-01T00:00:01.000Z', 0);
    const getThreadEvents = vi
      .fn()
      .mockResolvedValueOnce({ events: [newer], nextSinceTs: 1000 })
      .mockResolvedValueOnce({ events: [older], nextSinceTs: 1000 });
    (connection as { client: unknown }).client = { getThreadEvents };

    await replay.loadFor('thr');

    expect(getThreadEvents).toHaveBeenCalledTimes(2);
    expect(getThreadEvents).toHaveBeenNthCalledWith(1, 'thr', undefined);
    expect(getThreadEvents).toHaveBeenNthCalledWith(2, 'thr', 1000);
    expect(replay.events('thr').map((e) => e.id)).toEqual(['older', 'newer']);
    expect(replay.cursor('thr')).toBe(2);
  });

  it('scrubTo clamps to [0, total]', () => {
    seed('thr', [
      event('a', '2026-01-01T00:00:00.000Z'),
      event('b', '2026-01-01T00:00:01.000Z'),
      event('c', '2026-01-01T00:00:02.000Z')
    ]);

    replay.scrubTo('thr', -5);
    expect(replay.cursor('thr')).toBe(0);

    replay.scrubTo('thr', 2);
    expect(replay.cursor('thr')).toBe(2);

    replay.scrubTo('thr', 99);
    expect(replay.cursor('thr')).toBe(3);
    expect(replay.eventsUpTo('thr', 2).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('play() advances the cursor at expected real-time deltas', () => {
    vi.useFakeTimers();
    seed('thr', [
      event('a', '2026-01-01T00:00:00.000Z'),
      event('b', '2026-01-01T00:00:00.050Z'),
      event('c', '2026-01-01T00:00:00.300Z')
    ]);
    replay.scrubTo('thr', 0);

    replay.play('thr');
    expect(replay.isPlaying('thr')).toBe(true);
    expect(replay.cursor('thr')).toBe(0);

    vi.advanceTimersByTime(99);
    expect(replay.cursor('thr')).toBe(0);

    vi.advanceTimersByTime(1);
    expect(replay.cursor('thr')).toBe(1);

    vi.advanceTimersByTime(249);
    expect(replay.cursor('thr')).toBe(1);

    vi.advanceTimersByTime(1);
    expect(replay.cursor('thr')).toBe(2);

    vi.advanceTimersByTime(500);
    expect(replay.cursor('thr')).toBe(3);
    expect(replay.isPlaying('thr')).toBe(false);
  });

  it('pause() clears the timer', () => {
    vi.useFakeTimers();
    seed('thr', [event('a', '2026-01-01T00:00:00.000Z'), event('b', '2026-01-01T00:00:01.000Z')]);
    replay.scrubTo('thr', 0);

    replay.play('thr');
    expect(replay.isPlaying('thr')).toBe(true);
    replay.pause('thr');

    expect(replay.isPlaying('thr')).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(replay.cursor('thr')).toBe(0);
  });
});
