// Tests for the mini-mode store (R64).
//
// We exercise the Tauri gate and the IPC payload. The store is a thin
// wrapper around `invoke('open_mini_window')` so the surface area is
// small; the cases below catch the cases that have historically gone
// wrong in sibling stores (tts.test.ts, settings.test.ts):
//
//   - no-op outside Tauri (browser preview, vitest)
//   - invoke called exactly once on toggle inside Tauri
//   - `open` flips to true on success
//   - swallowed invoke rejection (the store must not throw upstream)
//   - reset() rewinds the flag

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}));

import { miniMode } from './mini-mode.svelte';

function setTauriInternals(present: boolean): void {
  const w = window as Window & { __TAURI_INTERNALS__?: unknown };
  if (present) {
    w.__TAURI_INTERNALS__ = {};
  } else {
    delete w.__TAURI_INTERNALS__;
  }
}

describe('miniMode store', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    miniMode.reset();
  });

  afterEach(() => {
    setTauriInternals(false);
    miniMode.reset();
  });

  it('no-ops outside Tauri', async () => {
    setTauriInternals(false);
    await miniMode.toggle();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(miniMode.open).toBe(false);
  });

  it('invokes open_mini_window inside Tauri and flips open=true', async () => {
    setTauriInternals(true);
    invokeMock.mockResolvedValueOnce(undefined);
    await miniMode.toggle();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('open_mini_window');
    expect(miniMode.open).toBe(true);
  });

  it('swallows invoke rejection without throwing', async () => {
    setTauriInternals(true);
    invokeMock.mockRejectedValueOnce(new Error('mini window already exists'));
    // Should not throw.
    await expect(miniMode.toggle()).resolves.toBeUndefined();
    // On failure we leave `open` false so the main window's UI doesn't
    // lie about state we don't actually own.
    expect(miniMode.open).toBe(false);
  });

  it('reset() rewinds the open flag', async () => {
    setTauriInternals(true);
    invokeMock.mockResolvedValueOnce(undefined);
    await miniMode.toggle();
    expect(miniMode.open).toBe(true);
    miniMode.reset();
    expect(miniMode.open).toBe(false);
  });
});
