import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { LlmProvider } from '$lib/api/types';

const { connectionStub, clientStub, settingsStub, toastsStub } = vi.hoisted(() => {
  const client = {
    listLlmProviders: vi.fn<() => Promise<LlmProvider[]>>(),
    testLlmConnection: vi.fn(),
    listLlmModels: vi.fn()
  };

  const connection = {
    client,
    activeProfile: {
      id: 'profile-1',
      name: 'Local profile',
      mode: 'local',
      remoteBaseUrl: 'https://gateway.example',
      localBaseUrl: 'http://127.0.0.1:3100',
      llmBackend: 'nearai',
      llmProviderId: 'nearai',
      llmModelId: undefined as string | undefined
    },
    sidecarPort: 31337,
    refresh: vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  };

  const settings = {
    getOpenRouterKey: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    getLlmProviderCredential: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    setOpenRouterKey: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    setLlmProviderCredential: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    deleteOpenRouterKey: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    deleteLlmProviderCredential: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    updateProfile: vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  };

  const toasts = {
    show: vi.fn(),
    dismiss: vi.fn(),
    clear: vi.fn()
  };

  return {
    connectionStub: connection,
    clientStub: client,
    settingsStub: settings,
    toastsStub: toasts
  };
});

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('$lib/stores/connection.svelte', () => ({
  connection: connectionStub
}));

vi.mock('$lib/stores/toasts.svelte', () => ({
  toasts: toastsStub
}));

vi.mock('$lib/stores/settings.svelte', () => ({
  getOpenRouterKey: settingsStub.getOpenRouterKey,
  getLlmProviderCredential: settingsStub.getLlmProviderCredential,
  setOpenRouterKey: settingsStub.setOpenRouterKey,
  setLlmProviderCredential: settingsStub.setLlmProviderCredential,
  deleteOpenRouterKey: settingsStub.deleteOpenRouterKey,
  deleteLlmProviderCredential: settingsStub.deleteLlmProviderCredential,
  updateProfile: settingsStub.updateProfile
}));

import LlmProviderPicker from './LlmProviderPicker.svelte';

const PROVIDERS: LlmProvider[] = [
  {
    id: 'nearai',
    name: 'NEAR.AI',
    adapter: 'nearai',
    credential_kind: 'session_token',
    builtin: true,
    configured: true,
    default_model: 'auto'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    adapter: 'open_ai_completions',
    credential_kind: 'api_key',
    builtin: true,
    configured: false,
    default_model: 'deepseek/deepseek-chat-v3-0324'
  },
  {
    id: 'bedrock',
    name: 'AWS Bedrock',
    adapter: 'bedrock',
    credential_kind: 'aws_credentials',
    builtin: true,
    configured: false
  }
];

function setProfile(mode: 'local' | 'remote', llmProviderId: string, llmModelId?: string): void {
  connectionStub.activeProfile = {
    id: 'profile-1',
    name: mode === 'local' ? 'Local profile' : 'Remote profile',
    mode,
    remoteBaseUrl: 'https://gateway.example',
    localBaseUrl: 'http://127.0.0.1:3100',
    llmBackend: 'nearai',
    llmProviderId,
    llmModelId
  };
}

async function renderPicker(): Promise<HTMLButtonElement> {
  render(LlmProviderPicker);
  await waitFor(() => {
    expect(clientStub.listLlmProviders).toHaveBeenCalled();
  });
  return screen.findByRole('button', { name: 'Save provider' }) as Promise<HTMLButtonElement>;
}

describe('LlmProviderPicker local sidecar support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientStub.listLlmProviders.mockResolvedValue(PROVIDERS);
    settingsStub.getOpenRouterKey.mockResolvedValue(null);
    settingsStub.getLlmProviderCredential.mockResolvedValue(null);
    settingsStub.updateProfile.mockResolvedValue(undefined);
    connectionStub.refresh.mockResolvedValue(undefined);
    setProfile('local', 'nearai');
  });

  it('blocks saving a remote-gateway-only provider in local mode', async () => {
    setProfile('local', 'bedrock');
    const save = await renderPicker();

    expect(await screen.findByText(/The bundled local sidecar cannot spawn it yet/i)).toBeTruthy();
    expect(screen.getAllByText('Remote gateway only').length).toBeGreaterThan(0);
    expect(save.disabled).toBe(true);

    await fireEvent.click(save);
    expect(settingsStub.updateProfile).not.toHaveBeenCalled();
  });

  it('allows saving a sidecar-supported provider in local mode', async () => {
    setProfile('local', 'openrouter');
    const save = await renderPicker();

    expect(await screen.findByText('Supported locally')).toBeTruthy();
    expect(screen.queryByText(/The bundled local sidecar cannot spawn it yet/i)).toBeNull();
    expect(save.disabled).toBe(false);

    await fireEvent.click(save);

    await waitFor(() => {
      expect(settingsStub.updateProfile).toHaveBeenCalledWith('profile-1', {
        llmProviderId: 'openrouter',
        llmBackend: 'openrouter',
        llmModelId: 'deepseek/deepseek-chat-v3-0324'
      });
    });
  });

  it('does not apply local sidecar gating in remote mode', async () => {
    setProfile('remote', 'bedrock');
    const save = await renderPicker();

    expect(screen.queryByText(/The bundled local sidecar cannot spawn it yet/i)).toBeNull();
    expect(save.disabled).toBe(false);

    await fireEvent.click(save);

    await waitFor(() => {
      expect(settingsStub.updateProfile).toHaveBeenCalledWith('profile-1', {
        llmProviderId: 'bedrock',
        llmBackend: 'nearai',
        llmModelId: undefined
      });
    });
  });

  it('saves an explicit model override with the provider', async () => {
    setProfile('local', 'nearai', 'nearai/fast');
    const save = await renderPicker();
    const model = screen.getByLabelText('Default model') as HTMLInputElement;
    expect(model.value).toBe('nearai/fast');

    await fireEvent.input(model, { target: { value: 'nearai/pro' } });
    await fireEvent.click(save);

    await waitFor(() => {
      expect(settingsStub.updateProfile).toHaveBeenCalledWith('profile-1', {
        llmProviderId: 'nearai',
        llmBackend: 'nearai',
        llmModelId: 'nearai/pro'
      });
    });
  });
});
