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

test('assistant markdown mounts mermaid, math, and plotly render hosts', async ({ page }) => {
  const now = new Date().toISOString();
  const markdown = [
    'Here is a diagram:',
    '',
    '```mermaid',
    'graph TD; A-->B',
    '```',
    '',
    'Inline math $x^2$ appears here.',
    '',
    '```plotly',
    '{"data":[{"x":[1,2],"y":[1,4],"type":"scatter"}],"layout":{"title":"Squares"}}',
    '```'
  ].join('\n');

  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  const messages = [
    {
      id: 'msg-user-mm',
      role: 'user' as const,
      content: 'Render multimodal blocks',
      created_at: now
    },
    {
      id: 'msg-assistant-mm',
      role: 'assistant' as const,
      content: markdown,
      created_at: now
    }
  ];

  await mockGateway(page, {
    threads: [
      {
        id: 'thread-multimodal',
        title: 'Multimodal thread',
        created_at: now,
        updated_at: now,
        message_count: 1
      }
    ],
    threadMessages: { 'thread-multimodal': messages }
  });
  await pinConnectionConnected(page);
  await stubClientMethods(page, {
    health: { ok: true, status: 'ok' },
    listThreads: [
      {
        id: 'thread-multimodal',
        title: 'Multimodal thread',
        created_at: now,
        updated_at: now,
        message_count: 1
      }
    ],
    getHistory: messages,
    listSkills: [],
    listLlmProviders: [{ id: 'nearai', name: 'NEAR AI', configured: true, builtin: true }],
    pollThreadChanges: { changed: [], deleted: [], nextSince: Date.now() }
  });

  await page.goto('/chat?thread=thread-multimodal');

  await expect(page.getByText('Here is a diagram:')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-md-renderer="mermaid"]').first()).toHaveCount(1);
  await expect(page.locator('[data-md-renderer="math"]').first()).toHaveCount(1);
  await expect(page.locator('[data-md-renderer="plotly"]').first()).toHaveCount(1);
});
