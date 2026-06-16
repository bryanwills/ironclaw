import { expect, test } from '@playwright/test';
import { mockGateway, mockGatewaySurfaces, mockTauri, type TauriMockSettings } from './_helpers';

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

test('Desk generated actions can use connected workspace sources without pasted text', async ({
  page
}) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page, {
    extensions: [
      { name: 'gmail', display_name: 'Gmail', kind: 'wasm_tool', active: true },
      {
        name: 'google_calendar',
        display_name: 'Google Calendar',
        kind: 'wasm_tool',
        active: true
      }
    ]
  });

  const responseInputs: string[] = [];
  await page.route(/\/api\/v1\/responses$/, async (route) => {
    const body = route.request().postDataJSON() as { input?: string } | null;
    responseInputs.push(body?.input ?? '');
    if (responseInputs.length > 1) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          output_text:
            '# Calendar and inbox brief\n\n## Summary\nGmail and Calendar should be reviewed before drafting any external reply.\n\n## Approval Needed\nNo messages have been sent.'
        })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        output_text: JSON.stringify([
          {
            title: 'Prepare the next calendar brief',
            item: 'Connected source: Google Workspace',
            why: 'The calendar source is connected and ready for a read-only sweep.',
            mode: 'dry-run',
            run_instruction: 'Inspect Gmail and Calendar, then prepare a concise briefing.',
            deliverable: 'Briefing with decisions, FYIs, and can-handle items.',
            domain: 'operations',
            context: [
              {
                label: 'Google Workspace',
                state: 'available',
                provenance: 'Connected source: Google Workspace'
              }
            ],
            risky_actions: [],
            expected_artifacts: [
              {
                type: 'briefing',
                title: 'Calendar and inbox brief',
                provenance: ['Connected source: Google Workspace']
              }
            ],
            watches: []
          }
        ])
      })
    });
  });

  await page.goto('/desk');

  await expect(page.getByRole('checkbox', { name: 'Google Workspace' })).toBeChecked();
  await page.getByRole('button', { name: 'Generate from Desk context' }).click();

  await expect(page.getByText('Prepare the next calendar brief')).toBeVisible();
  expect(responseInputs).toHaveLength(1);
  expect(responseInputs[0]).toContain('Connected source: Google Workspace');
  expect(responseInputs[0]).toContain('Read-only collection request');
  expect(responseInputs[0]).toContain('Do not send');
  expect(responseInputs[0]).not.toContain('tools/gmail');

  await page.getByRole('button', { name: 'Create in Work' }).click();
  await expect(page).toHaveURL(/\/work\?item=.*&artifact=/);
  await expect(
    page.getByRole('heading', { name: 'Prepare the next calendar brief' })
  ).toBeVisible();
  await expect(page.getByText('Calendar and inbox brief').first()).toBeVisible();
  const artifactContent = page.getByTestId('work-artifact-content');
  await expect(artifactContent).toContainText('No messages have been sent.');
  await expect
    .poll(async () => {
      const detailBox = await page.getByRole('region', { name: 'Work item detail' }).boundingBox();
      const artifactBox = await artifactContent.boundingBox();
      if (!detailBox || !artifactBox) return false;
      return artifactBox.y >= detailBox.y && artifactBox.y < detailBox.y + detailBox.height;
    })
    .toBe(true);
  expect(responseInputs).toHaveLength(2);
  expect(responseInputs[1]).toContain('Create the deliverable');
  expect(responseInputs[1]).toContain('Do not return JSON');
});
