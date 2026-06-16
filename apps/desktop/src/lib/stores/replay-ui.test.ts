// Tests for the replay UI store (R58 — time-travel replay bar visibility).
// Per-thread open flags (independent across threads, null-safe) plus a
// persisted speed preference with default/validation guards. localStorage
// only — install the Map-backed shim (jsdom's global varies).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { replayUI } from './replay-ui.svelte';

const STORAGE_KEY = 'ironclaw-replay-ui-open';

function installLocalStorageShim(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return store.size;
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => void store.set(String(k), String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear()
    }
  });
}

function reset(): void {
  installLocalStorageShim();
  (replayUI as unknown as { openByThread: Record<string, boolean> }).openByThread = {};
}

beforeEach(reset);
afterEach(reset);

describe('replayUI — per-thread open flags', () => {
  it('isOpenFor is false for null or an unknown thread', () => {
    expect(replayUI.isOpenFor(null)).toBe(false);
    expect(replayUI.isOpenFor('nope')).toBe(false);
  });

  it('open / close flip the flag for a thread', () => {
    replayUI.open('t1');
    expect(replayUI.isOpenFor('t1')).toBe(true);
    replayUI.close('t1');
    expect(replayUI.isOpenFor('t1')).toBe(false);
  });

  it('toggle flips the flag both ways', () => {
    replayUI.toggle('t1');
    expect(replayUI.isOpenFor('t1')).toBe(true);
    replayUI.toggle('t1');
    expect(replayUI.isOpenFor('t1')).toBe(false);
  });

  it('tracks threads independently', () => {
    replayUI.open('a');
    expect(replayUI.isOpenFor('a')).toBe(true);
    expect(replayUI.isOpenFor('b')).toBe(false);
  });
});

describe('replayUI — speed preference', () => {
  it('defaults to 1 when nothing is stored', () => {
    expect(replayUI.readSpeed()).toBe(1);
  });

  it('round-trips a positive speed through localStorage', () => {
    replayUI.writeSpeed(2.5);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('2.5');
    expect(replayUI.readSpeed()).toBe(2.5);
  });

  it('falls back to 1 for invalid / zero / negative stored values', () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-number');
    expect(replayUI.readSpeed()).toBe(1);
    localStorage.setItem(STORAGE_KEY, '0');
    expect(replayUI.readSpeed()).toBe(1);
    localStorage.setItem(STORAGE_KEY, '-3');
    expect(replayUI.readSpeed()).toBe(1);
  });
});
