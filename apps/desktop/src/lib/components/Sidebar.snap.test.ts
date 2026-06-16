// Snapshot tests for Sidebar. The Sidebar reaches into many stores
// (connection, signIn, threads, updater) and the SvelteKit `$app/state`
// + `$app/navigation` modules; rather than wire each one through its
// real implementation we replace each module with a plain stub whose
// reads are deterministic for the snapshot.
//
// Two axes covered:
//   - expanded vs collapsed (controlled via the localStorage key the
//     component hydrates in `onMount`).
//   - default tint (signal) vs custom tint (orange) on the active
//     profile — exercises the per-profile accent override that the
//     connection store would normally paint into CSS variables.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';

// ---- Stubs (hoisted so `vi.mock` factories can capture them) ----------
const { connectionStub, signInStub, threadsStub, updaterStub, toastsStub, pageStub } = vi.hoisted(
  () => ({
    connectionStub: {
      status: 'connected' as 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error',
      lastError: null as string | null,
      sidecarStatus: 'idle' as 'idle' | 'starting' | 'running' | 'exited' | 'error',
      sidecarPort: null as number | null,
      sidecarError: null as string | null,
      settings: {
        activeProfileId: 'p1',
        profiles: [
          {
            id: 'p1',
            name: 'Default',
            mode: 'remote' as const,
            remoteBaseUrl: 'http://127.0.0.1:3100',
            localBaseUrl: 'http://127.0.0.1:3100',
            llmBackend: 'nearai' as const,
            tint: undefined as string | undefined
          }
        ],
        onboardingComplete: true,
        adminMode: false,
        engineV2Enabled: false
      },
      activeProfile: {
        id: 'p1',
        name: 'Default',
        mode: 'remote' as const,
        remoteBaseUrl: 'http://127.0.0.1:3100',
        localBaseUrl: 'http://127.0.0.1:3100',
        llmBackend: 'nearai' as const,
        tint: undefined as string | undefined
      },
      client: null as null | object,
      init: async () => undefined,
      stopPolling: () => undefined,
      switchProfile: async () => undefined,
      startSidecar: async () => false
    },
    signInStub: {
      status: 'signed-out' as 'signed-out' | 'signed-in',
      profile: null as null | { near_account?: string; display_name?: string; user_id?: string }
    },
    threadsStub: {
      threads: [] as Array<{ id: string }>
    },
    updaterStub: {
      status: 'idle' as string,
      error: null as string | null
    },
    toastsStub: {
      show: () => 0,
      dismiss: () => undefined,
      clear: () => undefined,
      toasts: [] as Array<{ id: number; message: string; kind: string }>
    },
    pageStub: {
      url: { pathname: '/' }
    }
  })
);

vi.mock('$app/state', () => ({
  page: pageStub,
  navigating: null,
  updated: { current: false }
}));

vi.mock('$app/navigation', () => ({
  goto: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('$lib/stores/connection.svelte', () => ({
  connection: connectionStub
}));

vi.mock('$lib/stores/sign-in.svelte', () => ({
  signIn: signInStub
}));

vi.mock('$lib/stores/threads.svelte', () => ({
  threads: threadsStub
}));

vi.mock('$lib/stores/updater.svelte', () => ({
  updater: updaterStub
}));

vi.mock('$lib/stores/toasts.svelte', () => ({
  toasts: toastsStub
}));

// Re-export `resolveTint` from the real settings module — we leave it
// unmocked so the tint palette stays canonical. The Sidebar imports it
// directly for the per-profile dot color.
vi.mock('$lib/stores/settings.svelte', async () => {
  const real = await vi.importActual<typeof import('$lib/stores/settings.svelte')>(
    '$lib/stores/settings.svelte'
  );
  return {
    resolveTint: real.resolveTint,
    PROFILE_TINTS: real.PROFILE_TINTS,
    // `reorderProfiles` is imported by Sidebar.svelte for the popover
    // drag-and-drop. The snapshot tests don't fire drags, so a stub
    // that returns nothing is enough — the real implementation hits
    // `requireCache()` which would throw without a primed cache.
    reorderProfiles: vi.fn().mockResolvedValue(undefined)
  };
});

// Import AFTER the mocks land.
import Sidebar from './Sidebar.svelte';

const COLLAPSE_KEY = 'ironclaw-sidebar-collapsed';

/**
 * vitest 4 + jsdom 29 currently surface a localStorage shim missing
 * the standard methods (`setItem is not a function` per a one-off
 * repro). Install a tiny Map-backed replacement on globalThis +
 * window so the component's `localStorage.getItem` and `setItem`
 * calls resolve to the same backing store across the test. Same
 * pattern as `src/lib/stores/notifications.test.ts`.
 */
function installLocalStorageShim(): void {
  const store = new Map<string, string>();
  const shim = {
    get length() {
      return store.size;
    },
    key(i: number) {
      return Array.from(store.keys())[i] ?? null;
    },
    getItem(k: string) {
      return store.has(k) ? (store.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      store.set(String(k), String(v));
    },
    removeItem(k: string) {
      store.delete(k);
    },
    clear() {
      store.clear();
    }
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: shim });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: shim });
  }
}

beforeEach(() => {
  installLocalStorageShim();
  // Reset stub state to a known baseline so a previous test's mutation
  // doesn't leak into the next snapshot.
  connectionStub.activeProfile.tint = undefined;
  connectionStub.settings.profiles[0].tint = undefined;
});

afterEach(() => {
  // Re-install (and therefore reset) the shim so the next test starts
  // from an empty store. Cheaper than calling `.clear()` since the
  // shim object is rebuilt fresh on each beforeEach anyway.
  installLocalStorageShim();
});

describe('Sidebar snapshots', () => {
  it('matches the expanded snapshot (main window, no tint)', async () => {
    localStorage.setItem(COLLAPSE_KEY, '0');
    const { container } = render(Sidebar);
    // The component reads the collapse flag from localStorage inside
    // `onMount` — flush microtasks so the post-mount state lands in
    // the DOM before we snapshot.
    await tick();
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('matches the collapsed snapshot (main window, no tint)', async () => {
    localStorage.setItem(COLLAPSE_KEY, '1');
    const { container } = render(Sidebar);
    await tick();
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('matches the expanded snapshot with an orange tint applied', async () => {
    localStorage.setItem(COLLAPSE_KEY, '0');
    connectionStub.activeProfile.tint = 'orange';
    connectionStub.settings.profiles[0].tint = 'orange';
    const { container } = render(Sidebar);
    await tick();
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('matches the collapsed snapshot with an orange tint applied', async () => {
    localStorage.setItem(COLLAPSE_KEY, '1');
    connectionStub.activeProfile.tint = 'orange';
    connectionStub.settings.profiles[0].tint = 'orange';
    const { container } = render(Sidebar);
    await tick();
    expect(container.innerHTML).toMatchSnapshot();
  });
});
