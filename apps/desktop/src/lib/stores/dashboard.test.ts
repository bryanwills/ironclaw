// Tests for the dashboard tile-layout store.
//
// The store is a `$state`-rune singleton; each test resets the
// in-memory shape via `dashboard.tiles = [...]` and clears the
// localStorage key so cases don't leak. Same Map-backed shim as
// `pins.test.ts` — vitest 4 + jsdom currently ships a localStorage
// missing the standard methods on some paths, and `vitest.setup.ts`
// is off-limits per the task constraints.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dashboard, defaultTitleForKind, type TileConfig } from './dashboard.svelte';

const LS_KEY = 'ironclaw-dashboard-layout';

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

function resetDashboard() {
  // Manually replace the array so the store starts empty for each
  // test. The constructor's hydrate path runs once on import; we set
  // tiles directly here so the cases own the surface area.
  dashboard.tiles = [];
}

describe('dashboard store', () => {
  beforeEach(() => {
    installLocalStorageShim();
    resetDashboard();
  });

  afterEach(() => {
    resetDashboard();
  });

  it('add() appends a tile when its id is unique', () => {
    const tile: TileConfig = { id: 'recent-threads', kind: 'recent-threads', span: 2 };
    dashboard.add(tile);
    expect(dashboard.tiles).toHaveLength(1);
    expect(dashboard.tiles[0]).toEqual(tile);
  });

  it('add() is a no-op when the id is already present', () => {
    dashboard.add({ id: 'recent-threads', kind: 'recent-threads', span: 2 });
    dashboard.add({ id: 'recent-threads', kind: 'recent-threads', span: 4 });
    expect(dashboard.tiles).toHaveLength(1);
    expect(dashboard.tiles[0].span).toBe(2);
  });

  it('remove() drops a tile by id and persists', () => {
    dashboard.add({ id: 'a', kind: 'custom', span: 2 });
    dashboard.add({ id: 'b', kind: 'custom', span: 2 });
    dashboard.remove('a');
    expect(dashboard.tiles.map((t) => t.id)).toEqual(['b']);
  });

  it('reorder() moves a tile from one slot to another', () => {
    dashboard.add({ id: 'a', kind: 'custom', span: 2 });
    dashboard.add({ id: 'b', kind: 'custom', span: 2 });
    dashboard.add({ id: 'c', kind: 'custom', span: 2 });
    dashboard.reorder(0, 2);
    expect(dashboard.tiles.map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('setSpan() updates the span for a tile in place', () => {
    dashboard.add({ id: 'a', kind: 'custom', span: 2 });
    dashboard.setSpan('a', 4);
    expect(dashboard.tiles[0].span).toBe(4);
  });

  it('persists mutations to localStorage under LS_KEY and survives a roundtrip', () => {
    dashboard.add({ id: 'recent-threads', kind: 'recent-threads', span: 2 });
    dashboard.add({ id: 'active-routines', kind: 'active-routines', span: 4 });
    const raw = localStorage.getItem(LS_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as TileConfig[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('recent-threads');
    expect(parsed[1].span).toBe(4);
  });

  it('reset() restores the default tile layout and writes it through', () => {
    dashboard.tiles = [];
    dashboard.reset();
    expect(dashboard.tiles.length).toBeGreaterThan(0);
    const ids = dashboard.tiles.map((t) => t.id);
    expect(ids).toContain('work-queue');
    expect(ids).toContain('recent-threads');
    expect(ids).toContain('active-routines');
    expect(ids).toContain('recent-skills');
    const raw = localStorage.getItem(LS_KEY);
    expect(raw).not.toBeNull();
  });

  it('default layout includes the open-loops tile (R103)', () => {
    dashboard.tiles = [];
    dashboard.reset();
    expect(dashboard.tiles.map((t) => t.kind)).toContain('open-loops');
  });

  it('default layout includes the work queue tile', () => {
    dashboard.tiles = [];
    dashboard.reset();
    expect(dashboard.tiles.map((t) => t.kind)).toContain('work-queue');
  });

  it('add() accepts a work queue tile and persists it', () => {
    dashboard.tiles = [];
    dashboard.add({ id: 'work-queue', kind: 'work-queue', span: 4 });
    expect(dashboard.tiles.map((t) => t.kind)).toEqual(['work-queue']);
    const raw = localStorage.getItem(LS_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as TileConfig[];
    expect(parsed[0].kind).toBe('work-queue');
  });

  it('add() accepts an open-loops tile and persists it', () => {
    dashboard.tiles = [];
    dashboard.add({ id: 'open-loops', kind: 'open-loops', span: 2 });
    expect(dashboard.tiles.map((t) => t.kind)).toEqual(['open-loops']);
    const raw = localStorage.getItem(LS_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as TileConfig[];
    expect(parsed[0].kind).toBe('open-loops');
  });

  it('defaultTitleForKind labels the open-loops tile', () => {
    expect(defaultTitleForKind('open-loops')).toBe('Open loops');
  });

  it('defaultTitleForKind labels the work queue tile', () => {
    expect(defaultTitleForKind('work-queue')).toBe('Work queue');
  });
});
