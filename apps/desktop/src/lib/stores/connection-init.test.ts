// Tests for connection.init()'s concurrent-call dedupe contract.
//
// Background: R29a (per CHANGELOG, v0.2.1 unreleased) was supposed to
// cache the in-flight `init()` promise so concurrent callers from the
// layout root, the sidebar, the status bar, and the chat surface
// dedupe to one initialization AND every caller awaits the *same*
// resolution. The current implementation only sets a synchronous
// boolean BEFORE awaiting `loadSettings()`, so the second caller's
// `await connection.init()` resolves *before* settings are loaded
// — observing the DEFAULT_SETTINGS shape (onboardingComplete: false)
// instead of the persisted one.
//
// In practice this is the v0.2.0 user-visible "wizard appears even
// though onboardingComplete=true on disk" bug: a downstream consumer
// observes the pre-load state, navigates to /onboarding, and the
// layout's $effect can't undo it.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

beforeEach(async () => {
  // Reset the singleton module between tests so each case sees a
  // fresh ConnectionStore instance with its own `initialized`/`initPromise`
  // state. Without this, the second test in the file would observe the
  // first test's already-loaded settings.
  vi.resetModules();
  // Reset the @tauri-apps/api/core mock to default no-op behavior.
  const { invoke } = await import('@tauri-apps/api/core');
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
});

afterEach(() => {
  // Strip the Tauri-runtime shim this suite stamps on `window` so a
  // sibling test under the same worker doesn't see a non-Tauri code
  // path skip its own setup. Defensive — vitest isolates by worker
  // but not by file within a worker.
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (win && '__TAURI_INTERNALS__' in win) {
    delete win.__TAURI_INTERNALS__;
  }
});

describe('connection.init() concurrent-call dedupe', () => {
  // Bumped from the default 5s after R40/R41 added new boot-path work
  // (LLM provider catalog warm, thread-model hydrate) that nudges this
  // test past the cold-import budget on macOS-14 CI. The dedupe assertion
  // itself completes in well under a second; the time is import overhead.
  it(
    'a second init() call awaits the first init()s settings load',
    { timeout: 15000 },
    async () => {
      // Arrange: simulate Tauri runtime + a slow get_settings response
      // shaped like the on-disk JSON the user reported (onboardingComplete: true).
      const win = (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
      win.__TAURI_INTERNALS__ = {};
      (globalThis as unknown as { window: Record<string, unknown> }).window = win;

      const ONDISK = {
        activeProfileId: 'default',
        adminMode: false,
        engineV2Enabled: false,
        onboardingComplete: true,
        profiles: [
          {
            id: 'default',
            llmBackend: 'nearai',
            llmProviderId: 'nearai',
            localBaseUrl: 'http://127.0.0.1:3100',
            mode: 'remote',
            name: 'Default',
            remoteBaseUrl: 'http://127.0.0.1:18789'
          }
        ],
        trayEnabled: true,
        useResponsesApi: true
      };

      const { invoke } = await import('@tauri-apps/api/core');
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        // Slow get_settings so the race window is wide enough to observe.
        if (cmd === 'get_settings') {
          await new Promise((r) => setTimeout(r, 20));
          return ONDISK;
        }
        if (cmd === 'get_token') return null;
        if (cmd === 'sidecar_status') return { running: false, port: null };
        // All other commands no-op.
        return undefined;
      });

      // Import the connection store AFTER the mocks are wired so the
      // module-load $effect.root paths see the Tauri runtime probe.
      const { connection } = await import('./connection.svelte');

      // Act: caller A starts init (mimics +layout.svelte.onMount).
      // Caller B awaits init (mimics +page.svelte.boot()), which under the
      // broken `if (initialized) return;` short-circuit resolves IMMEDIATELY
      // even though loadSettings() hasn't fired yet.
      //
      // The reproduction is: after B's `await connection.init()` resolves,
      // B reads `connection.settings.onboardingComplete`. With a correct
      // promise cache, B should see `true` (from disk). With the broken
      // contract, B sees `false` (DEFAULT_SETTINGS placeholder) because
      // loadSettings's promise inside A's call is still pending.
      void connection.init(); // caller A — fire-and-forget
      await connection.init(); // caller B — must await the same load
      expect(connection.settings.onboardingComplete).toBe(true);
      expect(connection.settings.activeProfileId).toBe('default');
    }
  );

  // Codex audit P1: a fresh, not-yet-onboarded install in local mode must
  // NOT auto-spawn the sidecar during init() — the onboarding wizard owns
  // the first launch so first-run boot never wedges inside a sidecar /
  // Keychain failure before the user has chosen Local vs Hosted.
  it(
    'does not auto-start the local sidecar before onboarding completes',
    { timeout: 15000 },
    async () => {
      const win = (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
      win.__TAURI_INTERNALS__ = {};
      (globalThis as unknown as { window: Record<string, unknown> }).window = win;

      const ONDISK = {
        activeProfileId: 'default',
        adminMode: false,
        engineV2Enabled: false,
        onboardingComplete: false, // <-- brand-new install, not onboarded
        profiles: [
          {
            id: 'default',
            llmBackend: 'nearai',
            llmProviderId: 'nearai',
            localBaseUrl: 'http://127.0.0.1:3100',
            mode: 'local', // <-- local mode would normally auto-start
            name: 'Default',
            remoteBaseUrl: 'http://127.0.0.1:3100',
            apiVersion: 'v2'
          }
        ],
        trayEnabled: true,
        useResponsesApi: true
      };

      const { invoke } = await import('@tauri-apps/api/core');
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === 'get_settings') return ONDISK;
        if (cmd === 'sidecar_status') return { running: false, port: null };
        if (cmd === 'get_token') return null;
        return undefined;
      });

      const { connection } = await import('./connection.svelte');
      await connection.init();

      const startedSidecar = vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'start_sidecar');
      expect(startedSidecar).toBe(false);
      expect(connection.status).toBe('disconnected');
    }
  );
});
