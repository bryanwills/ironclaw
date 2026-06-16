import { describe, expect, it } from 'vitest';

import { groupThreadsByRecency } from './thread-groups';
import type { ThreadSummary } from '$lib/api/reborn';

// Fixed "now": 2026-05-29 12:00 local.
const NOW = new Date(2026, 4, 29, 12, 0, 0).getTime();
const DAY = 86_400_000;

function t(id: string, msAgoFromMidnight: number | null): ThreadSummary {
  // null → no timestamp; otherwise an ISO string offset from today's midnight.
  if (msAgoFromMidnight === null) return { thread_id: id, title: id };
  const midnight = new Date(2026, 4, 29, 0, 0, 0).getTime();
  return {
    thread_id: id,
    title: id,
    updated_at: new Date(midnight - msAgoFromMidnight).toISOString()
  };
}

describe('groupThreadsByRecency', () => {
  it('buckets threads into Today / Yesterday / Previous 7 days / Older', () => {
    const threads = [
      t('today', -3 * 3600_000), // 03:00 today (midnight + 3h)
      t('yesterday', 5 * 3600_000), // 19:00 yesterday
      t('threeDaysAgo', 3 * DAY),
      t('lastMonth', 30 * DAY),
      t('noTs', null)
    ];
    const groups = groupThreadsByRecency(threads, NOW);
    const byLabel = Object.fromEntries(
      groups.map((g) => [g.label, g.threads.map((x) => x.thread_id)])
    );
    expect(byLabel['Today']).toEqual(['today']);
    expect(byLabel['Yesterday']).toEqual(['yesterday']);
    expect(byLabel['Previous 7 days']).toEqual(['threeDaysAgo']);
    expect(byLabel['Older']).toEqual(['lastMonth', 'noTs']);
  });

  it('omits empty groups and preserves order + fixed group ordering', () => {
    const groups = groupThreadsByRecency([t('a', -1000), t('b', -2000)], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Today');
    expect(groups[0].threads.map((x) => x.thread_id)).toEqual(['a', 'b']);
  });

  it('returns no groups for an empty list', () => {
    expect(groupThreadsByRecency([], NOW)).toEqual([]);
  });

  it('falls back to created_at when updated_at is absent', () => {
    const created: ThreadSummary = {
      thread_id: 'c',
      title: 'c',
      created_at: new Date(NOW - 40 * DAY).toISOString()
    };
    const groups = groupThreadsByRecency([created], NOW);
    expect(groups[0].label).toBe('Older');
  });
});
