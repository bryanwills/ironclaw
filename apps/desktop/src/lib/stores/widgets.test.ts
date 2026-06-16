import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PromotableBlock, Widget } from '$lib/api/types';
import { WidgetsStore } from './widgets.svelte';

const LS_KEY = 'ironclaw-widgets';

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

function block(overrides: Partial<PromotableBlock> = {}): PromotableBlock {
  return {
    kind: 'table',
    title: 'TEE hardware comparison',
    payload: {
      headers: ['Feature', 'SGX', 'SEV'],
      rows: [
        ['Isolation', 'Enclave', 'VM'],
        ['Attestation', 'EPID/DCAP', 'SNP report']
      ]
    },
    source: { thread_id: 't1', message_id: 'm1', query: 'compare TEEs' },
    ...overrides
  };
}

function widget(overrides: Partial<Widget> = {}): Widget {
  const now = new Date(0).toISOString();
  return {
    id: 'wgt-existing',
    kind: 'text',
    title: 'Existing',
    source: {},
    payload: 'body',
    pinned_to: [],
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

describe('widgets store', () => {
  beforeEach(() => {
    vi.useRealTimers();
    installLocalStorageShim();
  });

  it('promote(block) creates a widget with a wgt-prefixed id', () => {
    const store = new WidgetsStore();
    const promoted = store.promote(block());

    expect(promoted.id).toMatch(/^wgt-\d+-[a-z0-9]{6}$/u);
    expect(promoted.title).toBe('TEE hardware comparison');
    expect(promoted.source).toEqual({
      thread_id: 't1',
      message_id: 'm1',
      query: 'compare TEEs'
    });
    // Svelte 5 wraps $state objects in a Proxy, so strict identity
    // (toBe) fails — assert shape equality instead.
    expect(store.byId[promoted.id]).toEqual(promoted);
  });

  it('pin/unpin toggles pinned_to for a widget', () => {
    const store = new WidgetsStore();
    const promoted = store.promote(block());

    store.pin(promoted.id, 'dashboard');
    expect(store.byId[promoted.id].pinned_to).toEqual(['dashboard']);

    store.unpin(promoted.id, 'dashboard');
    expect(store.byId[promoted.id].pinned_to).toEqual([]);
  });

  it('storage round-trips through localStorage across store instances', () => {
    const first = new WidgetsStore();
    const promoted = first.promote(block({ title: 'Round trip' }));
    first.pin(promoted.id, 'dashboard');

    const second = new WidgetsStore();
    expect(second.byId[promoted.id]?.title).toBe('Round trip');
    expect(second.byId[promoted.id]?.pinned_to).toEqual(['dashboard']);
  });

  it('hydrates existing widget blobs from localStorage', () => {
    const existing = widget({ id: 'wgt-123', pinned_to: ['canvas'] });
    localStorage.setItem(LS_KEY, JSON.stringify({ [existing.id]: existing }));

    const store = new WidgetsStore();
    expect(store.byId['wgt-123']).toEqual(existing);
  });

  it('rejects prototype-pollution keys while hydrating', () => {
    const existing = widget({ id: 'wgt-safe' });
    localStorage.setItem(
      LS_KEY,
      `{"__proto__":{"id":"wgt-bad","kind":"text","title":"bad","source":{},"payload":"","pinned_to":[],"created_at":"x","updated_at":"x"},"wgt-safe":${JSON.stringify(
        existing
      )}}`
    );

    const store = new WidgetsStore();
    expect(store.byId['wgt-safe']).toEqual(existing);
    expect(Object.prototype).not.toHaveProperty('id');
    expect(store.byId).not.toHaveProperty('__proto__');
  });
});
