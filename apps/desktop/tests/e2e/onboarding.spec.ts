// E2E: cold-start onboarding → dashboard Get Started → connector-gated mission.

import { test, expect } from '@playwright/test';
import { mockGateway, mockGatewaySurfaces, mockTauri } from './_helpers';

test('first-run setup lands on dashboard and gates missions by connector readiness', async ({
  page
}) => {
  const extensions: Array<{
    name: string;
    display_name?: string;
    kind?: string;
    description?: string;
    version?: string;
    installed?: boolean;
    active?: boolean;
    ready?: boolean;
    readiness_message?: string;
  }> = [];

  await mockTauri(page);
  await mockGateway(page);
  await mockGatewaySurfaces(page, { extensions });

  // Cold start: the layout hydrates settings, sees onboardingComplete=false,
  // and redirects the fresh profile to the onboarding takeover.
  await page.goto('/');
  await expect(page).toHaveURL(/\/onboarding/);

  await expect(page.getByRole('heading', { name: 'IronClaw Desktop' })).toBeVisible();
  await expect(page.getByText(/chief of staff/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect, brief, approve' })).toBeVisible();
  await expect(page.getByText(/Step 1\s*[—-]\s*connect a runner/i)).toBeVisible();
  await expect(page.getByText('Run on this Mac')).toBeVisible();
  await expect(page.getByText('Connect to hosted')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up later' })).toBeVisible();
  await expect(page.getByText('Advanced')).toBeVisible();

  await page.getByRole('button', { name: 'Run locally on this Mac' }).click();

  await page.waitForURL((url) => url.pathname === '/dashboard', { timeout: 5000 });

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up your chief of staff' })).toBeVisible();
  await expect(page.getByText('1. Runner connected')).toBeVisible();
  await expect(page.getByText('2. Workspace packs')).toBeVisible();
  await expect(page.getByText('3. Mission launcher')).toBeVisible();

  // The hermetic first-run path must land with a healthy mocked local runner;
  // the connector-readiness journey below should fail if onboarding leaves the
  // app disconnected.
  const morningBrief = page.getByTestId('mission-card-morning-brief');
  await expect(morningBrief.getByText('Needs Google Workspace')).toBeVisible();
  await expect(
    morningBrief.getByRole('link', { name: 'Connect Google Workspace' })
  ).toHaveAttribute('href', '/extensions?focus=gmail&setup=1');
  await expect(morningBrief.getByRole('button', { name: 'Morning Brief' })).toBeDisabled();

  // Make the Google Workspace connectors READY. The surface mock closes over
  // this array, so mutating it makes the next Refresh see the same readiness
  // shape the gateway would report.
  extensions.splice(
    0,
    extensions.length,
    ...[
      'gmail',
      'google_calendar',
      'google_docs',
      'google_drive',
      'google_sheets',
      'google_slides'
    ].map((name) => ({
      name,
      installed: true,
      active: true,
      ready: true,
      readiness_message: 'ready'
    }))
  );

  await page.getByRole('button', { name: 'Refresh' }).first().click();
  await expect(morningBrief.getByText('Needs Google Workspace')).toBeHidden();
  await expect(morningBrief.getByRole('button', { name: 'Morning Brief' })).toBeEnabled();

  await morningBrief.getByRole('button', { name: 'Morning Brief' }).click();
  await page.waitForURL((url) => url.pathname === '/chat', { timeout: 5000 });
});
