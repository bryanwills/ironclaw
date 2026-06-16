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
      llmProviderId: 'nearai'
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

test('/streams renders filter chips and aggregated activity cards', async ({ page }) => {
  const now = new Date().toISOString();

  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  const threads = [
    {
      id: 'thread-stream',
      title: 'Stream thread',
      created_at: now,
      updated_at: now,
      message_count: 4
    }
  ];
  const routines = [
    {
      id: 'routine-stream',
      name: 'Stream briefing',
      schedule: '0 8 * * *',
      enabled: true,
      last_run: now,
      next_run: new Date(Date.now() + 7_200_000).toISOString()
    }
  ];
  const skills = [
    {
      name: 'stream-skill',
      description: 'Skill event fixture',
      version: '1.0.0',
      installed: true
    }
  ];

  await mockGateway(page, { threads, routines, skills });
  await pinConnectionConnected(page);
  await stubClientMethods(page, {
    health: { ok: true, status: 'ok' },
    listThreads: threads,
    listRoutines: routines,
    listSkills: skills,
    pollThreadChanges: { changed: [], deleted: [], nextSince: Date.now() }
  });

  await page.goto('/streams');

  await expect(page.getByRole('heading', { name: 'Streams' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'All' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chats' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Briefings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Skills' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Stream thread/i })).toBeVisible({
    timeout: 10_000
  });
});
