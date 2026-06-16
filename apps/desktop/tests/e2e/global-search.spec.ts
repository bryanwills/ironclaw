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
  engineV2Enabled: true
};

const GATEWAY_HOSTS = '(?:127\\.0\\.0\\.1|localhost):(?:3100|3334|3000|8080|18789|22821|4444)';

async function openGlobalSearch(page: Parameters<typeof mockTauri>[0]): Promise<void> {
  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('F');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');
  await expect(page.getByRole('dialog', { name: 'Global search' })).toBeVisible({
    timeout: 5000
  });
}

test('global search groups rendered results and keyboard-opens a thread deep link', async ({
  page
}) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page, {
    threads: [
      {
        id: 'thread-northwind',
        title: 'Northwind MSA',
        created_at: '2026-06-01T08:00:00.000Z',
        updated_at: '2026-06-01T08:30:00.000Z',
        message_count: 19
      }
    ]
  });
  await mockGatewaySurfaces(page, {
    skills: [
      {
        name: 'northwind-contract-brief',
        description: 'Summarize Northwind contract risks.',
        version: '1.0.0'
      }
    ],
    routines: [
      {
        id: 'routine-northwind',
        name: 'Northwind renewal sweep',
        enabled: true,
        trigger_summary: 'weekday 08:30'
      }
    ],
    jobs: [
      {
        id: 'job-northwind',
        title: 'Northwind diligence export',
        state: 'completed',
        user_id: 'default',
        created_at: '2026-06-01T08:00:00.000Z'
      }
    ],
    extensions: [
      {
        name: 'northwind',
        display_name: 'Northwind Connector',
        kind: 'mcp',
        description: 'Northwind workspace connector.',
        active: true
      }
    ],
    memoryNodes: [{ path: 'contracts/Northwind_MSA.md', type: 'file' }]
  });
  await page.route(new RegExp(`^https?://${GATEWAY_HOSTS}/api/memory/search$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          {
            path: 'contracts/Northwind_MSA.md',
            snippet: 'Northwind may raise renewal fees by 12%.',
            score: 0.98
          }
        ]
      })
    });
  });
  await page.route(
    new RegExp(
      `^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/thread-northwind/timeline(?:\\?.*)?$`
    ),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          records: [
            {
              kind: 'user',
              message_id: 'u-northwind',
              content: 'Can you triage the Northwind MSA?',
              sequence: 1,
              created_at: '2026-06-01T08:00:00.000Z'
            },
            {
              kind: 'assistant',
              message_id: 'a-northwind',
              content: 'Northwind follow-up is due.',
              sequence: 2,
              created_at: '2026-06-01T08:01:00.000Z'
            }
          ],
          next_cursor: null,
          has_more: false
        })
      });
    }
  );

  await page.goto('/dashboard');
  await refreshMockedGatewayConnection(page);
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await openGlobalSearch(page);
  const dialog = page.getByRole('dialog', { name: 'Global search' });
  await page.getByLabel('Global search across all surfaces').fill('northwind');

  for (const section of ['Knowledge', 'Threads', 'Jobs', 'Skills', 'Routines', 'Extensions']) {
    await expect(dialog.getByText(section, { exact: true }).first()).toBeVisible({
      timeout: 5000
    });
  }
  await expect(dialog.getByText('contracts/Northwind_MSA.md')).toBeVisible();
  await expect(dialog.getByText('Northwind MSA')).toBeVisible();
  await expect(dialog.getByText('Northwind diligence export')).toBeVisible();

  await dialog.getByRole('tab', { name: /Threads/ }).click();
  await page.getByLabel('Global search across all surfaces').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Northwind follow-up is due.')).toBeVisible({ timeout: 5000 });

  await openGlobalSearch(page);
  await expect(dialog.getByText('Recent searches')).toBeVisible();
  await expect(dialog.getByText('northwind', { exact: true })).toBeVisible();
});

test('global search extension result opens setup with a bare Reborn extension name', async ({
  page
}) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page, {
    extensions: [],
    registryExtensions: [
      {
        name: 'tools/gmail',
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
        extensions: installedExtensions.map((extension) => ({
          name: extension.name,
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

  await openGlobalSearch(page);
  const dialog = page.getByRole('dialog', { name: 'Global search' });
  await page.getByLabel('Global search across all surfaces').fill('gmail');
  await dialog.getByRole('tab', { name: /Extensions/ }).click();
  await expect(dialog.getByText('Gmail', { exact: true }).first()).toBeVisible({ timeout: 5000 });
  await dialog.getByText('Gmail', { exact: true }).first().click();

  await page.waitForURL((url) => url.pathname === '/extensions');
  await expect(page.getByRole('heading', { name: 'Extensions' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Gmail' })).toBeVisible();
  await expect(page.getByText('Google sign-in')).toBeVisible();
  expect(installBodies).toEqual([expect.objectContaining({ name: 'gmail', slug: 'gmail' })]);
  expect(JSON.stringify(installBodies[0])).not.toContain('tools/gmail');
  expect(setupUrls.at(-1)).toContain('/api/extensions/gmail/setup');
});
