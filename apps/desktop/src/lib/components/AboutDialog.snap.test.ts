// Snapshot test for the open AboutDialog. The dialog's content surface
// depends on `gatewayStatus()` (server roundtrip) + Tauri's
// `app.getVersion()` + the navigator UA — we mock all three so the
// rendered output is byte-identical across runs and machines.
//
// Tauri's `app` module is dynamically `import()`-ed inside the dialog
// only when `open` flips true; vitest's `vi.mock` covers dynamic
// imports the same way it does static, so the mock below catches the
// call regardless.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';

const { connectionStub } = vi.hoisted(() => ({
  connectionStub: {
    status: 'connected' as 'connected' | 'disconnected' | 'error' | 'connecting' | 'idle',
    activeProfile: {
      id: 'p1',
      name: 'Default',
      mode: 'remote' as 'remote' | 'local',
      remoteBaseUrl: 'http://127.0.0.1:3100',
      localBaseUrl: 'http://127.0.0.1:3100',
      llmBackend: 'nearai' as const
    },
    settings: {
      profiles: [
        {
          id: 'p1',
          name: 'Default',
          mode: 'remote' as const,
          remoteBaseUrl: 'http://127.0.0.1:3100',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai' as const
        }
      ]
    },
    sidecarStatus: 'idle' as 'idle' | 'starting' | 'running' | 'exited' | 'error',
    sidecarPort: null as number | null,
    sidecarError: null as string | null,
    client: {
      gatewayStatus: async () => ({
        version: '0.29.4',
        engine_v2_enabled: true,
        llm_model: 'deepseek-chat-v3-0324',
        enabled_channels: ['telegram', 'discord']
      })
    }
  }
}));

vi.mock('$lib/stores/connection.svelte', () => ({
  connection: connectionStub
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn().mockResolvedValue('0.1.13')
}));

import AboutDialog from './AboutDialog.svelte';

// jsdom doesn't ship a stable `navigator.userAgent`/`screen` pair for
// our snapshot needs. Pin both before the component reads them so
// the System section renders fixed values rather than the host OS.
beforeAll(() => {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
  });
  if (typeof window !== 'undefined' && window.screen) {
    Object.defineProperty(window.screen, 'width', { configurable: true, value: 1920 });
    Object.defineProperty(window.screen, 'height', { configurable: true, value: 1080 });
  }
});

beforeEach(() => {
  connectionStub.status = 'connected';
});

afterEach(() => {
  // Restore body overflow that the dialog's $effect sets to "hidden"
  // on open. Test isolation otherwise leaks across files.
  if (typeof document !== 'undefined') document.body.style.overflow = '';
});

describe('AboutDialog snapshots', () => {
  it('matches the open snapshot with a connected gateway', async () => {
    const { container } = render(AboutDialog, {
      props: { open: true, onclose: () => undefined }
    });
    // The gateway info + Tauri app version both resolve in the next
    // microtask queue. Wait a couple of beats so both promises settle
    // before we sample the DOM.
    await new Promise((r) => setTimeout(r, 10));
    expect(container.innerHTML).toMatchSnapshot();
  });
});
