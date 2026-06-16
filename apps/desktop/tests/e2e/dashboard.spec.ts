import { test, expect, type Page } from '@playwright/test';
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
  adminMode: true,
  trayEnabled: true,
  useResponsesApi: false,
  engineV2Enabled: false
};

async function pinConnectionConnected(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seed = async (): Promise<void> => {
      try {
        const url = new URL('/src/lib/stores/connection.svelte.ts', window.location.origin).href;
        const mod = (await import(/* @vite-ignore */ url)) as {
          connection: { status: string };
        };
        mod.connection.status = 'connected';
        setTimeout(() => (mod.connection.status = 'connected'), 200);
        setTimeout(() => (mod.connection.status = 'connected'), 800);
      } catch {
        /* best-effort */
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => void seed(), { once: true });
    } else {
      void seed();
    }
  });
}

async function stubClientMethods(page: Page, overrides: Record<string, unknown>): Promise<void> {
  await page.addInitScript((ov: Record<string, unknown>) => {
    const seed = async (): Promise<void> => {
      try {
        const url = new URL('/src/lib/api/ironclaw.ts', window.location.origin).href;
        const mod = (await import(/* @vite-ignore */ url)) as {
          IronClawClient: { prototype: Record<string, unknown> };
        };
        for (const [name, value] of Object.entries(ov)) {
          mod.IronClawClient.prototype[name] = function stub() {
            return Promise.resolve(value);
          };
        }
      } catch {
        /* best-effort */
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => void seed(), { once: true });
    } else {
      void seed();
    }
  }, overrides);
}

test('/dashboard renders the default dashboard tile grid', async ({ page }) => {
  const now = new Date().toISOString();

  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page);
  await pinConnectionConnected(page);
  await stubClientMethods(page, {
    health: { ok: true, status: 'ok' },
    listThreads: [
      {
        id: 'thread-dashboard',
        title: 'Dashboard thread',
        created_at: now,
        updated_at: now,
        message_count: 3
      }
    ],
    listRoutines: [
      {
        id: 'routine-dashboard',
        name: 'Daily briefing',
        schedule: '0 9 * * *',
        enabled: true,
        last_run: now,
        next_run: new Date(Date.now() + 3_600_000).toISOString()
      }
    ],
    listSkills: [
      {
        name: 'research',
        description: 'Research assistant',
        version: '1.0.0',
        installed: true
      }
    ],
    pollThreadChanges: { changed: [], deleted: [], nextSince: Date.now() }
  });

  await page.goto('/dashboard');

  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('tile-grid')).toBeVisible();
  await expect(page.getByTestId('tile-title').filter({ hasText: 'Work queue' })).toBeVisible();
  await expect(page.getByTestId('tile-title').filter({ hasText: 'Recent threads' })).toBeVisible();
  await expect(page.getByTestId('tile-title').filter({ hasText: 'Active routines' })).toBeVisible();
  await expect(page.getByTestId('tile-title').filter({ hasText: 'Recent skills' })).toBeVisible();
});

test('root route redirects to the Today front door', async ({ page }) => {
  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page);
  await pinConnectionConnected(page);

  await page.goto('/');

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible({ timeout: 10_000 });
});

test('/dashboard opens as a prepared morning brief with a real approval gate', async ({ page }) => {
  const now = new Date().toISOString();

  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page);
  await pinConnectionConnected(page);
  await stubClientMethods(page, {
    health: { ok: true, status: 'ok' },
    listThreads: [],
    listRoutines: [],
    listSkills: [],
    pollThreadChanges: { changed: [], deleted: [], nextSince: Date.now() }
  });

  await page.addInitScript((timestamp: string) => {
    window.localStorage.setItem(
      'ironclaw-work-items',
      JSON.stringify([
        {
          id: 'approval-work',
          title: 'Send renewal terms',
          objective: 'Get the customer renewal terms out.',
          domain: 'legal',
          runbookIds: ['legal'],
          status: 'waiting-approval',
          created_at: timestamp,
          updated_at: timestamp,
          links: [{ kind: 'thread', ref: 'thread-1', label: 'Renewal thread' }],
          dossier: [{ label: 'CRM note', state: 'used', provenance: 'mock fixture' }],
          approvalBoundaries: [
            {
              id: 'gate-1',
              action: 'Send email',
              kind: 'send',
              payload: 'renewal email to customer@example.com',
              reason: 'External send needs user approval.',
              status: 'pending'
            }
          ],
          artifacts: [
            {
              id: 'artifact-1',
              type: 'email',
              title: 'Renewal email',
              status: 'ready',
              provenance: ['runbook']
            }
          ],
          watches: [],
          openApprovals: ['Send email'],
          followUps: [],
          nextAction: 'Review approval: Send email'
        },
        {
          id: 'blocked-work',
          title: 'Watch competitor launch',
          objective: 'Track pricing changes.',
          domain: 'research',
          runbookIds: ['research'],
          status: 'blocked',
          created_at: timestamp,
          updated_at: timestamp,
          links: [],
          dossier: [{ label: 'Pricing source', state: 'missing', provenance: 'mock fixture' }],
          approvalBoundaries: [],
          artifacts: [],
          watches: [
            {
              id: 'watch-1',
              trigger: 'pricing page changed',
              cadence: 'daily',
              source: 'competitor site',
              next_check: null,
              escalation: 'notify user',
              status: 'active'
            }
          ],
          openApprovals: [],
          followUps: [],
          nextAction: 'Add pricing source'
        }
      ])
    );
    window.localStorage.setItem(
      'ironclaw-open-loops',
      JSON.stringify([
        {
          id: 'loop-1',
          text: 'Follow up on board packet',
          done: false,
          createdAt: Date.now()
        }
      ])
    );
  }, now);

  await page.goto('/dashboard');

  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#morning-brief-heading')).toBeVisible();
  await expect(page.getByTestId('morning-brief-line')).toContainText('1 approval waiting');
  await expect(page.getByTestId('today-first-decision')).toContainText('Send email');
  await expect(page.getByTestId('today-first-decision')).toContainText(
    'External send needs user approval.'
  );
  await expect(page.getByTestId('today-active-matters')).toContainText('Watch competitor launch');

  await page.getByRole('button', { name: 'Approve' }).click();

  await expect(page.getByTestId('morning-brief-line')).toContainText('No approvals waiting');
  await expect(page.getByTestId('today-handled-receipts')).toContainText('Approved · Send email');
});

test('/dashboard fires due watches and surfaces handled receipts without user action', async ({
  page
}) => {
  const now = new Date().toISOString();

  await mockTauri(page, { settings: SETTINGS, token: 'tok' });
  await mockGateway(page);
  await mockGatewaySurfaces(page);
  await pinConnectionConnected(page);
  await stubClientMethods(page, {
    health: { ok: true, status: 'ok' },
    listThreads: [],
    listRoutines: [],
    listSkills: [],
    pollThreadChanges: { changed: [], deleted: [], nextSince: Date.now() }
  });

  await page.addInitScript((timestamp: string) => {
    window.localStorage.setItem(
      'ironclaw-work-items',
      JSON.stringify([
        {
          id: 'watch-work',
          title: 'Watch board packet',
          objective: 'Notice when the latest board packet changes.',
          domain: 'operations',
          runbookIds: ['operations'],
          status: 'active',
          created_at: timestamp,
          updated_at: timestamp,
          links: [],
          dossier: [{ label: 'Board packet folder', state: 'used', provenance: 'mock fixture' }],
          approvalBoundaries: [],
          artifacts: [],
          watches: [
            {
              id: 'watch-board-packet',
              trigger: 'board packet file changed',
              cadence: 'daily',
              source: 'workspace',
              next_check: '2026-01-01T00:00:00.000Z',
              escalation: 'Surface a receipt before the prep meeting.',
              status: 'active'
            }
          ],
          receipts: [],
          openApprovals: [],
          followUps: [],
          nextAction: 'Wait for the next packet change'
        }
      ])
    );
  }, now);

  await page.goto('/dashboard');

  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('morning-brief-line')).toContainText('No approvals waiting');
  await expect(page.getByTestId('today-handled-receipts')).toContainText(
    'Handled · Checked board packet file changed'
  );
  await expect(page.getByTestId('today-active-matters')).toContainText(
    'Review watch receipt: Checked board packet file changed'
  );

  const persisted = await page.evaluate(() => {
    const raw = window.localStorage.getItem('ironclaw-work-items');
    if (!raw) return null;
    const [item] = JSON.parse(raw) as Array<{
      receipts: Array<{ title: string; status: string; source: string }>;
      watches: Array<{ next_check: string | null; status: string }>;
    }>;
    return {
      receipt: item.receipts[0],
      watch: item.watches[0]
    };
  });

  expect(persisted?.receipt).toEqual(
    expect.objectContaining({
      title: 'Checked board packet file changed',
      status: 'handled',
      source: 'workspace'
    })
  );
  expect(persisted?.watch.status).toBe('active');
  expect(persisted?.watch.next_check).not.toBe('2026-01-01T00:00:00.000Z');
});
