import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { Extension } from '$lib/api/types';
import { CONNECTOR_PACKS } from '$lib/data/connector-packs';
import { FIRST_RUN_MISSIONS } from '$lib/data/missions';

const gotoMock = vi.hoisted(() => vi.fn());
const composerPushMock = vi.hoisted(() => vi.fn());
const { connectionStub } = vi.hoisted(() => ({
  connectionStub: {
    activeProfile: { id: 'profile-1', name: 'Work' },
    apiVersion: 'v2',
    status: 'connected' as 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error',
    client: null as null | {
      listExtensions: () => Promise<Extension[]>;
      installExtension: (name: string) => Promise<{ ok: boolean }>;
    }
  }
}));

vi.mock('$app/navigation', () => ({
  goto: gotoMock
}));

vi.mock('$lib/stores/templates.svelte', () => ({
  composerInsert: {
    push: composerPushMock
  }
}));

vi.mock('$lib/stores/connection.svelte', () => ({
  connection: connectionStub
}));

import GetStarted from './GetStarted.svelte';

function installFakeClient(): void {
  connectionStub.status = 'connected';
  connectionStub.client = {
    listExtensions: vi.fn(async () => [
      { name: 'gmail', installed: true, ready: true, readiness_message: 'ready' },
      { name: 'google_calendar', installed: true, ready: true, readiness_message: 'ready' },
      { name: 'google_docs', installed: true, ready: true, readiness_message: 'ready' },
      { name: 'google_drive', installed: true, ready: true, readiness_message: 'ready' },
      { name: 'google_sheets', installed: true, ready: true, readiness_message: 'ready' },
      { name: 'google_slides', installed: true, ready: true, readiness_message: 'ready' }
    ]),
    installExtension: vi.fn(async (_name: string) => ({ ok: true }))
  };
}

describe('GetStarted component', () => {
  beforeEach(() => {
    // The test runtime's global `localStorage` is the node experimental one
    // (no functional getItem/setItem); the component swallows that via
    // try/catch, but the assertions need a real store, so install a
    // Map-backed shim per test (mirrors ResizeHandle.test.ts).
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => void store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      }
    });
    vi.clearAllMocks();
    installFakeClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the setup flow with connector packs and missions', async () => {
    render(GetStarted);

    expect(screen.getByRole('heading', { name: 'Set up your chief of staff' })).toBeTruthy();
    expect(screen.getByText('1. Runner connected')).toBeTruthy();
    expect(screen.getByText('2. Workspace packs')).toBeTruthy();
    expect(screen.getByText('3. Mission launcher')).toBeTruthy();
    expect(screen.getByText('1 · Runner connected')).toBeTruthy();
    expect(screen.getByText('2 · Connect a workspace pack')).toBeTruthy();
    expect(screen.getByText('3 · Run your first mission')).toBeTruthy();

    await waitFor(() => {
      expect(connectionStub.client?.listExtensions).toHaveBeenCalled();
    });

    expect(screen.getAllByText(CONNECTOR_PACKS[0].display_name).length).toBeGreaterThan(0);
    expect(screen.getAllByText(FIRST_RUN_MISSIONS[0].title).length).toBeGreaterThan(0);
    expect(screen.getByTestId('mission-grid')).toBeTruthy();
  });

  it('persists profile-scoped collapse after the flow is complete', async () => {
    render(GetStarted);

    await waitFor(() => {
      expect(screen.getAllByText('Connected').length).toBeGreaterThan(0);
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: FIRST_RUN_MISSIONS[0].title })
          .disabled
      ).toBe(false);
    });

    await fireEvent.click(screen.getByRole('button', { name: FIRST_RUN_MISSIONS[0].title }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Collapse setup tracker' }));

    const raw = localStorage.getItem('ironclaw-get-started:profile-1');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw ?? '{}')).toMatchObject({ collapsed: true });
    expect(screen.queryByRole('heading', { name: 'Set up your chief of staff' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Chief-of-staff loop is ready' })).toBeTruthy();
  });

  it('keeps connector setup locked when the runner client exists but health is failing', async () => {
    installFakeClient();
    connectionStub.status = 'error';
    render(GetStarted);

    expect(screen.getByText('Connect a healthy runner before packs or missions.')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Open Settings' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Connect runner first' }).length).toBeGreaterThan(
      0
    );

    await waitFor(() => {
      expect(connectionStub.client?.listExtensions).not.toHaveBeenCalled();
    });
  });
});
