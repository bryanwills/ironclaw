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

test('chat tabs render persisted thread tabs on the /chat deep link', async ({ page }) => {
  test.setTimeout(60_000);
  const now = new Date().toISOString();
  const threads = [
    {
      id: 'thread-alpha',
      title: 'Alpha thread',
      created_at: now,
      updated_at: now,
      message_count: 1
    },
    {
      id: 'thread-beta',
      title: 'Beta thread',
      created_at: now,
      updated_at: now,
      message_count: 2
    }
  ];

  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page, {
    threads,
    threadMessages: { 'thread-alpha': [], 'thread-beta': [] }
  });
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'ironclaw-chat-tabs-default',
      JSON.stringify({ openTabs: ['thread-alpha', 'thread-beta'], activeTabId: 'thread-alpha' })
    );
  });

  await page.goto('/chat?thread=thread-alpha');

  const tablist = page.getByRole('tablist', { name: 'Open chat tabs' });
  await expect(tablist).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[role="tab"][title="Alpha thread"]')).toHaveAttribute(
    'aria-selected',
    'true'
  );

  await expect(tablist.getByRole('tab')).toHaveCount(2);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
