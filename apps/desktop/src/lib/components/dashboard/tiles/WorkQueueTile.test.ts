// Render tests for WorkQueueTile — Today's durable matter summary.
// The tile reads the workItems singleton; we seed its $state directly so the
// test stays local and never depends on gateway state.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

import WorkQueueTile from './WorkQueueTile.svelte';
import { createWorkItem } from '$lib/data/work-item';
import { workItems } from '$lib/stores/work-items.svelte';

const now = '2026-06-01T00:00:00.000Z';

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
  Object.defineProperty(window, 'localStorage', { configurable: true, value: shim });
}

beforeEach(() => {
  installLocalStorageShim();
  window.localStorage.removeItem('ironclaw-work-items');
  workItems.reload();
});

describe('WorkQueueTile', () => {
  it('shows an empty state when there are no live work items', () => {
    const { getByText, queryByTestId } = render(WorkQueueTile);
    expect(getByText('No live work yet')).toBeTruthy();
    expect(queryByTestId('work-queue-list')).toBeNull();
  });

  it('summarizes live matters, pending approvals, blocked items, and watches', () => {
    workItems.items = [
      createWorkItem({
        id: 'approval',
        now,
        title: 'Send renewal terms',
        objective: 'Prepare final terms.',
        domain: 'legal',
        status: 'waiting-approval',
        approvalBoundaries: [
          {
            id: 'gate-1',
            action: 'Send email',
            kind: 'send',
            payload: 'renewal email',
            reason: 'External send needs user approval.',
            status: 'pending'
          }
        ],
        artifacts: [
          {
            id: 'artifact-1',
            type: 'email',
            title: 'Renewal email',
            status: 'ready',
            provenance: ['runbook']
          }
        ]
      }),
      createWorkItem({
        id: 'blocked',
        now,
        title: 'Watch competitor launch',
        domain: 'research',
        status: 'blocked',
        watches: [
          {
            id: 'watch-1',
            trigger: 'pricing update',
            cadence: 'daily',
            source: 'site',
            next_check: null,
            escalation: 'alert user',
            status: 'active'
          }
        ]
      }),
      createWorkItem({
        id: 'done',
        now,
        title: 'Archived item',
        status: 'done'
      })
    ];

    const { getByText, getByTestId, queryByText } = render(WorkQueueTile);
    expect(getByTestId('work-queue-list')).toBeTruthy();
    expect(getByText('Send renewal terms')).toBeTruthy();
    expect(getByText('Watch competitor launch')).toBeTruthy();
    expect(queryByText('Archived item')).toBeNull();
    expect(getByText('Needs approval')).toBeTruthy();
    expect(getByText('1 ready artifacts across live work')).toBeTruthy();
  });
});
