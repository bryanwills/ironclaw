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

/**
 * Force `connection.status` to `'connected'` after layout boot.
 * mockTauri pre-seeds settings + token + initialized=true, but never fires
 * a ping — so without this, surfaces that gate on `connection.status ===
 * 'connected'` (council, missions, jobs) render their "IronClaw is offline"
 * guard instead of the live picker / list.
 */
async function pinConnectionConnected(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seed = async (): Promise<void> => {
      try {
        const url = new URL('/src/lib/stores/connection.svelte.ts', window.location.origin).href;
        const mod = (await import(/* @vite-ignore */ url)) as {
          connection: { status: string };
        };
        mod.connection.status = 'connected';
        // Re-apply across the layout's init() flips; the chat surface
        // also re-pings after thread load.
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

/**
 * Override one or more methods on `IronClawClient.prototype` so calls
 * resolve with canned data instead of going through the broken tauri-http
 * fetch path. Each key in `overrides` is a method name; the value is the
 * async return.
 */
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

test('Cmd+Space opens omnibar, typing filters, and Esc closes it', async ({ page }) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await pinConnectionConnected(page);
  await stubClientMethods(page, {
    health: { ok: true, status: 'ok' },
    listThreads: [],
    getHistory: [],
    listSkills: [
      {
        name: 'settings-helper',
        description: 'Helps tune workspace settings.',
        version: '1.0.0',
        installed: true
      }
    ],
    searchMemory: [],
    listLlmProviders: [{ id: 'nearai', name: 'NEAR AI', configured: true, builtin: true }],
    pollThreadChanges: { changed: [], deleted: [], nextSince: Date.now() }
  });

  await page.goto('/chat');
  await expect(page.getByRole('button', { name: /^New Chat$/ })).toBeEnabled({ timeout: 10_000 });

  await page.keyboard.down('Meta');
  await page.keyboard.press('Space');
  await page.keyboard.up('Meta');

  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible({ timeout: 10_000 });
  await expect(listbox.getByRole('option').first()).toBeVisible();

  await page.getByLabel('Search omnibar').fill('settings');
  await expect(listbox.getByRole('option', { name: /Open Settings/i })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(listbox).toBeHidden();
});
