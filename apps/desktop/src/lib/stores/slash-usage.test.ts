// Tests for the slash-command usage-frequency store. Exercise the
// public API only: `record` / `score` / `cleanup` + the
// localStorage round-trip. Recency decay is the load-bearing case
// — `score()` must drop to zero past the 14-day window — and the
// cleanup cap is the case that would otherwise silently bloat the
// on-disk blob.
//
// We freeze "now" via `vi.useFakeTimers` so the recency-decay tests
// are deterministic. The localStorage shim matches the pattern from
// `pins.test.ts` (vitest.setup.ts is off-limits so we install per-file).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENTRY_TTL_DAYS,
  MAX_ENTRIES,
  RECENCY_HALF_LIFE_DAYS,
  slashUsage
} from './slash-usage.svelte';

const LS_KEY = 'ironclaw-slash-usage';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

function resetStore() {
  slashUsage.entries = new Map();
  // Reset the hydration flag via a fresh init() in tests that need
  // to hydrate; the field is private so we work around it by
  // toggling the entries directly here. This is consistent with how
  // `pins.test.ts` resets the pins map.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (slashUsage as any).hydrated = false;
}

describe('slash-usage store', () => {
  beforeEach(() => {
    installLocalStorageShim();
    resetStore();
    vi.useFakeTimers();
    // Fixed wall-clock so recency math is deterministic across runs.
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetStore();
  });

  it('record() creates an entry with count 1 and a timestamp', () => {
    slashUsage.record('code-review');
    const e = slashUsage.entries.get('code-review');
    expect(e).toBeDefined();
    expect(e?.count).toBe(1);
    expect(e?.skillName).toBe('code-review');
    expect(e?.lastUsedAt).toBe('2026-06-01T12:00:00.000Z');
  });

  it('record() increments the count and bumps the timestamp on subsequent calls', () => {
    slashUsage.record('code-review');
    vi.setSystemTime(new Date('2026-06-02T12:00:00.000Z'));
    slashUsage.record('code-review');
    slashUsage.record('code-review');
    const e = slashUsage.entries.get('code-review');
    expect(e?.count).toBe(3);
    expect(e?.lastUsedAt).toBe('2026-06-02T12:00:00.000Z');
  });

  it('record() ignores empty skill names', () => {
    slashUsage.record('');
    expect(slashUsage.entries.size).toBe(0);
  });

  it('score() returns 0 for never-used skills', () => {
    expect(slashUsage.score('never-run')).toBe(0);
  });

  it('score() returns count when the entry is fresh (today)', () => {
    slashUsage.record('foo');
    slashUsage.record('foo');
    slashUsage.record('foo');
    // 3 records, age = 0 → recency factor ~= 1.0 → score = 3.
    expect(slashUsage.score('foo')).toBe(3);
  });

  it('score() halves at RECENCY_HALF_LIFE_DAYS (~7d)', () => {
    slashUsage.record('foo');
    slashUsage.record('foo'); // count = 2
    vi.setSystemTime(new Date(Date.now() + RECENCY_HALF_LIFE_DAYS * MS_PER_DAY));
    // recency = 1 - 7/14 = 0.5; count = 2 → score = 1.0.
    expect(slashUsage.score('foo')).toBeCloseTo(1.0, 5);
  });

  it('score() decays to 0 past the 14-day zero point', () => {
    slashUsage.record('foo');
    vi.setSystemTime(new Date(Date.now() + 14 * MS_PER_DAY));
    expect(slashUsage.score('foo')).toBe(0);
    vi.setSystemTime(new Date(Date.now() + 1000 * MS_PER_DAY));
    expect(slashUsage.score('foo')).toBe(0);
  });

  it('score() ranks a frequently-used recent skill higher than a once-used recent skill', () => {
    slashUsage.record('frequent');
    slashUsage.record('frequent');
    slashUsage.record('frequent');
    slashUsage.record('frequent');
    slashUsage.record('frequent');
    slashUsage.record('rare');
    expect(slashUsage.score('frequent')).toBeGreaterThan(slashUsage.score('rare'));
  });

  it('cleanup() drops entries older than ENTRY_TTL_DAYS', () => {
    slashUsage.record('old');
    slashUsage.record('fresh');
    // Manually age the "old" entry past the TTL.
    const old = slashUsage.entries.get('old')!;
    const m = new Map(slashUsage.entries);
    m.set('old', {
      ...old,
      lastUsedAt: new Date(Date.now() - (ENTRY_TTL_DAYS + 1) * MS_PER_DAY).toISOString()
    });
    slashUsage.entries = m;

    slashUsage.cleanup();

    expect(slashUsage.entries.has('old')).toBe(false);
    expect(slashUsage.entries.has('fresh')).toBe(true);
  });

  it('cleanup() caps at MAX_ENTRIES, keeping the most-recent', () => {
    // Seed (MAX_ENTRIES + 5) records across a span of days so the cap
    // has something to trim. Each record is one day "newer" than the
    // last, so the youngest skill names should survive.
    const baseDay = new Date('2026-06-01T00:00:00.000Z').getTime();
    const m = new Map<
      string,
      ReturnType<typeof slashUsage.entries.values> extends IterableIterator<infer V> ? V : never
    >();
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
      const ts = new Date(baseDay + i * 60_000).toISOString(); // 1-minute steps
      m.set(`skill-${i}`, { skillName: `skill-${i}`, count: 1, lastUsedAt: ts });
    }
    slashUsage.entries = m;

    // Make "now" newer than all the timestamps so cleanup doesn't
    // TTL-drop everything.
    vi.setSystemTime(new Date(baseDay + (MAX_ENTRIES + 10) * 60_000));

    slashUsage.cleanup();

    expect(slashUsage.entries.size).toBe(MAX_ENTRIES);
    // The 5 oldest (skill-0 .. skill-4) should be the ones dropped.
    expect(slashUsage.entries.has('skill-0')).toBe(false);
    expect(slashUsage.entries.has('skill-4')).toBe(false);
    expect(slashUsage.entries.has(`skill-${MAX_ENTRIES + 4}`)).toBe(true);
  });

  it('persists records to localStorage under the LS_KEY blob', () => {
    slashUsage.record('foo');
    slashUsage.record('bar');
    const raw = localStorage.getItem(LS_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Array<{
      skillName: string;
      count: number;
      lastUsedAt: string;
    }>;
    const names = parsed.map((p) => p.skillName).sort();
    expect(names).toEqual(['bar', 'foo']);
  });

  it('init() rehydrates the map from localStorage and runs cleanup', () => {
    // Stuff a valid blob into storage BEFORE init() runs.
    const blob = [
      { skillName: 'fresh', count: 4, lastUsedAt: new Date(Date.now() - MS_PER_DAY).toISOString() },
      {
        skillName: 'ancient',
        count: 10,
        lastUsedAt: new Date(Date.now() - (ENTRY_TTL_DAYS + 5) * MS_PER_DAY).toISOString()
      }
    ];
    localStorage.setItem(LS_KEY, JSON.stringify(blob));

    slashUsage.init();

    expect(slashUsage.entries.has('fresh')).toBe(true);
    // Cleanup dropped the entry past the TTL.
    expect(slashUsage.entries.has('ancient')).toBe(false);
  });

  it('init() is idempotent — calling twice is safe', () => {
    slashUsage.record('foo');
    const sizeBefore = slashUsage.entries.size;
    slashUsage.init();
    slashUsage.init();
    expect(slashUsage.entries.size).toBe(sizeBefore);
  });

  it('init() tolerates corrupt JSON in localStorage', () => {
    localStorage.setItem(LS_KEY, '{not valid json');
    slashUsage.init();
    expect(slashUsage.entries.size).toBe(0);
  });

  it('init() drops entries with missing fields', () => {
    const blob = [
      { skillName: 'ok', count: 1, lastUsedAt: new Date().toISOString() },
      { skillName: 'no-count', lastUsedAt: new Date().toISOString() },
      { count: 2, lastUsedAt: new Date().toISOString() }, // no name
      { skillName: 'bad-time', count: 1, lastUsedAt: 'not-a-date' }
    ];
    localStorage.setItem(LS_KEY, JSON.stringify(blob));
    slashUsage.init();
    expect(slashUsage.entries.size).toBe(1);
    expect(slashUsage.entries.has('ok')).toBe(true);
  });
});
