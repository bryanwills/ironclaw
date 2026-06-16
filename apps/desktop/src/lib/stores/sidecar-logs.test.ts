// Tests for the sidecar log ring-buffer store (R26 — sidecar stdout/stderr
// bridge). Two regimes:
//   - Outside the Tauri webview (default jsdom): every method is a safe
//     no-op except the local mirror clear.
//   - Inside a faked Tauri webview: init() backfills via the get_sidecar_logs
//     IPC and attaches a sidecar:log listener; the listener appends with a
//     MIRROR_CAP ring prune.
// We mock @tauri-apps/api/core + /event (third-party modules, so vi.mock is
// safe — only sibling .svelte.ts mocks break the rune transform).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { sidecarLogs, type SidecarLogEntry } from './sidecar-logs.svelte';

const MIRROR_CAP = 2500; // mirror of the module-private cap

function entry(over: Partial<SidecarLogEntry> = {}): SidecarLogEntry {
  return { timestamp: Date.now(), stream: 'stdout', message: 'line', ...over };
}

function setTauri(on: boolean): void {
  if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

function resetStore(): void {
  sidecarLogs.entries = [];
  sidecarLogs.listening = false;
  const s = sidecarLogs as unknown as {
    inited: boolean;
    initPromise: unknown;
    unlisten: unknown;
  };
  s.inited = false;
  s.initPromise = null;
  s.unlisten = null;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();
  resetStore();
  setTauri(false);
});

afterEach(() => {
  setTauri(false);
  resetStore();
});

describe('sidecarLogs — outside Tauri', () => {
  it('init() is a safe no-op (no IPC, empty buffer)', async () => {
    await sidecarLogs.init();
    expect(invoke).not.toHaveBeenCalled();
    expect(sidecarLogs.entries).toEqual([]);
    expect(sidecarLogs.listening).toBe(false);
  });

  it('clear() empties the local mirror without an IPC', async () => {
    sidecarLogs.entries = [entry({ message: 'a' }), entry({ message: 'b' })];
    await sidecarLogs.clear();
    expect(sidecarLogs.entries).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('sidecarLogs — inside Tauri', () => {
  beforeEach(() => setTauri(true));

  it('init() backfills from the IPC and attaches the live listener', async () => {
    const history = [entry({ message: 'old-1' }), entry({ message: 'old-2' })];
    vi.mocked(invoke).mockResolvedValue(history);
    vi.mocked(listen).mockResolvedValue(() => {});

    await sidecarLogs.init();

    expect(invoke).toHaveBeenCalledWith('get_sidecar_logs', { limit: 500 });
    expect(sidecarLogs.entries.map((e) => e.message)).toEqual(['old-1', 'old-2']);
    expect(sidecarLogs.listening).toBe(true);
  });

  it('the live listener appends new entries', async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    let handler: (ev: { payload: SidecarLogEntry }) => void = () => {};
    vi.mocked(listen).mockImplementation((_name: string, cb: unknown) => {
      handler = cb as (ev: { payload: SidecarLogEntry }) => void;
      return Promise.resolve(() => {});
    });

    await sidecarLogs.init();
    handler({ payload: entry({ message: 'live-1' }) });
    expect(sidecarLogs.entries.map((e) => e.message)).toEqual(['live-1']);
  });

  it('prunes the oldest entry once MIRROR_CAP is reached', async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    let handler: (ev: { payload: SidecarLogEntry }) => void = () => {};
    vi.mocked(listen).mockImplementation((_name: string, cb: unknown) => {
      handler = cb as (ev: { payload: SidecarLogEntry }) => void;
      return Promise.resolve(() => {});
    });
    await sidecarLogs.init();

    // Fill to the cap, then push one more.
    sidecarLogs.entries = Array.from({ length: MIRROR_CAP }, (_, i) => entry({ message: `e${i}` }));
    handler({ payload: entry({ message: 'newest' }) });

    expect(sidecarLogs.entries).toHaveLength(MIRROR_CAP);
    expect(sidecarLogs.entries[0].message).toBe('e1'); // e0 rolled off
    expect(sidecarLogs.entries[MIRROR_CAP - 1].message).toBe('newest');
  });

  it('clear() issues the clear IPC and empties the mirror', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    sidecarLogs.entries = [entry()];
    await sidecarLogs.clear();
    expect(sidecarLogs.entries).toEqual([]);
    expect(invoke).toHaveBeenCalledWith('clear_sidecar_logs');
  });

  it('teardown() detaches the listener and resets listening', async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    const unlisten = vi.fn();
    vi.mocked(listen).mockResolvedValue(unlisten);
    await sidecarLogs.init();
    expect(sidecarLogs.listening).toBe(true);

    sidecarLogs.teardown();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(sidecarLogs.listening).toBe(false);
  });
});
