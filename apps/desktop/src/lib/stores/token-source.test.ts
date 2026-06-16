// Covers getTokenSource — the JS wrapper around the get_token_source
// Rust IPC shipped in v0.2.9 to give the Settings page a visible
// keychain-vs-file-fallback badge.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getTokenSource', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
    if (win && '__TAURI_INTERNALS__' in win) delete win.__TAURI_INTERNALS__;
  });

  it('returns "absent" outside Tauri without calling invoke', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockReset();
    const { getTokenSource } = await import('./settings.svelte');

    const result = await getTokenSource('default');

    expect(result).toBe('absent');
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it('passes through the keychain answer when Tauri returns it', async () => {
    const win = (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
    win.__TAURI_INTERNALS__ = {};
    (globalThis as unknown as { window: Record<string, unknown> }).window = win;
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue('keychain');
    const { getTokenSource } = await import('./settings.svelte');

    expect(await getTokenSource('default')).toBe('keychain');
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('get_token_source', { profileId: 'default' });
  });

  it('passes through the file-fallback answer when Tauri returns it', async () => {
    const win = (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
    win.__TAURI_INTERNALS__ = {};
    (globalThis as unknown as { window: Record<string, unknown> }).window = win;
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue('file');
    const { getTokenSource } = await import('./settings.svelte');

    expect(await getTokenSource('default')).toBe('file');
  });

  it('falls back to "absent" when the IPC returns an unexpected value', async () => {
    const win = (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
    win.__TAURI_INTERNALS__ = {};
    (globalThis as unknown as { window: Record<string, unknown> }).window = win;
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue('something-unexpected');
    const { getTokenSource } = await import('./settings.svelte');

    expect(await getTokenSource('default')).toBe('absent');
  });

  it('catches IPC rejections and returns "absent"', async () => {
    const win = (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
    win.__TAURI_INTERNALS__ = {};
    (globalThis as unknown as { window: Record<string, unknown> }).window = win;
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockRejectedValue(new Error('boom'));
    const { getTokenSource } = await import('./settings.svelte');

    expect(await getTokenSource('default')).toBe('absent');
  });
});
