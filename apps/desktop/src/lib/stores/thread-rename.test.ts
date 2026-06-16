// Tests for the local-only thread-rename overlay. The store is a runtime
// singleton with `$state` runes, so each test resets `renames` and clears
// the LS_KEY persistence so cases don't leak into one another.
//
// We exercise the public API: `set` / `unset` / `get` / `has` /
// `displayTitle`, the localStorage round-trip, the broadcast fan-out, and
// the receive-path (`applyRemote`) that the broadcast handler dispatches
// into. The broadcast spy mirrors the pattern in `notifications.test.ts`
// — patch `broadcast.send` and assert the right kind lands on the bus.
//
// Vitest 4 ships an experimental localStorage that's missing the standard
// Storage methods in this jsdom path; we install a tiny Map-backed shim
// per file (test files only — `vitest.setup.ts` is off-limits per the
// task constraints).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { threadRename } from './thread-rename.svelte';
import { broadcast } from './broadcast.svelte';

const LS_KEY = 'ironclaw-thread-renames';
const TOOLTIP_KEY = 'ironclaw-rename-tooltip-seen';

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
  threadRename.renames = {};
  // `hydrated` is private; cast through any so a fresh `init()` in the
  // next test will re-read localStorage rather than short-circuit on
  // residual state from the previous test.
  (threadRename as unknown as { hydrated: boolean }).hydrated = false;
}

describe('thread-rename store', () => {
  beforeEach(() => {
    installLocalStorageShim();
    resetStore();
  });

  afterEach(() => {
    resetStore();
    vi.restoreAllMocks();
  });

  it('set() records a custom title and get() returns it', () => {
    vi.spyOn(broadcast, 'send').mockImplementation(() => {});
    threadRename.set('t1', 'My research thread');
    expect(threadRename.get('t1')).toBe('My research thread');
    expect(threadRename.has('t1')).toBe(true);
  });

  it('unset() removes a custom title and reverts to undefined', () => {
    vi.spyOn(broadcast, 'send').mockImplementation(() => {});
    threadRename.set('t1', 'My thread');
    expect(threadRename.has('t1')).toBe(true);
    threadRename.unset('t1');
    expect(threadRename.get('t1')).toBeUndefined();
    expect(threadRename.has('t1')).toBe(false);
  });

  it('set() trims whitespace and treats blank input as an unset', () => {
    vi.spyOn(broadcast, 'send').mockImplementation(() => {});
    threadRename.set('t1', '  Trimmed  ');
    expect(threadRename.get('t1')).toBe('Trimmed');
    // Blank input collapses to an unset rather than stranding the thread
    // with a literal empty string.
    threadRename.set('t1', '   ');
    expect(threadRename.has('t1')).toBe(false);
  });

  it('displayTitle() returns the override when present, falls back to server title otherwise', () => {
    vi.spyOn(broadcast, 'send').mockImplementation(() => {});
    expect(threadRename.displayTitle('t1', 'Server title')).toBe('Server title');
    threadRename.set('t1', 'Local title');
    expect(threadRename.displayTitle('t1', 'Server title')).toBe('Local title');
    // Empty / null / undefined server titles collapse to 'Untitled' so
    // the UI never renders a blank row.
    expect(threadRename.displayTitle('other', '')).toBe('Untitled');
    expect(threadRename.displayTitle('other', null)).toBe('Untitled');
    expect(threadRename.displayTitle('other', undefined)).toBe('Untitled');
  });

  it('persists mutations to localStorage under the LS_KEY blob', () => {
    vi.spyOn(broadcast, 'send').mockImplementation(() => {});
    threadRename.set('t1', 'Saved title');
    threadRename.set('t2', 'Another title');
    const raw = localStorage.getItem(LS_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Record<string, string>;
    expect(parsed).toEqual({ t1: 'Saved title', t2: 'Another title' });
  });

  it('init() rehydrates the override map from localStorage', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ t1: 'Hydrated', t2: 'Other' }));
    threadRename.init();
    expect(threadRename.get('t1')).toBe('Hydrated');
    expect(threadRename.get('t2')).toBe('Other');
    expect(threadRename.has('missing')).toBe(false);
  });

  it('set() and unset() each emit a thread-rename broadcast', () => {
    const sendSpy = vi.spyOn(broadcast, 'send').mockImplementation(() => {});
    threadRename.set('t1', 'New title');
    expect(sendSpy).toHaveBeenCalledWith({
      kind: 'thread-rename',
      threadId: 't1',
      title: 'New title'
    });
    sendSpy.mockClear();
    threadRename.unset('t1');
    expect(sendSpy).toHaveBeenCalledWith({
      kind: 'thread-rename',
      threadId: 't1',
      title: null
    });
  });

  it('applyRemote() converges to the peer state without re-broadcasting', () => {
    const sendSpy = vi.spyOn(broadcast, 'send').mockImplementation(() => {});
    threadRename.applyRemote('t1', 'From peer');
    expect(threadRename.get('t1')).toBe('From peer');
    threadRename.applyRemote('t1', null);
    expect(threadRename.has('t1')).toBe(false);
    // The receive path must NOT echo back onto the bus — belt-and-braces
    // with the senderId loop guard in `broadcast.svelte.ts`.
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('tooltip dismissal persists across calls', () => {
    expect(threadRename.isTooltipUnseen()).toBe(true);
    threadRename.markTooltipSeen();
    expect(threadRename.isTooltipUnseen()).toBe(false);
    // Stays dismissed on a repeat check — the seen flag lives in
    // localStorage, not in-memory.
    expect(localStorage.getItem(TOOLTIP_KEY)).toBe('true');
  });
});
