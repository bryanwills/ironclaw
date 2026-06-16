import { expect, test } from '@playwright/test';
import {
  mockGateway,
  mockGatewaySurfaces,
  mockTauri,
  refreshMockedGatewayConnection,
  type TauriMockSettings
} from './_helpers';

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
  adminMode: false,
  trayEnabled: true,
  useResponsesApi: false,
  engineV2Enabled: false
};

test('Cmd+K exposes connector setup actions before the user finds Extensions', async ({ page }) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page, {
    extensions: [],
    registryExtensions: [
      {
        name: 'gmail',
        display_name: 'Gmail',
        kind: 'wasm_tool',
        description: 'Gmail workspace connector.'
      }
    ]
  });

  let installedExtensions: Array<{
    name: string;
    display_name?: string;
    kind?: string;
    description?: string;
    active?: boolean;
  }> = [];
  const installBodies: unknown[] = [];
  const setupUrls: string[] = [];

  await page.route(/\/api\/extensions(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ extensions: installedExtensions })
    });
  });
  await page.route(/\/api\/extensions\/readiness(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        extensions: installedExtensions.map((e) => ({
          name: e.name,
          phase: 'needs_setup',
          active: false,
          authenticated: false
        }))
      })
    });
  });
  await page.route(/\/api\/extensions\/install$/, async (route) => {
    installBodies.push(route.request().postDataJSON());
    installedExtensions = [
      {
        name: 'gmail',
        display_name: 'Gmail',
        kind: 'wasm_tool',
        description: 'Gmail workspace connector.',
        active: false
      }
    ];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'installed' })
    });
  });
  await page.route(/\/api\/extensions\/[^/]+\/setup(?:\?.*)?$/, async (route) => {
    setupUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        fields: [{ key: 'google_oauth', label: 'Google OAuth', type: 'oauth', required: true }]
      })
    });
  });

  await page.goto('/dashboard');
  await refreshMockedGatewayConnection(page);
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await page.keyboard.down('Meta');
  await page.keyboard.press('K');
  await page.keyboard.up('Meta');

  await page.getByLabel('Command palette search').fill('gmail');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const connectGmail = palette.getByText('Connect Gmail', { exact: true });
  await expect(connectGmail).toBeVisible();
  await connectGmail.click();

  await page.waitForURL((url) => url.pathname === '/extensions');
  await expect(page.getByRole('heading', { name: 'Extensions' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Gmail' })).toBeVisible();
  await expect(page.getByText('Google sign-in')).toBeVisible();
  expect(installBodies).toEqual([expect.objectContaining({ name: 'gmail', slug: 'gmail' })]);
  expect(JSON.stringify(installBodies[0])).not.toContain('tools/gmail');
  expect(setupUrls.at(-1)).toContain('/api/extensions/gmail/setup');
});

test('Cmd+K hides gated Missions navigation when Engine v2 is disabled', async ({ page }) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page);

  await page.goto('/dashboard');
  await refreshMockedGatewayConnection(page);
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await page.keyboard.down('Meta');
  await page.keyboard.press('K');
  await page.keyboard.up('Meta');

  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await page.getByLabel('Command palette search').fill('missions');
  await expect(palette.getByText('Missions', { exact: true })).toHaveCount(0);
});

test('Cmd+K shows Missions navigation when Engine v2 is enabled', async ({ page }) => {
  await mockTauri(page, {
    settings: { ...SETTINGS, engineV2Enabled: true },
    token: 'tok'
  });
  await mockGateway(page);
  await mockGatewaySurfaces(page);

  await page.goto('/dashboard');
  await refreshMockedGatewayConnection(page);
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await page.keyboard.down('Meta');
  await page.keyboard.press('K');
  await page.keyboard.up('Meta');

  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await page.getByLabel('Command palette search').fill('missions');
  await expect(palette.getByText('Missions', { exact: true })).toBeVisible();
});
