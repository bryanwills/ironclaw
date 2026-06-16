import { test, expect, type Page } from '@playwright/test';
import { mockGateway, mockTauri, type TauriMockSettings } from './_helpers';

const SETTINGS: TauriMockSettings = {
  activeProfileId: 'default',
  profiles: [
    {
      id: 'default',
      name: 'Default',
      mode: 'remote',
      remoteBaseUrl: 'http://127.0.0.1:18789',
      localBaseUrl: 'http://127.0.0.1:3100',
      llmBackend: 'nearai',
      llmProviderId: 'nearai',
      apiVersion: 'v1'
    }
  ],
  onboardingComplete: true,
  adminMode: true,
  trayEnabled: true,
  useResponsesApi: false,
  engineV2Enabled: false
};

async function pinConnectionConnected(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seed = async (): Promise<void> => {
      try {
        const url = new URL('/src/lib/stores/connection.svelte.ts', window.location.origin).href;
        const mod = (await import(/* @vite-ignore */ url)) as {
          connection: { status: string };
        };
        mod.connection.status = 'connected';
        setTimeout(() => (mod.connection.status = 'connected'), 200);
        setTimeout(() => (mod.connection.status = 'connected'), 800);
      } catch {
        /* best-effort */
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => void seed(), { once: true });
    } else {
      void seed();
    }
  });
}

async function stubClientMethods(page: Page, overrides: Record<string, unknown>): Promise<void> {
  await page.addInitScript((ov: Record<string, unknown>) => {
    const seed = async (): Promise<void> => {
      try {
        const url = new URL('/src/lib/api/ironclaw.ts', window.location.origin).href;
        const mod = (await import(/* @vite-ignore */ url)) as {
          IronClawClient: { prototype: Record<string, unknown> };
        };
        for (const [name, value] of Object.entries(ov)) {
          mod.IronClawClient.prototype[name] = function stub() {
            return Promise.resolve(value);
          };
        }
      } catch {
        /* best-effort */
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => void seed(), { once: true });
    } else {
      void seed();
    }
  }, overrides);
}

test('Cmd+. reveals replay bar with scrubber and play button', async ({ page }) => {
  const now = new Date();
  const thread = {
    id: 'thread-replay',
    title: 'Replay thread',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    message_count: 1
  };

  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  const messages = [
    {
      id: 'msg-user-replay',
      role: 'user' as const,
      content: 'Replay this',
      created_at: now.toISOString()
    },
    {
      id: 'msg-assistant-replay',
      role: 'assistant' as const,
      content: 'Replayed answer',
      created_at: now.toISOString()
    }
  ];
  const replayEvents = [
    {
      id: 'ev-1',
      kind: 'message_start',
      ts: new Date(now.getTime() - 2000).toISOString(),
      payload: { role: 'user' }
    },
    {
      id: 'ev-2',
      kind: 'content_delta',
      ts: new Date(now.getTime() - 1000).toISOString(),
      payload: { delta: 'Replayed answer' }
    }
  ];

  await mockGateway(page, {
    threads: [thread],
    threadMessages: { 'thread-replay': messages },
    threadEvents: { 'thread-replay': { events: replayEvents, nextSinceTs: now.getTime() } }
  });
  await pinConnectionConnected(page);
  await stubClientMethods(page, {
    health: { ok: true, status: 'ok' },
    listThreads: [thread],
    getHistory: messages,
    getThreadEvents: {
      events: replayEvents,
      nextSinceTs: now.getTime()
    },
    listSkills: [],
    listLlmProviders: [{ id: 'nearai', name: 'NEAR AI', configured: true, builtin: true }],
    pollThreadChanges: { changed: [], deleted: [], nextSince: Date.now() }
  });

  await page.goto('/chat?thread=thread-replay');
  await expect(page.getByText('Replayed answer')).toBeVisible({ timeout: 10_000 });

  await page.keyboard.down('Meta');
  await page.keyboard.press('.');
  await page.keyboard.up('Meta');

  const replay = page.getByRole('region', { name: 'Time-travel replay controls' });
  await expect(replay).toBeVisible({ timeout: 10_000 });
  await expect(replay.getByLabel('Replay cursor')).toBeVisible();
  await expect(replay.getByRole('button', { name: 'Play replay' })).toBeVisible();
});
