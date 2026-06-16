import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('thread Spotlight indexing', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
    if (win && '__TAURI_INTERNALS__' in win) delete win.__TAURI_INTERNALS__;
  });

  it('no-ops outside Tauri without calling invoke', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockReset();
    const { threads } = await import('./threads.svelte');

    await (
      threads as unknown as {
        indexInSpotlight(threadId: string): Promise<void>;
      }
    ).indexInSpotlight('thread-1');

    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  }, 15_000);
});
