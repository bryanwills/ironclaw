// Tests for the surface-refresh registry (R24a — Cmd+R per-surface refresh).
// Self-contained store (no deps): a single registered closure with
// last-registration-wins semantics and a crash-safe invoke(). The contract
// that matters: invoke() returns false when nothing is registered, true when
// a handler ran (even if it threw — Cmd+R must never crash the app).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { surfaceRefresh } from './surface-refresh.svelte';

beforeEach(() => surfaceRefresh.unregister());
afterEach(() => {
  surfaceRefresh.unregister();
  vi.restoreAllMocks();
});

describe('surfaceRefresh', () => {
  it('invoke() returns false when no handler is registered', async () => {
    expect(await surfaceRefresh.invoke()).toBe(false);
  });

  it('register + invoke() runs the handler and returns true', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    surfaceRefresh.register(fn);
    expect(await surfaceRefresh.invoke()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('is last-registration-wins (only the newest handler runs)', async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);
    surfaceRefresh.register(a);
    surfaceRefresh.register(b);
    await surfaceRefresh.invoke();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('unregister() clears the slot so invoke() returns false', async () => {
    surfaceRefresh.register(vi.fn().mockResolvedValue(undefined));
    surfaceRefresh.unregister();
    expect(await surfaceRefresh.invoke()).toBe(false);
  });

  it('awaits an async handler before resolving', async () => {
    let done = false;
    surfaceRefresh.register(async () => {
      await new Promise((r) => setTimeout(r, 5));
      done = true;
    });
    await surfaceRefresh.invoke();
    expect(done).toBe(true);
  });

  it('swallows a throwing handler (crash-safety) and still returns true', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    surfaceRefresh.register(async () => {
      throw new Error('gateway down');
    });
    let result: boolean | undefined;
    await expect(
      (async () => {
        result = await surfaceRefresh.invoke();
      })()
    ).resolves.toBeUndefined();
    expect(result).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });
});
