// Unit tests for the Tauri runtime probes (R25-1 — IPC gating helpers).
// Pure functions over `window.__TAURI_INTERNALS__`, `import.meta.env.DEV`,
// and `window.localStorage`. We drive each branch by setting/deleting the
// internals object, stubbing the Vite env flag, and (for the diag opt-in) a
// Map-backed localStorage — the test runtime's global localStorage is the
// broken node experimental one.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { inTauri, inTauriFully, diagEnabled } from './runtime';

type WinWithInternals = { __TAURI_INTERNALS__?: unknown };

function setInternals(v: unknown): void {
  (window as unknown as WinWithInternals).__TAURI_INTERNALS__ = v;
}
function clearInternals(): void {
  delete (window as unknown as WinWithInternals).__TAURI_INTERNALS__;
}
function mapLocalStorage(entries: [string, string][] = []): void {
  const store = new Map<string, string>(entries);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear()
  });
}

afterEach(() => {
  clearInternals();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('inTauri', () => {
  it('is false when __TAURI_INTERNALS__ is absent', () => {
    clearInternals();
    expect(inTauri()).toBe(false);
  });

  it('is true when __TAURI_INTERNALS__ is present', () => {
    setInternals({});
    expect(inTauri()).toBe(true);
  });
});

describe('inTauriFully', () => {
  it('is false when not in Tauri at all', () => {
    clearInternals();
    expect(inTauriFully()).toBe(false);
  });

  it('is false when the shim is present but lacks transformCallback', () => {
    setInternals({});
    expect(inTauriFully()).toBe(false);
  });

  it('is false when transformCallback is present but not a function', () => {
    setInternals({ transformCallback: 'nope' });
    expect(inTauriFully()).toBe(false);
  });

  it('is true when the real IPC dispatcher exposes transformCallback', () => {
    setInternals({ transformCallback: () => {} });
    expect(inTauriFully()).toBe(true);
  });
});

describe('diagEnabled', () => {
  it('is true in Vite dev mode regardless of the opt-in', () => {
    vi.stubEnv('DEV', true);
    expect(diagEnabled()).toBe(true);
  });

  it('falls back to the localStorage opt-in when not in dev', () => {
    vi.stubEnv('DEV', false);
    mapLocalStorage([['ironclaw-diag', '1']]);
    expect(diagEnabled()).toBe(true);
  });

  it('is false when not in dev and the opt-in is unset', () => {
    vi.stubEnv('DEV', false);
    mapLocalStorage([]);
    expect(diagEnabled()).toBe(false);
  });

  it('is false when not in dev and the opt-in is not exactly "1"', () => {
    vi.stubEnv('DEV', false);
    mapLocalStorage([['ironclaw-diag', '0']]);
    expect(diagEnabled()).toBe(false);
  });
});
