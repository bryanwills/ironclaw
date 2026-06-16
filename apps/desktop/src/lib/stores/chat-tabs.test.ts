import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatTabs } from './chat-tabs.svelte';

// Vitest's experimental localStorage in this jsdom path is missing
// the standard Storage methods — install a tiny Map-backed shim that
// matches the pins.test.ts pattern (test files only, vitest.setup
// is off-limits to lane scope).
function installLocalStorageShim(): void {
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

beforeEach(() => {
  installLocalStorageShim();
  // Reset to a fresh state by binding twice with different ids.
  chatTabs.bindProfile('__test_reset__');
  chatTabs.closeAll();
  chatTabs.bindProfile('p-default');
  chatTabs.closeAll();
});

afterEach(() => {
  localStorage.clear();
});

describe('chatTabs store', () => {
  it('opens a tab and makes it active', () => {
    chatTabs.open('thr-1');
    expect(chatTabs.openTabs).toEqual(['thr-1']);
    expect(chatTabs.activeTabId).toBe('thr-1');
  });

  it('focusing an already-open tab does not duplicate', () => {
    chatTabs.open('thr-1');
    chatTabs.open('thr-2');
    chatTabs.open('thr-1');
    expect(chatTabs.openTabs).toEqual(['thr-1', 'thr-2']);
    expect(chatTabs.activeTabId).toBe('thr-1');
  });

  it('closing the active tab focuses the right neighbor', () => {
    chatTabs.open('thr-1');
    chatTabs.open('thr-2');
    chatTabs.open('thr-3');
    chatTabs.setActive('thr-2');
    const nextActive = chatTabs.close('thr-2');
    expect(chatTabs.openTabs).toEqual(['thr-1', 'thr-3']);
    expect(nextActive).toBe('thr-3');
    expect(chatTabs.activeTabId).toBe('thr-3');
  });

  it('closing the last tab falls back to left neighbor', () => {
    chatTabs.open('thr-1');
    chatTabs.open('thr-2');
    chatTabs.setActive('thr-2');
    chatTabs.close('thr-2');
    expect(chatTabs.activeTabId).toBe('thr-1');
  });

  it('closing the only tab leaves activeTabId null', () => {
    chatTabs.open('thr-1');
    chatTabs.close('thr-1');
    expect(chatTabs.openTabs).toEqual([]);
    expect(chatTabs.activeTabId).toBeNull();
  });

  it('reorder moves a tab from one position to another', () => {
    chatTabs.open('a');
    chatTabs.open('b');
    chatTabs.open('c');
    chatTabs.reorder(0, 2);
    expect(chatTabs.openTabs).toEqual(['b', 'c', 'a']);
  });

  it('reorder is a no-op when from === to', () => {
    chatTabs.open('a');
    chatTabs.open('b');
    chatTabs.reorder(0, 0);
    expect(chatTabs.openTabs).toEqual(['a', 'b']);
  });

  it('closeOthers leaves only the named tab', () => {
    chatTabs.open('a');
    chatTabs.open('b');
    chatTabs.open('c');
    chatTabs.closeOthers('b');
    expect(chatTabs.openTabs).toEqual(['b']);
    expect(chatTabs.activeTabId).toBe('b');
  });

  it('persists across a profile rebind to the same id', () => {
    chatTabs.open('a');
    chatTabs.open('b');
    chatTabs.setActive('a');
    // Simulate reload by binding a different profile first, then
    // rebinding the original — read() runs and rehydrates from
    // localStorage.
    chatTabs.bindProfile('other');
    chatTabs.bindProfile('p-default');
    expect(chatTabs.openTabs).toEqual(['a', 'b']);
    expect(chatTabs.activeTabId).toBe('a');
  });

  it('each profile has its own tab set', () => {
    chatTabs.open('a');
    chatTabs.bindProfile('p-other');
    chatTabs.open('z');
    expect(chatTabs.openTabs).toEqual(['z']);
    chatTabs.bindProfile('p-default');
    expect(chatTabs.openTabs).toEqual(['a']);
  });

  it('caps tabs at the configured maximum (FIFO eviction of inactive)', () => {
    // Default cap is 12 — open 13 distinct threads and verify the
    // first inactive one was evicted.
    for (let i = 1; i <= 13; i++) {
      chatTabs.open(`t${i}`);
    }
    expect(chatTabs.openTabs).toHaveLength(12);
    // t1 (oldest inactive) should be evicted; t13 should be active.
    expect(chatTabs.openTabs).not.toContain('t1');
    expect(chatTabs.activeTabId).toBe('t13');
  });

  it('isOpen returns whether a tab is in the strip', () => {
    chatTabs.open('a');
    expect(chatTabs.isOpen('a')).toBe(true);
    expect(chatTabs.isOpen('b')).toBe(false);
  });
});
