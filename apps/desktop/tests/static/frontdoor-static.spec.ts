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

test('static front door: cold open shows backed needs-you and handled receipts', async ({
  page
}) => {
  const consoleIssues: string[] = [];
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      consoleIssues.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    consoleIssues.push(`pageerror: ${error.message}`);
  });

  await page.addInitScript(() => {
    window.localStorage.setItem(
      'ironclaw:v2-thread-attention',
      JSON.stringify([['thread-needs-you', 'needs_attention']])
    );
  });
  await installFrontDoorMocks(page);

  await page.goto('/v2/chat?token=frontdoor-static-token');
  await expect(
    page.getByRole('heading', { name: 'What should IronClaw handle next?' })
  ).toBeVisible();

  const panel = page.getByTestId('frontdoor-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Needs you')).toBeVisible();
  await expect(panel.getByText('Legal review approval')).toBeVisible();
  await expect(panel.getByText('Needs approval')).toBeVisible();
  await expect(panel.getByRole('link', { name: /Legal review approval/ })).toHaveAttribute(
    'href',
    '/v2/chat/thread-needs-you'
  );

  await expect(panel.getByText('Handled')).toBeVisible();
  await expect(panel.getByText('Daily digest')).toBeVisible();
  await expect(panel.getByText('Completed')).toBeVisible();
  await expect(panel.getByRole('link', { name: /Daily digest/ })).toHaveAttribute(
    'href',
    '/v2/automations'
  );

  expect(consoleIssues).toEqual([]);
});

test('static front door: receipt rows show the full specific detail, not just badge metadata', async ({
  page
}) => {
  // Trust law: a receipt earns the panel by showing specific data, not wallpaper.
  // Regression guard for the old single-line `badge · age · detail` cram, where the
  // load-bearing detail (the actual receipt) was clipped behind the category badge
  // and age on desktop and went fully invisible at 390px. The detail must render in
  // full and wrap (line-clamp), and the badge must be its own chip on the title row.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'ironclaw:v2-thread-attention',
      JSON.stringify([['thread-needs-you', 'needs_attention']])
    );
  });
  await installFrontDoorMocks(page);

  await page.goto('/v2/chat?token=frontdoor-static-token');
  const panel = page.getByTestId('frontdoor-panel');
  await expect(panel).toBeVisible();

  const needsRow = panel.getByRole('link', { name: /Legal review approval/ });
  // The specific receipt payload is present in full (was truncated to "...waiting in t…").
  await expect(needsRow).toContainText('An approval or auth gate is waiting in this thread.');
  // The detail lives on its own wrappable line, never a single-line truncate.
  const needsDetail = needsRow.locator('[title]').filter({
    hasText: 'An approval or auth gate is waiting in this thread.'
  });
  await expect(needsDetail).toHaveCount(1);
  const needsDetailClass = (await needsDetail.first().getAttribute('class')) || '';
  expect(needsDetailClass).toContain('line-clamp-2');
  expect(needsDetailClass).not.toContain('truncate');
  // Age and badge are still shown, but as supporting metadata around the detail.
  await expect(needsRow).toContainText('Needs approval');
  await expect(needsRow).toContainText(/\dh ago/);

  // Handled receipts keep their specific payload too.
  const handledRow = panel.getByRole('link', { name: /Daily digest/ });
  await expect(handledRow).toContainText('Automation result from');
  const handledDetailClass =
    (await handledRow.locator('[title]').first().getAttribute('class')) || '';
  expect(handledDetailClass).toContain('line-clamp-2');
});

test('static front door: suggestion action label never wraps', async ({ page }) => {
  // Design-system SuggestionCard keeps the "Use prompt" affordance on one line
  // (whiteSpace: nowrap). The shipped static card had dropped this, so the label
  // wrapped to "Use\nprompt" and ragged the third column. Guard it stays one line.
  await installFrontDoorMocks(page);

  await page.goto('/v2/chat?token=frontdoor-static-token');
  await expect(page.getByTestId('frontdoor-panel')).toBeVisible();

  const useLabel = page.getByText('Use prompt', { exact: true }).first();
  await expect(useLabel).toBeVisible();
  const labelClass = (await useLabel.getAttribute('class')) || '';
  expect(labelClass).toContain('whitespace-nowrap');

  // Single text line: client rect height stays within one line-height band.
  const lineMetrics = await useLabel.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || rect.height;
    return { height: rect.height, lineHeight };
  });
  expect(lineMetrics.height).toBeLessThanOrEqual(lineMetrics.lineHeight + 2);
});

test('static front door: empty desk keeps zero-state pills neutral and shows at most one setup nudge', async ({
  page
}) => {
  // No seeded attention state, no automations, no threads => both Needs you and
  // Handled render their empty zero-state. onboarding-desk-3: the count pill must
  // stay on muted tokens (no gold/warning glow on a meaningless "0"). chat-3/DT-1:
  // the prepared desk surfaces a single "Open setup" connect affordance (the NEAR
  // AI Cloud panel when setup is blocked) — never duplicate competing nudges.
  await installFrontDoorMocks(page, { threads: [], automations: [] });

  await page.goto('/v2/chat?token=frontdoor-static-token');
  await expect(
    page.getByRole('heading', { name: 'What should IronClaw handle next?' })
  ).toBeVisible();

  const panel = page.getByTestId('frontdoor-panel');
  await expect(panel).toBeVisible();

  for (const tone of ['warning', 'gold']) {
    const section = panel.getByTestId(`frontdoor-${tone}`);
    await expect(section).toBeVisible();
    // The empty section renders its zero-state copy, never a real item link.
    await expect(section.getByRole('link')).toHaveCount(0);
    const countPill = section.locator('span').filter({ hasText: /^0$/ });
    await expect(countPill).toHaveCount(1);
    const pillClass = (await countPill.first().getAttribute('class')) || '';
    expect(pillClass).toContain('var(--v2-surface-soft)');
    expect(pillClass).toContain('var(--v2-text-muted)');
    expect(pillClass).not.toContain('var(--v2-gold-soft)');
    expect(pillClass).not.toContain('var(--v2-warning-soft)');
  }

  await expect(panel.getByText('Nothing waiting on you.')).toBeVisible();
  await expect(panel.getByText('No completed receipts yet.')).toBeVisible();

  // chat-3/DT-1: the prepared desk carries at most one "Open setup" affordance
  // (the single connect panel when setup is blocked; none when a provider is ready).
  expect(await page.getByRole('link', { name: 'Open setup' }).count()).toBeLessThanOrEqual(1);
  expect(await page.getByRole('button', { name: 'Open setup' }).count()).toBeLessThanOrEqual(1);
});

test('static front door at 390px: no horizontal overflow and composer touch targets stay >=44px', async ({
  page
}) => {
  // Mobile-first law: the chat front door must not overflow at 390px and every
  // composer control the user taps must clear the 44px touch-target minimum.
  // Regression guard for the composer send/add/model controls (were 32-36px)
  // and the prepared-desk "Open setup" CTA (was 32px).
  await page.setViewportSize({ width: 390, height: 844 });
  await installFrontDoorMocks(page);

  await page.goto('/v2/chat?token=frontdoor-static-token');
  await expect(
    page.getByRole('heading', { name: 'What should IronClaw handle next?' })
  ).toBeVisible();
  await expect(page.getByTestId('frontdoor-panel')).toBeVisible();

  // No horizontal overflow: the document never scrolls sideways at 390px.
  const overflow = await page.evaluate(() => {
    const de = document.documentElement;
    return {
      docOverflow: de.scrollWidth - de.clientWidth,
      bodyOverflow: document.body.scrollWidth - de.clientWidth
    };
  });
  expect(overflow.docOverflow).toBeLessThanOrEqual(1);
  expect(overflow.bodyOverflow).toBeLessThanOrEqual(1);

  // Every composer control the thumb hits clears 44px in both dimensions.
  const composer = page.getByTestId('chat-composer');
  for (const name of ['Chat model settings', 'Add to message', 'Send message']) {
    const control = composer.getByRole('button', { name }).first();
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box, `${name} should have a measurable box`).not.toBeNull();
    expect(box!.height, `${name} height >=44px`).toBeGreaterThanOrEqual(44);
    expect(box!.width, `${name} width >=44px`).toBeGreaterThanOrEqual(44);
  }
});

async function installFrontDoorMocks(
  page: Page,
  overrides: { threads?: unknown[]; automations?: unknown[] } = {}
) {
  // Timestamps are relative to now so the rendered relative-age stays in the
  // "Xh ago" band the assertions expect, regardless of the calendar date the
  // suite runs on. (Hardcoded dates aged past 24h and flipped to "1d ago".)
  const now = Date.now();
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const hoursFromNow = (h: number) => new Date(now + h * 3_600_000).toISOString();
  const threads = overrides.threads ?? [
    {
      id: 'thread-needs-you',
      thread_id: 'thread-needs-you',
      title: 'Legal review approval',
      turn_count: 4,
      updated_at: hoursAgo(3)
    },
    {
      id: 'thread-recent',
      thread_id: 'thread-recent',
      title: 'Draft launch memo',
      turn_count: 2,
      updated_at: hoursAgo(1)
    }
  ];
  const automations = overrides.automations ?? [
    {
      id: 'daily-digest',
      name: 'Daily digest',
      state: 'active',
      source: { type: 'schedule', cron: '0 8 * * *' },
      last_status: 'ok',
      last_run_at: hoursAgo(2),
      next_run_at: hoursFromNow(6),
      created_at: hoursAgo(72)
    }
  ];
  await installFrontDoorRoutes(page, threads, automations);
}

async function installFrontDoorRoutes(page: Page, threads: unknown[], automations: unknown[]) {
  await page.route(/\/(api|auth)\//, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === '/api/gateway/status') {
      return json(route, gatewayStatus);
    }
    if (path === '/api/webchat/v2/llm/providers') {
      return json(route, llmProviders);
    }
    if (path === '/api/webchat/v2/llm/list-models' && method === 'POST') {
      return json(route, { ok: true, models: ['auto', 'z-ai/glm-4.5'] });
    }
    if (path === '/api/webchat/v2/threads' && method === 'GET') {
      return json(route, { threads, next_cursor: null });
    }
    if (path === '/api/webchat/v2/automations' && method === 'GET') {
      return json(route, { automations, next_cursor: null });
    }
    if (path === '/api/webchat/v2/extensions/registry') {
      return json(route, { entries: [] });
    }
    if (path === '/api/webchat/v2/extensions') {
      return json(route, { extensions: [] });
    }
    if (path === '/api/webchat/v2/channels/connectable') {
      return json(route, { channels: [] });
    }
    if (path === '/auth/providers') {
      return json(route, { providers: [] });
    }

    return json(route, { ok: true });
  });
}

async function json(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body)
  });
}
