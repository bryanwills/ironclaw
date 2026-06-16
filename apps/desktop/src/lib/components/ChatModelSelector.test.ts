import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { GatewayStatus, LlmModel, LlmProvider } from '$lib/api/types';

const { connectionStub, clientStub, settingsStub, toastsStub } = vi.hoisted(() => {
  const client = {
    listLlmProviders: vi.fn<() => Promise<LlmProvider[]>>(),
    listLlmModels: vi.fn<(provider: string) => Promise<LlmModel[]>>(),
    gatewayStatus: vi.fn<() => Promise<GatewayStatus>>()
  };
  const connection = {
    client,
    status: 'connected',
    sidecarStatus: 'running',
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
    reloadSettings: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stopSidecar: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    startSidecar: vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
  };
  return {
    clientStub: client,
    connectionStub: connection,
    settingsStub: {
      updateProfile: vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    },
    toastsStub: {
      show: vi.fn()
    }
  };
});

vi.mock('$lib/stores/connection.svelte', () => ({
  connection: connectionStub
}));

vi.mock('$lib/stores/settings.svelte', () => ({
  updateProfile: settingsStub.updateProfile
}));

vi.mock('$lib/stores/toasts.svelte', () => ({
  toasts: toastsStub
}));

import ChatModelSelector from './ChatModelSelector.svelte';

const PROVIDERS: LlmProvider[] = [
  {
    id: 'nearai',
    name: 'NEAR.AI',
    configured: true,
    builtin: true,
    default_model: 'auto'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    configured: true,
    builtin: true,
    default_model: 'deepseek/deepseek-chat-v3-0324'
  }
];

describe('ChatModelSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionStub.client = clientStub;
    connectionStub.sidecarStatus = 'running';
    connectionStub.activeProfile = {
      id: 'profile-1',
      name: 'Local profile',
      mode: 'local',
      remoteBaseUrl: 'https://gateway.example',
      localBaseUrl: 'http://127.0.0.1:3100',
      llmBackend: 'nearai',
      llmProviderId: 'nearai',
      llmModelId: undefined
    };
    clientStub.listLlmProviders.mockResolvedValue(PROVIDERS);
    clientStub.listLlmModels.mockResolvedValue([]);
    clientStub.gatewayStatus.mockResolvedValue({
      llm_backend: 'nearai',
      llm_model: 'auto',
      model_execution_verified: true,
      model_readiness: 'GREEN',
      enabled_channels: [],
      sse_connections: 0,
      ws_connections: 0,
      total_connections: 0
    });
  });

  it('shows the active provider and gateway-reported model in chat', async () => {
    render(ChatModelSelector);

    expect(await screen.findByLabelText('Chat model controls')).toBeTruthy();
    expect(await screen.findByText(/Running: NEAR\.AI \/ auto/i)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: /Running: NEAR\.AI \/ auto/i }));
    expect((screen.getByLabelText('Chat model') as HTMLInputElement).value).toBe('auto');
  });

  it('shows configured-but-unverified models as runnable first-run probes', async () => {
    clientStub.gatewayStatus.mockResolvedValueOnce({
      llm_backend: 'NEAR.AI',
      llm_model: 'z-ai/glm-4.5',
      model_execution_verified: false,
      model_readiness: 'unverified',
      enabled_channels: [],
      sse_connections: 0,
      ws_connections: 0,
      total_connections: 0
    });

    render(ChatModelSelector);

    await fireEvent.click(
      await screen.findByRole('button', { name: /Running: NEAR\.AI \/ z-ai\/glm-4\.5/i })
    );
    expect(screen.getByText(/first successful chat run will verify/i)).toBeTruthy();
  });

  it('hides non-NEAR providers for the local sidecar chat selector', async () => {
    render(ChatModelSelector);

    await fireEvent.click(
      await screen.findByRole('button', { name: /Running: NEAR\.AI \/ auto/i })
    );

    expect(screen.getByRole('option', { name: 'NEAR.AI' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'OpenRouter' })).toBeNull();
  });

  it('saves a local model override and offers a runner restart', async () => {
    render(ChatModelSelector);

    await fireEvent.click(
      await screen.findByRole('button', { name: /Running: NEAR\.AI \/ auto/i })
    );
    const model = screen.getByLabelText('Chat model') as HTMLInputElement;
    await fireEvent.input(model, { target: { value: 'nearai/pro' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(settingsStub.updateProfile).toHaveBeenCalledWith('profile-1', {
        llmProviderId: 'nearai',
        llmBackend: 'nearai',
        llmModelId: 'nearai/pro'
      });
    });
    expect(await screen.findByRole('button', { name: 'Restart runner' })).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Restart runner' }));
    expect(connectionStub.stopSidecar).toHaveBeenCalled();
    expect(connectionStub.startSidecar).toHaveBeenCalled();
  });
});
