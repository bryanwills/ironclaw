import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
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

const XLSX_RENEWAL_REPLY = `# Renewal amendment

Use the attached workbook as the source of truth.

| Item | Value |
| --- | --- |
| Account | Beacon Robotics |
| Seats | 12 |
| Discount | 15% |
| Net annual fee | USD 51,000 |

## Draft language

The parties agree to renew the subscription for twelve seats at a fifteen percent discount. No invoice or external notice is approved.`;

const CSV_ORDER_FORM_REPLY = `# Order form

- Customer: Northwind SaaS
- Seats: 5
- Implementation fee: USD 25,000
- Support: USD 3,000 monthly

## Approval note

Keep this as a draft until finance approves the payment terms.`;

const DOCX_SOW_REPLY = `# Statement of Work

## Scope

Service Provider will onboard analytics dashboards, configure workspace automations, and train the customer operations team.

## Timeline

Week 1: discovery and data mapping.
Week 2: implementation and acceptance testing.

## Deliverables

- Implementation plan
- Acceptance checklist
- Administrator handoff notes`;

const PPTX_BOARD_REPLY = `# Board brief

## Executive summary

The attached deck supports a 90-day chief-of-staff automation pilot.

## Decisions requested

- Approve workspace connector pilot
- Approve legal review for data handling language
- Defer external rollout until the pilot success metrics are met`;

const JSON_PLAN_REPLY = `# Implementation plan

## Client requirements

- Client: Atlas Harbor
- Hosting: single tenant
- Data boundary: no external writes without approval

## Next steps

1. Confirm connector owners.
2. Draft the security appendix.
3. Schedule acceptance testing.`;

let pageErrors: string[] = [];

test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
});

test.afterEach(() => {
  expect(pageErrors.filter((error) => !isKnownDevServerModuleNoise(error))).toEqual([]);
});

function isKnownDevServerModuleNoise(error: string): boolean {
  return error.includes(
    'Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html"'
  );
}

async function mockCompletedOnboarding(page: Page): Promise<void> {
  await mockTauri(page, { settings: SETTINGS, token: 'mock-token-abc' });
}

async function sendAttachmentForGeneratedReply(
  page: Page,
  input: {
    fileName: string;
    mimeType: string;
    bytes: Buffer;
    prompt: string;
    reply: string;
    expectedText: string;
  }
): Promise<Record<string, unknown> | null> {
  await mockCompletedOnboarding(page);
  await mockGateway(page, { threads: [], mockedReply: input.reply });
  await mockGatewaySurfaces(page);

  let postedBody: Record<string, unknown> | null = null;
  await page.route(/\/api\/webchat\/v2\/threads\/([^/]+)\/messages$/, async (route) => {
    postedBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fallback();
  });

  await page.goto('/chat');
  await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({ timeout: 10_000 });

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: input.fileName,
    mimeType: input.mimeType,
    buffer: input.bytes
  });
  await expect(page.getByText(input.fileName)).toBeVisible();

  const composer = page.getByPlaceholder('Message IronClaw…');
  await composer.fill(input.prompt);
  const send = page.getByRole('button', { name: /^Send( message)?$/ });
  await expect(send).toBeEnabled({ timeout: 5000 });
  await send.click();

  await expect
    .poll(() => postedBody, { timeout: 5000 })
    .toMatchObject({
      content: input.prompt,
      attachments: [
        {
          name: input.fileName,
          mime_type: input.mimeType,
          data_base64: input.bytes.toString('base64')
        }
      ]
    });
  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByText(input.prompt)).toBeVisible();
  await expect(page.getByTestId('local-approval-gate')).toHaveCount(0);
  expect(JSON.stringify(postedBody)).not.toContain('Work item:');

  const assistantResponse = page.locator('.reborn-msg--assistant').last();
  await expect(assistantResponse.getByRole('heading', { name: input.expectedText })).toBeVisible({
    timeout: 5000
  });
  await expect(assistantResponse).not.toContainText(/^\s*\{/);
  await expect(page.getByRole('button', { name: 'Copy Assistant response' }).last()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Export Assistant response as DOCX' }).last()
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Export Assistant response as PDF' }).last()
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save Assistant response to Work' }).last()
  ).toBeVisible();
  return postedBody;
}

test('XLSX input can generate a renewal work product and export an HTML table', async ({
  page
}) => {
  await sendAttachmentForGeneratedReply(page, {
    fileName: 'renewal-calculator.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: Buffer.from('PK\u0003\u0004dummy xlsx workbook with seats, discount, and annual fee'),
    prompt:
      'Use the attached XLSX renewal calculator to draft a renewal amendment for Beacon Robotics. Keep it in chat only.',
    reply: XLSX_RENEWAL_REPLY,
    expectedText: 'Renewal amendment'
  });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Assistant response as HTML' }).last().click()
  ]);
  expect(download.suggestedFilename()).toBe('assistant-response.html');
  const path = await download.path();
  expect(path).toBeTruthy();
  const html = await readFile(path!, 'utf8');
  expect(html).toContain('<table>');
  expect(html).toContain('<td>Beacon Robotics</td>');
  expect(html).toContain('<td>USD 51,000</td>');
});

test('CSV input can generate an order form and export a DOCX', async ({ page }) => {
  await sendAttachmentForGeneratedReply(page, {
    fileName: 'pricing-schedule.csv',
    mimeType: 'text/csv',
    bytes: Buffer.from('item,price\nimplementation,25000\nsupport,3000\n'),
    prompt:
      'Use the attached CSV pricing schedule to draft an order form for Northwind SaaS with 5 seats.',
    reply: CSV_ORDER_FORM_REPLY,
    expectedText: 'Order form'
  });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Assistant response as DOCX' }).last().click()
  ]);
  expect(download.suggestedFilename()).toBe('assistant-response.docx');
  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path!);
  const docx = bytes.toString('utf8');
  expect(bytes.subarray(0, 2).toString('utf8')).toBe('PK');
  expect(docx).toContain('word/document.xml');
  expect(docx).toContain('Northwind SaaS');
  expect(docx).toContain('USD 25,000');
});

test('DOCX input can generate an SOW and export a PDF', async ({ page }) => {
  await sendAttachmentForGeneratedReply(page, {
    fileName: 'sow-template.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: Buffer.from('PK\u0003\u0004dummy docx template with scope and timeline placeholders'),
    prompt: 'Use the attached DOCX SOW template to draft a two-week analytics onboarding SOW.',
    reply: DOCX_SOW_REPLY,
    expectedText: 'Statement of Work'
  });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Assistant response as PDF' }).last().click()
  ]);
  expect(download.suggestedFilename()).toBe('assistant-response.pdf');
  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path!);
  expect(bytes.subarray(0, 8).toString('utf8')).toBe('%PDF-1.4');
  expect(bytes.toString('latin1')).toContain('(STATEMENT OF WORK) Tj');
  expect(bytes.toString('latin1')).toContain('(Week 2: implementation and acceptance testing.) Tj');
});

test('PPTX input can generate a board brief, save it to Work, and export Markdown', async ({
  page
}) => {
  await sendAttachmentForGeneratedReply(page, {
    fileName: 'board-update.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    bytes: Buffer.from('PK\u0003\u0004dummy pptx deck with pilot metrics and decisions'),
    prompt: 'Use the attached PPTX board update to write a concise board brief and decision list.',
    reply: PPTX_BOARD_REPLY,
    expectedText: 'Board brief'
  });

  await page.getByRole('button', { name: 'Save Assistant response to Work' }).last().click();
  await page.waitForFunction(() => {
    const saved = JSON.parse(localStorage.getItem('ironclaw-static-work-products') || '[]');
    return saved.length > 0 || window.location.pathname === '/work';
  });

  const savedInStaticStore = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('ironclaw-static-work-products') || '[]')
  );
  if (savedInStaticStore.length > 0) {
    expect(savedInStaticStore).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Board brief',
          content: expect.stringContaining('Approve workspace connector pilot')
        })
      ])
    );
  } else {
    await expect(page).toHaveURL(/\/work\?item=.*artifact=/, { timeout: 5000 });
    await expect(page.getByTestId('work-artifact-content')).toContainText('Board brief');
    await expect(page.getByTestId('work-artifact-content')).toContainText(
      'Approve workspace connector pilot'
    );
  }

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page
      .getByRole('button', {
        name:
          savedInStaticStore.length > 0
            ? 'Export Assistant response as Markdown'
            : 'Export Board brief as Markdown'
      })
      .last()
      .click()
  ]);
  expect(download.suggestedFilename()).toMatch(/^(assistant-response|board-brief)\.md$/u);
  const path = await download.path();
  expect(path).toBeTruthy();
  const markdown = await readFile(path!, 'utf8');
  expect(markdown).toContain(
    'The attached deck supports a 90-day chief-of-staff automation pilot.'
  );
});

test('JSON input can generate an implementation plan and export the whole thread as JSON', async ({
  page
}) => {
  const prompt =
    'Use the attached JSON requirements to generate a single-tenant implementation plan for Atlas Harbor.';
  await sendAttachmentForGeneratedReply(page, {
    fileName: 'requirements.json',
    mimeType: 'application/json',
    bytes: Buffer.from(
      JSON.stringify({
        client: 'Atlas Harbor',
        hosting: 'single tenant',
        approval_boundary: 'no external writes'
      })
    ),
    prompt,
    reply: JSON_PLAN_REPLY,
    expectedText: 'Implementation plan'
  });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export IronClaw chat thread as JSON' }).last().click()
  ]);
  expect(download.suggestedFilename()).toBe('ironclaw-chat-thread.json');
  const path = await download.path();
  expect(path).toBeTruthy();
  const exported = JSON.parse(await readFile(path!, 'utf8')) as {
    messages: Array<{ role: string; content: string }>;
  };
  expect(
    exported.messages.some((message) => message.role === 'user' && message.content === prompt)
  ).toBe(true);
  expect(
    exported.messages.some(
      (message) => message.role === 'assistant' && message.content.includes('single tenant')
    )
  ).toBe(true);
});
