// Tests for the Work Object Spine: the pure helpers in $lib/data/work-item
// and the persisted rune store here. The store is a runtime singleton with
// `$state` runes — each test resets its in-memory shape and the hydration
// guard, and installs a Map-backed localStorage shim per file (mirrors
// open-loops.test.ts / pins.test.ts; vitest.setup.ts deliberately does not
// provide localStorage).
//
// TODO(gateway): once the server-side work-item persistence contract exists
// (a `/api/work-items` style endpoint that owns matters across devices),
// add round-trip / sync tests here against that layer. Today the store is
// local-only, so these cover the localStorage cache + the pure helpers.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkItem, summarizeStatus, type WorkItem } from '$lib/data/work-item';
import { MAX_WORK_ITEMS, workItems } from './work-items.svelte';

const LS_KEY = 'ironclaw-work-items';

function installLocalStorageShim() {
  const store = new Map<string, string>();
  const shim = {
    get length() {
      return store.size;
    },
    key(i: number) {
      return Array.from(store.keys())[i] ?? null;
    },
    getItem(k: string) {
      return store.has(k) ? (store.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      store.set(String(k), String(v));
    },
    removeItem(k: string) {
      store.delete(k);
    },
    clear() {
      store.clear();
    }
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: shim });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: shim });
  }
}

/** Reset both the in-memory state and the hydration guard so hydrate()
 *  re-reads the (freshly shimmed) localStorage in each test. */
function resetStore() {
  workItems.items = [];
  (workItems as unknown as { hydrated: boolean }).hydrated = false;
}

describe('createWorkItem (pure)', () => {
  it('builds the documented default shape', () => {
    const w = createWorkItem({ id: 'w1', now: '2026-05-31T00:00:00.000Z', title: 'Acme matter' });
    expect(w).toEqual({
      id: 'w1',
      title: 'Acme matter',
      objective: '',
      domain: 'general',
      runbookIds: [],
      status: 'active',
      created_at: '2026-05-31T00:00:00.000Z',
      updated_at: '2026-05-31T00:00:00.000Z',
      links: [],
      dossier: [],
      approvalBoundaries: [],
      artifacts: [],
      watches: [],
      receipts: [],
      openApprovals: [],
      followUps: [],
      nextAction: null
    } satisfies WorkItem);
  });

  it('honours objective + domain overrides', () => {
    const w = createWorkItem({
      id: 'w2',
      now: '2026-05-31T00:00:00.000Z',
      title: 'Series A',
      objective: 'Close the round',
      domain: 'finance'
    });
    expect(w.objective).toBe('Close the round');
    expect(w.domain).toBe('finance');
  });

  it('is deterministic: same id + now => structurally identical object', () => {
    const a = createWorkItem({ id: 'same', now: '2026-01-01T12:00:00.000Z', title: 'T' });
    const b = createWorkItem({ id: 'same', now: '2026-01-01T12:00:00.000Z', title: 'T' });
    expect(a).toEqual(b);
    // Independent objects (no shared array references) so callers can mutate.
    expect(a).not.toBe(b);
    expect(a.links).not.toBe(b.links);
  });
});

describe('summarizeStatus (pure)', () => {
  function base(overrides: Partial<WorkItem> = {}): WorkItem {
    return {
      ...createWorkItem({ id: 'x', now: '2026-01-01T00:00:00.000Z', title: 'X' }),
      ...overrides
    };
  }

  it('active with no detail', () => {
    expect(summarizeStatus(base())).toBe('Active');
  });

  it('active surfaces the next action', () => {
    expect(summarizeStatus(base({ nextAction: 'send the redline' }))).toBe(
      'Active — next: send the redline'
    );
  });

  it('active falls back to follow-up counts', () => {
    expect(summarizeStatus(base({ followUps: ['ping legal'] }))).toBe('Active — 1 follow-up');
    expect(summarizeStatus(base({ followUps: ['a', 'b'] }))).toBe('Active — 2 follow-ups');
  });

  it('waiting-approval pluralizes approval counts', () => {
    expect(summarizeStatus(base({ status: 'waiting-approval' }))).toBe('Waiting on approval');
    expect(summarizeStatus(base({ status: 'waiting-approval', openApprovals: ['send'] }))).toBe(
      'Waiting on 1 approval'
    );
    expect(
      summarizeStatus(base({ status: 'waiting-approval', openApprovals: ['send', 'wire'] }))
    ).toBe('Waiting on 2 approvals');
  });

  it('blocked, done, archived', () => {
    expect(summarizeStatus(base({ status: 'blocked' }))).toBe('Blocked');
    expect(summarizeStatus(base({ status: 'blocked', nextAction: 'await counsel' }))).toBe(
      'Blocked — next: await counsel'
    );
    expect(summarizeStatus(base({ status: 'done' }))).toBe('Done');
    expect(summarizeStatus(base({ status: 'archived' }))).toBe('Archived');
  });
});

describe('work-items store', () => {
  beforeEach(() => {
    installLocalStorageShim();
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it('create() stamps id + timestamps and returns the item', () => {
    const item = workItems.create({
      title: '  Acme NDA  ',
      objective: ' review ',
      domain: 'legal'
    });
    expect(item).not.toBeNull();
    expect(item?.title).toBe('Acme NDA');
    expect(item?.objective).toBe('review');
    expect(item?.domain).toBe('legal');
    expect(item?.status).toBe('active');
    expect(item?.id).toBeTruthy();
    expect(item?.created_at).toBeTruthy();
    expect(item?.updated_at).toBe(item?.created_at);
    expect(workItems.items).toHaveLength(1);
    expect(workItems.activeCount).toBe(1);
  });

  it('create() ignores an empty / whitespace-only title', () => {
    expect(workItems.create({ title: '' })).toBeNull();
    expect(workItems.create({ title: '   ' })).toBeNull();
    expect(workItems.items).toHaveLength(0);
  });

  it('get() finds by id and returns undefined when absent', () => {
    const item = workItems.create({ title: 'Find me' });
    expect(workItems.get(item!.id)?.title).toBe('Find me');
    expect(workItems.get('nope')).toBeUndefined();
  });

  it('update() applies a patch and re-stamps updated_at', async () => {
    const item = workItems.create({ title: 'Patch me' });
    const before = item!.updated_at;
    // Ensure the clock advances so the stamp differs.
    await new Promise((r) => setTimeout(r, 2));
    const updated = workItems.update(item!.id, {
      status: 'waiting-approval',
      openApprovals: ['send the wire'],
      nextAction: 'confirm bank details'
    });
    expect(updated?.status).toBe('waiting-approval');
    expect(updated?.openApprovals).toEqual(['send the wire']);
    expect(updated?.nextAction).toBe('confirm bank details');
    expect(updated?.created_at).toBe(item!.created_at);
    expect(updated?.updated_at).not.toBe(before);
    expect(workItems.get(item!.id)?.status).toBe('waiting-approval');
  });

  it('update() is a no-op for an unknown id', () => {
    expect(workItems.update('ghost', { status: 'done' })).toBeUndefined();
  });

  it('updateApprovalBoundary() approves a boundary and clears waiting state when unblocked', () => {
    const item = workItems.create({
      title: 'Approve send',
      status: 'waiting-approval',
      approvalBoundaries: [
        {
          id: 'approval-send',
          action: 'Send reply',
          kind: 'send',
          payload: 'Outbound reply',
          reason: 'User approval required.',
          status: 'pending'
        }
      ],
      openApprovals: ['Send reply'],
      nextAction: 'Review approval: Send reply'
    });

    const updated = workItems.updateApprovalBoundary(item!.id, 'approval-send', 'approved');

    expect(updated?.approvalBoundaries[0]).toEqual(
      expect.objectContaining({ id: 'approval-send', status: 'approved' })
    );
    expect(updated?.status).toBe('active');
    expect(updated?.openApprovals).toEqual([]);
    expect(updated?.nextAction).toBe('Approved; continue the work.');
  });

  it('updateApprovalBoundary() keeps a matter blocked when required context is missing', () => {
    const item = workItems.create({
      title: 'Missing dossier',
      status: 'blocked',
      dossier: [
        {
          label: 'Inbox, queue, or backlog to triage',
          state: 'missing',
          provenance: 'runbook:operations'
        }
      ],
      approvalBoundaries: [
        {
          id: 'approval-send',
          action: 'Send reply',
          kind: 'send',
          payload: 'Outbound reply',
          reason: 'User approval required.',
          status: 'pending'
        }
      ],
      openApprovals: ['Send reply']
    });

    const updated = workItems.updateApprovalBoundary(item!.id, 'approval-send', 'approved');

    expect(updated?.approvalBoundaries[0]?.status).toBe('approved');
    expect(updated?.status).toBe('blocked');
    expect(updated?.openApprovals).toEqual([]);
  });

  it('updateApprovalBoundary() keeps explicit other approval gates waiting until resolved', () => {
    const item = workItems.create({
      title: 'Runbook gate',
      status: 'waiting-approval',
      approvalBoundaries: [
        {
          id: 'approval-runbook',
          action: 'Review runbook gate',
          kind: 'other',
          payload: 'A runbook approval-required step.',
          reason: 'Runbook requires explicit user approval.',
          status: 'pending'
        },
        {
          id: 'approval-send',
          action: 'Send reply',
          kind: 'send',
          payload: 'Outbound reply',
          reason: 'User approval required.',
          status: 'pending'
        }
      ],
      openApprovals: ['Review runbook gate', 'Send reply'],
      nextAction: 'Review approval: Review runbook gate'
    });

    const updated = workItems.updateApprovalBoundary(item!.id, 'approval-send', 'approved');

    expect(updated?.status).toBe('waiting-approval');
    expect(updated?.openApprovals).toEqual(['Review runbook gate']);
    expect(updated?.nextAction).toBe('Review approval: Review runbook gate');
  });

  it('updateApprovalBoundary() denies a boundary and blocks the matter', () => {
    const item = workItems.create({
      title: 'Deny send',
      status: 'waiting-approval',
      approvalBoundaries: [
        {
          id: 'approval-send',
          action: 'Send reply',
          kind: 'send',
          payload: 'Outbound reply',
          reason: 'User approval required.',
          status: 'pending'
        }
      ],
      openApprovals: ['Send reply']
    });

    const updated = workItems.updateApprovalBoundary(item!.id, 'approval-send', 'denied');

    expect(updated?.approvalBoundaries[0]?.status).toBe('denied');
    expect(updated?.status).toBe('blocked');
    expect(updated?.openApprovals).toEqual([]);
    expect(updated?.nextAction).toBe('Revise the ask or approval boundary.');
  });

  it('runDueWatches() fires due watches, writes receipts, and rearms recurring cadence', () => {
    const now = new Date('2026-06-01T10:00:00.000Z');
    const item = workItems.create({
      title: 'Watch competitor pricing',
      watches: [
        {
          id: 'watch-pricing',
          trigger: 'competitor pricing changes',
          cadence: 'daily',
          source: 'competitor site',
          next_check: '2026-06-01T09:59:00.000Z',
          escalation: 'Surface material pricing changes before drafting a response.',
          status: 'active'
        },
        {
          id: 'watch-later',
          trigger: 'later event',
          cadence: 'daily',
          source: 'calendar',
          next_check: '2026-06-02T09:59:00.000Z',
          escalation: 'Not due yet.',
          status: 'active'
        }
      ]
    });

    const receipts = workItems.runDueWatches(now);
    const updated = workItems.get(item!.id)!;

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toEqual(
      expect.objectContaining({
        kind: 'watch',
        title: 'Checked competitor pricing changes',
        source: 'competitor site',
        status: 'handled',
        created_at: '2026-06-01T10:00:00.000Z'
      })
    );
    expect(updated.receipts[0]).toEqual(receipts[0]);
    expect(updated.watches.find((watch) => watch.id === 'watch-pricing')?.next_check).toBe(
      '2026-06-02T10:00:00.000Z'
    );
    expect(updated.watches.find((watch) => watch.id === 'watch-pricing')?.status).toBe('active');
    expect(updated.watches.find((watch) => watch.id === 'watch-later')?.next_check).toBe(
      '2026-06-02T09:59:00.000Z'
    );
    expect(updated.nextAction).toBe('Review watch receipt: Checked competitor pricing changes');
  });

  it('runDueWatches() completes one-shot watches with a handled receipt', () => {
    const item = workItems.create({
      title: 'One-shot watch',
      watches: [
        {
          id: 'watch-once',
          trigger: 'signed term sheet arrives',
          cadence: 'once',
          source: 'gmail',
          next_check: '2026-06-01T09:00:00.000Z',
          escalation: 'Tell the user to review it.',
          status: 'active'
        }
      ]
    });

    const receipts = workItems.runDueWatches(new Date('2026-06-01T10:00:00.000Z'));
    const updated = workItems.get(item!.id)!;

    expect(receipts).toHaveLength(1);
    expect(updated.watches[0].status).toBe('done');
    expect(updated.watches[0].next_check).toBeNull();
    expect(updated.receipts[0].title).toBe('Checked signed term sheet arrives');
  });

  it('activeCount excludes done + archived', () => {
    const a = workItems.create({ title: 'a' });
    const b = workItems.create({ title: 'b' });
    workItems.create({ title: 'c' });
    expect(workItems.activeCount).toBe(3);
    workItems.update(a!.id, { status: 'done' });
    workItems.update(b!.id, { status: 'archived' });
    expect(workItems.activeCount).toBe(1);
  });

  it('remove() deletes by id', () => {
    const a = workItems.create({ title: 'one' });
    workItems.create({ title: 'two' });
    workItems.remove(a!.id);
    expect(workItems.items.map((w) => w.title)).toEqual(['two']);
  });

  it('persists across a hydrate() round-trip', () => {
    const created = workItems.create({
      title: 'persist me',
      objective: 'do the thing',
      domain: 'research'
    });
    // New "session": clear memory + guard, then hydrate from the shim.
    workItems.items = [];
    (workItems as unknown as { hydrated: boolean }).hydrated = false;
    workItems.hydrate();
    expect(workItems.items).toHaveLength(1);
    const loaded = workItems.items[0];
    expect(loaded.title).toBe('persist me');
    expect(loaded.objective).toBe('do the thing');
    expect(loaded.domain).toBe('research');
    expect(loaded.id).toBe(created!.id);
  });

  it('coerces a corrupt persisted blob to a valid shape on load', () => {
    window.localStorage.setItem(
      LS_KEY,
      JSON.stringify([
        {
          id: 'ok',
          title: 'valid',
          objective: 'o',
          domain: 'bogus-domain',
          status: 'bogus-status',
          links: [
            { kind: 'thread', ref: 't1', label: 'Thread 1' },
            { kind: 'nope', ref: 'x' }
          ],
          openApprovals: ['approve', 42],
          followUps: 'not-an-array',
          nextAction: ''
        },
        { title: 'no id — dropped' },
        { id: 'no-title' },
        42,
        { id: 'ok', title: 'dup id — dropped' }
      ])
    );
    (workItems as unknown as { hydrated: boolean }).hydrated = false;
    workItems.items = [];
    workItems.hydrate();
    expect(workItems.items).toHaveLength(1);
    const w = workItems.items[0];
    expect(w.title).toBe('valid');
    expect(w.domain).toBe('general'); // bad enum coerced to default
    expect(w.status).toBe('active'); // bad enum coerced to default
    expect(w.links).toEqual([{ kind: 'thread', ref: 't1', label: 'Thread 1' }]); // bad link dropped
    expect(w.openApprovals).toEqual(['approve']); // non-string dropped
    expect(w.followUps).toEqual([]); // non-array coerced to []
    expect(w.nextAction).toBeNull(); // empty string coerced to null
  });

  it('enforces the MAX_WORK_ITEMS cap, dropping the oldest', () => {
    workItems.items = Array.from({ length: MAX_WORK_ITEMS }, (_v, i) => {
      const n = MAX_WORK_ITEMS - 1 - i;
      return createWorkItem({
        id: `seed-${n}`,
        now: `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`,
        title: `item ${n}`
      });
    });

    workItems.create({ title: `item ${MAX_WORK_ITEMS}` });

    expect(workItems.items).toHaveLength(MAX_WORK_ITEMS);
    // Newest-first: the freshest create is at the head; the oldest rolled off.
    expect(workItems.items[0].title).toBe(`item ${MAX_WORK_ITEMS}`);
    expect(workItems.items.some((w) => w.title === 'item 0')).toBe(false);
  });

  it('assigns a unique id to every item', () => {
    for (let i = 0; i < 50; i++) workItems.create({ title: `item ${i}` });
    const ids = workItems.items.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('clear() empties everything', () => {
    workItems.create({ title: 'a' });
    workItems.create({ title: 'b' });
    workItems.clear();
    expect(workItems.items).toHaveLength(0);
  });
});
