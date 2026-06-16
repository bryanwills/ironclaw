// Render/structure tests for the collapsed first-run onboarding screen
// (v0.4.72). The three-step wizard was replaced by a single Local-vs-Hosted
// decision:
//   • Local  → one click ("Run on this Mac"), spawns the sidecar.
//   • Hosted → prefilled gateway URL + paste access token; health-checked
//              before onboarding is marked complete.
// Optional config (custom URL, OpenRouter key, API version) lives behind an
// "Advanced" disclosure.
//
// These are render/structure smoke tests — the full save→refresh→navigate
// flow (which drives the connection store + IPC) is covered by the Playwright
// e2e (tests/e2e/onboarding.spec.ts). We deliberately do NOT click the
// completing actions here so the suite stays free of the sidecar/keychain
// IPC chain.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';

import OnboardingPage from './+page.svelte';
import { HOSTED_DEFAULT_URL } from '$lib/stores/settings.svelte';
import { setPagePathname } from '../../../tests/__mocks__/app-state';

/** A default-shaped on-disk settings payload (remote @ localhost, not yet
 *  onboarded) so onMount's loadSettings() hydrates a real active profile. */
function defaultOnDisk() {
  return {
    activeProfileId: 'default',
    onboardingComplete: false,
    profiles: [
      {
        id: 'default',
        name: 'Default',
        mode: 'remote',
        localBaseUrl: 'http://127.0.0.1:3100',
        remoteBaseUrl: 'http://127.0.0.1:3100',
        llmBackend: 'nearai',
        llmProviderId: 'nearai',
        apiVersion: 'v2'
      }
    ],
    trayEnabled: true,
    useResponsesApi: true
  };
}

beforeEach(async () => {
  vi.resetModules();
  const { invoke } = await import('@tauri-apps/api/core');
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  setPagePathname('/onboarding');
  // Tauri shim so loadSettings() round-trips the get_settings payload.
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
  win.__TAURI_INTERNALS__ = {};
  (globalThis as unknown as { window: Record<string, unknown> }).window = win;
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'get_settings') return defaultOnDisk();
    if (cmd === 'get_token') return null;
    if (cmd === 'get_openrouter_key') return null;
    if (cmd === 'sidecar_status') return { running: false, port: null };
    return undefined;
  });
});

afterEach(() => {
  setPagePathname('/');
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (win && '__TAURI_INTERNALS__' in win) {
    delete win.__TAURI_INTERNALS__;
  }
});

describe('onboarding — collapsed Local-vs-Hosted screen', () => {
  it('renders the welcome heading and both choice cards', async () => {
    const { container, getByText } = render(OnboardingPage);
    await waitFor(() => {
      expect(container.textContent).toMatch(/IronClaw Desktop/);
    });
    expect(getByText('Run on this Mac')).toBeTruthy();
    expect(getByText('Connect to hosted')).toBeTruthy();
    // The completing action exists but is not clicked here.
    expect(getByText('Set up later')).toBeTruthy();
  });

  it('reveals the token field on "Connect to hosted" and gates Connect on a token', async () => {
    const { container, getByText, getByLabelText, queryByLabelText } = render(OnboardingPage);
    await waitFor(() => {
      expect(container.textContent).toMatch(/IronClaw Desktop/);
    });
    // Token field is hidden until the user chooses Hosted.
    expect(queryByLabelText('Access token')).toBeNull();

    await fireEvent.click(getByText('Connect to hosted'));

    const token = getByLabelText('Access token') as HTMLInputElement;
    expect(token).toBeTruthy();
    const connect = getByText('Connect') as HTMLButtonElement;
    expect(connect.disabled).toBe(true); // empty token → disabled
    await fireEvent.input(token, { target: { value: 'tok_abc123' } });
    expect(connect.disabled).toBe(false); // token present → enabled
  });

  it('prefills the hosted gateway URL and defaults the API version to v2', async () => {
    const { container, getByLabelText, getByText } = render(OnboardingPage);
    await waitFor(() => {
      expect(container.textContent).toMatch(/IronClaw Desktop/);
    });
    const url = getByLabelText('Custom server URL') as HTMLInputElement;
    expect(url.value).toBe(HOSTED_DEFAULT_URL);
    // The v2 segment is the active default.
    expect((getByText('v2 (recommended)') as HTMLButtonElement).className).toMatch(/on/);
  });

  it('disables the Local action until settings hydrate, then enables it', async () => {
    // Gate get_settings on a deferred promise to observe the pre-hydration
    // window: before loadSettings() resolves, activeProfile is null and an
    // early Local click would silently no-op — so the button must stay
    // disabled until hydration completes.
    const { invoke } = await import('@tauri-apps/api/core');
    let releaseSettings!: (v: unknown) => void;
    const settingsGate = new Promise((res) => {
      releaseSettings = res;
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return settingsGate;
      if (cmd === 'get_token') return null;
      if (cmd === 'get_openrouter_key') return null;
      if (cmd === 'sidecar_status') return { running: false, port: null };
      return undefined;
    });

    const { getByLabelText } = render(OnboardingPage);
    const local = getByLabelText('Run locally on this Mac') as HTMLButtonElement;
    expect(local.disabled).toBe(true); // pre-hydration → disabled, no silent no-op

    releaseSettings(defaultOnDisk());
    await waitFor(() => expect(local.disabled).toBe(false)); // hydrated → enabled
  });
});
