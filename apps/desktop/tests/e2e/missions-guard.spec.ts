import { expect, test } from '@playwright/test';
import { mockGateway, mockGatewaySurfaces, mockTauri, type TauriMockSettings } from './_helpers';

function settings(engineV2Enabled: boolean): TauriMockSettings {
  return {
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
    engineV2Enabled
  };
}

test('missions route stays mounted after hydrated Engine v2 settings allow it', async ({
  page
}) => {
  await mockTauri(page, { settings: settings(true), token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page);

  await page.goto('/missions');

  await expect(page).toHaveURL(/\/missions$/);
  await expect(page.getByRole('heading', { name: 'Missions', exact: true })).toBeVisible();
});

test('missions route redirects to Settings only after hydrated Engine v2 settings disable it', async ({
  page
}) => {
  await mockTauri(page, { settings: settings(false), token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page);

  await page.goto('/missions');

  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
});
