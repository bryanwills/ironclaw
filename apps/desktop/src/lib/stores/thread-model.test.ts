// Tests for the per-thread LLM provider tracker (R41 — provider chip).
// A localStorage-backed threadId→providerId map. We install a Map-backed
// localStorage shim (jsdom's global shape varies) and reset the private
// `hydrated` flag between tests so init() can be exercised repeatedly.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { threadModel } from './thread-model.svelte';

const LS_KEY = 'ironclaw-thread-providers';

function installLocalStorageShim(): void {
  const store = new Map<string, string>();
  const shim = {
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(String(k), String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear()
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: shim });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: shim });
  }
}

function resetHydrated(): void {
  (threadModel as unknown as { hydrated: boolean }).hydrated = false;
}

function reset(): void {
  installLocalStorageShim();
  threadModel.providers = new Map();
  resetHydrated();
}

describe('threadModel store', () => {
  beforeEach(reset);
  afterEach(reset);

  it('setProvider records a tag and getProvider/has read it back', () => {
    threadModel.setProvider('t1', 'nearai');
    expect(threadModel.getProvider('t1')).toBe('nearai');
    expect(threadModel.has('t1')).toBe(true);
    expect(threadModel.has('t2')).toBe(false);
    expect(threadModel.getProvider('t2')).toBeUndefined();
  });

  it('setProvider persists to localStorage as a flat object', () => {
    threadModel.setProvider('t1', 'openrouter');
    const blob = JSON.parse(localStorage.getItem(LS_KEY) as string);
    expect(blob).toEqual({ t1: 'openrouter' });
  });

  it('setProvider trims whitespace', () => {
    threadModel.setProvider('t1', '  nearai  ');
    expect(threadModel.getProvider('t1')).toBe('nearai');
  });

  it('setProvider ignores empty/whitespace/non-string providers and empty threadId', () => {
    threadModel.setProvider('t1', '');
    threadModel.setProvider('t2', '   ');
    threadModel.setProvider('t3', null);
    threadModel.setProvider('t4', undefined);
    threadModel.setProvider('', 'nearai');
    expect(threadModel.providers.size).toBe(0);
  });

  it('is write-last-wins across turns', () => {
    threadModel.setProvider('t1', 'nearai');
    threadModel.setProvider('t1', 'openrouter');
    expect(threadModel.getProvider('t1')).toBe('openrouter');
  });

  it('no-ops (preserves the Map reference) when the value is unchanged', () => {
    threadModel.setProvider('t1', 'nearai');
    const before = threadModel.providers;
    threadModel.setProvider('t1', 'nearai');
    expect(threadModel.providers).toBe(before);
  });

  it('init() hydrates from localStorage and coerceLoaded drops invalid rows', () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ good: 'p1', '': 'dropped-empty-key', bad: 123, empty: '' })
    );
    threadModel.providers = new Map();
    resetHydrated();
    threadModel.init();
    expect(threadModel.getProvider('good')).toBe('p1');
    expect(threadModel.providers.size).toBe(1);
  });

  it('init() is idempotent — a second call does not wipe live state', () => {
    threadModel.setProvider('t1', 'nearai');
    threadModel.init(); // hydrated already true after the lazy init in setProvider
    expect(threadModel.getProvider('t1')).toBe('nearai');
  });
});
