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

test('legacy prefixed extension focus opens setup through the Reborn bare name', async ({
  page
}) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page, {
    extensions: [
      {
        name: 'gmail',
        display_name: 'Gmail',
        kind: 'wasm_tool',
        description: 'Gmail workspace connector.',
        active: false
      }
    ]
  });

  const setupUrls: string[] = [];
  await page.route(/\/api\/extensions\/[^/]+\/setup(?:\?.*)?$/, async (route) => {
    setupUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        secrets: [{ name: 'google_oauth_token', prompt: 'Google OAuth token', optional: false }],
        fields: []
      })
    });
  });

  await page.goto('/extensions?focus=tools%2Fgmail&setup=1');
  await refreshMockedGatewayConnection(page);

  await expect(page.getByRole('heading', { name: 'Extensions' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Gmail' })).toBeVisible();
  await expect(page.getByText('Google sign-in token')).toBeVisible();
  expect(setupUrls).toHaveLength(1);
  expect(setupUrls[0]).toContain('/api/extensions/gmail/setup');
  expect(setupUrls[0]).not.toContain('tools%2Fgmail');
});

test('offline setup deep link preserves connector intent instead of showing a generic dead end', async ({
  page
}) => {
  await mockTauri(page, { settings: SETTINGS, token: null });
  await mockGateway(page, { profile: null });
  await mockGatewaySurfaces(page, { extensions: [] });

  await page.goto('/extensions?focus=gmail&setup=1');

  await expect(page.getByRole('heading', { name: 'Extensions' })).toBeVisible();
  await expect(page.getByText('Connect IronClaw to set up Gmail')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Settings' })).toHaveAttribute(
    'href',
    '/settings'
  );
  await expect(page.getByRole('link', { name: 'Connect runner' })).toHaveAttribute(
    'href',
    '/onboarding'
  );
});

test('registry-only setup deep link installs with a Reborn bare name then opens setup', async ({
  page
}) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page, {
    extensions: [],
    registryExtensions: [
      {
        name: 'mcp-servers/notion',
        display_name: 'Notion',
        kind: 'mcp_server',
        description: 'Notion workspace connector.'
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
        name: 'notion',
        display_name: 'Notion',
        kind: 'mcp_server',
        description: 'Notion workspace connector.',
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
        fields: [{ key: 'notion_token', label: 'Notion token', type: 'secret', required: true }]
      })
    });
  });

  await page.goto('/extensions?focus=mcp-servers%2Fnotion&setup=1');
  await refreshMockedGatewayConnection(page);

  await expect(page.getByRole('dialog', { name: 'Notion' })).toBeVisible();
  await expect(page.getByText('Notion token')).toBeVisible();
  expect(installBodies).toEqual([
    expect.objectContaining({ name: 'notion', slug: 'notion', kind: 'mcp_server' })
  ]);
  expect(JSON.stringify(installBodies[0])).not.toContain('mcp-servers/notion');
  expect(setupUrls).toHaveLength(1);
  expect(setupUrls[0]).toContain('/api/extensions/notion/setup');
});

test('same-route extension focus navigation opens setup through the Reborn bare name', async ({
  page
}) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page, {
    extensions: [
      {
        name: 'gmail',
        display_name: 'Gmail',
        kind: 'wasm_tool',
        description: 'Gmail workspace connector.',
        active: false
      }
    ]
  });

  const setupUrls: string[] = [];
  await page.route(/\/api\/extensions\/[^/]+\/setup(?:\?.*)?$/, async (route) => {
    setupUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        secrets: [{ name: 'google_oauth_token', prompt: 'Google OAuth token', optional: false }],
        fields: []
      })
    });
  });

  await page.goto('/extensions');
  await refreshMockedGatewayConnection(page);
  await expect(page.getByRole('heading', { name: 'Extensions' })).toBeVisible();

  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = '/extensions?focus=tools%2Fgmail&setup=1';
    link.textContent = 'Open Gmail setup';
    link.setAttribute('data-testid', 'same-route-focus-link');
    document.body.appendChild(link);
  });
  await page.getByTestId('same-route-focus-link').click();

  await expect(page.getByRole('dialog', { name: 'Gmail' })).toBeVisible();
  await expect(page.getByText('Google sign-in token')).toBeVisible();
  expect(setupUrls.at(-1)).toContain('/api/extensions/gmail/setup');
  expect(setupUrls.at(-1)).not.toContain('tools%2Fgmail');
});

test('workspace connector setup matrix normalizes catalog refs for Gmail, Calendar, Notion, and Slack', async ({
  page
}) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page, {
    extensions: [
      {
        name: 'gmail',
        display_name: 'Gmail',
        kind: 'wasm_tool',
        description: 'Gmail workspace connector.'
      },
      {
        name: 'google_calendar',
        display_name: 'Google Calendar',
        kind: 'wasm_tool',
        description: 'Google Calendar workspace connector.'
      },
      {
        name: 'notion',
        display_name: 'Notion',
        kind: 'mcp_server',
        description: 'Notion workspace connector.'
      },
      {
        name: 'slack',
        display_name: 'Slack',
        kind: 'wasm_channel',
        description: 'Slack channel connector.'
      },
      {
        name: 'slack_tool',
        display_name: 'Slack search',
        kind: 'wasm_tool',
        description: 'Slack search connector.'
      }
    ]
  });

  const setupUrls: string[] = [];
  await page.route(/\/api\/extensions\/[^/]+\/setup(?:\?.*)?$/, async (route) => {
    setupUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ fields: [] })
    });
  });

  const cases = [
    { focus: 'tools/gmail', title: 'Gmail', expectedName: 'gmail' },
    {
      focus: 'tools/google_calendar',
      title: 'Google Calendar',
      expectedName: 'google_calendar'
    },
    { focus: 'mcp-servers/notion', title: 'Notion', expectedName: 'notion' },
    { focus: 'channels/slack', title: 'Slack', expectedName: 'slack' },
    { focus: 'tools/slack_tool', title: 'Slack search', expectedName: 'slack_tool' }
  ];

  for (const entry of cases) {
    await page.goto(`/extensions?focus=${encodeURIComponent(entry.focus)}&setup=1`);
    await refreshMockedGatewayConnection(page);

    const dialog = page.getByRole('dialog', { name: entry.title });
    await expect(dialog).toBeVisible();
    expect(setupUrls.at(-1)).toContain(`/api/extensions/${entry.expectedName}/setup`);
    expect(setupUrls.at(-1)).not.toContain(encodeURIComponent(entry.focus));
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
});

test('OAuth setup drawer starts and polls device login through the Reborn bare name', async ({
  page
}) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page, {
    extensions: [
      {
        name: 'gmail',
        display_name: 'Gmail',
        kind: 'wasm_tool',
        description: 'Gmail workspace connector.',
        active: false
      }
    ]
  });

  const setupUrls: string[] = [];
  await page.route(/\/api\/extensions\/[^/]+\/setup(?:\?.*)?$/, async (route) => {
    setupUrls.push(route.request().url());
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'configured' })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        fields: [
          {
            key: 'google_oauth',
            label: 'Google OAuth',
            type: 'oauth',
            required: true,
            description: 'Sign in with Google.'
          }
        ]
      })
    });
  });

  const loginUrls: string[] = [];
  const loginBodies: unknown[] = [];
  await page.route(/\/api\/extensions\/[^/]+\/login\/start$/, async (route) => {
    loginUrls.push(route.request().url());
    loginBodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        device_code: 'oauth-session-1',
        verification_uri: 'https://accounts.example.test/device',
        user_code: 'ABCD-EFGH',
        expires_in: 600,
        interval: 0.1
      })
    });
  });
  await page.route(/\/api\/extensions\/[^/]+\/login\/poll$/, async (route) => {
    loginUrls.push(route.request().url());
    loginBodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        status: 'completed',
        activated: true,
        session_id: 'oauth-session-1'
      })
    });
  });

  await page.goto('/extensions?focus=tools%2Fgmail&setup=1');
  await refreshMockedGatewayConnection(page);

  await expect(page.getByRole('dialog', { name: 'Gmail' })).toBeVisible();
  await page.getByRole('button', { name: 'Log in with Gmail' }).click();

  await expect(page.getByText('ABCD-EFGH')).toBeVisible();
  await expect(page.getByText('Authorized')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();

  expect(setupUrls[0]).toContain('/api/extensions/gmail/setup');
  expect(loginUrls).toEqual([
    expect.stringContaining('/api/extensions/gmail/login/start'),
    expect.stringContaining('/api/extensions/gmail/login/poll')
  ]);
  expect(loginUrls.join('\n')).not.toContain('tools%2Fgmail');
  expect(loginBodies[0]).toMatchObject({ session_id: expect.any(String) });
  expect(loginBodies[1]).toEqual({ session_id: 'oauth-session-1' });
});

test('needs-auth OAuth connector with empty setup schema still starts sign-in', async ({
  page
}) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page, {
    extensions: [
      {
        name: 'gmail',
        display_name: 'Gmail',
        kind: 'wasm_tool',
        description: 'Gmail workspace connector.',
        active: false
      }
    ]
  });

  await page.route(/\/api\/extensions\/readiness(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        extensions: [
          {
            name: 'gmail',
            phase: 'needs_auth',
            authenticated: false,
            active: false
          }
        ]
      })
    });
  });

  const setupUrls: string[] = [];
  await page.route(/\/api\/extensions\/[^/]+\/setup(?:\?.*)?$/, async (route) => {
    setupUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ fields: [] })
    });
  });

  const loginUrls: string[] = [];
  await page.route(/\/api\/extensions\/[^/]+\/login\/start$/, async (route) => {
    loginUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        status: 'pending',
        session_id: 'oauth-empty-schema-session',
        verification_uri: 'https://accounts.example.test/device',
        user_code: 'ZXCV-1234',
        expires_in: 600,
        interval: 30
      })
    });
  });

  await page.goto('/extensions?focus=tools%2Fgmail&setup=1');
  await refreshMockedGatewayConnection(page);

  const dialog = page.getByRole('dialog', { name: 'Gmail' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Log in with Gmail', exact: true })
  ).toBeVisible();
  await expect(dialog.getByText('This extension has no setup fields')).toHaveCount(0);
  await expect(dialog.getByText(/gateway did not return setup fields/i)).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Log in with Gmail' }).click();

  await expect(dialog.getByText('ZXCV-1234')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(setupUrls).toEqual([expect.stringContaining('/api/extensions/gmail/setup')]);
  expect(loginUrls).toEqual([expect.stringContaining('/api/extensions/gmail/login/start')]);
  expect(`${setupUrls.join('\n')}\n${loginUrls.join('\n')}`).not.toContain('tools%2Fgmail');
});

test('needs-auth connector falls back to Reborn activate auth_url when device login is absent', async ({
  page
}) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page, {
    extensions: [
      {
        name: 'gmail',
        display_name: 'Gmail',
        kind: 'wasm_tool',
        description: 'Gmail workspace connector.',
        active: false
      }
    ]
  });

  await page.route(/\/api\/extensions\/readiness(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        extensions: [
          {
            name: 'gmail',
            phase: 'needs_auth',
            authenticated: false,
            active: false
          }
        ]
      })
    });
  });

  const setupUrls: string[] = [];
  await page.route(/\/api\/extensions\/[^/]+\/setup(?:\?.*)?$/, async (route) => {
    setupUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ fields: [] })
    });
  });

  const loginUrls: string[] = [];
  await page.route(/\/api\/extensions\/[^/]+\/login\/start$/, async (route) => {
    loginUrls.push(route.request().url());
    await route.fulfill({
      status: 404,
      contentType: 'text/plain',
      body: 'not found'
    });
  });

  const activateUrls: string[] = [];
  let activateCount = 0;
  await page.route(/\/api\/extensions\/[^/]+\/activate$/, async (route) => {
    activateUrls.push(route.request().url());
    activateCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        activateCount === 1
          ? {
              success: false,
              message: 'Gmail requires authentication.',
              auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=hosted',
              instructions: 'Finish sign-in in the browser.'
            }
          : {
              success: true,
              status: 'ok',
              activated: true,
              message: 'Gmail connected.'
            }
      )
    });
  });

  await page.goto('/extensions?focus=tools%2Fgmail&setup=1');
  await refreshMockedGatewayConnection(page);

  const dialog = page.getByRole('dialog', { name: 'Gmail' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Log in with Gmail' }).click();

  await expect(dialog.getByText('Finish sign-in in your browser')).toBeVisible();
  await expect(dialog.getByText('https://accounts.google.com/o/oauth2/v2/auth')).toBeVisible();
  await expect(dialog.getByText(/\/api\/extensions\/gmail\/login\/start/)).toHaveCount(0);
  await expect(dialog.getByText(/404/)).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Check connection' }).click();
  await expect(dialog.getByText('Authorized')).toBeVisible();

  expect(setupUrls).toEqual([expect.stringContaining('/api/extensions/gmail/setup')]);
  expect(loginUrls).toEqual([expect.stringContaining('/api/extensions/gmail/login/start')]);
  expect(activateUrls).toEqual([
    expect.stringContaining('/api/extensions/gmail/activate'),
    expect.stringContaining('/api/extensions/gmail/activate')
  ]);
  expect(
    `${setupUrls.join('\n')}\n${loginUrls.join('\n')}\n${activateUrls.join('\n')}`
  ).not.toContain('tools%2Fgmail');
});

test('connector auth never claims connected from an ambiguous activation response', async ({
  page
}) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page, {
    extensions: [
      {
        name: 'gmail',
        display_name: 'Gmail',
        kind: 'wasm_tool',
        description: 'Gmail workspace connector.',
        active: false
      }
    ]
  });

  await page.route(/\/api\/extensions\/readiness(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        extensions: [{ name: 'gmail', phase: 'needs_auth', authenticated: false, active: false }]
      })
    });
  });
  await page.route(/\/api\/extensions\/[^/]+\/setup(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ fields: [] })
    });
  });
  await page.route(/\/api\/extensions\/[^/]+\/login\/start$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        status: 'failed',
        message: 'Server does not support OAuth for this connector yet.'
      })
    });
  });
  await page.route(/\/api\/extensions\/[^/]+\/activate$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({})
    });
  });

  await page.goto('/extensions?focus=tools%2Fgmail&setup=1');
  await refreshMockedGatewayConnection(page);

  const dialog = page.getByRole('dialog', { name: 'Gmail' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Log in with Gmail' }).click();

  await expect(
    dialog.getByText('Server does not support OAuth for this connector yet.')
  ).toBeVisible();
  await expect(dialog.getByText('Authorized')).toHaveCount(0);
  await expect(dialog.getByText(/Connected to Gmail/i)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(dialog.getByText(/\/api\/extensions\/gmail\/login\/start|404|500/)).toHaveCount(0);
});

test('connector drawer uses provider-safe login copy and masks secret fields', async ({ page }) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page, {
    extensions: [
      {
        name: 'google_calendar',
        display_name: 'Google Calendar',
        kind: 'wasm_tool',
        description: 'Google Calendar workspace connector.',
        active: false
      },
      {
        name: 'notion',
        display_name: 'Notion',
        kind: 'mcp_server',
        description: 'Notion workspace connector.',
        active: false
      }
    ]
  });

  await page.route(/\/api\/extensions\/readiness(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        extensions: [
          {
            name: 'google_calendar',
            phase: 'needs_auth',
            authenticated: false,
            active: false
          },
          { name: 'notion', phase: 'needs_setup', authenticated: false, active: false }
        ]
      })
    });
  });
  await page.route(/\/api\/extensions\/[^/]+\/setup(?:\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        path.includes('/notion/')
          ? {
              fields: [
                {
                  key: 'notion_token',
                  label: 'Notion token',
                  type: 'secret',
                  required: true
                }
              ]
            }
          : { fields: [] }
      )
    });
  });

  await page.goto('/extensions?focus=tools%2Fgoogle_calendar&setup=1');
  await refreshMockedGatewayConnection(page);

  let dialog = page.getByRole('dialog', { name: 'Google Calendar' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Log in with Google', exact: true })
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Log in with Google Calendar/ })).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.goto('/extensions?focus=mcp-servers%2Fnotion&setup=1');
  await refreshMockedGatewayConnection(page);

  dialog = page.getByRole('dialog', { name: 'Notion' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input[aria-label="Notion token"]')).toHaveAttribute(
    'type',
    'password'
  );
});

test('setup submit auth_url opens browser-auth handoff instead of closing the drawer', async ({
  page
}) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page, {
    extensions: [
      {
        name: 'gmail',
        display_name: 'Gmail',
        kind: 'wasm_tool',
        description: 'Gmail workspace connector.',
        active: false
      }
    ]
  });

  const setupUrls: string[] = [];
  await page.route(/\/api\/extensions\/[^/]+\/setup(?:\?.*)?$/, async (route) => {
    setupUrls.push(`${route.request().method()} ${route.request().url()}`);
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          message: 'Configuration saved. Complete OAuth in your browser.',
          auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=setup',
          instructions: 'Finish sign-in in the browser.',
          activated: false
        })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        fields: [
          {
            key: 'google_client_secret',
            label: 'Google client secret',
            type: 'secret',
            required: true
          }
        ]
      })
    });
  });
  await page.route(/\/api\/extensions\/[^/]+\/activate$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, status: 'ok', activated: true })
    });
  });

  await page.goto('/extensions?focus=tools%2Fgmail&setup=1');
  await refreshMockedGatewayConnection(page);

  const dialog = page.getByRole('dialog', { name: 'Gmail' });
  await expect(dialog).toBeVisible();
  await dialog.locator('input[aria-label="Google client secret"]').fill('not-a-real-secret');
  await dialog.getByRole('button', { name: 'Save' }).click();

  await expect(dialog.getByText('Finish sign-in in your browser')).toBeVisible();
  await expect(dialog.getByText('https://accounts.google.com/o/oauth2/v2/auth')).toBeVisible();
  await dialog.getByRole('button', { name: 'Check connection' }).click();
  await expect(dialog).toBeHidden();

  expect(setupUrls).toEqual([
    expect.stringContaining('GET http://127.0.0.1:18789/api/extensions/gmail/setup'),
    expect.stringContaining('POST http://127.0.0.1:18789/api/extensions/gmail/setup')
  ]);
  expect(setupUrls.join('\n')).not.toContain('tools%2Fgmail');
});
