// Tests for the settings schema migration. `migrateLoaded` is pure
// (no IPC) so we can call it directly with synthetic disk shapes.
//
// Three cases matter:
//   1. Empty file → fresh defaults, one Default profile.
//   2. Legacy flat shape → wrapped into a single profile with id
//      `DEFAULT_PROFILE_ID`.
//   3. Profile-aware shape with a bogus activeProfileId → re-anchored
//      to the first profile.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROFILE_ID,
  listProfiles,
  loadSettings,
  migrateLoaded,
  reorderProfiles,
  validateImportedSettings
} from './settings.svelte';

describe('migrateLoaded', () => {
  it('produces one Default profile from an empty input', () => {
    const s = migrateLoaded({});
    expect(s.profiles).toHaveLength(1);
    expect(s.profiles[0].id).toBe(DEFAULT_PROFILE_ID);
    expect(s.profiles[0].name).toBe('Default');
    expect(s.activeProfileId).toBe(DEFAULT_PROFILE_ID);
    expect(s.onboardingComplete).toBe(false);
    // trayEnabled is opt-OUT — true by default.
    expect(s.trayEnabled).toBe(true);
    // useResponsesApi is opt-OUT — true by default.
    expect(s.useResponsesApi).toBe(true);
    // adminMode + engineV2Enabled are opt-IN — false by default.
    expect(s.adminMode).toBe(false);
    expect(s.engineV2Enabled).toBe(false);
  });

  it('wraps legacy flat shape into a single profile with the default id', () => {
    const s = migrateLoaded({
      mode: 'remote',
      remoteBaseUrl: 'http://example.test:3100',
      localBaseUrl: 'http://127.0.0.1:3100',
      llmBackend: 'openrouter',
      llmModelId: 'anthropic/claude-opus-4.1',
      onboardingComplete: true
    });
    expect(s.profiles).toHaveLength(1);
    expect(s.profiles[0].id).toBe(DEFAULT_PROFILE_ID);
    expect(s.profiles[0].mode).toBe('remote');
    expect(s.profiles[0].remoteBaseUrl).toBe('http://example.test:3100');
    expect(s.profiles[0].llmBackend).toBe('openrouter');
    // llmProviderId should default to the legacy backend on the
    // migrated profile so existing installs round-trip cleanly.
    expect(s.profiles[0].llmProviderId).toBe('openrouter');
    expect(s.profiles[0].llmModelId).toBe('anthropic/claude-opus-4.1');
    expect(s.activeProfileId).toBe(DEFAULT_PROFILE_ID);
    expect(s.onboardingComplete).toBe(true);
  });

  it('re-anchors activeProfileId when it points at an orphaned id', () => {
    const s = migrateLoaded({
      activeProfileId: 'orphan',
      profiles: [
        {
          id: 'p1',
          name: 'first',
          mode: 'remote',
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai'
        },
        {
          id: 'p2',
          name: 'second',
          mode: 'local',
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai'
        }
      ]
    });
    expect(s.profiles).toHaveLength(2);
    // First-profile pivot.
    expect(s.activeProfileId).toBe('p1');
  });

  it('trusts a valid activeProfileId when it matches a profile', () => {
    const s = migrateLoaded({
      activeProfileId: 'p2',
      profiles: [
        {
          id: 'p1',
          name: 'first',
          mode: 'remote',
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai'
        },
        {
          id: 'p2',
          name: 'second',
          mode: 'local',
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai'
        }
      ]
    });
    expect(s.activeProfileId).toBe('p2');
  });

  it('normalizes invalid mode / llmBackend values on stored profiles', () => {
    const s = migrateLoaded({
      activeProfileId: 'p1',
      profiles: [
        {
          id: 'p1',
          name: 'first',
          // @ts-expect-error — exercising the defensive normalizer
          mode: 'garbage',
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          // @ts-expect-error — exercising the defensive normalizer
          llmBackend: 'mystery'
        }
      ]
    });
    expect(s.profiles[0].mode).toBe('remote');
    expect(s.profiles[0].llmBackend).toBe('nearai');
  });

  it('recovers stale packaged Local IronClaw profiles that still point remote mode at :3000', () => {
    const s = migrateLoaded({
      activeProfileId: 'default',
      onboardingComplete: true,
      profiles: [
        {
          id: 'default',
          name: 'Local IronClaw (:3000)',
          mode: 'remote',
          remoteBaseUrl: 'http://127.0.0.1:3000',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai',
          llmProviderId: 'nearai',
          llmModelId: 'auto'
        }
      ]
    });
    expect(s.profiles[0].mode).toBe('local');
    expect(s.profiles[0].name).toBe('Local IronClaw (:3100)');
    expect(s.profiles[0].remoteBaseUrl).toBe('http://127.0.0.1:3100');
    expect(s.profiles[0].localBaseUrl).toBe('http://127.0.0.1:3100');
  });

  it('preserves a non-empty per-profile model id and defaults blank NEAR.AI ids to GLM', () => {
    const s = migrateLoaded({
      activeProfileId: 'p1',
      profiles: [
        {
          id: 'p1',
          name: 'with-model',
          mode: 'remote',
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai',
          llmModelId: 'nearai/fast'
        },
        {
          id: 'p2',
          name: 'blank-model',
          mode: 'remote',
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai',
          llmModelId: '   '
        }
      ]
    });
    expect(s.profiles[0].llmModelId).toBe('nearai/fast');
    expect(s.profiles[1].llmModelId).toBe('auto');
  });

  it('defaults apiVersion to v2; only an explicit v1 opts back out', () => {
    const s = migrateLoaded({
      activeProfileId: 'p1',
      profiles: [
        {
          id: 'p1',
          name: 'explicit-v1',
          mode: 'remote',
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai',
          apiVersion: 'v1'
        },
        {
          id: 'p2',
          name: 'no-version-field',
          mode: 'remote',
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai'
        },
        {
          id: 'p3',
          name: 'garbage-version',
          mode: 'remote',
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai',
          // @ts-expect-error — exercising the defensive narrower
          apiVersion: 'v9'
        }
      ]
    });
    // Explicit v1 is preserved.
    expect(s.profiles[0].apiVersion).toBe('v1');
    // Absent field → v2 (the migration default).
    expect(s.profiles[1].apiVersion).toBe('v2');
    // Unknown value → v2 (lenient, no rejection).
    expect(s.profiles[2].apiVersion).toBe('v2');
  });
});

describe('validateImportedSettings apiVersion', () => {
  function withProfile(extra: Record<string, unknown>): string {
    return JSON.stringify({
      activeProfileId: 'p1',
      profiles: [
        {
          id: 'p1',
          name: 'imported',
          mode: 'remote',
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai',
          ...extra
        }
      ],
      onboardingComplete: true
    });
  }

  it('preserves an explicit v1 apiVersion', () => {
    const res = validateImportedSettings(withProfile({ apiVersion: 'v1' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.settings.profiles[0].apiVersion).toBe('v1');
  });

  it('defaults a missing apiVersion to v2 without rejecting', () => {
    const res = validateImportedSettings(withProfile({}));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.settings.profiles[0].apiVersion).toBe('v2');
  });

  it('narrows an unknown apiVersion to v2 (forward-compat, no reject)', () => {
    const res = validateImportedSettings(withProfile({ apiVersion: 'v3' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.settings.profiles[0].apiVersion).toBe('v2');
  });

  it('preserves a non-empty llmModelId through import validation', () => {
    const res = validateImportedSettings(withProfile({ llmModelId: 'gpt-5-mini' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.settings.profiles[0].llmModelId).toBe('gpt-5-mini');
  });

  it('defaults missing NEAR.AI model ids to auto through import validation', () => {
    const res = validateImportedSettings(withProfile({ llmModelId: '   ' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.settings.profiles[0].llmModelId).toBe('auto');
  });
});

describe('validateImportedSettings useResponsesApi', () => {
  function withTopLevel(extra: Record<string, unknown>): string {
    return JSON.stringify({
      activeProfileId: 'p1',
      profiles: [
        {
          id: 'p1',
          name: 'imported',
          mode: 'remote',
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai'
        }
      ],
      onboardingComplete: true,
      ...extra
    });
  }

  it('preserves an explicit useResponsesApi:false through a backup round-trip', () => {
    const res = validateImportedSettings(withTopLevel({ useResponsesApi: false }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.settings.useResponsesApi).toBe(false);
  });

  it('defaults a missing useResponsesApi to true (opt-out)', () => {
    const res = validateImportedSettings(withTopLevel({}));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.settings.useResponsesApi).toBe(true);
  });

  it('preserves an explicit useResponsesApi:true', () => {
    const res = validateImportedSettings(withTopLevel({ useResponsesApi: true }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.settings.useResponsesApi).toBe(true);
  });
});

// `reorderProfiles` runs against the live in-memory cache, so each test
// primes it via `loadSettings()` first. The test harness has no Tauri
// runtime, so `loadSettings()` falls back to `DEFAULT_SETTINGS` — we add
// extra profiles up front by saving a synthetic shape through the cache.
describe('reorderProfiles', () => {
  // Helper: prime the cache with a known set of three profiles and
  // return their ids. Uses loadSettings to set up the cache, then mutates
  // through saveSettings so subsequent calls see a multi-profile state.
  async function primeThreeProfiles(): Promise<[string, string, string]> {
    const { saveSettings } = await import('./settings.svelte');
    await loadSettings();
    const synthetic = {
      activeProfileId: 'p1',
      profiles: [
        {
          id: 'p1',
          name: 'first',
          mode: 'remote' as const,
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai' as const,
          llmProviderId: 'nearai'
        },
        {
          id: 'p2',
          name: 'second',
          mode: 'remote' as const,
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai' as const,
          llmProviderId: 'nearai'
        },
        {
          id: 'p3',
          name: 'third',
          mode: 'remote' as const,
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai' as const,
          llmProviderId: 'nearai'
        }
      ],
      onboardingComplete: true,
      adminMode: false,
      trayEnabled: true,
      useResponsesApi: true,
      engineV2Enabled: false
    };
    await saveSettings(synthetic);
    return ['p1', 'p2', 'p3'];
  }

  it('reorders the profiles array to match the supplied order', async () => {
    const [p1, p2, p3] = await primeThreeProfiles();
    await reorderProfiles([p3, p1, p2]);
    const profiles = listProfiles();
    expect(profiles.map((p) => p.id)).toEqual([p3, p1, p2]);
  });

  it('preserves the active profile id across a reorder', async () => {
    const [p1, p2, p3] = await primeThreeProfiles();
    await reorderProfiles([p2, p3, p1]);
    const { getActiveProfile } = await import('./settings.svelte');
    expect(getActiveProfile().id).toBe('p1');
  });

  it('rejects an order with the wrong number of ids', async () => {
    const [p1, p2] = await primeThreeProfiles();
    await expect(reorderProfiles([p1, p2])).rejects.toThrow(/id count mismatch/);
  });

  it('rejects an order containing a foreign id', async () => {
    const [p1, p2] = await primeThreeProfiles();
    await expect(reorderProfiles([p1, p2, 'ghost'])).rejects.toThrow(/unknown profile id/);
  });

  it('rejects an order containing a duplicate id', async () => {
    const [p1, p2] = await primeThreeProfiles();
    await expect(reorderProfiles([p1, p2, p1])).rejects.toThrow(/duplicate id/);
  });

  it('no-ops (does not throw) when the order is already current', async () => {
    const [p1, p2, p3] = await primeThreeProfiles();
    await reorderProfiles([p1, p2, p3]);
    const profiles = listProfiles();
    expect(profiles.map((p) => p.id)).toEqual([p1, p2, p3]);
  });
});

// saveSettings must only adopt the new settings into the in-memory cache
// AFTER the on-disk write succeeds (Codex audit P0). These tests force the
// Tauri path (so saveSettings calls invoke) and drive the IPC outcome.
describe('saveSettings cache-after-IPC (audit P0)', () => {
  const OLD = {
    activeProfileId: 'default',
    onboardingComplete: false,
    adminMode: false,
    trayEnabled: true,
    useResponsesApi: true,
    engineV2Enabled: false,
    profiles: [
      {
        id: 'default',
        name: 'OldName',
        mode: 'remote' as const,
        remoteBaseUrl: 'http://127.0.0.1:3100',
        localBaseUrl: 'http://127.0.0.1:3100',
        llmBackend: 'nearai' as const,
        llmProviderId: 'nearai',
        apiVersion: 'v2' as const
      }
    ]
  };

  beforeEach(async () => {
    const win = (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
    win.__TAURI_INTERNALS__ = {};
    (globalThis as unknown as { window: Record<string, unknown> }).window = win;
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockReset();
  });
  afterEach(() => {
    const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
    if (win && '__TAURI_INTERNALS__' in win) delete win.__TAURI_INTERNALS__;
  });

  it('keeps the last-known-good cache when the on-disk write fails', async () => {
    const { saveSettings } = await import('./settings.svelte');
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return OLD;
      if (cmd === 'save_settings') throw new Error('disk full');
      return undefined;
    });
    await loadSettings(); // cached = OLD
    const next = structuredClone(OLD);
    next.profiles[0].name = 'NewName';
    await expect(saveSettings(next)).rejects.toThrow('disk full');
    // The failed write must NOT have been adopted into the cache.
    expect(listProfiles()[0].name).toBe('OldName');
  });

  it('adopts the new settings into the cache after a successful write', async () => {
    const { saveSettings } = await import('./settings.svelte');
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return OLD;
      return undefined; // save_settings resolves
    });
    await loadSettings();
    const next = structuredClone(OLD);
    next.profiles[0].name = 'NewName';
    await saveSettings(next);
    expect(listProfiles()[0].name).toBe('NewName');
  });
});
