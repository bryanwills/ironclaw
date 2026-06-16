import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

type AxeImpact = 'critical' | 'serious' | 'moderate' | 'minor';

interface Surface {
  label: string;
  path: string;
  authenticated?: boolean;
  waitFor: (page: Page) => Promise<void>;
}

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

const surfaces: Surface[] = [
  {
    label: 'onboarding',
    path: '/v2/welcome',
    waitFor: async (page) => {
      await expect(page.getByRole('heading', { name: 'IronClaw Desktop' })).toBeVisible();
    }
  },
  {
    label: 'chat',
    path: '/v2/chat',
    authenticated: true,
    waitFor: async (page) => {
      await expect(
        page.getByRole('heading', { name: 'What should IronClaw handle next?' })
      ).toBeVisible();
    }
  },
  {
    label: 'connections registry',
    path: '/v2/extensions/registry',
    authenticated: true,
    waitFor: async (page) => {
      await expect(page.getByText('Daily news digest')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Gmail' })).toBeVisible();
    }
  },
  {
    label: 'connections installed',
    path: '/v2/extensions',
    authenticated: true,
    waitFor: async (page) => {
      await expect(page.getByRole('heading', { name: 'No apps connected yet' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Browse apps' })).toBeVisible();
    }
  },
  {
    label: 'connections channels',
    path: '/v2/extensions/channels',
    authenticated: true,
    waitFor: async (page) => {
      await expect(page.getByText('Built-in messaging paths')).toBeVisible();
      await expect(page.getByText('Slack').first()).toBeVisible();
    }
  },
  {
    label: 'connections knowledge apps',
    path: '/v2/extensions/mcp',
    authenticated: true,
    waitFor: async (page) => {
      await expect(
        page.getByRole('heading', { name: 'No knowledge apps connected' })
      ).toBeVisible();
      await expect(page.getByRole('link', { name: 'Browse knowledge apps' })).toHaveAttribute(
        'href',
        '/v2/extensions/registry?setup=1&focus=notion'
      );
    }
  },
  {
    label: 'AI setup',
    path: '/v2/settings/inference',
    authenticated: true,
    waitFor: async (page) => {
      await expect(page.getByText('AI runtime')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'NEAR AI Cloud' })).toBeVisible();

      // No fake readiness: the embeddings/sampling field cards write through a
      // settings endpoint that does not exist yet (useSettings status:'todo').
      // Live toggles/inputs that silently fail to save must not render; only the
      // real, gateway-backed provider controls stay on this surface.
      await expect(page.getByRole('switch', { name: 'Enable embeddings' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Embeddings' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Sampling' })).toHaveCount(0);
      await expect(page.getByLabel('Temperature')).toHaveCount(0);
    }
  },
  {
    label: 'settings agent deep link',
    path: '/v2/settings/agent',
    authenticated: true,
    waitFor: async (page) => {
      // No fake readiness: every Agent field writes through a settings endpoint
      // that does not exist yet (useSettings status:'todo'). Editable
      // toggles/selects/inputs that silently fail to save must not render. The
      // surface shows a dignified explanation instead of empty void or live
      // controls over a stub.
      await expect(
        page.getByRole('heading', { name: 'Editing not available on this gateway yet' })
      ).toBeVisible();
      await expect(page.getByRole('switch')).toHaveCount(0);
      await expect(page.getByRole('combobox')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Core' })).toHaveCount(0);
      await expect(page.getByLabel('Agent name')).toHaveCount(0);
    }
  },
  {
    label: 'settings networking deep link',
    path: '/v2/settings/networking',
    authenticated: true,
    waitFor: async (page) => {
      // No fake readiness: the Networking fields share the same settings stub
      // (useSettings status:'todo'). Live inputs that never persist must not
      // render; the honest unavailable state stands in their place.
      await expect(
        page.getByRole('heading', { name: 'Editing not available on this gateway yet' })
      ).toBeVisible();
      await expect(page.getByRole('combobox')).toHaveCount(0);
      await expect(page.getByRole('textbox')).toHaveCount(0);
    }
  },
  {
    label: 'language settings',
    path: '/v2/settings/language',
    authenticated: true,
    waitFor: async (page) => {
      await expect(page.getByRole('heading', { name: 'Language' })).toBeVisible();
      await expect(page.getByText('English').first()).toBeVisible();
    }
  },
  {
    label: 'settings tools deep link',
    path: '/v2/settings/tools',
    authenticated: true,
    waitFor: async (page) => {
      await expect(page.getByRole('heading', { name: 'Tool permissions' })).toBeVisible();

      // No fake readiness: no v2 tools-write endpoint exists (useTools
      // status:'todo'), so editable permission selects must not render over a
      // stub that silently fails to persist. Only read-only state is honest here.
      await expect(page.getByRole('combobox')).toHaveCount(0);
    }
  },
  {
    label: 'settings skills deep link',
    path: '/v2/settings/skills',
    authenticated: true,
    waitFor: async (page) => {
      await expect(page.getByRole('heading', { name: 'No skills installed' })).toBeVisible();

      // No fake readiness: no v2 skills endpoint exists (useSkills status:'todo'),
      // so the Import-skill form must not render over a stub. Submitting it would
      // silently no-op. The dignified empty state stands alone.
      await expect(page.getByRole('heading', { name: 'Import skill' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
    }
  },
  {
    label: 'automations deep link',
    path: '/v2/automations',
    authenticated: true,
    waitFor: async (page) => {
      await expect(page.getByRole('heading', { name: 'Scheduled', exact: true })).toBeVisible();
      await expect(page.getByText('No scheduled automations yet.')).toBeVisible();
    }
  },
  {
    label: 'workspace deep link',
    path: '/v2/workspace',
    authenticated: true,
    waitFor: async (page) => {
      await expect(page.getByText('No files in workspace.')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Pick a workspace file' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    }
  },
  {
    label: 'projects deep link',
    path: '/v2/projects',
    authenticated: true,
    waitFor: async (page) => {
      await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();

      // No fake readiness: the projects overview endpoint does not exist yet
      // (useProjectsOverview status:'todo' over a {todo:true} stub), so the
      // four-tile live metrics strip — including a green "Spend today" tile —
      // must not render hardcoded zeros as a polling dashboard. Mirrors the jobs
      // gate below; only the dignified empty state stands.
      await expect(page.getByText('Spend today')).toHaveCount(0);
      await expect(page.getByText('Active missions')).toHaveCount(0);
    }
  },
  {
    label: 'jobs deep link',
    path: '/v2/jobs',
    authenticated: true,
    waitFor: async (page) => {
      await expect(page.getByRole('heading', { name: 'No jobs yet' })).toBeVisible();

      // No fake readiness: with no v2 jobs endpoint (useJobs status:'todo') the
      // six-tile live metrics ledger must not render hardcoded zeros as a polling
      // dashboard. Only the dignified empty state stands.
      await expect(page.getByText('Total jobs')).toHaveCount(0);
      await expect(page.getByText('In progress')).toHaveCount(0);
    }
  },
  {
    label: 'routines deep link',
    path: '/v2/routines',
    authenticated: true,
    waitFor: async (page) => {
      await expect(page.getByRole('heading', { name: 'Routines' })).toBeVisible();
      await expect(page.getByText('No routines yet')).toBeVisible();
      // Empty/loading dignity (DSYS-2): the empty state is not a dead-end — it
      // exposes a real next action back to where routines are created. Scope to
      // main content so we assert the empty-state CTA, not the sidebar nav link.
      const routinesAction = page.getByRole('main').getByRole('link', { name: 'Chat' });
      await expect(routinesAction).toBeVisible();
      await expect(routinesAction).toHaveAttribute('href', '/v2/chat');
    }
  },
  {
    label: 'missions deep link',
    path: '/v2/missions',
    authenticated: true,
    waitFor: async (page) => {
      await expect(page.getByRole('heading', { name: 'Execution loops' })).toBeVisible();
      await expect(page.getByText('No missions match')).toBeVisible();

      // No fake readiness: the missions overview shares the projects {todo:true}
      // stub (useMissions status:'todo'), so the four-tile signal/warning/green
      // metrics strip must not render over empty stubs. Mirrors the jobs gate;
      // "Total missions" only appears in that strip, never in the empty state.
      await expect(page.getByText('Total missions')).toHaveCount(0);
      await expect(page.getByText('Spawned threads')).toHaveCount(0);

      // Empty/loading dignity (DSYS-2): the empty state names a real next action
      // (missions are created inside projects) instead of dead-ending. Scope to
      // main content so we assert the empty-state CTA, not the sidebar nav link.
      const missionsAction = page.getByRole('main').getByRole('link', { name: 'Projects' });
      await expect(missionsAction).toBeVisible();
      await expect(missionsAction).toHaveAttribute('href', '/v2/projects');
    }
  },
  {
    label: 'logs deep link',
    path: '/v2/logs',
    authenticated: true,
    waitFor: async (page) => {
      // Empty/loading dignity (DT-5): no v2 log-streaming endpoint exists, so the
      // surface must show a dignified empty state with a real next action instead
      // of a void plus stream-lifecycle controls that imply a capability the
      // gateway cannot prove.
      await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible();
      const logsAction = page.getByRole('main').getByRole('link', { name: 'Chat' });
      await expect(logsAction).toBeVisible();
      await expect(logsAction).toHaveAttribute('href', '/v2/chat');

      // No fake readiness: lifecycle controls (Pause/Clear/Auto-scroll) must not
      // render while there is no stream to control.
      await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Clear' })).toHaveCount(0);
      await expect(page.getByLabel('Auto-scroll')).toHaveCount(0);

      // The named filter control stays (preserves the prior control-name fix).
      // Its >=44px mobile tap-target floor is asserted at 390px in
      // keyboard-static.spec.ts, where the viewport is controlled explicitly.
      await expect(page.getByLabel('Log level filter')).toBeVisible();
    }
  }
];

async function installStaticApiMocks(page: Page, automations: unknown[] = []) {
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
    if (path === '/api/webchat/v2/threads' && method === 'GET') {
      return json(route, { threads: [], next_cursor: null });
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

async function expectNoBlockingA11y(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
  const blocking = results.violations
    .filter((violation) => ['critical', 'serious'].includes(violation.impact || ''))
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact as AxeImpact,
      help: violation.help,
      helpUrl: violation.helpUrl,
      targets: violation.nodes.slice(0, 5).map((node) => ({
        selector: node.target.join(' > '),
        html: node.html.slice(0, 200)
      }))
    }));

  expect(
    blocking,
    `${label} has ${blocking.length} blocking a11y violation(s): ${JSON.stringify(blocking, null, 2)}`
  ).toEqual([]);
}

const mixedAutomations = [
  {
    automation_id: 'daily-digest',
    name: 'Daily news digest',
    source: { type: 'schedule', cron: '0 9 * * 1-5' },
    state: 'active',
    is_active: true,
    next_run_at: '2026-06-15T13:00:00Z',
    last_run_at: '2026-06-13T13:01:00Z',
    last_status: 'ok'
  },
  {
    automation_id: 'weekly-report',
    name: 'Weekly portfolio report',
    source: { type: 'schedule', cron: '0 17 * * 0' },
    state: 'paused',
    is_active: false,
    next_run_at: null,
    last_run_at: '2026-06-08T16:01:00Z',
    last_status: 'error'
  },
  {
    automation_id: 'month-close',
    name: 'Month-close summary',
    source: { type: 'schedule', cron: '0 8 1 * *' },
    state: 'scheduled',
    is_active: true,
    next_run_at: '2026-07-01T12:00:00Z',
    last_run_at: null,
    last_status: null
  }
];

const POSITIVE_GREEN = 'rgb(32, 210, 154)';

test('static automations: backed rows attribute enabled state in gold, not the live success tone', async ({
  page
}) => {
  // Status truth (DESIGN.md "Honest by construction"): an enabled-but-idle
  // schedule must not render in the success green with a live breathing dot,
  // which is the visual reserved for a genuinely completed run. Before this pass
  // "Active"/"Scheduled" state pills were `signal` tone — identical green + pulse
  // to a "Done" last-run pill — so three different truths looked the same and all
  // looked "running/healthy now". Enabled schedules now carry gold agent
  // attribution; only a real completed run keeps the success tone.
  await installStaticApiMocks(page, mixedAutomations);
  await page.goto('/v2/automations?token=static-a11y-token');
  await expect(page.getByRole('heading', { name: 'Scheduled', exact: true })).toBeVisible();
  await expect(page.getByText('Daily news digest')).toBeVisible();

  const rows = page.locator('table tbody tr');
  await expect(rows).toHaveCount(3);

  type PillInfo = { color: string; live: boolean };
  async function pill(rowName: string, label: string): Promise<PillInfo> {
    const span = page
      .locator('table tbody tr', { hasText: rowName })
      .locator('span.inline-flex', { hasText: label })
      .first();
    await expect(span).toBeVisible();
    return span.evaluate((el) => {
      const dot = el.querySelector('span');
      return {
        color: getComputedStyle(el).color,
        live: dot ? getComputedStyle(dot).animationName !== 'none' : false
      };
    });
  }

  // Enabled states render in gold and are NOT the live success green.
  for (const [row, state] of [
    ['Daily news digest', 'Active'],
    ['Month-close summary', 'Scheduled']
  ] as const) {
    const info = await pill(row, state);
    expect(info.color, `${state} state pill is not the live success green`).not.toBe(
      POSITIVE_GREEN
    );
    expect(info.live, `${state} state pill does not pulse as live`).toBe(false);
  }

  // A genuinely completed run keeps the success tone — the two truths stay
  // visually distinct on the same surface.
  const done = await pill('Daily news digest', 'Done');
  expect(done.color, 'a completed run keeps the success green').toBe(POSITIVE_GREEN);

  // A paused schedule and a failed last run read as their own honest tones, not
  // green: the surface never makes a stopped/errored automation look active.
  const paused = await pill('Weekly portfolio report', 'Paused');
  expect(paused.color, 'paused state is not green').not.toBe(POSITIVE_GREEN);
  const errored = await pill('Weekly portfolio report', 'Error');
  expect(errored.color, 'errored last run is not green').not.toBe(POSITIVE_GREEN);

  await expectNoBlockingA11y(page, 'automations backed rows');
});

test('static automations at 390px: list controls clear 44px and the surface does not overflow', async ({
  page
}) => {
  // Mobile-first law: the filter segmented control and the refresh button are
  // real tap targets at 390px (were 36px and 32px before this pass), matching the
  // 44px floor a sibling pass set on chat/connections/shell/settings/work.
  await page.setViewportSize({ width: 390, height: 844 });
  await installStaticApiMocks(page, mixedAutomations);
  await page.goto('/v2/automations?token=static-a11y-token');
  await expect(page.getByText('Daily news digest')).toBeVisible();

  const filterButtons = page.locator(
    '[role="group"][aria-label="Automation status filter"] button'
  );
  const filterCount = await filterButtons.count();
  expect(filterCount).toBe(3);
  for (let i = 0; i < filterCount; i += 1) {
    const box = await filterButtons.nth(i).boundingBox();
    expect(box, `filter button ${i} should have a measurable box`).not.toBeNull();
    expect(box!.height, `filter button ${i} height >=44px`).toBeGreaterThanOrEqual(44);
  }

  const refresh = page.getByRole('button', { name: 'Refresh automations' });
  const refreshBox = await refresh.boundingBox();
  expect(refreshBox, 'refresh button should have a measurable box').not.toBeNull();
  expect(refreshBox!.height, 'refresh button height >=44px').toBeGreaterThanOrEqual(44);
  expect(refreshBox!.width, 'refresh button width >=44px').toBeGreaterThanOrEqual(44);

  const docOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(docOverflow, 'no horizontal overflow at 390px on Automations').toBeLessThanOrEqual(1);
});

test('static automations: empty state offers a real next action instead of dead-ending', async ({
  page
}) => {
  // Empty/loading dignity (DT-5): with no scheduled automations the surface names
  // a real next action (automations are created from Chat) instead of leaving a
  // dead-end. Scope to main content so we assert the empty-state CTA, not the
  // sidebar nav link.
  await installStaticApiMocks(page, []);
  await page.goto('/v2/automations?token=static-a11y-token');
  await expect(page.getByText('No scheduled automations yet.')).toBeVisible();
  const action = page.getByRole('main').getByRole('link', { name: 'Chat' });
  await expect(action).toBeVisible();
  await expect(action).toHaveAttribute('href', '/v2/chat');
});

for (const surface of surfaces) {
  test(`static a11y: ${surface.label}`, async ({ page }) => {
    const consoleIssues: string[] = [];
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) {
        consoleIssues.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      consoleIssues.push(`pageerror: ${error.message}`);
    });

    await installStaticApiMocks(page);
    const token = surface.authenticated ? '?token=static-a11y-token' : '';
    await page.goto(`${surface.path}${token}`);
    await surface.waitFor(page);

    await expectNoBlockingA11y(page, surface.label);
    expect(consoleIssues, `${surface.label} console should stay quiet`).toEqual([]);
  });
}

// First-run is the only surface every user sees, and its three NEAR AI Cloud
// auth controls are the whole job of the screen. They must all be real tap
// targets — not just the primary. The two secondary actions (Use Google / Use
// NEAR Wallet) previously shipped at `size="sm"` (32px), below the 44px desktop
// floor and visibly shorter than the primary. This guards every auth control to
// the same `Button` `md` height the primary uses (>=44px desktop, >=40px mobile)
// so the fix cannot silently regress to `sm`.
for (const viewport of [
  { width: 1440, height: 950, label: 'desktop', minHeight: 44 },
  { width: 390, height: 844, label: 'mobile', minHeight: 40 }
] as const) {
  test(`static a11y: onboarding auth controls meet tap-target floor (${viewport.label})`, async ({
    page
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installStaticApiMocks(page);
    await page.goto('/v2/welcome');
    await expect(page.getByRole('heading', { name: 'IronClaw Desktop' })).toBeVisible();

    const authNames = ['Sign in with GitHub', 'Use Google', 'Use NEAR Wallet'];
    for (const name of authNames) {
      const button = page.getByRole('button', { name });
      await expect(button, `${name} should render on first-run`).toBeVisible();
      const box = await button.boundingBox();
      expect(box, `${name} should have a layout box`).not.toBeNull();
      expect(
        Math.round(box!.height),
        `${name} must be at least ${viewport.minHeight}px tall at ${viewport.label}`
      ).toBeGreaterThanOrEqual(viewport.minHeight);
    }
  });
}
