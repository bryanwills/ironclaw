// Round 34a dogfood spec — drives the desktop UI against the LIVE IronClaw
// gateway tunneled at 127.0.0.1:18789. Bypasses `mockGateway`/`mockGatewaySurfaces`
// so every route mounts against real wire data and we catch regressions
// from Rounds 26-33 that the canned-mock specs cannot.
//
// Token is injected via the existing `mockTauri` Tauri-IPC shim:
// `mockTauri({ token })` makes `get_token('default')` return the
// keychain-pulled bearer, which `connection.init()` reads into
// `this.token` and the layout uses to build `IronClawClient`. The fetches
// from the page then go straight to the tunnel.
//
// Token is read from the macOS Keychain at runtime via the
// `IRONCLAW_DOGFOOD_TOKEN` env var (the npm script sets it). NEVER write
// the token to disk and NEVER print it inside this spec.

import { test, expect, type Page, type Route, type Request } from '@playwright/test';
import { mockTauri, type TauriMockSettings } from './_helpers';

const TOKEN = process.env.IRONCLAW_DOGFOOD_TOKEN ?? '';
const GATEWAY_BASE = 'http://127.0.0.1:18789';

/**
 * Forward every `/api/*` request from the Playwright page to the real
 * tunneled gateway via Playwright's fetch (which is NOT subject to
 * browser CORS), then inject permissive CORS headers in the response so
 * the page's fetch() accepts the result.
 *
 * Without this, the Vite dev origin (`http://localhost:1420`) gets
 * cross-origin-rejected by the real IronClaw gateway, which only
 * allow-lists Tauri's own origin in production. In the real Tauri app
 * the webview runs at `tauri://localhost` and is exempt.
 *
 * Handles SSE separately: `text/event-stream` responses must be streamed
 * as a body. Playwright's `route.fulfill({body})` buffers, which is fine
 * for the initial replay buffer of `/api/logs/events` (single chunk +
 * keep-alive). Long-lived SSE streams stay open at the gateway side; the
 * page sees the buffered prefix and then a clean EOF, which is what an
 * EventSource expects on disconnect.
 */
async function proxyToGateway(page: Page, baseUrl: string, token: string): Promise<void> {
  await page.route(
    /^https?:\/\/(?:127\.0\.0\.1|localhost):18789\/.*/,
    async (route: Route, req: Request) => {
      // OPTIONS preflight — short-circuit with permissive CORS, no upstream call.
      if (req.method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD'
          }
        });
        return;
      }

      const upstreamUrl = req
        .url()
        .replace(/^https?:\/\/(?:127\.0\.0\.1|localhost):18789/, baseUrl);
      const headers: Record<string, string> = { ...req.headers() };
      delete headers['host'];
      headers['authorization'] = `Bearer ${token}`;

      try {
        const upstream = await page.request.fetch(upstreamUrl, {
          method: req.method(),
          headers,
          data: req.postData() ?? undefined,
          timeout: 8000
        });
        const buf = await upstream.body();
        const respHeaders: Record<string, string> = {};
        const upstreamHeaders = upstream.headers();
        // Pass content-type through (especially text/event-stream).
        if (upstreamHeaders['content-type']) {
          respHeaders['content-type'] = upstreamHeaders['content-type'];
        }
        respHeaders['access-control-allow-origin'] = '*';
        respHeaders['access-control-allow-headers'] = '*';
        respHeaders['access-control-expose-headers'] = '*';
        await route.fulfill({
          status: upstream.status(),
          headers: respHeaders,
          body: buf
        });
      } catch (err) {
        await route.fulfill({
          status: 502,
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ error: `proxy failure: ${String(err)}` })
        });
      }
    }
  );
}

// Real-gateway settings: onboarding complete, admin mode + engine v2 on,
// remoteBaseUrl pointed at the SSH tunnel.
const REAL_SETTINGS: TauriMockSettings = {
  activeProfileId: 'default',
  profiles: [
    {
      id: 'default',
      name: 'Dogfood',
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
  useResponsesApi: true,
  engineV2Enabled: true
};

/** Console + network error sink wired into the page so each test can
 *  assert against the totals after a route mount. */
function attachErrorSinks(page: Page): {
  consoleErrors: string[];
  networkFailures: string[];
} {
  const consoleErrors: string[] = [];
  const networkFailures: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Filter SSE-reconnect noise — EventSource reconnect failures
      // hit the console as `Failed to load resource` and aren't
      // regressions. Filter Vite's `Failed to fetch dynamically` HMR
      // warnings too — they're test-env artifacts.
      if (
        /event-stream|Failed to fetch dynamically|the server responded with a status of 404 \(\)|status of 405 \(Method Not Allowed\)/i.test(
          text
        )
      ) {
        return;
      }
      consoleErrors.push(text);
    }
  });

  page.on('response', (res) => {
    const url = res.url();
    if (!url.includes('/api/')) return;
    const status = res.status();
    if (status >= 400 && status !== 404) {
      networkFailures.push(`${res.request().method()} ${url} -> ${status}`);
    }
  });

  return { consoleErrors, networkFailures };
}

// Skip the entire suite (not fail) when no token is available. The dogfood
// spec is opt-in: it expects an `IRONCLAW_DOGFOOD_TOKEN` env var sourced
// from the macOS Keychain wrapper. CI runs e2e without the token and should
// skip these tests cleanly instead of failing.
test.skip(!TOKEN, 'IRONCLAW_DOGFOOD_TOKEN env var not set — opt-in spec, skipping');

test.describe.configure({ mode: 'serial' });

// ---- HTTP+UI route sweep --------------------------------------------------
// One test per route, each asserts:
//   1. Route mounted without redirecting away.
//   2. No console errors after a 2s settle.
//   3. No 5xx network failures.
//   4. A route-specific landmark text/element is visible (proves the
//      page actually rendered the loaded state, not just the skeleton).

const ROUTES: Array<{
  path: string;
  label: string;
  landmark: RegExp;
}> = [
  { path: '/chat', label: 'chat-threads', landmark: /Threads|New chat|Chat/i },
  { path: '/knowledge', label: 'knowledge', landmark: /Knowledge|Memory|MEMORY\.md/i },
  { path: '/skills', label: 'skills', landmark: /Skills|skill/i },
  { path: '/routines', label: 'routines', landmark: /Routines|routine/i },
  { path: '/jobs', label: 'jobs', landmark: /Jobs|No jobs|job/i },
  { path: '/logs', label: 'logs', landmark: /Logs|log/i },
  { path: '/extensions', label: 'extensions', landmark: /Extensions|nearai|NEAR AI/i },
  { path: '/admin', label: 'admin', landmark: /Admin|Usage|usage/i },
  { path: '/missions', label: 'missions', landmark: /Missions|mission|conversation-insights/i }
];

for (const { path, label, landmark } of ROUTES) {
  test(`dogfood: ${label} (${path}) mounts against real gateway`, async ({ page }) => {
    const sinks = attachErrorSinks(page);

    await mockTauri(page, { settings: REAL_SETTINGS, token: TOKEN });
    // No mockGateway() — fetches go through `proxyToGateway` which forwards
    // to the real tunneled gateway and injects CORS so the dev origin works.
    await proxyToGateway(page, GATEWAY_BASE, TOKEN);

    await page.goto(path);
    // Wait for route to settle. 3s covers list/summary parallel fetches
    // against a tunneled gateway with ~30ms round-trip.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {
      // networkidle never reaches quiet on /logs (SSE keeps a connection
      // open). Fall through — the landmark assertion below is what we
      // actually care about.
    });

    // Confirm we're on the route we asked for (not bounced to /onboarding).
    expect(page.url(), `route ${path} should not have redirected`).toContain(path);

    // Landmark visible — proves the page rendered its loaded state.
    await expect(
      page.getByText(landmark).first(),
      `landmark for ${label} should be visible`
    ).toBeVisible({ timeout: 6000 });

    // Snapshot the error totals AFTER settle.
    await page.waitForTimeout(500);

    expect(
      sinks.consoleErrors,
      `route ${label} produced ${sinks.consoleErrors.length} console error(s):\n${sinks.consoleErrors.join('\n  -- ')}`
    ).toEqual([]);

    expect(
      sinks.networkFailures,
      `route ${label} produced ${sinks.networkFailures.length} network failure(s):\n${sinks.networkFailures.join('\n  -- ')}`
    ).toEqual([]);
  });
}

// ---- Functional smoke: create thread, send message, delete -----------------
//
// Skipped by default because it spends real LLM tokens and a real gateway
// turn (~3-15s). Enable with `IRONCLAW_DOGFOOD_FUNCTIONAL=1`.

test(`dogfood: chat send roundtrip (skipped unless IRONCLAW_DOGFOOD_FUNCTIONAL=1)`, async ({
  page
}) => {
  test.skip(
    process.env.IRONCLAW_DOGFOOD_FUNCTIONAL !== '1',
    'set IRONCLAW_DOGFOOD_FUNCTIONAL=1 to run the live LLM roundtrip'
  );

  const sinks = attachErrorSinks(page);
  await mockTauri(page, { settings: REAL_SETTINGS, token: TOKEN });
  await proxyToGateway(page, GATEWAY_BASE, TOKEN);
  await page.goto('/chat');

  // Wait for thread list to load.
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // Find the new-chat button (cmd+N affordance) and click it.
  const newChatBtn = page
    .getByRole('button', { name: /Start a new chat|new chat|new thread/i })
    .first();
  await newChatBtn.click({ timeout: 5000 });

  // Wait for the composer to be present (proves we're on a thread surface).
  const composer = page.locator('textarea').first();
  await expect(composer).toBeVisible({ timeout: 5000 });

  // Use a unique marker so we can disambiguate the LLM response from
  // existing sidebar thread titles (e.g. "reply only PONG3").
  const MARKER = `DOGFOOD_R34A_${Date.now().toString(36).toUpperCase()}`;
  await composer.fill(`Reply with exactly this single token, nothing else: ${MARKER}`);
  await composer.press('Enter');

  // Wait for the assistant bubble. The chat surface renders each turn as
  // a pair of [role="article"] elements (user + assistant). Wait for AT
  // LEAST TWO occurrences of the marker on the page total (sidebar entry
  // + assistant response). 60s budget for cold-LLM round-trip via tunnel.
  await expect
    .poll(
      async () => {
        const matches = await page.getByText(MARKER).count();
        return matches;
      },
      { timeout: 60_000, intervals: [500, 1000, 2000] }
    )
    .toBeGreaterThanOrEqual(2);

  expect(
    sinks.consoleErrors,
    `chat send produced ${sinks.consoleErrors.length} console error(s):\n${sinks.consoleErrors.join('\n  -- ')}`
  ).toEqual([]);
});
