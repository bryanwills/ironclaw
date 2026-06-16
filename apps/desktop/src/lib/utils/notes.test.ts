import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined));
const inTauriMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('$lib/utils/runtime', () => ({ inTauri: inTauriMock }));

import { exportToNotes } from '$lib/api/files';

describe('exportToNotes', () => {
  afterEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    inTauriMock.mockReset();
    inTauriMock.mockReturnValue(true);
  });

  it("calls invoke('export_to_notes', { title, body })", async () => {
    await exportToNotes('Keep', 'This answer');

    expect(invokeMock).toHaveBeenCalledWith('export_to_notes', {
      title: 'Keep',
      body: 'This answer'
    });
  });

  it('throws when outside Tauri', async () => {
    inTauriMock.mockReturnValue(false);

    await expect(exportToNotes('Keep', 'This answer')).rejects.toThrow(
      'Apple Notes export requires the desktop app'
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('propagates invoke errors', async () => {
    invokeMock.mockRejectedValueOnce(new Error('osascript failed'));

    await expect(exportToNotes('Keep', 'This answer')).rejects.toThrow('osascript failed');
  });

  it('lets empty title/body fall through', async () => {
    await exportToNotes('', '');

    expect(invokeMock).toHaveBeenCalledWith('export_to_notes', { title: '', body: '' });
  });
});
