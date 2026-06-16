// Snapshot tests for StatusBar — three connection states cover the
// bar's main visual modes: disconnected, connected (remote), and
// local-mode sidecar running. The bar's polling loop is owned by the
// component itself; we never let it actually fire because the mocked
// `connection.client` is null in disconnected variants and a no-op
// stub in connected variants (no real fetch goes out).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';

const { connectionStub } = vi.hoisted(() => ({
  connectionStub: {
    status: 'disconnected' as 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error',
    lastError: null as string | null,
    sidecarStatus: 'idle' as 'idle' | 'starting' | 'running' | 'exited' | 'error',
    sidecarPort: null as number | null,
    sidecarError: null as string | null,
    activeProfile: {
      id: 'p1',
      name: 'Default',
      mode: 'remote' as 'remote' | 'local',
      remoteBaseUrl: 'http://127.0.0.1:3100',
      localBaseUrl: 'http://127.0.0.1:3100',
      llmBackend: 'nearai' as const,
      llmProviderId: undefined as string | undefined,
      tint: undefined as string | undefined
    },
    client: null as null | {
      health: () => Promise<{ ok: boolean }>;
      jobsSummary: () => Promise<{ in_progress: number; pending: number }>;
      getUsageSummary: () => Promise<null>;
    },
    startSidecar: async () => false
  }
}));

vi.mock('$lib/stores/connection.svelte', () => ({
  connection: connectionStub
}));

vi.mock('$lib/stores/settings.svelte', async () => {
  const real = await vi.importActual<typeof import('$lib/stores/settings.svelte')>(
    '$lib/stores/settings.svelte'
  );
  return { resolveTint: real.resolveTint, PROFILE_TINTS: real.PROFILE_TINTS };
});

import StatusBar from './StatusBar.svelte';

// matchMedia isn't implemented by jsdom; provide a tiny stub so the
// `<900px` compact-mode probe inside StatusBar resolves cleanly.
beforeEach(() => {
  if (typeof window !== 'undefined' && !window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false
      })
    });
  }
  // Reset stub state.
  connectionStub.status = 'disconnected';
  connectionStub.lastError = null;
  connectionStub.sidecarStatus = 'idle';
  connectionStub.sidecarPort = null;
  connectionStub.activeProfile.mode = 'remote';
  connectionStub.client = null;
});

afterEach(() => {
  connectionStub.status = 'disconnected';
  connectionStub.client = null;
});

describe('StatusBar snapshots', () => {
  it('matches the disconnected snapshot', () => {
    connectionStub.status = 'disconnected';
    connectionStub.activeProfile.mode = 'remote';
    const { container } = render(StatusBar);
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('matches the connected (remote) snapshot', () => {
    connectionStub.status = 'connected';
    connectionStub.activeProfile.mode = 'remote';
    // Provide a stub client so `pollOnce` exits cleanly without going
    // through `fetch`. Each method resolves to a fixed shape; the
    // component swallows the result into local state which doesn't
    // appear in the synchronous first-frame snapshot below.
    connectionStub.client = {
      health: async () => ({ ok: true }),
      jobsSummary: async () => ({ in_progress: 0, pending: 0 }),
      getUsageSummary: async () => null
    };
    const { container } = render(StatusBar);
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('matches the local-sidecar-running snapshot', () => {
    connectionStub.status = 'connected';
    connectionStub.activeProfile.mode = 'local';
    connectionStub.sidecarStatus = 'running';
    connectionStub.sidecarPort = 31337;
    connectionStub.client = {
      health: async () => ({ ok: true }),
      jobsSummary: async () => ({ in_progress: 0, pending: 0 }),
      getUsageSummary: async () => null
    };
    const { container } = render(StatusBar);
    expect(container.innerHTML).toMatchSnapshot();
  });
});
