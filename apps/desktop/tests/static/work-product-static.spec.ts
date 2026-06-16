import { expect, test, type Page, type Route } from '@playwright/test';

const gatewayStatus = {
  engine_v2_enabled: true,
  restart_enabled: false,
  total_connections: 0,
  llm_backend: 'nearai',
  llm_model: 'auto',
  model_execution_verified: true,
  model_readiness: 'ready',
  model_execution_readiness: 'ready'
};

const llmProviders = {
  providers: [
    {
      id: 'nearai',
      name: 'NEAR AI Cloud',
      description: 'Model access through NEAR AI Cloud.',
      adapter: 'nearai',
      default_model: 'auto',
      builtin: true,
      api_key_required: false,
      accepts_api_key: true,
      base_url_required: false,
      api_key_set: true
    }
  ],
  active: {
    provider_id: 'nearai',
    model: 'auto'
  }
};

test('static work product: saved chat artifact reloads in Work route', async ({ page }) => {
  await installWorkProductMocks(page);
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'ironclaw-work-items',
      JSON.stringify([
        {
          id: 'work-static-1',
          title: 'Services agreement draft',
          objective: 'Saved work product from chat.',
          domain: 'general',
          runbookIds: ['general'],
          status: 'active',
          created_at: '2026-06-13T15:00:00.000Z',
          updated_at: '2026-06-13T15:00:00.000Z',
          links: [{ kind: 'thread', ref: 'thread-services', label: 'Services thread' }],
          dossier: [],
          approvalBoundaries: [],
          artifacts: [
            {
              id: 'artifact-static-1',
              type: 'document',
              title: 'Services agreement draft',
              status: 'ready',
              provenance: ['thread:thread-services'],
              content:
                '# Services agreement draft\n\nAcme Labs hires Northstar Ops for implementation work.\n\n- Fee: $42,000\n- Payment: Net 30\n- Term: 90 days',
              content_format: 'markdown'
            }
          ],
          watches: [],
          receipts: [],
          openApprovals: [],
          followUps: [],
          nextAction: 'Review saved work product.'
        }
      ])
    );
  });

  await page.goto('/v2/work?item=work-static-1&artifact=artifact-static-1&token=static-work-token');

  await expect(page.locator('article h1').first()).toHaveText('Services agreement draft');
  await expect(page.getByTestId('saved-work-artifact')).toContainText(
    'Acme Labs hires Northstar Ops'
  );
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'DOCX', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'PDF', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open thread' })).toHaveAttribute(
    'href',
    '/v2/chat/thread-services'
  );
});

test('static work product: assistant generated DOCX chip saves to Work and reloads as a file', async ({
  page
}) => {
  await installWorkProductMocks(page);

  await page.goto('/v2/chat/thread-generated-file?token=static-work-token');

  await expect(page.getByTestId('generated-file-artifact-chip')).toContainText(
    'services-agreement.docx'
  );
  await expect(page.getByTestId('generated-file-artifact-chip')).toContainText('Generated file');
  await expect(page.getByRole('button', { name: 'Preview services-agreement.docx' })).toBeVisible();
  await page.getByRole('button', { name: 'Save services-agreement.docx to Work' }).click();

  await expect(page).toHaveURL(/\/v2\/work\?item=work-/);
  await expect(page.getByTestId('saved-work-file-artifact')).toContainText('DOCX file artifact');
  await expect(page.getByTestId('saved-work-file-artifact')).toContainText(
    'services-agreement.docx'
  );
  await expect(page.getByRole('button', { name: 'Save original' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open thread' })).toHaveAttribute(
    'href',
    '/v2/chat/thread-generated-file'
  );
});

test('static work product: sidebar Work entry appears after a save and opens the Work route', async ({
  page
}) => {
  await installWorkProductMocks(page);
  // workproduct-1: the Work nav slot is hidden until at least one work product
  // exists. Seeding ironclaw-work-items must reveal it and route to /v2/work.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'ironclaw-work-items',
      JSON.stringify([
        {
          id: 'work-nav-1',
          title: 'Sidebar work entry',
          objective: 'Saved work product from chat.',
          status: 'active',
          created_at: '2026-06-13T15:00:00.000Z',
          updated_at: '2026-06-13T15:00:00.000Z',
          links: [],
          artifacts: [
            {
              id: 'artifact-nav-1',
              type: 'document',
              title: 'Sidebar work entry',
              status: 'ready',
              provenance: ['chat'],
              content: '# Sidebar work entry\n\nSeeded so the Work nav slot appears.',
              content_format: 'markdown'
            }
          ]
        }
      ])
    );
  });

  await page.goto('/v2/chat?token=static-work-token');
  await expect(
    page.getByRole('heading', { name: 'What should IronClaw handle next?' })
  ).toBeVisible();

  const workNavLink = page.getByRole('link', { name: 'Work', exact: true });
  await expect(workNavLink).toBeVisible();
  await expect(workNavLink).toHaveAttribute('href', '/v2/work');

  await workNavLink.click();
  await expect(page).toHaveURL(/\/v2\/work(\?|$)/);
  await expect(page.locator('article h1').first()).toHaveText('Sidebar work entry');
});

test('static work product: a stale deep link shows "Saved work not found"', async ({ page }) => {
  await installWorkProductMocks(page);
  // workproduct-4: an item id that resolves to nothing must show the honest
  // not-found state, never silently substitute another saved artifact.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'ironclaw-work-items',
      JSON.stringify([
        {
          id: 'work-real-1',
          title: 'A real saved item',
          status: 'active',
          created_at: '2026-06-13T15:00:00.000Z',
          updated_at: '2026-06-13T15:00:00.000Z',
          links: [],
          artifacts: [
            {
              id: 'artifact-real-1',
              type: 'document',
              title: 'A real saved item',
              status: 'ready',
              provenance: ['chat'],
              content: '# A real saved item\n\nShould not be substituted for a bad deep link.',
              content_format: 'markdown'
            }
          ]
        }
      ])
    );
  });

  await page.goto('/v2/work?item=does-not-exist&artifact=also-missing&token=static-work-token');

  await expect(page.getByRole('heading', { name: 'Saved work not found' })).toBeVisible();
  await expect(
    page.getByText('That saved artifact is no longer in this desktop profile.')
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to chat' })).toBeVisible();
  // The honest not-found state never leaks the unrelated saved artifact.
  await expect(page.getByText('A real saved item')).toHaveCount(0);
});

test('static work product: reader badge attributes generated agent work in gold, not success-green', async ({
  page
}) => {
  await installWorkProductMocks(page);
  // Color meaning (DESIGN.md): gold is the agent's hand (generated work);
  // success-green is a status this reader cannot prove. The header badge must
  // resolve to the gold token and read "Generated artifact", matching the chat
  // "Generated document" chip and the gold file-artifact preview on this page.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'ironclaw-work-items',
      JSON.stringify([
        {
          id: 'work-badge-1',
          title: 'Gold badge item',
          status: 'active',
          created_at: '2026-06-13T15:00:00.000Z',
          updated_at: '2026-06-13T15:00:00.000Z',
          links: [],
          artifacts: [
            {
              id: 'artifact-badge-1',
              type: 'document',
              title: 'Gold badge item',
              status: 'ready',
              provenance: ['chat'],
              content: '# Gold badge item\n\nBody.',
              content_format: 'markdown'
            }
          ]
        }
      ])
    );
  });

  await page.goto('/v2/work?item=work-badge-1&artifact=artifact-badge-1&token=static-work-token');

  const badge = page.getByText('Generated artifact', { exact: true });
  await expect(badge).toBeVisible();
  // No success/readiness language survives in the reader badge.
  await expect(page.getByText('Ready artifact')).toHaveCount(0);

  // The badge text color resolves to the gold token, never the success token.
  const colors = await badge.evaluate((el) => {
    const cs = getComputedStyle(el);
    const root = getComputedStyle(document.documentElement);
    return {
      badge: cs.color,
      gold: root.getPropertyValue('--v2-gold-text').trim(),
      success: root.getPropertyValue('--v2-success-text').trim()
    };
  });
  const norm = (value: string) => value.replace(/\s+/g, '').toLowerCase();
  expect(norm(colors.badge)).toBe(norm(toRgb(colors.gold)));
  expect(norm(colors.badge)).not.toBe(norm(toRgb(colors.success)));
});

test('static work product at 390px: reader has no horizontal overflow and 44px tap targets', async ({
  page
}) => {
  await installWorkProductMocks(page);
  // Mobile-first law: at 390px the reader pane and the saved-work list must stay
  // inside the viewport (the single-column grid tracks were unconstrained `auto`
  // and blew past the container by ~85px), and the export/thread controls must
  // clear the 44px tap-target floor enforced across the shell/palette/connectors.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'ironclaw-work-items',
      JSON.stringify([
        {
          id: 'work-mobile-1',
          title:
            'Services agreement draft for Northstar Ops engagement with a deliberately long title',
          objective:
            'Saved work product from chat. A long objective line that should wrap, not push the reader pane off the right edge of a 390px viewport.',
          status: 'active',
          created_at: '2026-06-13T15:00:00.000Z',
          updated_at: '2026-06-13T15:00:00.000Z',
          links: [{ kind: 'thread', ref: 'thread-services', label: 'Services thread' }],
          artifacts: [
            {
              id: 'artifact-mobile-1',
              type: 'document',
              title: 'Services agreement draft',
              status: 'ready',
              provenance: ['thread:thread-services'],
              content:
                '# Services agreement draft\n\nAcme Labs hires Northstar Ops.\n\n- Fee: $42,000',
              content_format: 'markdown'
            }
          ]
        }
      ])
    );
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/v2/work?item=work-mobile-1&artifact=artifact-mobile-1&token=static-work-token');
  await expect(page.locator('article h1').first()).toBeVisible();

  // No element runs past the right viewport edge: check the document and the
  // inner scroll container (the page scrolls vertically, so a horizontal blowout
  // hides inside the .overflow-y-auto wrapper rather than the documentElement).
  const docOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(docOverflow, 'no document horizontal overflow at 390px').toBeLessThanOrEqual(1);

  const scrollerOverflow = await page
    .locator('div.overflow-y-auto')
    .first()
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(scrollerOverflow, 'no inner-scroller horizontal overflow at 390px').toBeLessThanOrEqual(1);

  // Export controls + the thread link are real touch targets at 390px (>=44px).
  for (const name of ['Copy', 'Markdown', 'DOCX', 'PDF', 'HTML', 'JSON']) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox();
    expect(box, `${name} should have a measurable box`).not.toBeNull();
    expect(box!.height, `${name} height >=44px at 390px`).toBeGreaterThanOrEqual(44);
  }
  const threadLink = await page.getByRole('link', { name: 'Open thread' }).boundingBox();
  expect(threadLink, 'Open thread should have a measurable box').not.toBeNull();
  expect(threadLink!.height, 'Open thread height >=44px at 390px').toBeGreaterThanOrEqual(44);
});

function toRgb(value: string): string {
  const hex = value.trim();
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex; // already rgb()/rgba() or a token we compare verbatim
  const int = parseInt(match[1], 16);
  return `rgb(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255})`;
}

async function installWorkProductMocks(page: Page) {
  await page.route(/\/(api|auth)\//, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === '/api/gateway/status') {
      return json(route, gatewayStatus);
    }
    if (path === '/api/webchat/v2/llm/providers') {
      return json(route, llmProviders);
    }
    if (path === '/api/webchat/v2/threads' && method === 'GET') {
      return json(route, {
        threads: [
          {
            id: 'thread-services',
            thread_id: 'thread-services',
            title: 'Services thread',
            updated_at: '2026-06-13T15:00:00.000Z'
          },
          {
            id: 'thread-generated-file',
            thread_id: 'thread-generated-file',
            title: 'Generated DOCX thread',
            updated_at: '2026-06-13T16:00:00.000Z'
          }
        ],
        next_cursor: null
      });
    }
    if (path === '/api/webchat/v2/threads/thread-generated-file/timeline') {
      return json(route, {
        messages: [
          {
            kind: 'assistant',
            message_id: 'msg-generated-docx',
            content: 'Draft complete. Review the generated Word file.',
            sequence: 1,
            turn_run_id: 'run-generated-docx',
            created_at: '2026-06-13T16:00:00.000Z',
            artifacts: [
              {
                title: 'Services agreement',
                filename: 'services-agreement.docx',
                mime_type:
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                data_base64: 'UEsDBGRvY3g=',
                size: 8
              }
            ]
          }
        ],
        summary_artifacts: [],
        next_cursor: null
      });
    }
    if (path === '/api/webchat/v2/threads/thread-generated-file/events') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: ': connected\n\n'
      });
    }
    if (path === '/auth/providers') {
      return json(route, { providers: [] });
    }

    return json(route, { ok: true });
  });
}

async function json(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body)
  });
}
