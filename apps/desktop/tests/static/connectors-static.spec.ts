import { expect, test, type Page, type Route } from '@playwright/test';

const gatewayStatus = {
  engine_v2_enabled: true,
  restart_enabled: false,
  total_connections: 0,
  llm_backend: 'nearai',
  llm_model: 'auto',
  model_execution_verified: true,
  model_readiness: 'ready',
  model_execution_readiness: 'ready'
};

const llmProviders = {
  providers: [
    {
      id: 'nearai',
      name: 'NEAR AI Cloud',
      description: 'Model access through NEAR AI Cloud.',
      adapter: 'nearai',
      default_model: 'auto',
      builtin: true,
      api_key_required: false,
      accepts_api_key: true,
      base_url_required: false,
      api_key_set: true
    }
  ],
  active: {
    provider_id: 'nearai',
    model: 'auto'
  }
};

const registryEntries = [
  {
    id: 'gmail',
    display_name: 'Gmail',
    kind: 'wasm_tool',
    description: 'Read, triage, draft, and prepare email work with approval gates.',
    package_ref: { kind: 'extension', id: 'tools/gmail' },
    keywords: ['email', 'google', 'inbox']
  },
  {
    id: 'google-calendar',
    display_name: 'Google Calendar',
    kind: 'wasm_tool',
    description: 'Find meetings, protect focus blocks, and prepare schedule changes.',
    package_ref: { kind: 'extension', id: 'tools/google_calendar' },
    keywords: ['calendar', 'google', 'schedule']
  },
  {
    id: 'notion',
    display_name: 'Notion',
    kind: 'mcp_server',
    description: 'Search team knowledge, draft pages, and keep decisions visible.',
    package_ref: { kind: 'extension', id: 'mcp-servers/notion' },
    keywords: ['knowledge', 'docs', 'wiki']
  },
  {
    id: 'slack',
    display_name: 'Slack',
    kind: 'wasm_channel',
    description: 'Summarize channels, prepare replies, and surface urgent asks.',
    package_ref: { kind: 'extension', id: 'channels/slack' },
    keywords: ['messages', 'team', 'channels']
  }
];

test('static connectors: registry clicks keep slash refs out of lifecycle URLs', async ({
  page
}) => {
  const calls: CapturedCall[] = [];
  await installConnectorMocks(page, calls);

  await page.goto('/v2/extensions/registry?token=connector-static-token');
  await expect(page.getByTestId('registry-card-gmail')).toBeVisible();

  await clickRegistryConnect(page, 'gmail');
  await expect
    .poll(() => hasPath(calls, '/api/webchat/v2/extensions/gmail/setup/oauth/start'))
    .toBe(true);
  await expectGoogleSetupLinks(page, 'gmail');

  await clickRegistryConnect(page, 'google-calendar');
  await expect
    .poll(() => hasPath(calls, '/api/webchat/v2/extensions/google-calendar/setup/oauth/start'))
    .toBe(true);
  await expectGoogleSetupLinks(page, 'google-calendar');

  await clickRegistryConnect(page, 'notion');
  await expect
    .poll(() => hasPath(calls, '/api/webchat/v2/extensions/notion/setup/oauth/start'))
    .toBe(true);
  await expect(
    page.getByTestId('registry-card-notion').getByRole('button', { name: 'Retry connect' })
  ).toBeVisible();

  await clickRegistryConnect(page, 'slack');
  await expect.poll(() => hasPath(calls, '/api/webchat/v2/extensions/slack/activate')).toBe(true);
  await expect(
    page.getByTestId('registry-card-slack').getByRole('button', { name: 'Connected' })
  ).toBeDisabled();

  const installCalls = calls.filter((call) => call.path === '/api/webchat/v2/extensions/install');
  expect(installCalls.map((call) => call.body?.package_ref?.id)).toEqual([
    'tools/gmail',
    'tools/google_calendar',
    'mcp-servers/notion',
    'channels/slack'
  ]);

  const lifecycleCalls = calls.filter((call) => call.path !== '/api/webchat/v2/extensions/install');
  for (const call of lifecycleCalls) {
    expect(call.path).not.toContain('tools/');
    expect(call.path).not.toContain('channels/');
    expect(call.path).not.toContain('mcp-servers/');
    expect(call.path).not.toContain('google_calendar');
  }
});

test('static connectors: registry surfaces honest BLOCKED and NEEDS SETUP readiness at rest', async ({
  page
}) => {
  // connections-1: a card may not imply readiness the gateway cannot prove. The
  // registry status badge reads a projected connect phase, so an at-rest card
  // shows BLOCKED (hosted Google OAuth unavailable) or NEEDS SETUP (credentials
  // required) instead of a fake "connected" state.
  const calls: CapturedCall[] = [];
  await installConnectorMocks(page, calls, [
    {
      id: 'gmail',
      display_name: 'Gmail',
      kind: 'wasm_tool',
      description: 'Read, triage, draft, and prepare email work with approval gates.',
      package_ref: { kind: 'extension', id: 'tools/gmail' },
      keywords: ['email', 'google', 'inbox'],
      connectPhase: { phase: 'blocked-google-client-id' }
    },
    {
      id: 'notion',
      display_name: 'Notion',
      kind: 'mcp_server',
      description: 'Search team knowledge, draft pages, and keep decisions visible.',
      package_ref: { kind: 'extension', id: 'mcp-servers/notion' },
      keywords: ['knowledge', 'docs', 'wiki'],
      connectPhase: { phase: 'needs-token' }
    }
  ]);

  await page.goto('/v2/extensions/registry?token=connector-static-token');

  const gmailCard = page.getByTestId('registry-card-gmail');
  await expect(gmailCard).toBeVisible();
  await expect(gmailCard.getByText('BLOCKED', { exact: true })).toBeVisible();
  await expect(gmailCard.getByText('AVAILABLE', { exact: true })).toHaveCount(0);

  const notionCard = page.getByTestId('registry-card-notion');
  await expect(notionCard).toBeVisible();
  await expect(notionCard.getByText('NEEDS SETUP', { exact: true })).toBeVisible();
  await expect(notionCard.getByText('AVAILABLE', { exact: true })).toHaveCount(0);

  // At-rest readiness is descriptive only — no install/lifecycle calls fire
  // just from rendering the catalog.
  expect(calls.filter((call) => call.path === '/api/webchat/v2/extensions/install')).toHaveLength(
    0
  );
});

test('static connectors: chat connect prompts open an honest extension setup path', async ({
  page
}) => {
  const calls: CapturedCall[] = [];
  await installConnectorMocks(page, calls);

  await page.goto('/v2/chat?token=connector-static-token');
  await expect(
    page.getByRole('heading', { name: 'What should IronClaw handle next?' })
  ).toBeVisible();

  await page
    .getByPlaceholder('Hand IronClaw a document, note, or task…')
    .fill('connect notion for my team docs');
  await page.getByRole('button', { name: 'Send message' }).click();

  const recovery = page.getByTestId('connector-recovery-card');
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText('Open Notion setup');
  await expect(recovery.getByRole('link', { name: 'Open setup' })).toHaveAttribute(
    'href',
    '/v2/extensions/registry?setup=1&focus=notion'
  );

  await recovery.getByRole('link', { name: 'Open setup' }).click();
  await expect(page).toHaveURL(/\/v2\/extensions\/registry\?setup=1&focus=notion/);
  await expect(page.getByTestId('registry-card-notion')).toBeVisible();
});

test('static connectors: custom MCP install posts a Reborn URL install payload', async ({
  page
}) => {
  const calls: CapturedCall[] = [];
  await installConnectorMocks(page, calls);

  await page.goto('/v2/extensions/mcp?token=connector-static-token');
  await expect(page.getByTestId('custom-mcp-card')).toBeVisible();
  await expect(page.getByTestId('custom-mcp-card')).toHaveAttribute('data-disabled-reason', '');

  await page.getByTestId('custom-mcp-name').fill('Team Docs');
  await page.getByTestId('custom-mcp-url').fill('https://docs.example.com/mcp');
  await page.getByTestId('custom-mcp-submit').click();

  await expect
    .poll(() =>
      calls.some(
        (call) =>
          call.path === '/api/webchat/v2/extensions/install' &&
          call.body?.kind === 'mcp_server' &&
          call.body?.name === 'team-docs'
      )
    )
    .toBe(true);

  const installCall = calls.find(
    (call) => call.path === '/api/webchat/v2/extensions/install' && call.body?.name === 'team-docs'
  );
  expect(installCall?.body).toEqual({
    name: 'team-docs',
    url: 'https://docs.example.com/mcp',
    kind: 'mcp_server'
  });
  expect(installCall?.body?.package_ref).toBeUndefined();
  await expect(page.getByText('team-docs installed')).toBeVisible();
});

test('static connectors: custom MCP form blocks insecure remote HTTP before gateway calls', async ({
  page
}) => {
  const calls: CapturedCall[] = [];
  await installConnectorMocks(page, calls);

  await page.goto('/v2/extensions/mcp?token=connector-static-token');
  await page.getByTestId('custom-mcp-name').fill('Team Docs');
  await page.getByTestId('custom-mcp-url').fill('http://docs.example.com/mcp');
  await page.getByTestId('custom-mcp-submit').click();

  await expect(
    page.getByText('Use HTTPS, or localhost HTTP for a local MCP server.')
  ).toBeVisible();
  expect(calls.filter((call) => call.path === '/api/webchat/v2/extensions/install')).toHaveLength(
    0
  );
});

test('static connectors: failed connector runs recover to extension setup', async ({ page }) => {
  const calls: CapturedCall[] = [];
  await installConnectorMocks(page, calls);

  await page.goto('/v2/chat/thread-connector-failure?token=connector-static-token');
  await page.locator('textarea').first().waitFor({ timeout: 20_000 });

  await expect(page.getByText('Notion tool is not installed for this run.')).toBeVisible({
    timeout: 20_000
  });
  const recovery = page.getByTestId('connector-recovery-card');
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText('Open Notion setup');
  await expect(recovery.getByRole('link', { name: 'Open setup' })).toHaveAttribute(
    'href',
    '/v2/extensions/registry?setup=1&focus=notion'
  );

  await recovery.getByRole('link', { name: 'Open setup' }).click();
  await expect(page).toHaveURL(/\/v2\/extensions\/registry\?setup=1&focus=notion/);
  await expect(page.getByTestId('registry-card-notion')).toBeVisible();
});

test('static connectors: registry surface has no horizontal overflow and 44px tap targets at 390px', async ({
  page
}) => {
  // Mobile responsive contract (matches the chat-composer 390px pass): the
  // Connections registry must not scroll sideways on a 390px phone, and its
  // primary controls — the Connect action, the registry filter input, and the
  // capability/keyword disclosure — must meet the 44px touch-target minimum.
  await page.setViewportSize({ width: 390, height: 844 });
  const calls: CapturedCall[] = [];
  await installConnectorMocks(page, calls);

  await page.goto('/v2/extensions/registry?token=connector-static-token');
  await expect(page.getByTestId('registry-card-gmail')).toBeVisible();

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  const filter = page.getByPlaceholder('Search apps...');
  expect(await tapHeight(filter)).toBeGreaterThanOrEqual(44);

  const connect = page.getByTestId('registry-card-gmail').getByRole('button', { name: 'Connect' });
  expect(await tapHeight(connect)).toBeGreaterThanOrEqual(44);

  const disclosure = page
    .getByTestId('registry-card-gmail')
    .getByRole('button', { name: /keyword/ });
  expect(await tapHeight(disclosure)).toBeGreaterThanOrEqual(44);

  const draftPrompt = page.getByRole('link', { name: /^Draft prompt for / }).first();
  expect(await tapHeight(draftPrompt)).toBeGreaterThanOrEqual(44);
});

test('static connectors: installed card actions stay 44px tappable at 390px', async ({ page }) => {
  // The overflow menu is the ONLY route to Configure / Remove on an installed
  // card, so its trigger and the primary card action must clear 44px on mobile.
  await page.setViewportSize({ width: 390, height: 844 });
  const calls: CapturedCall[] = [];
  await installConnectorMocks(page, calls);
  await page.route('**/api/webchat/v2/extensions', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        extensions: [
          {
            display_name: 'Google Calendar Scheduling Assistant',
            kind: 'wasm_tool',
            active: true,
            version: '1.4.2',
            package_ref: { kind: 'extension', id: 'tools/google_calendar' },
            description: 'Find meetings, protect focus blocks, and prepare schedule changes.',
            tools: ['list_events', 'create_event', 'update_event', 'delete_event']
          }
        ]
      })
    });
  });

  await page.goto('/v2/extensions/installed?token=connector-static-token');

  const overflowTrigger = page.getByRole('button', { name: 'More actions' }).first();
  await expect(overflowTrigger).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  const trigger = await overflowTrigger.boundingBox();
  expect(trigger).not.toBeNull();
  expect(Math.min(trigger!.width, trigger!.height)).toBeGreaterThanOrEqual(44);

  const disclosure = page.getByRole('button', { name: /capabilit/ }).first();
  expect(await tapHeight(disclosure)).toBeGreaterThanOrEqual(44);
});

test('static connectors: configure setup dialog honors the modal keyboard contract', async ({
  page
}) => {
  // The connector setup dialog renders its own ModalShell (not the shared Modal).
  // It had Esc but no focus trap, no focus-in, and no focus-restore — the same
  // broken contract the command palette had. After the fix it must move focus in
  // on open, trap Tab/Shift-Tab behind the backdrop, close on Esc from a control,
  // and return focus to the opener. Driven via the ?setup=1&focus deep link, which
  // auto-opens ConfigureModal for a matching installed extension.
  const calls: CapturedCall[] = [];
  await installConnectorMocks(page, calls);
  await page.route('**/api/webchat/v2/extensions', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        extensions: [
          {
            display_name: 'Google Calendar',
            kind: 'wasm_tool',
            active: true,
            version: '1.4.2',
            package_ref: { kind: 'extension', id: 'tools/google_calendar' },
            description: 'Find meetings, protect focus blocks, and prepare schedule changes.',
            tools: ['list_events', 'create_event']
          }
        ]
      })
    });
  });

  // Land on the installed tab first so a real control holds focus to restore to,
  // then trigger the deep link that opens the setup dialog.
  await page.goto('/v2/extensions/installed?token=connector-static-token');
  const opener = page.getByRole('button', { name: 'More actions' }).first();
  await expect(opener).toBeVisible();
  await opener.focus();

  await page.goto(
    '/v2/extensions/installed?setup=1&focus=google-calendar&token=connector-static-token'
  );

  const dialog = page.getByTestId('connector-setup-modal');
  await expect(dialog).toBeVisible();

  // Focus moved into the dialog on open.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const d = document.querySelector('[data-testid="connector-setup-modal"]');
        return !!d && d.contains(document.activeElement);
      })
    )
    .toBe(true);

  // Tab stays trapped inside the setup dialog.
  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="connector-setup-modal"]');
      return !!d && d.contains(document.activeElement);
    });
    expect(inside, `focus stays inside the setup dialog after ${i + 1} tab(s)`).toBe(true);
  }

  // Esc closes from the Cancel control (a non-input button).
  await dialog.getByRole('button', { name: 'Cancel' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('connector-setup-modal')).toHaveCount(0);
});

async function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
}

async function tapHeight(locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox();
  return box ? box.height : 0;
}

type CapturedCall = {
  method: string;
  path: string;
  body: any;
};

async function clickRegistryConnect(page: Page, id: string) {
  const card = page.getByTestId(`registry-card-${id}`);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Connect' }).click();
}

async function expectGoogleSetupLinks(page: Page, id: string) {
  const links = page.getByTestId(`registry-card-${id}`).getByRole('link', {
    name: 'Open Google setup'
  });
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('href', '/v2/settings/inference#google-oauth');
  await expect(links.last()).toHaveAttribute('href', '/v2/settings/inference#google-oauth');
}

function hasPath(calls: CapturedCall[], path: string) {
  return calls.some((call) => call.path === path);
}

async function installConnectorMocks(
  page: Page,
  calls: CapturedCall[],
  entries: unknown[] = registryEntries
) {
  await page.route(/\/(api|auth)\//, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path.startsWith('/api/webchat/v2/extensions')) {
      calls.push({ method, path, body: await requestJson(route) });
    }

    if (path === '/api/gateway/status') {
      return json(route, gatewayStatus);
    }
    if (path === '/api/webchat/v2/llm/providers') {
      return json(route, llmProviders);
    }
    if (path === '/api/webchat/v2/llm/list-models' && method === 'POST') {
      return json(route, { ok: true, models: ['auto', 'z-ai/glm-4.5', 'gpt-oss-120b'] });
    }
    if (path === '/api/webchat/v2/llm/active' && method === 'POST') {
      return json(route, { ok: true, active: llmProviders.active });
    }
    if (path === '/api/webchat/v2/threads' && method === 'GET') {
      return json(route, {
        threads: [
          {
            thread_id: 'thread-connector-failure',
            id: 'thread-connector-failure',
            title: 'Connector failure proof'
          }
        ],
        next_cursor: null
      });
    }
    if (path === '/api/webchat/v2/threads/thread-connector-failure/timeline') {
      return json(route, { messages: [], summary_artifacts: [], next_cursor: null });
    }
    if (path === '/api/webchat/v2/threads/thread-connector-failure/events') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: [
          ': connected',
          '',
          'id: connector-failure-1',
          'event: projection_update',
          `data: ${JSON.stringify({
            type: 'projection_update',
            state: {
              items: [
                { run_status: { run_id: 'run-connector-failure', status: 'running' } },
                {
                  run_status: {
                    run_id: 'run-connector-failure',
                    status: 'failed',
                    failure_category: 'missing_tool',
                    failure_summary: 'Notion tool is not installed for this run.'
                  }
                }
              ]
            }
          })}`,
          '',
          ''
        ].join('\n')
      });
    }
    if (path === '/api/webchat/v2/automations' && method === 'GET') {
      return json(route, { automations: [], next_cursor: null });
    }
    if (path === '/api/webchat/v2/extensions/registry') {
      return json(route, { entries });
    }
    if (path === '/api/webchat/v2/extensions' && method === 'GET') {
      return json(route, { extensions: [] });
    }
    if (path === '/api/webchat/v2/channels/connectable') {
      return json(route, { channels: [] });
    }
    if (path === '/auth/providers') {
      return json(route, { providers: [] });
    }
    if (path === '/api/webchat/v2/extensions/install' && method === 'POST') {
      const body = await requestJson(route);
      if (body?.kind === 'mcp_server' && body?.url) {
        return json(route, { success: true, message: `${body.name} installed` });
      }
      return json(route, { success: true });
    }
    if (path.endsWith('/setup') && method === 'GET') {
      return json(route, setupResponseFor(path));
    }
    if (path.endsWith('/setup/oauth/start') && method === 'POST') {
      return json(route, oauthStartResponseFor(path));
    }
    if (path.endsWith('/activate') && method === 'POST') {
      return json(route, {
        success: true,
        phase: 'connected',
        authenticated: true,
        account_ready: true,
        account_label: 'workspace@example.com'
      });
    }

    return json(route, { ok: true });
  });
}

function setupResponseFor(path: string) {
  if (path.includes('/slack/')) {
    return { secrets: [] };
  }
  const provider = path.includes('/notion/')
    ? 'notion'
    : path.includes('/google-calendar/')
      ? 'google_calendar'
      : 'gmail';
  return {
    secrets: [
      {
        name: `${provider}_oauth`,
        provider,
        provided: false,
        setup: {
          kind: 'oauth',
          scopes: provider === 'notion' ? ['search'] : ['read']
        }
      }
    ]
  };
}

function oauthStartResponseFor(path: string) {
  if (path.includes('/notion/')) {
    return { success: false, message: 'No hosted Notion OAuth client is configured.' };
  }
  return { success: false, message: 'No hosted Google OAuth client is configured.' };
}

async function requestJson(route: Route) {
  const raw = route.request().postData();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function json(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body)
  });
}
