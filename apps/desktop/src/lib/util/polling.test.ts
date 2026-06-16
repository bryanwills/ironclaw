import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPollingRefresh } from './polling';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('createPollingRefresh', () => {
  // Async timer advancement throughout: the tick is async (the in-flight
  // guard resets in a microtask), and `advanceTimersByTimeAsync` flushes
  // microtasks between fires — which is what happens in production when each
  // refresh promise resolves before the next interval.
  it('invokes fn once per interval after start', async () => {
    const fn = vi.fn();
    const poll = createPollingRefresh(fn, 1000);
    poll.start();
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    poll.stop();
  });

  it('stop() halts further ticks', async () => {
    const fn = vi.fn();
    const poll = createPollingRefresh(fn, 1000);
    poll.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    poll.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('start() is idempotent (no double timers)', async () => {
    const fn = vi.fn();
    const poll = createPollingRefresh(fn, 1000);
    poll.start();
    poll.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    poll.stop();
  });

  it('suppresses overlapping ticks while a slow fn is in flight', async () => {
    let resolve: () => void = () => {};
    const fn = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        })
    );
    const poll = createPollingRefresh(fn, 1000);
    poll.start();
    // First tick starts the slow promise.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(poll.running).toBe(true);
    // Two more intervals elapse while still in flight — both skipped.
    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(1);
    // Resolve; the next tick runs again.
    resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    poll.stop();
  });

  it('keeps polling after fn throws', async () => {
    const fn = vi.fn(() => {
      throw new Error('boom');
    });
    const poll = createPollingRefresh(fn, 1000);
    poll.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(2);
    poll.stop();
  });
});
