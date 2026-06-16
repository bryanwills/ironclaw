// Group Reborn v2 threads into recency buckets for the chat rail —
// "Today / Yesterday / Previous 7 days / Older", the conventional
// conversation-list grouping. Pure + `now`-injectable so it unit-tests
// without a clock. Server order (most-recent-first) is preserved within
// each bucket; a thread with no parseable timestamp falls to "Older".

import type { ThreadSummary } from '$lib/api/reborn';

export interface ThreadGroup {
  label: string;
  threads: ThreadSummary[];
}

const DAY_MS = 86_400_000;

/** Local midnight for the day containing epoch-ms `t`. */
function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Recency label for a thread timestamp relative to `now`. */
function bucketFor(ts: number, now: number): string {
  if (!Number.isFinite(ts)) return 'Older';
  const todayStart = startOfDay(now);
  if (ts >= todayStart) return 'Today';
  if (ts >= todayStart - DAY_MS) return 'Yesterday';
  if (ts >= todayStart - 6 * DAY_MS) return 'Previous 7 days';
  return 'Older';
}

/**
 * Bucket `threads` by `updated_at` (falling back to `created_at`) into
 * recency groups. Returns only non-empty groups, in fixed display order,
 * preserving the input order within each group.
 */
export function groupThreadsByRecency(
  threads: ThreadSummary[],
  now: number = Date.now()
): ThreadGroup[] {
  const buckets: Record<string, ThreadSummary[]> = {
    Today: [],
    Yesterday: [],
    'Previous 7 days': [],
    Older: []
  };
  for (const t of threads) {
    const raw = t.updated_at || t.created_at;
    const ts = raw ? Date.parse(raw) : NaN;
    buckets[bucketFor(ts, now)].push(t);
  }
  return (['Today', 'Yesterday', 'Previous 7 days', 'Older'] as const)
    .filter((label) => buckets[label].length > 0)
    .map((label) => ({ label, threads: buckets[label] }));
}
