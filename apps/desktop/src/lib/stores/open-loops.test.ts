// Tests for the open-loops (tracked commitments) store. Runtime singleton
// with `$state` runes — each test resets its in-memory shape and clears the
// LS_KEY persistence so cases don't leak. Exercises the public API plus the
// localStorage round-trip + defensive load.
//
// Vitest 4's experimental localStorage is missing the standard Storage
// methods in this jsdom path, so we install a tiny Map-backed shim per file
// (mirrors pins.test.ts — vitest.setup.ts is off-limits).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_LOOPS, openLoops } from './open-loops.svelte';

const LS_KEY = 'ironclaw-open-loops';

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

/** Reset both the in-memory state and the hydration guard so init() re-reads
 *  the (freshly shimmed) localStorage in each test. */
function resetStore() {
  openLoops.loops = [];
  // The `hydrated` guard is private; force a re-hydrate by clearing storage
  // and reassigning loops. Tests that need init() call it explicitly after
  // seeding LS, and the guard is per-singleton — so we reset it via a cast.
  (openLoops as unknown as { hydrated: boolean }).hydrated = false;
}

describe('open-loops store', () => {
  beforeEach(() => {
    installLocalStorageShim();
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it('add() trims, stores, and returns the loop', () => {
    const loop = openLoops.add('  send the budget revision  ');
    expect(loop).not.toBeNull();
    expect(loop?.text).toBe('send the budget revision');
    expect(openLoops.loops).toHaveLength(1);
    expect(openLoops.activeCount).toBe(1);
  });

  it('add() ignores empty / whitespace-only input', () => {
    expect(openLoops.add('')).toBeNull();
    expect(openLoops.add('   ')).toBeNull();
    expect(openLoops.loops).toHaveLength(0);
  });

  it('toggleDone() flips done and drops it from active', () => {
    const loop = openLoops.add('follow up with design');
    expect(openLoops.activeCount).toBe(1);
    openLoops.toggleDone(loop!.id);
    expect(openLoops.loops[0].done).toBe(true);
    expect(openLoops.activeCount).toBe(0);
    // activeTexts only includes not-done loops.
    expect(openLoops.activeTexts()).toEqual([]);
  });

  it('remove() deletes by id', () => {
    const a = openLoops.add('one');
    openLoops.add('two');
    openLoops.remove(a!.id);
    expect(openLoops.loops.map((l) => l.text)).toEqual(['two']);
  });

  it('setText() replaces text but ignores empty input', () => {
    const loop = openLoops.add('draft memo');
    openLoops.setText(loop!.id, 'draft the board memo');
    expect(openLoops.loops[0].text).toBe('draft the board memo');
    openLoops.setText(loop!.id, '   ');
    expect(openLoops.loops[0].text).toBe('draft the board memo');
  });

  it('clearDone() removes only completed loops', () => {
    const a = openLoops.add('done one');
    openLoops.add('still open');
    openLoops.toggleDone(a!.id);
    openLoops.clearDone();
    expect(openLoops.loops.map((l) => l.text)).toEqual(['still open']);
  });

  it('activeTexts() returns active commitment strings in order', () => {
    openLoops.add('first');
    openLoops.add('second');
    expect(openLoops.activeTexts()).toEqual(['first', 'second']);
  });

  it('persists across an init() round-trip', () => {
    openLoops.add('persist me');
    // New "session": clear memory + guard, then hydrate from the shim.
    openLoops.loops = [];
    (openLoops as unknown as { hydrated: boolean }).hydrated = false;
    openLoops.init();
    expect(openLoops.loops.map((l) => l.text)).toEqual(['persist me']);
  });

  it('coerces a corrupt persisted blob to a valid shape on load', () => {
    window.localStorage.setItem(
      LS_KEY,
      JSON.stringify([
        { id: 'ok', text: 'valid', done: false, createdAt: 1 },
        { text: '' }, // empty text — dropped
        42, // non-object — dropped
        { id: 'ok', text: 'dup id', done: false } // duplicate id — dropped
      ])
    );
    (openLoops as unknown as { hydrated: boolean }).hydrated = false;
    openLoops.loops = [];
    openLoops.init();
    expect(openLoops.loops).toHaveLength(1);
    expect(openLoops.loops[0].text).toBe('valid');
  });

  it('enforces the MAX_LOOPS cap, dropping the oldest', () => {
    for (let i = 0; i < MAX_LOOPS + 5; i++) openLoops.add(`loop ${i}`);
    expect(openLoops.loops).toHaveLength(MAX_LOOPS);
    // The freshest add survives; the oldest rolled off.
    expect(openLoops.loops.at(-1)?.text).toBe(`loop ${MAX_LOOPS + 4}`);
    expect(openLoops.loops.some((l) => l.text === 'loop 0')).toBe(false);
  });

  it('clear() empties everything', () => {
    openLoops.add('a');
    openLoops.add('b');
    openLoops.clear();
    expect(openLoops.loops).toHaveLength(0);
  });

  it('assigns a unique id to every loop (Review P2)', () => {
    for (let i = 0; i < 50; i++) openLoops.add(`loop ${i}`);
    const ids = openLoops.loops.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
