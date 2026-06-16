// Unit tests for the toast singleton (shared transient-notification store).
// Pure rune store with a setTimeout-based auto-dismiss; we drive it through
// its public API (show/dismiss/clear) and use fake timers for the timeout.
// nextId is private and persists across tests, so we assert on the id
// returned by show() rather than absolute values.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toasts } from './toasts.svelte';

const AUTO_DISMISS_MS = 3500;

beforeEach(() => {
  vi.useFakeTimers();
  toasts.clear();
});

afterEach(() => {
  toasts.clear();
  vi.useRealTimers();
});

describe('toasts store', () => {
  it('show() appends a toast with the returned id and default "info" kind', () => {
    const id = toasts.show('hello');
    expect(toasts.toasts).toHaveLength(1);
    const t = toasts.toasts.at(-1)!;
    expect(t.id).toBe(id);
    expect(t.message).toBe('hello');
    expect(t.kind).toBe('info');
  });

  it('show() honours an explicit kind', () => {
    toasts.show('boom', 'error');
    expect(toasts.toasts.at(-1)!.kind).toBe('error');
  });

  it('accumulates multiple toasts in order with distinct ids', () => {
    const a = toasts.show('a');
    const b = toasts.show('b', 'success');
    expect(toasts.toasts.map((t) => t.message)).toEqual(['a', 'b']);
    expect(b).not.toBe(a);
  });

  it('dismiss() removes the matching toast and leaves the rest', () => {
    const a = toasts.show('a');
    toasts.show('b');
    toasts.dismiss(a);
    expect(toasts.toasts.map((t) => t.message)).toEqual(['b']);
  });

  it('dismiss() of an unknown id is a no-op', () => {
    toasts.show('a');
    toasts.dismiss(99999);
    expect(toasts.toasts).toHaveLength(1);
  });

  it('auto-dismisses after the timeout elapses', () => {
    toasts.show('bye');
    expect(toasts.toasts).toHaveLength(1);
    vi.advanceTimersByTime(AUTO_DISMISS_MS);
    expect(toasts.toasts).toHaveLength(0);
  });

  it('does not auto-dismiss before the timeout elapses', () => {
    toasts.show('still here');
    vi.advanceTimersByTime(AUTO_DISMISS_MS - 1);
    expect(toasts.toasts).toHaveLength(1);
  });

  it('clear() empties all toasts and cancels pending timers', () => {
    toasts.show('a');
    toasts.show('b');
    toasts.clear();
    expect(toasts.toasts).toHaveLength(0);
    // A cancelled timer must not resurrect a toast or throw.
    vi.advanceTimersByTime(AUTO_DISMISS_MS + 1000);
    expect(toasts.toasts).toHaveLength(0);
  });
});
