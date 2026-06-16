import assert from 'node:assert/strict';
import test from 'node:test';

import { THREAD_STATE } from '../../../lib/thread-state.js';
import { buildFrontDoorData, relativeAge } from './frontdoor-data.js';

const now = Date.parse('2026-06-13T18:00:00.000Z');

test('buildFrontDoorData ranks backed needs-you threads before ordinary recent work', () => {
  const data = buildFrontDoorData({
    now,
    threadStates: new Map([
      ['legal-approval', THREAD_STATE.NEEDS_ATTENTION],
      ['failed-run', THREAD_STATE.FAILED]
    ]),
    threads: [
      {
        id: 'legal-approval',
        title: 'Legal review approval',
        updated_at: '2026-06-13T17:45:00.000Z',
        turn_count: 4
      },
      {
        id: 'recent-thread',
        title: 'Draft launch memo',
        updated_at: '2026-06-13T16:00:00.000Z',
        turn_count: 3
      },
      {
        id: 'failed-run',
        title: 'Workspace sync recovery',
        updated_at: '2026-06-13T17:50:00.000Z',
        turn_count: 2
      }
    ],
    automations: []
  });

  assert.deepEqual(
    data.needsYou.map((item) => [item.title, item.badge, item.href]),
    [
      ['Workspace sync recovery', 'Needs recovery', '/chat/failed-run'],
      ['Legal review approval', 'Needs approval', '/chat/legal-approval']
    ]
  );
  assert.deepEqual(
    data.handled.map((item) => item.title),
    ['Draft launch memo']
  );
  assert.equal(data.handled[0].badge, 'Recent work');
  // With ≤ limit needs-you items, the true total equals the rendered count.
  assert.equal(data.needsYouTotal, 2);
});

test('buildFrontDoorData reports the true needs-you total even when rows are truncated', () => {
  const threadStates = new Map();
  const threads = [];
  for (let i = 0; i < 5; i += 1) {
    threadStates.set(`gate-${i}`, THREAD_STATE.NEEDS_ATTENTION);
    threads.push({
      id: `gate-${i}`,
      title: `Pending ${i}`,
      updated_at: `2026-06-13T1${i}:00:00.000Z`
    });
  }
  const data = buildFrontDoorData({ now, threadStates, threads, automations: [], limit: 3 });
  // Only the top 3 rows render, but the badge must report all 5 waiting.
  assert.equal(data.needsYou.length, 3);
  assert.equal(data.needsYouTotal, 5);
});

test('buildFrontDoorData surfaces completed automation receipts without faking failed ones', () => {
  const data = buildFrontDoorData({
    now,
    threads: [],
    automations: [
      {
        id: 'daily-digest',
        display_name: 'Daily digest',
        last_status: 'ok',
        last_run_at: '2026-06-13T17:30:00.000Z',
        last_run_label: 'Jun 13, 05:30 PM'
      },
      {
        id: 'broken-digest',
        display_name: 'Broken digest',
        last_status: 'error',
        last_run_at: '2026-06-13T17:50:00.000Z'
      }
    ]
  });

  assert.equal(data.needsYou.length, 0);
  assert.equal(data.handled.length, 1);
  assert.equal(data.handled[0].title, 'Daily digest');
  assert.equal(data.handled[0].badge, 'Completed');
  assert.equal(data.handled[0].href, '/automations');
});

test('relativeAge keeps the front door compact', () => {
  assert.equal(relativeAge('2026-06-13T17:59:00.000Z', now), '1m ago');
  assert.equal(relativeAge('2026-06-13T16:00:00.000Z', now), '2h ago');
  assert.equal(relativeAge('2026-06-11T18:00:00.000Z', now), '2d ago');
  assert.equal(relativeAge('', now), '');
});

test('buildFrontDoorData surfaces automations that ran since the last-seen watermark', () => {
  const lastSeenAt = Date.parse('2026-06-13T12:00:00.000Z');
  const automations = [
    {
      id: 'a',
      display_name: 'Digest',
      last_status: 'ok',
      last_run_at: '2026-06-13T15:00:00.000Z',
      last_run_label: '3:00 PM'
    },
    {
      id: 'b',
      display_name: 'Sync',
      last_status: 'failed',
      last_run_at: '2026-06-13T17:30:00.000Z'
    },
    {
      id: 'c',
      display_name: 'Old run',
      last_status: 'ok',
      last_run_at: '2026-06-13T09:00:00.000Z'
    },
    {
      id: 'd',
      display_name: 'In flight',
      last_status: 'running',
      last_run_at: '2026-06-13T17:45:00.000Z'
    }
  ];
  const data = buildFrontDoorData({ now, lastSeenAt, automations, threads: [] });
  // Newest settled run first; pre-watermark and non-terminal runs excluded.
  assert.deepEqual(
    data.sinceAway.map((item) => [item.title, item.badge, item.href]),
    [
      ['Sync', 'Failed', '/automations'],
      ['Digest', 'Completed', '/automations']
    ]
  );
  assert.equal(data.sinceAwayTotal, 2);
});

test('buildFrontDoorData shows nothing "since away" on a first visit (no watermark)', () => {
  const automations = [
    { id: 'a', display_name: 'Digest', last_status: 'ok', last_run_at: '2026-06-13T17:00:00.000Z' }
  ];
  const data = buildFrontDoorData({ now, lastSeenAt: 0, automations, threads: [] });
  assert.deepEqual(data.sinceAway, []);
  assert.equal(data.sinceAwayTotal, 0);
});

test('a completed automation shown under "since away" is not duplicated under handled', () => {
  const lastSeenAt = Date.parse('2026-06-13T12:00:00.000Z');
  const automations = [
    {
      id: 'recent',
      display_name: 'Recent digest',
      last_status: 'ok',
      last_run_at: '2026-06-13T16:00:00.000Z'
    },
    {
      id: 'older',
      display_name: 'Older digest',
      last_status: 'ok',
      last_run_at: '2026-06-13T08:00:00.000Z'
    }
  ];
  const data = buildFrontDoorData({ now, lastSeenAt, automations, threads: [] });
  assert.deepEqual(
    data.sinceAway.map((i) => i.title),
    ['Recent digest']
  );
  // The recent one is under "since away"; only the older completed run remains in handled.
  assert.deepEqual(
    data.handled.map((i) => i.title),
    ['Older digest']
  );
});

test('buildFrontDoorData on a fully cold desk yields empty needs-you and handled (honest empty front door)', () => {
  const data = buildFrontDoorData({
    now,
    lastSeenAt: null,
    automations: [],
    threads: [],
    threadStates: new Map(),
  });
  assert.deepEqual(data.needsYou, []);
  assert.equal(data.needsYouTotal, 0);
  assert.deepEqual(data.handled, []);
  assert.deepEqual(data.sinceAway, []);
});

test('a thread carrying only an in-thread state that is not NEEDS_ATTENTION/FAILED does not appear in needs-you', () => {
  const data = buildFrontDoorData({
    now,
    threadStates: new Map([['busy-thread', THREAD_STATE.RUNNING]]),
    threads: [
      { id: 'busy-thread', title: 'Working thread', updated_at: '2026-06-13T17:50:00.000Z' },
    ],
  });
  assert.equal(
    data.needsYou.some((row) => row.id === 'busy-thread'),
    false,
  );
});
