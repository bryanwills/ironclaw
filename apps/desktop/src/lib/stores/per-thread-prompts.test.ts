// Tests for the per-thread system-prompt override store.
//
// The store is a runtime singleton with `$state` runes, so each test
// resets `prompts` and clears the LS_KEY persistence so cases don't
// leak into one another. We follow the same pattern as
// `thread-rename.test.ts` — Map-backed localStorage shim per file so
// the Vitest 4 jsdom path's incomplete Storage implementation doesn't
// trip the round-trip assertions.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { perThreadPrompts, MAX_PROMPT_CHARS } from './per-thread-prompts.svelte';

const LS_KEY = 'ironclaw-per-thread-prompts';

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
  perThreadPrompts.prompts = {};
  // `hydrated` is private; cast through any so the next read re-pulls
  // localStorage rather than short-circuiting on residual state.
  (perThreadPrompts as unknown as { hydrated: boolean }).hydrated = false;
}

describe('per-thread-prompts store', () => {
  beforeEach(() => {
    installLocalStorageShim();
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it('set() records a custom prompt and get() returns it', () => {
    perThreadPrompts.set('t1', 'You are a Spanish tutor.');
    expect(perThreadPrompts.get('t1')).toBe('You are a Spanish tutor.');
    expect(perThreadPrompts.hasOverride('t1')).toBe(true);
  });

  it('clear() removes the override and reverts to null', () => {
    perThreadPrompts.set('t1', 'Custom prompt');
    expect(perThreadPrompts.hasOverride('t1')).toBe(true);
    perThreadPrompts.clear('t1');
    expect(perThreadPrompts.get('t1')).toBeNull();
    expect(perThreadPrompts.hasOverride('t1')).toBe(false);
  });

  it('set() trims whitespace and treats blank input as a clear()', () => {
    perThreadPrompts.set('t1', '  Trimmed prompt  ');
    expect(perThreadPrompts.get('t1')).toBe('Trimmed prompt');
    perThreadPrompts.set('t1', '   ');
    expect(perThreadPrompts.hasOverride('t1')).toBe(false);
  });

  it('persists mutations to localStorage under the LS_KEY blob', () => {
    perThreadPrompts.set('t1', 'Prompt one');
    perThreadPrompts.set('t2', 'Prompt two');
    const raw = localStorage.getItem(LS_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Record<string, string>;
    expect(parsed).toEqual({ t1: 'Prompt one', t2: 'Prompt two' });
  });

  it('rehydrates the override map from localStorage on first read', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ t1: 'Hydrated prompt', t2: 'Other prompt' }));
    // Reading via the public API should trigger the lazy hydrate.
    expect(perThreadPrompts.get('t1')).toBe('Hydrated prompt');
    expect(perThreadPrompts.get('t2')).toBe('Other prompt');
    expect(perThreadPrompts.hasOverride('missing')).toBe(false);
  });

  it('accepts prompts longer than MAX_PROMPT_CHARS without truncating', () => {
    const longPrompt = 'a'.repeat(MAX_PROMPT_CHARS + 1000);
    expect(longPrompt.length).toBe(MAX_PROMPT_CHARS + 1000);
    perThreadPrompts.set('t1', longPrompt);
    // The store records the full payload — the UI is the one that
    // surfaces the warning, not the store.
    expect(perThreadPrompts.get('t1')).toBe(longPrompt);
    expect(perThreadPrompts.get('t1')?.length).toBe(MAX_PROMPT_CHARS + 1000);
  });

  it('ignores prototype-pollution attempts via forbidden keys', () => {
    perThreadPrompts.set('__proto__', 'poisoned');
    perThreadPrompts.set('constructor', 'also poisoned');
    perThreadPrompts.set('prototype', 'still poisoned');
    expect(perThreadPrompts.hasOverride('__proto__')).toBe(false);
    expect(perThreadPrompts.hasOverride('constructor')).toBe(false);
    expect(perThreadPrompts.hasOverride('prototype')).toBe(false);
    // The pollution attempts should NOT have leaked onto Object.prototype.
    expect(({} as Record<string, unknown>).poisoned).toBeUndefined();
    // A real thread id still works after the forbidden attempts.
    perThreadPrompts.set('t1', 'Real prompt');
    expect(perThreadPrompts.get('t1')).toBe('Real prompt');
  });

  it('drops forbidden keys when rehydrating from a tampered localStorage blob', () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        __proto__: 'poisoned',
        constructor: 'also poisoned',
        prototype: 'still poisoned',
        t1: 'legitimate'
      })
    );
    expect(perThreadPrompts.get('t1')).toBe('legitimate');
    expect(perThreadPrompts.hasOverride('__proto__')).toBe(false);
    expect(perThreadPrompts.hasOverride('constructor')).toBe(false);
  });

  it('returns null and false for empty / unknown thread ids without throwing', () => {
    expect(perThreadPrompts.get('')).toBeNull();
    expect(perThreadPrompts.hasOverride('')).toBe(false);
    expect(perThreadPrompts.get('never-saved')).toBeNull();
    expect(perThreadPrompts.hasOverride('never-saved')).toBe(false);
  });
});
