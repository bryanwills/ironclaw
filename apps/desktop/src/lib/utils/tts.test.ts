import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}));

import { listVoices, speak, stopSpeaking } from './tts';

function clearTauriInternals() {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

describe('tts utils', () => {
  afterEach(() => {
    clearTauriInternals();
    invokeMock.mockReset();
  });

  it('no-ops speak outside Tauri', async () => {
    clearTauriInternals();

    await speak('hello world', { voice: 'Samantha', rate: 200 });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('no-ops stopSpeaking outside Tauri', async () => {
    clearTauriInternals();

    await stopSpeaking();

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('returns an empty voice list outside Tauri', async () => {
    clearTauriInternals();

    await expect(listVoices()).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
