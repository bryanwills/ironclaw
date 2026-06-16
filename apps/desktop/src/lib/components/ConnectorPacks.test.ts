import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { Extension } from '$lib/api/types';
import { CONNECTOR_PACKS } from '$lib/data/connector-packs';

const gotoMock = vi.hoisted(() => vi.fn());
const { connectionStub } = vi.hoisted(() => ({
  connectionStub: {
    status: 'connected' as 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error',
    client: null as null | {
      listExtensions: () => Promise<Extension[]>;
      installExtension: (name: string, kindHint?: unknown) => Promise<{ ok: boolean }>;
    }
  }
}));

vi.mock('$app/navigation', () => ({
  goto: gotoMock
}));

vi.mock('$lib/stores/connection.svelte', () => ({
  connection: connectionStub
}));

import ConnectorPacks from './ConnectorPacks.svelte';

function installFakeClient(
  extensions: Extension[] = [],
  installExtension: (name: string, kindHint?: unknown) => Promise<{ ok: boolean }> = vi.fn(
    async (_name: string) => ({ ok: true })
  )
): void {
  connectionStub.status = 'connected';
  connectionStub.client = {
    listExtensions: vi.fn(async () => extensions),
    installExtension
  };
}

describe('ConnectorPacks component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFakeClient();
  });

  it('renders every workspace pack with starter tasks', async () => {
    render(ConnectorPacks);

    await waitFor(() => {
      expect(connectionStub.client?.listExtensions).toHaveBeenCalled();
    });

    for (const pack of CONNECTOR_PACKS) {
      expect(screen.getByText(pack.display_name)).toBeTruthy();
      expect(screen.getByText(pack.example_tasks[0])).toBeTruthy();
    }
  });

  it('shows an inline connection message when no gateway client exists', async () => {
    connectionStub.status = 'disconnected';
    connectionStub.client = null;
    render(ConnectorPacks);

    expect(screen.getAllByRole('button', { name: 'Connect runner first' }).length).toBeGreaterThan(
      0
    );
    expect(screen.getAllByText('Needs runner').length).toBeGreaterThan(0);
  });

  it('does not install when a configured client is not healthy yet', async () => {
    const installExtension = vi.fn(async (_name: string) => ({ ok: true }));
    installFakeClient([], installExtension);
    connectionStub.status = 'error';
    render(ConnectorPacks);

    const [connectButton] = await screen.findAllByRole('button', {
      name: 'Connect runner first'
    });
    expect((connectButton as HTMLButtonElement).disabled).toBe(true);
    expect(installExtension).not.toHaveBeenCalled();
  });

  it('shows readiness states from extension readiness', async () => {
    installFakeClient([
      { name: 'gmail', installed: true, ready: true, readiness_message: 'ready' },
      { name: 'google_docs', installed: true, ready: true, readiness_message: 'ready' },
      { name: 'google_drive', installed: true, ready: true, readiness_message: 'ready' },
      { name: 'google_sheets', installed: true, ready: true, readiness_message: 'ready' },
      { name: 'google_slides', installed: true, ready: true, readiness_message: 'ready' },
      { name: 'notion', installed: true, readiness_message: 'needs_auth' },
      { name: 'slack', installed: true, ready: true, readiness_message: 'ready' },
      { name: 'slack_tool', installed: true, ready: true, readiness_message: 'ready' }
    ]);

    render(ConnectorPacks);

    await waitFor(() => {
      expect(screen.getByText('Connected')).toBeTruthy();
      expect(screen.getByText('Needs sign-in')).toBeTruthy();
      expect(screen.getByText('Partial')).toBeTruthy();
    });
  });

  it('connects packs using Reborn bare extension names', async () => {
    installFakeClient([]);
    render(ConnectorPacks);

    const [googleConnect] = await screen.findAllByRole('button', { name: 'Connect' });
    await fireEvent.click(googleConnect);

    await waitFor(() => {
      expect(connectionStub.client?.installExtension).toHaveBeenCalledTimes(
        CONNECTOR_PACKS[0].extensions.length
      );
    });
    const install = connectionStub.client?.installExtension;
    expect(install).toBeTruthy();
    const names = vi.mocked(install!).mock.calls.map(([name]) => name);
    expect(names).toEqual(CONNECTOR_PACKS[0].extensions);
    expect(names.every((name) => !name.includes('/'))).toBe(true);
    expect(gotoMock).toHaveBeenCalledWith('/extensions?focus=gmail&setup=1');
  });

  it('does not let optional Google app install failures block core setup', async () => {
    const installExtension = vi.fn(async (name: string) => {
      if (name === 'google_docs') {
        const error = new Error('404 optional app not available');
        Object.assign(error, { status: 404 });
        throw error;
      }
      return { ok: true };
    });
    installFakeClient([], installExtension);
    render(ConnectorPacks);

    const [googleConnect] = await screen.findAllByRole('button', { name: 'Connect' });
    await fireEvent.click(googleConnect);

    await waitFor(() => {
      expect(gotoMock).toHaveBeenCalledWith('/extensions?focus=gmail&setup=1');
    });
    expect(installExtension).toHaveBeenCalledWith('gmail', 'wasm_tool');
    expect(installExtension).toHaveBeenCalledWith('google_calendar', 'wasm_tool');
    expect(installExtension).toHaveBeenCalledWith('google_docs', 'wasm_tool');
    expect(
      screen.getByText('Core apps installed. Open setup if optional apps need credentials.')
    ).toBeTruthy();
  });

  it('opens a pack in Extensions with the primary extension focused', async () => {
    render(ConnectorPacks);

    const openButtons = await screen.findAllByRole('button', { name: 'Open in Extensions' });
    await fireEvent.click(openButtons[0]);

    expect(gotoMock).toHaveBeenCalledWith(
      `/extensions?focus=${encodeURIComponent(CONNECTOR_PACKS[0].primary_extension_id)}`
    );
  });
});
