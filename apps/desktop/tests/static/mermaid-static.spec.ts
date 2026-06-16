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

const mermaidReply = [
  'Here is the flow:',
  '',
  '```mermaid',
  'graph TD',
  '  A[Review request] --> B{Needs approval?}',
  '  B -->|Yes| C[Ask user]',
  '  B -->|No| D[Ship receipt]',
  '```',
  '',
  'And the helper:',
  '',
  '```js',
  'function ship(receipt) {',
  '  return receipt.approved;',
  '}',
  '```'
].join('\n');

test('static mermaid renderer is lazy, on-click, and renders sanitized SVG', async ({ page }) => {
  await installMermaidApiMocks(page);

  await page.goto('http://127.0.0.1:1420/v2/chat/thread-mermaid?token=static-mermaid-token');
  await expect(page.getByText('Here is the flow:')).toBeVisible();

  await expect(page.locator('script[src$="vendor/mermaid.min.js"]')).toHaveCount(0);
  await expect(page.locator('[data-md-renderer="mermaid"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Render diagram' })).toBeVisible();

  await page.getByRole('button', { name: 'Render diagram' }).click();

  await expect(page.locator('script[src$="vendor/mermaid.min.js"]')).toHaveCount(1);
  await expect(page.locator('.v2-mermaid-card__output svg')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.v2-mermaid-card__output script')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rendered' })).toBeDisabled();
});

test('rendered diagram and code-block toolbar survive a bubble re-render', async ({ page }) => {
  await installMermaidApiMocks(page);

  await page.goto('http://127.0.0.1:1420/v2/chat/thread-mermaid?token=static-mermaid-token');
  await expect(page.getByText('Here is the flow:')).toBeVisible();
  await expect(page.locator('[data-md-renderer="mermaid"]')).toBeVisible();

  // Render the diagram, then confirm the regular code block was enhanced with
  // its hover toolbar (the Copy button lives in the imperatively-built wrap).
  await page.getByRole('button', { name: 'Render diagram' }).click();
  await expect(page.locator('.v2-mermaid-card__output svg')).toBeVisible({ timeout: 15_000 });
  // The code-block toolbar's Copy button is built imperatively inside the
  // markdown body (the mermaid card's button reads "Copy source", not "Copy").
  const codeCopyButton = page.locator('.markdown-body button').filter({ hasText: /^Copy$/ });
  await expect(codeCopyButton).toHaveCount(1);

  // Force React to re-commit the markdown body innerHTML exactly the way it does
  // on a re-render: re-set __html to the pre-enhancement markup, reconstructed
  // from the still-present source <pre>s. This wipes every imperatively-built
  // node (mermaid card + rendered SVG + code toolbars).
  const wiped = await page.evaluate(() => {
    const body = document.querySelector('.markdown-body');
    if (!body) return false;
    const mermaidPre = document.querySelector('.v2-mermaid-card__source pre');
    const codePre = Array.from(body.querySelectorAll('pre')).find(
      (pre) => !pre.closest('.v2-mermaid-card__source')
    );
    if (!mermaidPre || !codePre) return false;
    // Strip enhancement markers so the markup matches what renderMarkdown emits
    // on a fresh React commit (no data-enhanced / data-icHighlighted).
    const clean = (pre: Element) => {
      const copy = pre.cloneNode(true) as HTMLElement;
      copy.removeAttribute('data-enhanced');
      copy.querySelectorAll('code').forEach((code) => {
        code.removeAttribute('data-ic-highlighted');
        code.removeAttribute('style');
        code.className = code.className.replace(/\bhljs\b/g, '').trim();
      });
      return copy.outerHTML;
    };
    body.innerHTML =
      '<p>Here is the flow:</p>' + clean(mermaidPre) + '<p>And the helper:</p>' + clean(codePre);
    return !document.querySelector('[data-md-renderer="mermaid"]');
  });
  expect(wiped).toBe(true);

  // Trigger a real bubble re-render with unchanged message content (Copy flips a
  // sibling useState). The fixed layout effect must run and re-enhance, and the
  // mermaid render cache must restore the rendered SVG without a second click.
  await page.getByRole('button', { name: 'Copy message' }).click();

  await expect(page.locator('[data-md-renderer="mermaid"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.v2-mermaid-card__output svg')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.v2-mermaid-card__output script')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rendered' })).toBeDisabled();
  await expect(codeCopyButton).toHaveCount(1);
});

async function installMermaidApiMocks(page: Page) {
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
    if (path === '/api/webchat/v2/llm/list-models' && method === 'POST') {
      return json(route, { ok: true, models: ['auto', 'z-ai/glm-4.5', 'gpt-oss-120b'] });
    }
    if (path === '/api/webchat/v2/threads' && method === 'GET') {
      return json(route, {
        threads: [
          {
            thread_id: 'thread-mermaid',
            id: 'thread-mermaid',
            title: 'Mermaid proof thread'
          }
        ],
        next_cursor: null
      });
    }
    if (path === '/api/webchat/v2/threads/thread-mermaid/timeline') {
      return json(route, {
        messages: [
          {
            kind: 'assistant',
            message_id: 'msg-assistant-mermaid',
            content: mermaidReply,
            sequence: 1,
            turn_run_id: 'run-mermaid',
            created_at: '2026-06-13T12:00:00.000Z'
          }
        ],
        summary_artifacts: [],
        next_cursor: null
      });
    }
    if (path === '/api/webchat/v2/threads/thread-mermaid/events') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: ': connected\n\n'
      });
    }
    if (path === '/api/webchat/v2/automations' && method === 'GET') {
      return json(route, { automations: [], next_cursor: null });
    }
    if (path === '/api/webchat/v2/extensions/registry') {
      return json(route, { entries: [] });
    }
    if (path === '/api/webchat/v2/extensions') {
      return json(route, { extensions: [] });
    }
    if (path === '/api/webchat/v2/channels/connectable') {
      return json(route, { channels: [] });
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
