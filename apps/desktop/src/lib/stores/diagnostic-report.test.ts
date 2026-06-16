// Covers getDiagnosticReport — JS wrapper around the diagnostic_report
// Rust IPC. Shipped in v0.2.10 so users can copy-paste a structured
// blob into an issue without leaking secrets.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getDiagnosticReport', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
    if (win && '__TAURI_INTERNALS__' in win) delete win.__TAURI_INTERNALS__;
  });

  it('returns null outside Tauri without calling invoke', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockReset();
    const { getDiagnosticReport } = await import('./settings.svelte');

    expect(await getDiagnosticReport('default')).toBeNull();
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it('passes the report through when the IPC resolves', async () => {
    const win = (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
    win.__TAURI_INTERNALS__ = {};
    (globalThis as unknown as { window: Record<string, unknown> }).window = win;
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockReset();
    const sample = {
      schema: 'ironclaw-diagnostic-report.v1',
      generated_at: 1700000000,
      app: {
        name: 'IronClaw Desktop',
        version: '0.2.9',
        bundle_id: 'com.openclaw.ironclaw-desktop',
        app_data_dir: '/Users/test/Library/Application Support/com.openclaw.ironclaw-desktop'
      },
      host: {
        os: 'macOS',
        os_version: '14.5',
        arch: 'aarch64',
        kernel: 'Darwin 23.5.0 arm64'
      },
      profile: {
        id: 'default',
        token_source: 'keychain'
      }
    };
    vi.mocked(invoke).mockResolvedValue(sample);
    const { getDiagnosticReport } = await import('./settings.svelte');

    const report = await getDiagnosticReport('default');

    expect(report).toEqual(sample);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('diagnostic_report', { profileId: 'default' });
  });

  it('returns null on IPC rejection (logged not thrown)', async () => {
    const win = (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
    win.__TAURI_INTERNALS__ = {};
    (globalThis as unknown as { window: Record<string, unknown> }).window = win;
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockRejectedValue(new Error('boom'));
    const { getDiagnosticReport } = await import('./settings.svelte');

    expect(await getDiagnosticReport('default')).toBeNull();
  });
});
