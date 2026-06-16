// Tests for the cross-surface pin store. The store is a runtime
// singleton with `$state` runes, so each test resets its in-memory
// shape via `pins.pins = …` and clears the LS_KEY persistence so
// cases don't leak into one another.
//
// We exercise the public API only: `pin` / `unpin` / `isPinned` /
// `all()` + the localStorage round-trip. The cap behaviour (`pin`
// dropping the oldest entry when over MAX_PER_SURFACE) is the most
// load-bearing case — it's the bug that would silently grow the
// on-disk blob without it.
//
// Vitest 4 ships an experimental localStorage that's missing the
// standard Storage methods in this jsdom path; we install a tiny
// Map-backed shim per file (test files only — `vitest.setup.ts` is
// off-limits per the task constraints).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_PER_SURFACE, pins } from './pins.svelte';

const LS_KEY = 'ironclaw-pins';

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

function resetPins() {
  pins.pins = {
    skill: [],
    routine: [],
    knowledge: [],
    thread: [],
    extension: []
  };
}

describe('pins store', () => {
  beforeEach(() => {
    installLocalStorageShim();
    resetPins();
  });

  afterEach(() => {
    resetPins();
  });

  it('pin() adds an id to the surface list', () => {
    pins.pin('skill', 'foo');
    expect(pins.pins.skill).toContain('foo');
  });

  it('unpin() removes an id from the surface list', () => {
    pins.pin('skill', 'foo');
    expect(pins.isPinned('skill', 'foo')).toBe(true);
    pins.unpin('skill', 'foo');
    expect(pins.isPinned('skill', 'foo')).toBe(false);
    expect(pins.pins.skill).not.toContain('foo');
  });

  it('isPinned() is true after pin and false after unpin', () => {
    expect(pins.isPinned('routine', 'r1')).toBe(false);
    pins.pin('routine', 'r1');
    expect(pins.isPinned('routine', 'r1')).toBe(true);
    pins.unpin('routine', 'r1');
    expect(pins.isPinned('routine', 'r1')).toBe(false);
  });

  it('pin() is idempotent — pinning the same id twice is a no-op', () => {
    pins.pin('skill', 'foo');
    pins.pin('skill', 'foo');
    expect(pins.pins.skill.filter((id) => id === 'foo')).toHaveLength(1);
  });

  it('caps the surface at MAX_PER_SURFACE; pinning one extra drops the oldest', () => {
    // Fill to the cap.
    for (let i = 0; i < MAX_PER_SURFACE; i += 1) {
      pins.pin('skill', `s${i}`);
    }
    expect(pins.pins.skill).toHaveLength(MAX_PER_SURFACE);
    expect(pins.pins.skill[0]).toBe('s0');

    // 21st pin → oldest (s0) rolls off.
    pins.pin('skill', 'overflow');
    expect(pins.pins.skill).toHaveLength(MAX_PER_SURFACE);
    expect(pins.pins.skill).not.toContain('s0');
    expect(pins.pins.skill[pins.pins.skill.length - 1]).toBe('overflow');
  });

  it('all() returns a flat list across every surface in declaration order', () => {
    pins.pin('skill', 's1');
    pins.pin('routine', 'r1');
    pins.pin('knowledge', 'k1');
    pins.pin('thread', 't1');
    pins.pin('extension', 'e1');

    const flat = pins.all();
    expect(flat).toEqual([
      { surface: 'skill', id: 's1' },
      { surface: 'routine', id: 'r1' },
      { surface: 'knowledge', id: 'k1' },
      { surface: 'thread', id: 't1' },
      { surface: 'extension', id: 'e1' }
    ]);
  });

  it('persists mutations to localStorage under the LS_KEY blob', () => {
    pins.pin('skill', 'foo');
    pins.pin('routine', 'bar');
    const raw = localStorage.getItem(LS_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Record<string, string[]>;
    expect(parsed.skill).toContain('foo');
    expect(parsed.routine).toContain('bar');
  });
});
