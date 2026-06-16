// Automated accessibility regression sweep.
//
// Visits every top-level route and runs axe-core against each loaded
// surface. The pass-or-fail bar is critical/serious violations only —
// moderate / minor findings are logged but don't gate CI. See
// `expectNoSeriousA11y` in `_helpers.ts` for the assertion shape.
//
// ---- Rule scoping --------------------------------------------------------
//
// We disable `color-contrast` for the whole suite. Two reasons:
//
//   1. Manual review (Round 19a a11y pass) walked the navy/cyan/gold brand
//      tokens through the WebAIM contrast checker and confirmed every
//      foreground/background pair meets WCAG AA 4.5:1. The tokens live in
//      `tailwind.config.js` and are the source of truth — axe doesn't read
//      them, it reads computed styles, which routinely report false
//      positives on tailwind opacity utilities (`text-text-muted/60`,
//      `bg-bg-elevated/40`) because axe assumes opacity composes against a
//      solid white page background. Our backgrounds are themselves opaque
//      navy, so the effective contrast is far higher than axe's model.
//
//   2. If we re-enable contrast checks later, we should pair that with an
//      axe configuration that injects the real underlying background so
//      the opacity math resolves correctly. Leaving the rule on today
//      would drown every route in dozens of false positives and the spec
//      would lose its signal value.
//
// We let moderate/minor findings through without failing because they are
// almost entirely `aria-labelledby` / `aria-describedby` references that
// resolve at runtime but axe can't dereference in the headless DOM (the
// referenced element is in a portaled overlay container that mounts on
// hover/focus). The console log makes the count visible so a regression
// (e.g. a new component shipping with no aria at all) still shows up.
//
// ---- Routes covered -----------------------------------------------------
//
// Each route mounts its own data-driven panels; the surface mock in
// `_helpers.ts` returns 2-3 fixture rows per endpoint so every panel
// transitions out of its loading skeleton before axe scans. Admin +
// Missions require `adminMode: true` and `engineV2Enabled: true`
// respectively — the layout's hide-on-disable guard would bounce us to
// `/settings` otherwise.

import { test, expect } from '@playwright/test';
import {
  expectNoSeriousA11y,
  mockGateway,
  mockGatewaySurfaces,
  mockTauri,
  type TauriMockSettings
} from './_helpers';

/** Settings used for every a11y test — admin + engine v2 enabled so all
 *  routes are reachable; onboarding complete so the layout doesn't bounce
 *  us to the wizard. */
const A11Y_SETTINGS: TauriMockSettings = {
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
  engineV2Enabled: true
};

/** Routes the sweep covers. Order matches the sidebar top-down. */
const ROUTES: Array<{ path: string; label: string }> = [
  { path: '/dashboard', label: 'today' },
  { path: '/desk', label: 'desk' },
  { path: '/work', label: 'work' },
  { path: '/streams', label: 'streams' },
  { path: '/chat', label: 'chat' },
  { path: '/canvas', label: 'canvas' },
  { path: '/knowledge', label: 'knowledge' },
  { path: '/memory', label: 'memory' },
  { path: '/skills', label: 'skills' },
  { path: '/routines', label: 'routines' },
  { path: '/jobs', label: 'jobs' },
  { path: '/logs', label: 'logs' },
  { path: '/extensions', label: 'extensions' },
  { path: '/admin', label: 'admin' },
  { path: '/settings', label: 'settings' },
  { path: '/missions', label: 'missions' }
];

/** Heading-less surfaces. These workspaces (chat thread view, the Desk
 *  action inbox, the spatial canvas) carry no `<h1>` — they each expose an
 *  `aria-label`'d region landmark on their root instead. We wait on that
 *  region rather than an `<h1>` so axe scans against a settled DOM. */
const REGION_BY_PATH: Record<string, string> = {
  '/chat': 'Chat',
  '/desk': 'The Desk',
  '/canvas': 'Canvas'
};

// One Playwright test per route. Splitting them gives per-route failure
// granularity (CI annotates the failing route directly) and avoids the
// "first route failed, rest skipped" cascade that a single combined test
// would produce.
for (const { path, label } of ROUTES) {
  test(`a11y: ${label} (${path}) has no critical/serious violations`, async ({ page }) => {
    await mockTauri(page, { settings: A11Y_SETTINGS, token: 'mock-token-abc' });
    await mockGateway(page, { threads: [] });
    await mockGatewaySurfaces(page);

    await page.goto(path);

    // Wait for a stable per-route signal so axe scans against a settled
    // DOM. Heading-less workspaces (see REGION_BY_PATH) expose an
    // `aria-label`'d region on their root — e.g. chat carries
    // `aria-label="Chat"`, present in BOTH the v1 thread-rail and the
    // default v2 (RebornChatPanel) layouts (the old "New Chat" anchor only
    // existed in the v1 rail, and apiVersion now defaults to 'v2'). Every
    // other surface ships an `<h1>` inside its `<section>`. The 8s ceiling
    // covers a cold Vite dev-server hot compile of the route module the
    // first time it's hit in the run.
    const regionName = REGION_BY_PATH[path];
    if (regionName) {
      await expect(page.getByRole('region', { name: regionName })).toBeVisible({
        timeout: 8000
      });
    } else {
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 8000 });
    }

    // Give Svelte's onMount callbacks a tick to settle — the data fetches
    // resolve on the next microtask after the heading paints. A small
    // wait here is cheaper than racing the assertion and keeps the scan
    // deterministic across the ten routes.
    await page.waitForTimeout(300);

    await expectNoSeriousA11y(page, { routeLabel: label });
  });
}
