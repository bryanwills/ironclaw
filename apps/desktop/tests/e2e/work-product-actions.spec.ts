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

const CHAT_REPLY = `# Pilot term sheet

- 90-day paid pilot
- 2 sites, 5 seats
- Follow-up email by Friday`;

const STRUCTURED_REPLY = `# Risk review

Intro with **bold**, *italic*, \`inline_code()\`, and [docs](https://example.com/docs?a=1&b=2).

1. First ordered item
   1. Nested ordered item
2. Second ordered item

> Plain quoted note with [a source](https://example.com/source).

> [!WARNING]
> Keep the Friday deploy frozen.

| Risk | Severity | Owner |
| --- | --- | --- |
| Data use rights | High | Legal |
| Pricing drift | Medium | Sales |
| Pipe \\| value | Medium | Ops |

\`\`\`python
def score(items):
    return [item["risk"] for item in items]
\`\`\`
`;

const ARTIFACT_CONTENT = `# Northwind MSA follow-up

- Ask counsel to review liability language.
- Draft a short client reply.
- Export a clean copy for review.`;

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

async function installClipboardSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          window.localStorage.setItem('__ironclaw_copied_text', text);
        }
      }
    });
  });
}

async function openChatWithReply(
  page: Page,
  reply = CHAT_REPLY,
  visibleText = 'Pilot term sheet'
): Promise<void> {
  await installClipboardSpy(page);
  await mockCompletedOnboarding(page);
  await mockGateway(page, { threads: [], mockedReply: reply });
  await mockGatewaySurfaces(page);

  await page.goto('/chat');
  await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({ timeout: 10_000 });

  const composer = page.getByPlaceholder('Message IronClaw…');
  await expect(composer).toBeEnabled({ timeout: 5000 });
  await composer.fill('Summarize this pilot note into a clean brief.');
  await page.getByRole('button', { name: /^Send( message)?$/ }).click();

  await expect(page.getByText(visibleText).first()).toBeVisible({ timeout: 5000 });
}

async function openWorkArtifact(page: Page): Promise<void> {
  await installClipboardSpy(page);
  await mockCompletedOnboarding(page);
  await mockGateway(page, { threads: [] });
  await page.addInitScript((content) => {
    window.localStorage.setItem(
      'ironclaw-work-items',
      JSON.stringify([
        {
          id: 'portable-work',
          title: 'Northwind MSA',
          objective: 'Prepare a clean follow-up and review packet.',
          domain: 'legal',
          runbookIds: ['legal'],
          status: 'active',
          created_at: '2026-06-01T08:00:00.000Z',
          updated_at: '2026-06-01T08:00:00.000Z',
          links: [],
          dossier: [],
          approvalBoundaries: [],
          artifacts: [
            {
              id: 'artifact-follow-up',
              type: 'doc',
              title: 'Northwind MSA follow-up',
              status: 'ready',
              provenance: ['chat:thread-northwind'],
              content,
              content_format: 'markdown'
            }
          ],
          watches: [],
          receipts: [],
          openApprovals: [],
          followUps: [],
          nextAction: 'Review follow-up'
        }
      ])
    );
  }, ARTIFACT_CONTENT);

  await page.goto('/work?item=portable-work&artifact=artifact-follow-up');
  await expect(page.getByRole('region', { name: 'Work item detail' })).toBeVisible({
    timeout: 10_000
  });
  await expect(page.getByTestId('work-artifact-content')).toContainText('Northwind MSA follow-up');
}

test('Reborn chat assistant responses can be copied from the rendered surface', async ({
  page
}) => {
  await openChatWithReply(page);

  await page.getByRole('button', { name: 'Copy Assistant response' }).last().click();

  await expect
    .poll(async () => page.evaluate(() => window.localStorage.getItem('__ironclaw_copied_text')))
    .toContain('90-day paid pilot');
});

test('Reborn chat assistant responses export as Markdown downloads', async ({ page }) => {
  await openChatWithReply(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Assistant response as Markdown' }).last().click()
  ]);

  expect(download.suggestedFilename()).toBe('assistant-response.md');
  const path = await download.path();
  expect(path).toBeTruthy();
  await expect.poll(async () => readFile(path!, 'utf8')).toContain('Pilot term sheet');
});

test('Reborn chat assistant responses export real DOCX files', async ({ page }) => {
  await openChatWithReply(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Assistant response as DOCX' }).last().click()
  ]);

  expect(download.suggestedFilename()).toBe('assistant-response.docx');
  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path!);
  expect(bytes.subarray(0, 2).toString('utf8')).toBe('PK');
  expect(bytes.toString('utf8')).toContain('word/document.xml');
  expect(bytes.toString('utf8')).toContain('Pilot term sheet');
});

test('Reborn chat assistant responses export real PDF files', async ({ page }) => {
  await openChatWithReply(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Assistant response as PDF' }).last().click()
  ]);

  expect(download.suggestedFilename()).toBe('assistant-response.pdf');
  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path!);
  expect(bytes.subarray(0, 8).toString('utf8')).toBe('%PDF-1.4');
  expect(bytes.toString('latin1')).toContain('(PILOT TERM SHEET) Tj');
  expect(bytes.toString('latin1')).toContain('(- 90-day paid pilot) Tj');
});

test('Reborn chat exports tables as structured HTML and DOCX', async ({ page }) => {
  await openChatWithReply(page, STRUCTURED_REPLY, 'Risk review');

  const [htmlDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Assistant response as HTML' }).last().click()
  ]);

  const htmlPath = await htmlDownload.path();
  expect(htmlPath).toBeTruthy();
  const html = await readFile(htmlPath!, 'utf8');
  expect(html).toContain('<table>');
  expect(html).toContain('<td>Data use rights</td>');
  expect(html).toContain('<td>Pricing drift</td>');
  expect(html).not.toContain('| Risk | Severity | Owner |');

  const [docxDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Assistant response as DOCX' }).last().click()
  ]);

  const docxPath = await docxDownload.path();
  expect(docxPath).toBeTruthy();
  const bytes = await readFile(docxPath!);
  const docx = bytes.toString('utf8');
  expect(bytes.subarray(0, 2).toString('utf8')).toBe('PK');
  expect(docx).toContain('word/document.xml');
  expect(docx).toContain('<w:t xml:space="preserve">Risk review</w:t>');
  expect(docx).toContain('<w:tbl>');
  expect(docx).toContain('<w:t xml:space="preserve">Data use rights</w:t>');
  expect(docx).toContain('<w:t xml:space="preserve">Pipe | value</w:t>');
  expect(docx).toContain('<w:t xml:space="preserve">def score(items):</w:t>');
});

test('Reborn chat exports the full visible thread, not only one bubble', async ({ page }) => {
  await openChatWithReply(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export IronClaw chat thread as Markdown' }).last().click()
  ]);

  expect(download.suggestedFilename()).toBe('ironclaw-chat-thread.md');
  const path = await download.path();
  expect(path).toBeTruthy();
  const exported = await readFile(path!, 'utf8');
  expect(exported).toContain('## User');
  expect(exported).toContain('Summarize this pilot note into a clean brief.');
  expect(exported).toContain('## Assistant');
  expect(exported).toContain('Pilot term sheet');
});

test('Reborn chat exports the full visible thread as JSON', async ({ page }) => {
  await openChatWithReply(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export IronClaw chat thread as JSON' }).last().click()
  ]);

  expect(download.suggestedFilename()).toBe('ironclaw-chat-thread.json');
  const path = await download.path();
  expect(path).toBeTruthy();
  const exported = JSON.parse(await readFile(path!, 'utf8')) as {
    thread: { id: string; title: string };
    messages: Array<{ role: string; content: string }>;
  };
  expect(exported.thread.title).toBeTruthy();
  expect(
    exported.messages.some(
      (message) =>
        message.role === 'user' &&
        message.content.includes('Summarize this pilot note into a clean brief.')
    )
  ).toBe(true);
  expect(
    exported.messages.some(
      (message) => message.role === 'assistant' && message.content.includes('Pilot term sheet')
    )
  ).toBe(true);
});

test('Reborn chat assistant responses can be promoted into a Work artifact', async ({ page }) => {
  await openChatWithReply(page);

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
          title: 'Pilot term sheet',
          content: expect.stringContaining('90-day paid pilot')
        })
      ])
    );
  } else {
    await expect(page).toHaveURL(/\/work\?item=.*artifact=/, { timeout: 5000 });
    await expect(page.getByTestId('work-artifact-content')).toContainText('90-day paid pilot');
  }
});

test('/work artifacts can be copied from the rendered artifact pane', async ({ page }) => {
  await openWorkArtifact(page);

  await page.getByRole('button', { name: 'Copy Northwind MSA follow-up' }).click();

  await expect
    .poll(async () => page.evaluate(() => window.localStorage.getItem('__ironclaw_copied_text')))
    .toContain('Ask counsel to review liability language.');
});

test('/work artifacts export real DOCX files from the rendered artifact pane', async ({ page }) => {
  await openWorkArtifact(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Northwind MSA follow-up as DOCX' }).click()
  ]);

  expect(download.suggestedFilename()).toBe('northwind-msa-follow-up.docx');
  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path!);
  expect(bytes.subarray(0, 2).toString('utf8')).toBe('PK');
  expect(bytes.toString('utf8')).toContain('word/document.xml');
  expect(bytes.toString('utf8')).toContain('Northwind MSA follow-up');
});

test('/work artifacts export real PDF files from the rendered artifact pane', async ({ page }) => {
  await openWorkArtifact(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Northwind MSA follow-up as PDF' }).click()
  ]);

  expect(download.suggestedFilename()).toBe('northwind-msa-follow-up.pdf');
  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path!);
  expect(bytes.subarray(0, 8).toString('utf8')).toBe('%PDF-1.4');
  expect(bytes.toString('latin1')).toContain('(Northwind MSA follow-up) Tj');
});
