import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn(async () => '/Users/a/Documents/IronClaw/default'));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { exportMemoryTree } from '$lib/api/files';

describe('exportMemoryTree', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue('/Users/a/Documents/IronClaw/default');
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it("calls invoke('export_memory_tree', { profileId, files })", async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    const files = [{ path: 'projects/a/notes.md', content: 'hello' }];

    await expect(exportMemoryTree('default', files)).resolves.toBe(
      '/Users/a/Documents/IronClaw/default'
    );

    expect(invokeMock).toHaveBeenCalledWith('export_memory_tree', {
      profileId: 'default',
      files
    });
  });

  it('throws when outside Tauri', async () => {
    await expect(exportMemoryTree('default', [])).rejects.toThrow(
      'Workspace export requires the desktop app'
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('propagates invoke errors', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    invokeMock.mockRejectedValueOnce(new Error('export failed'));

    await expect(exportMemoryTree('default', [])).rejects.toThrow('export failed');
  });
});
