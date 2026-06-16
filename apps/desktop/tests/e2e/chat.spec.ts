// E2E: send a Reborn chat message and see the user bubble + mocked assistant
// reply render in the stream.
//
// We seed settings with `onboardingComplete: true` to skip the wizard.
// The `mockTauri()` helper detects that flag and pre-seeds the
// connection store before the layout mounts, so the layout's first-run
// guard sees the right `onboardingComplete` value and never bounces us
// to `/onboarding`. (Without the pre-seed there's a known race: the
// sidebar's onMount takes the `initialized` flag before the layout's
// runs, then the layout's `init().then(...)` callback fires against
// `DEFAULT_SETTINGS` and unconditionally redirects.)
//
// The mocked gateway answers `/api/chat/send` with `{message_id,
// thread_id, status: queued}` and `/api/chat/events` with a single SSE
// frame carrying `Mocked reply`, then a `message_end`.

import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';
import {
  mockGateway,
  mockGatewaySurfaces,
  mockTauri,
  refreshMockedGatewayConnection
} from './_helpers';

const GATEWAY_HOSTS = '(?:127\\.0\\.0\\.1|localhost):(?:3100|3334|3000|8080|18789|22821|4444)';

async function mockCompletedOnboarding(page: Parameters<typeof mockTauri>[0]): Promise<void> {
  await mockTauri(page, {
    settings: {
      activeProfileId: 'default',
      profiles: [
        {
          id: 'default',
          name: 'Default',
          mode: 'remote',
          remoteBaseUrl: 'http://127.0.0.1:18789',
          localBaseUrl: 'http://127.0.0.1:3100',
          llmBackend: 'nearai',
          llmProviderId: 'nearai',
          llmModelId: undefined
        }
      ],
      onboardingComplete: true,
      adminMode: false,
      trayEnabled: true,
      useResponsesApi: false,
      engineV2Enabled: false
    },
    token: 'mock-token-abc'
  });
}

test('user can send a message and see it in the stream', async ({ page }) => {
  await mockCompletedOnboarding(page);

  await mockGateway(page, {
    threads: [],
    mockedReply: 'Mocked reply'
  });
  await mockGatewaySurfaces(page);

  await page.goto('/chat');

  // No onboarding redirect should fire (the pre-seed in mockTauri
  // prevents it). Land directly on the Reborn chat surface.
  await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({
    timeout: 10_000
  });

  // Lock onto the stable placeholder text "Message IronClaw…" (only present
  // once the connection-store client is non-null).
  const composer = page.getByPlaceholder('Message IronClaw…');
  await expect(composer).toBeEnabled({ timeout: 5000 });
  await composer.fill('Hello agent');
  await expect(composer).toHaveValue('Hello agent');

  await composer.press('Enter');

  await expect(page.getByText('Hello agent', { exact: true })).toBeVisible({
    timeout: 4000
  });

  await expect(page.getByText('Mocked reply').first()).toBeVisible({
    timeout: 4000
  });
});

test('sent Reborn message stays visible when terminal timeline is missing the user row', async ({
  page
}) => {
  await mockCompletedOnboarding(page);

  await mockGateway(page, {
    threads: [],
    mockedReply: 'Server reply after lagging timeline'
  });
  await mockGatewaySurfaces(page);

  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/([^/]+)/timeline(?:\\?.*)?$`),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          records: [
            {
              kind: 'assistant',
              message_id: 'assistant-lagging-user-row',
              content: 'Server reply after lagging timeline',
              sequence: 2,
              created_at: '2026-06-01T12:00:02.000Z'
            }
          ],
          next_cursor: null,
          has_more: false
        })
      });
    }
  );
  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/([^/]+)/events(?:\\?.*)?$`),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        },
        body: `event: projection_update\ndata: ${JSON.stringify({
          state: {
            items: [{ run_status: { run_id: 'mock-v2-run-1', status: 'completed' } }]
          }
        })}\n\n`
      });
    }
  );

  await page.goto('/chat');
  await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({ timeout: 10_000 });

  const composer = page.getByPlaceholder('Message IronClaw…');
  await expect(composer).toBeEnabled({ timeout: 5000 });
  await composer.fill('Preserve this sent turn');
  await composer.press('Enter');

  await expect(page.getByText('Server reply after lagging timeline')).toBeVisible({
    timeout: 5000
  });
  await expect(page.getByText('Preserve this sent turn', { exact: true })).toBeVisible();
});

test('chat falls back to legacy when Reborn WebChat v2 routes are absent', async ({ page }) => {
  await mockCompletedOnboarding(page);

  await mockGateway(page, {
    webChatV2Available: false,
    threads: [],
    mockedReply: 'Legacy fallback reply'
  });
  await mockGatewaySurfaces(page);

  await page.goto('/chat');
  await refreshMockedGatewayConnection(page);

  await expect(page.getByTestId('reborn-chat-panel')).toHaveCount(0, { timeout: 10_000 });
  const composer = page.getByPlaceholder('Message IronClaw…');
  await expect(composer).toBeEnabled({ timeout: 5000 });
  await composer.fill('Hello through the compatible chat path');
  await composer.press('Enter');

  await expect(page.getByText('Hello through the compatible chat path')).toBeVisible({
    timeout: 4000
  });
  await expect(page.getByText('Legacy fallback reply').first()).toBeVisible({ timeout: 4000 });
});

test('legacy chat fallback blocks risky asks before /api/chat/send', async ({ page }) => {
  await mockCompletedOnboarding(page);

  await mockGateway(page, {
    webChatV2Available: false,
    threads: [],
    mockedReply: 'This should never send before approval.'
  });
  await mockGatewaySurfaces(page);

  let sendAttempts = 0;
  await page.route(new RegExp(`^https?://${GATEWAY_HOSTS}/api/chat/send$`), async (route) => {
    sendAttempts += 1;
    await route.fallback();
  });

  await page.goto('/chat');
  await refreshMockedGatewayConnection(page);

  await expect(page.getByTestId('reborn-chat-panel')).toHaveCount(0, { timeout: 10_000 });
  const composer = page.getByPlaceholder('Message IronClaw…');
  await expect(composer).toBeEnabled({ timeout: 5000 });
  await composer.fill('Draft an email reply and send the client update.');
  await composer.press('Enter');

  await expect(page).toHaveURL(/\/work\?item=/, { timeout: 5000 });
  await expect(page.getByText('This should never send before approval.')).not.toBeVisible();
  expect(sendAttempts).toBe(0);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('ironclaw-work-items');
        return raw ? JSON.parse(raw) : [];
      })
    )
    .toEqual([
      expect.objectContaining({
        title: 'Draft an email reply and send the client update.',
        domain: 'operations',
        runbookIds: ['operations'],
        status: 'blocked',
        approvalBoundaries: expect.arrayContaining([
          expect.objectContaining({ kind: 'send', status: 'pending' })
        ])
      })
    ]);
});

test('chat exposes the active provider and model selector', async ({ page }) => {
  await mockCompletedOnboarding(page);

  await mockGateway(page, {
    threads: [],
    llmProviders: [
      { id: 'nearai', name: 'NEAR.AI', configured: true, builtin: true, default_model: 'auto' },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        configured: true,
        builtin: true,
        default_model: 'deepseek/deepseek-chat-v3-0324'
      }
    ]
  });
  await mockGatewaySurfaces(page);

  await page.goto('/chat');
  await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[aria-label="Chat model controls"]')).toBeVisible();
  await expect(page.getByText(/Running: NEAR\.AI \/ mock-model/i)).toBeVisible();
  await page.getByRole('button', { name: /Running: NEAR\.AI \/ mock-model/i }).click();
  await expect(page.getByRole('textbox', { name: 'Chat model' })).toHaveValue('auto');
});

test('chat dispatches the first run when the selected model is configured but unverified', async ({
  page
}) => {
  await mockCompletedOnboarding(page);

  await mockGateway(page, {
    threads: [],
    gatewayStatus: {
      llm_backend: 'NEAR.AI',
      llm_model: 'z-ai/glm-4.5',
      model_execution_verified: false,
      model_readiness: 'unverified',
      model_readiness_reason:
        'Gateway status reports configured provider/model only; execution is verified by a successful WebChat run.'
    }
  });
  await mockGatewaySurfaces(page);

  let messageRequests = 0;
  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/([^/]+)/messages$`),
    async (route) => {
      messageRequests += 1;
      await route.fallback();
    }
  );

  await page.goto('/chat');
  await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/The selected model has not passed an execution test/i)).toHaveCount(
    0
  );

  const composer = page.getByPlaceholder('Message IronClaw…');
  await expect(composer).toBeEnabled({ timeout: 5000 });
  await composer.fill('Hello agent');
  await expect(composer).toHaveValue('Hello agent');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();

  await composer.press('Enter');
  await expect.poll(() => messageRequests).toBeGreaterThan(0);
  await expect(page.getByText('Hello agent', { exact: true })).toBeVisible({
    timeout: 4000
  });
  await expect(page.getByText('Mocked reply').first()).toBeVisible({ timeout: 4000 });
});

test('risky Reborn chat asks create a durable Work Item before dispatch', async ({ page }) => {
  await mockCompletedOnboarding(page);

  await mockGateway(page, {
    threads: [],
    mockedReply: 'I will draft it for approval first.'
  });
  await mockGatewaySurfaces(page);

  await page.goto('/chat');
  await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({ timeout: 10_000 });

  const composer = page.getByPlaceholder('Message IronClaw…');
  await composer.fill('Draft an email reply and send the client update.');
  await composer.press('Enter');

  await expect(page.getByTestId('local-approval-gate')).toBeVisible({ timeout: 4000 });
  await expect(page.getByText('I will draft it for approval first.').first()).not.toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('ironclaw-work-items');
        return raw ? JSON.parse(raw) : [];
      })
    )
    .toEqual([
      expect.objectContaining({
        title: 'Draft an email reply and send the client update.',
        domain: 'operations',
        runbookIds: ['operations'],
        status: 'blocked',
        approvalBoundaries: expect.arrayContaining([
          expect.objectContaining({ kind: 'send', status: 'pending' })
        ]),
        links: []
      })
    ]);

  await page.getByRole('button', { name: 'Approve and send' }).click();
  await expect(page.getByText(/Work item: Draft an email reply/)).toBeVisible({ timeout: 4000 });
  await expect(page.getByText('I will draft it for approval first.').first()).toBeVisible({
    timeout: 4000
  });

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('ironclaw-work-items');
        return raw ? JSON.parse(raw) : [];
      })
    )
    .toEqual([
      expect.objectContaining({
        title: 'Draft an email reply and send the client update.',
        domain: 'operations',
        runbookIds: ['operations'],
        status: 'blocked',
        approvalBoundaries: expect.arrayContaining([
          expect.objectContaining({ kind: 'send', status: 'approved' })
        ]),
        links: expect.arrayContaining([expect.objectContaining({ kind: 'thread' })])
      })
    ]);
});

test('approving a risky Reborn chat ask from Work resumes the held dispatch', async ({ page }) => {
  await mockCompletedOnboarding(page);

  await mockGateway(page, {
    threads: [],
    mockedReply: 'I will draft it for approval first.'
  });
  await mockGatewaySurfaces(page);

  const sentBodies: unknown[] = [];
  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/[^/]+/messages$`),
    async (route) => {
      sentBodies.push(route.request().postDataJSON());
      await route.fallback();
    }
  );

  await page.goto('/chat');
  await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({ timeout: 10_000 });

  const composer = page.getByPlaceholder('Message IronClaw…');
  await composer.fill('Draft an email reply and send the client update.');
  await composer.press('Enter');

  await expect(page.getByTestId('local-approval-gate')).toBeVisible({ timeout: 4000 });
  await page.getByRole('link', { name: 'Review in Work' }).click();

  await page.waitForURL((url) => {
    return (
      url.pathname === '/work' &&
      url.searchParams.has('item') &&
      url.searchParams.has('resumeWorkDispatch')
    );
  });
  expect(sentBodies).toHaveLength(0);

  for (let i = 0; i < 4; i += 1) {
    if (new URL(page.url()).pathname === '/chat') break;
    const approve = page.getByRole('button', { name: 'Approve' });
    if ((await approve.count()) === 0) break;
    await approve.first().click();
  }

  await page.waitForURL((url) => {
    return url.pathname === '/chat' && url.searchParams.has('resumeWorkDispatch');
  });
  await expect(page.getByText(/Work item: Draft an email reply/)).toBeVisible({ timeout: 4000 });
  await expect(page.getByText('I will draft it for approval first.').first()).toBeVisible({
    timeout: 4000
  });
  expect(sentBodies).toHaveLength(1);
  expect(JSON.stringify(sentBodies[0])).toContain('Work item: Draft an email reply');

  await expect
    .poll(async () =>
      page.evaluate(() => window.localStorage.getItem('ironclaw-work-dispatch-resumes') ?? '')
    )
    .not.toContain('Draft an email reply and send the client update.');
});

test('existing Reborn threads with legacy-shaped ids auto-open and render messages', async ({
  page
}) => {
  await mockCompletedOnboarding(page);
  await mockGateway(page, { threads: [] });
  await mockGatewaySurfaces(page);

  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads(?:\\?.*)?$`),
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          threads: [
            {
              id: 'legacy-thread-19',
              title: 'Inbox triage',
              created_at: '2026-06-01T06:00:00.000Z',
              updated_at: '2026-06-01T06:30:00.000Z',
              message_count: 19
            }
          ],
          next_cursor: null
        })
      });
    }
  );
  await page.route(
    new RegExp(
      `^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/legacy-thread-19/timeline(?:\\?.*)?$`
    ),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              kind: 'user',
              message_id: 'u-existing',
              content: 'Can you triage these 19 messages?',
              sequence: 1,
              created_at: '2026-06-01T06:30:00.000Z'
            },
            {
              kind: 'assistant',
              message_id: 'a-existing',
              content: 'Yes. Three need your decision and the rest can wait.',
              sequence: 2,
              created_at: '2026-06-01T06:31:00.000Z'
            }
          ],
          next_cursor: null,
          has_more: false
        })
      });
    }
  );

  await page.goto('/chat');
  await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Inbox triage')).toBeVisible();
  await expect(page.getByText('Can you triage these 19 messages?')).toBeVisible({
    timeout: 5000
  });
  await expect(
    page.getByText('Yes. Three need your decision and the rest can wait.')
  ).toBeVisible();
});

test('Reborn thread deep link opens the requested older thread instead of the freshest', async ({
  page
}) => {
  await mockCompletedOnboarding(page);
  await mockGateway(page, { threads: [] });
  await mockGatewaySurfaces(page);

  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads(?:\\?.*)?$`),
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          threads: [
            {
              id: 'newest-v2-thread',
              title: 'Newest thread',
              created_at: '2026-06-01T07:00:00.000Z',
              updated_at: '2026-06-01T07:30:00.000Z',
              message_count: 2
            },
            {
              id: 'older-v2-thread',
              title: 'Older linked thread',
              created_at: '2026-06-01T06:00:00.000Z',
              updated_at: '2026-06-01T06:30:00.000Z',
              message_count: 19
            }
          ],
          next_cursor: null
        })
      });
    }
  );
  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/([^/]+)/timeline(?:\\?.*)?$`),
    async (route) => {
      const url = new URL(route.request().url());
      const threadId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          records: [
            {
              kind: 'assistant',
              message_id: `${threadId}-assistant`,
              content:
                threadId === 'older-v2-thread'
                  ? 'This is the older linked thread.'
                  : 'This is the newest thread.',
              sequence: 1,
              created_at: '2026-06-01T06:31:00.000Z'
            }
          ],
          next_cursor: null,
          has_more: false
        })
      });
    }
  );

  await page.goto('/chat?thread=older-v2-thread');
  await expect(page.getByRole('button', { name: /Older linked thread/ })).toBeVisible();
  await expect(page.getByText('This is the older linked thread.')).toBeVisible({
    timeout: 5000
  });
  await expect(page.getByText('This is the newest thread.')).toBeHidden();
});

test('timeline load failure for existing Reborn history shows a retry state, not starter copy', async ({
  page
}) => {
  await mockCompletedOnboarding(page);
  await mockGateway(page, { threads: [] });
  await mockGatewaySurfaces(page);

  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads(?:\\?.*)?$`),
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          threads: [
            {
              id: 'legacy-thread-error',
              title: 'Needs recovery',
              created_at: '2026-06-01T06:00:00.000Z',
              updated_at: '2026-06-01T06:30:00.000Z',
              message_count: 19
            }
          ],
          next_cursor: null
        })
      });
    }
  );

  let timelineCalls = 0;
  await page.route(
    new RegExp(
      `^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/legacy-thread-error/timeline(?:\\?.*)?$`
    ),
    async (route) => {
      timelineCalls += 1;
      if (timelineCalls === 1) {
        await route.fulfill({ status: 503, body: 'timeline unavailable' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          records: [
            {
              kind: 'assistant',
              message_id: 'recovered',
              content: 'Recovered history is visible now.',
              sequence: 1,
              created_at: '2026-06-01T06:31:00.000Z'
            }
          ],
          next_cursor: null,
          has_more: false
        })
      });
    }
  );

  await page.goto('/chat');
  await expect(page.getByText('Needs recovery')).toBeVisible();
  await expect(page.getByText('Could not load messages for this conversation.')).toBeVisible({
    timeout: 5000
  });
  await expect(
    page.getByText('Your Chief of Staff for briefs, triage, drafts, and approval-gated work.')
  ).toBeHidden();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('Recovered history is visible now.')).toBeVisible();
});

test('Reborn composer accepts attachments and posts them with the message', async ({ page }) => {
  await mockCompletedOnboarding(page);
  await mockGateway(page, { threads: [] });
  await mockGatewaySurfaces(page);

  let postedBody: Record<string, unknown> | null = null;
  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/([^/]+)/messages$`),
    async (route) => {
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ run_id: 'attachment-run', thread_id: 'attachment-thread' })
      });
    }
  );

  await page.goto('/chat');
  await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({ timeout: 10_000 });

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# notes')
  });
  await expect(page.getByText('notes.md')).toBeVisible();

  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Attached notes.md')).toBeVisible({ timeout: 4000 });
  await expect
    .poll(() => postedBody)
    .toMatchObject({
      content: 'Attached notes.md',
      attachments: [{ name: 'notes.md', mime_type: 'text/markdown', data_base64: 'IyBub3Rlcw==' }]
    });
});

test('Reborn composer accepts dropped files and posts them with the message', async ({ page }) => {
  await mockCompletedOnboarding(page);
  await mockGateway(page, { threads: [] });
  await mockGatewaySurfaces(page);

  let postedBody: Record<string, unknown> | null = null;
  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/([^/]+)/messages$`),
    async (route) => {
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ run_id: 'dropped-attachment-run', thread_id: 'drop-thread' })
      });
    }
  );

  await page.goto('/chat');
  await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({ timeout: 10_000 });

  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['dragged notes'], 'dragged.md', { type: 'text/markdown' }));
    return dt;
  });
  const composer = page.getByRole('group', { name: 'Message composer' });
  await composer.dispatchEvent('dragenter', { dataTransfer });
  await expect(page.getByText('Drop files here')).toBeVisible();
  await composer.dispatchEvent('drop', { dataTransfer });
  await expect(page.getByText('dragged.md')).toBeVisible();

  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Attached dragged.md')).toBeVisible({ timeout: 4000 });
  await expect
    .poll(() => postedBody)
    .toMatchObject({
      content: 'Attached dragged.md',
      attachments: [
        { name: 'dragged.md', mime_type: 'text/markdown', data_base64: 'ZHJhZ2dlZCBub3Rlcw==' }
      ]
    });
});

test('failed Reborn run surfaces model denial instead of silently dropping the reply', async ({
  page
}) => {
  await mockCompletedOnboarding(page);
  await mockGateway(page, { threads: [] });
  await mockGatewaySurfaces(page);

  let postedBody: Record<string, unknown> | null = null;
  let messageRequests = 0;
  let messageResponses = 0;
  let eventRequests = 0;
  let timelineRequests = 0;
  let runStateRequests = 0;
  let messageThreadId = '';
  const eventThreadIds: string[] = [];
  const timelineThreadIds: string[] = [];
  const timelineRunIds: string[] = [];
  const runStateThreadIds: string[] = [];
  const runStateRunIds: string[] = [];
  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/([^/]+)/messages$`),
    async (route) => {
      messageRequests += 1;
      const url = new URL(route.request().url());
      const threadId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
      messageThreadId = threadId;
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          outcome: 'submitted',
          accepted_message_ref: 'msg:policy-denied-user',
          turn_id: 'turn-policy-denied',
          run_id: 'policy-denied-run',
          thread_id: threadId,
          status: 'Queued'
        })
      });
      messageResponses += 1;
    }
  );
  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/([^/]+)/runs/([^/?#]+)$`),
    async (route) => {
      runStateRequests += 1;
      const url = new URL(route.request().url());
      const threadId = decodeURIComponent(url.pathname.split('/').at(-3) ?? '');
      const runId = decodeURIComponent(url.pathname.split('/').at(-1) ?? 'policy-denied-run');
      runStateThreadIds.push(threadId);
      runStateRunIds.push(runId);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          run_id: runId,
          status: 'Failed',
          failure: { category: 'policy_denied' }
        })
      });
    }
  );
  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/([^/]+)/events(?:\\?.*)?$`),
    async (route) => {
      eventRequests += 1;
      const url = new URL(route.request().url());
      const threadId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
      eventThreadIds.push(threadId);
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        },
        body: `event: accepted\ndata: ${JSON.stringify({
          type: 'accepted',
          ack: { run_id: 'policy-denied-run', thread_id: threadId, status: 'accepted' }
        })}\n\nevent: keep_alive\ndata: ${JSON.stringify({ type: 'keep_alive' })}\n\n`
      });
    }
  );
  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/([^/]+)/timeline(?:\\?.*)?$`),
    async (route) => {
      timelineRequests += 1;
      const url = new URL(route.request().url());
      const threadId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
      timelineThreadIds.push(threadId);
      if (postedBody) timelineRunIds.push('policy-denied-run');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: postedBody
            ? [
                {
                  thread_id: threadId,
                  turn_id: 'turn-policy-denied',
                  kind: 'user',
                  message_id: 'policy-denied-user',
                  status: 'submitted',
                  content: postedBody.content,
                  sequence: 1,
                  turn_run_id: 'policy-denied-run',
                  created_at: '2026-06-02T05:41:54.000Z'
                }
              ]
            : [],
          next_cursor: null,
          has_more: false
        })
      });
    }
  );

  await page.goto('/chat');
  await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({ timeout: 10_000 });

  await page.getByPlaceholder('Message IronClaw…').fill('hello live assistant check');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('hello live assistant check')).toBeVisible({ timeout: 4000 });
  await expect.poll(() => messageRequests).toBeGreaterThan(0);
  await expect.poll(() => messageResponses).toBeGreaterThan(0);
  await expect.poll(() => eventRequests).toBeGreaterThan(0);
  await expect.poll(() => timelineRequests).toBeGreaterThan(0);
  await expect.poll(() => runStateRequests).toBeGreaterThan(0);
  expect(eventThreadIds).toContain(messageThreadId);
  expect(timelineThreadIds).toContain(messageThreadId);
  expect(timelineRunIds).toContain('policy-denied-run');
  expect(runStateThreadIds).toContain(messageThreadId);
  expect(runStateRunIds).toContain('policy-denied-run');
  await expect(
    page.getByText(
      'The selected model is not available for this account or provider plan. Choose a model this account can run, or update provider credentials.'
    )
  ).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('Mocked reply')).toHaveCount(0);
  await expect(
    page.getByText('IronClaw accepted this turn, but no assistant result arrived')
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(page.getByPlaceholder('Message IronClaw…')).toBeEnabled();
  await page.getByPlaceholder('Message IronClaw…').fill('next check');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Copy Assistant response/i })).toHaveCount(0);
});

test('draft-from-attachment stays in chat and posts the original ask', async ({ page }) => {
  await mockCompletedOnboarding(page);
  await mockGateway(page, {
    threads: [],
    mockedReply: 'Here is a clean draft services agreement.'
  });
  await mockGatewaySurfaces(page);

  let postedBody: Record<string, unknown> | null = null;
  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/([^/]+)/messages$`),
    async (route) => {
      const url = new URL(route.request().url());
      const threadId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ run_id: 'draft-attachment-run', thread_id: threadId })
      });
    }
  );

  await page.goto('/chat');
  await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({ timeout: 10_000 });

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'services.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('Vendor will provide implementation services.')
  });
  await expect(page.getByText('services.md')).toBeVisible();

  const composer = page.getByPlaceholder('Message IronClaw…');
  await composer.fill('draft me a services agreement based on this');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('draft me a services agreement based on this')).toBeVisible({
    timeout: 4000
  });
  await expect(page.getByTestId('local-approval-gate')).toHaveCount(0);
  await expect(page).toHaveURL(/\/chat/);
  await expect
    .poll(() => postedBody)
    .toMatchObject({
      content: 'draft me a services agreement based on this',
      attachments: [
        {
          name: 'services.md',
          mime_type: 'text/markdown',
          data_base64: 'VmVuZG9yIHdpbGwgcHJvdmlkZSBpbXBsZW1lbnRhdGlvbiBzZXJ2aWNlcy4='
        }
      ]
    });
  expect(JSON.stringify(postedBody)).not.toContain('Work item:');
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('ironclaw-work-items');
        return raw ? JSON.parse(raw) : [];
      })
    )
    .toEqual([]);
});

test('legacy attachment send auto-approves the uploaded-file read gate and continues streaming', async ({
  page
}) => {
  await mockCompletedOnboarding(page);
  await mockGateway(page, {
    threads: [],
    mockedReply: 'Draft services agreement generated from the uploaded PDF.',
    webChatV2Available: false
  });
  await mockGatewaySurfaces(page);

  let approvalBody: Record<string, unknown> | null = null;
  await page.route(new RegExp(`^https?://${GATEWAY_HOSTS}/api/chat/approval$`), async (route) => {
    approvalBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ message_id: 'approval-message', status: 'accepted' })
    });
  });

  await page.route(
    new RegExp(`^https?://${GATEWAY_HOSTS}/api/chat/events(?:\\?.*)?$`),
    async (route) => {
      const frames = [
        `event: approval_needed\ndata: ${JSON.stringify({
          type: 'approval_needed',
          request_id: '11111111-2222-3333-4444-555555555555',
          thread_id: 'legacy-thread',
          tool_name: 'read_file',
          description: "Tool 'read_file' requires approval",
          parameters: '{}',
          allow_always: true
        })}\n\n`,
        `event: response\ndata: ${JSON.stringify({
          type: 'response',
          content: 'Draft services agreement generated from the uploaded PDF.'
        })}\n\n`,
        `event: message\ndata: ${JSON.stringify({
          type: 'message_end',
          finish_reason: 'stop'
        })}\n\n`
      ];
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        },
        body: frames.join('')
      });
    }
  );

  await page.goto('/chat');
  await refreshMockedGatewayConnection(page);
  await expect(page.getByPlaceholder('Message IronClaw…')).toBeEnabled({ timeout: 10_000 });

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Attach file/ }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'services-template.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% uploaded service agreement template\n%%EOF')
  });
  await expect(page.getByText('services-template.pdf')).toBeVisible();

  const prompt =
    'Using the attached services agreement PDF as the template, generate a new services agreement for Atlas Harbor Analytics and Northstar Forge Labs.';
  await page.getByPlaceholder('Message IronClaw…').fill(prompt);
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText(prompt)).toBeVisible({ timeout: 4000 });
  await expect(
    page.getByText('Draft services agreement generated from the uploaded PDF.')
  ).toBeVisible({
    timeout: 4000
  });
  await expect
    .poll(() => approvalBody)
    .toEqual({
      thread_id: 'legacy-thread',
      request_id: '11111111-2222-3333-4444-555555555555',
      action: 'approve'
    });
});

const draftTemplateScenarios = [
  {
    label: 'PDF services agreement template',
    fileName: 'services-template.pdf',
    mimeType: 'application/pdf',
    bytes: Buffer.from(
      [
        '%PDF-1.4',
        '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
        '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
        '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj',
        '4 0 obj << /Length 71 >> stream',
        'BT /F1 12 Tf 72 720 Td (Services Agreement Template: update parties, fees, term.) Tj ET',
        'endstream endobj',
        'xref',
        '0 5',
        '0000000000 65535 f ',
        'trailer << /Root 1 0 R >>',
        '%%EOF'
      ].join('\n')
    ),
    prompt:
      'Draft a services agreement using the attached PDF template. Update client to Beacon Robotics, fees to $25k, and term to 90 days. Do not send or file it.'
  },
  {
    label: 'DOCX SOW template',
    fileName: 'sow-template.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: Buffer.from('PK\u0003\u0004minimal docx template bytes'),
    prompt:
      "Draft an SOW using the attached Word template. Update scope to onboarding analytics, add a two-week implementation timeline, and don't email anyone."
  },
  {
    label: 'CSV pricing schedule',
    fileName: 'pricing.csv',
    mimeType: 'text/csv',
    bytes: Buffer.from('item,price\nimplementation,25000\nsupport,3000\n'),
    prompt:
      'Use the attached pricing schedule to draft an order form. Update quantities to 5 seats and keep it as a draft only.'
  },
  {
    label: 'JSON client requirements',
    fileName: 'client-requirements.json',
    mimeType: 'application/json',
    bytes: Buffer.from(
      JSON.stringify({
        client: 'Northwind',
        data: 'telemetry',
        hosting: 'single tenant',
        term_days: 90
      })
    ),
    prompt:
      'Draft a DPA using the attached JSON requirements. Update the security section for single-tenant hosting with no external writes.'
  },
  {
    label: 'XLSX renewal calculator',
    fileName: 'renewal-calculator.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: Buffer.from('PK\u0003\u0004minimal xlsx workbook bytes'),
    prompt:
      'Use the attached renewal calculator workbook to draft a contract renewal amendment. Update seats to 12, discount to 15%, and keep it in chat only.'
  },
  {
    label: 'Markdown MSA template',
    fileName: 'msa-template.md',
    mimeType: 'text/markdown',
    bytes: Buffer.from('# MSA Template\n\nTerm: TBD\nFees: TBD\nLiability: TBD\n'),
    prompt:
      'Use the attached Markdown MSA template. Update term to 12 months, fees to annual prepaid, and liability cap to fees paid in the prior 12 months.'
  }
] as const;

for (const scenario of draftTemplateScenarios) {
  test(`draft-from-template attachment stays in chat: ${scenario.label}`, async ({ page }) => {
    await mockCompletedOnboarding(page);
    await mockGateway(page, {
      threads: [],
      mockedReply: `Draft created from ${scenario.fileName}.`
    });
    await mockGatewaySurfaces(page);

    let postedBody: Record<string, unknown> | null = null;
    await page.route(
      new RegExp(`^https?://${GATEWAY_HOSTS}/api/webchat/v2/threads/([^/]+)/messages$`),
      async (route) => {
        const url = new URL(route.request().url());
        const threadId = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
        postedBody = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ run_id: `draft-${scenario.fileName}`, thread_id: threadId })
        });
      }
    );

    await page.goto('/chat');
    await expect(page.getByTestId('reborn-chat-panel')).toBeVisible({ timeout: 10_000 });

    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Attach files' }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: scenario.fileName,
      mimeType: scenario.mimeType,
      buffer: scenario.bytes
    });
    await expect(page.getByText(scenario.fileName)).toBeVisible();

    const composer = page.getByPlaceholder('Message IronClaw…');
    await composer.fill(scenario.prompt);
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText(scenario.prompt)).toBeVisible({ timeout: 4000 });
    await expect(page.getByTestId('local-approval-gate')).toHaveCount(0);
    await expect
      .poll(() => postedBody)
      .toMatchObject({
        content: scenario.prompt,
        attachments: [
          {
            name: scenario.fileName,
            mime_type: scenario.mimeType,
            data_base64: scenario.bytes.toString('base64')
          }
        ]
      });
    expect(JSON.stringify(postedBody)).not.toContain('Work item:');
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem('ironclaw-work-items');
          return raw ? JSON.parse(raw) : [];
        })
      )
      .toEqual([]);
  });
}
