// Regression guard for the /skills route auto-reload loop.
//
// Round 34a dogfood measured /skills taking ~8.6s to mount vs ~1.3s for
// every other route. Root cause: the page's auto-load `$effect` read
// `loadState` reactively and re-fired whenever `loadState` transitioned
// out of `'loading'`, which included the post-fetch transition to
// `'loaded'`. The effect then called `loadSkills()` again, creating an
// infinite fetch loop that prevented `networkidle` from ever quieting.
//
// This spec mocks `/api/skills` and asserts that the endpoint is hit
// EXACTLY ONCE during a 2-second window after the route mounts. Without
// the fix, the call count would climb continuously.

import { test, expect, type Route, type Request } from '@playwright/test';
import { mockTauri, mockGatewaySurfaces, type TauriMockSettings } from './_helpers';

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

test('skills: /api/skills is fetched exactly once on a stable mount', async ({ page }) => {
  await mockTauri(page, { settings: SETTINGS, token: 'test-token' });
  await mockGatewaySurfaces(page);

  // Count GET /api/skills calls separately from the standard mock so we
  // see every hit even though the response is canned.
  let skillsHits = 0;
  await page.route(/\/api\/skills(?:\?.*)?$/, async (route: Route, req: Request) => {
    if (req.method() === 'GET' && /\/api\/skills(\?|$)/.test(req.url())) {
      skillsHits += 1;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ skills: [] })
    });
  });

  await page.goto('/skills');
  // Wait long enough for any reactive re-fire cycle to complete several
  // iterations. With the loop, each round-trip is sub-100ms against a
  // canned mock — 2s would see dozens of hits.
  await page.waitForTimeout(2000);

  expect(skillsHits, 'GET /api/skills should be fetched exactly once on mount').toBe(1);
});
