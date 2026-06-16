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

test('static activity: completed tool result renders as an agent receipt', async ({ page }) => {
  await installActivityMocks(page);
  await page.goto('/v2/chat/thread-receipt?token=receipt-static-token');

  const receipt = page.getByTestId('activity-receipt-card');
  await expect(receipt).toBeVisible();
  await expect(receipt.getByText('Agent action completed')).toBeVisible();
  await expect(receipt.getByText('Saved services agreement')).toBeVisible();
  await expect(receipt.getByText('Outcome')).toBeVisible();
  await expect(receipt.getByText('DOCX ready to review')).toBeVisible();
  await expect(receipt.getByText('Steps')).toBeVisible();
  await expect(receipt.getByText('1 tool step')).toBeVisible();
  await expect(receipt.getByRole('link', { name: 'Open result' })).toHaveAttribute(
    'href',
    'https://example.com/work/services-agreement.docx'
  );

  await receipt.getByRole('button', { name: 'View action details' }).click();
  await expect(receipt.getByText('ok')).toBeVisible();
});

async function installActivityMocks(page: Page) {
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
      return json(route, { ok: true, models: ['auto', 'z-ai/glm-4.5'] });
    }
    if (path === '/api/webchat/v2/threads' && method === 'GET') {
      return json(route, {
        threads: [
          {
            id: 'thread-receipt',
            thread_id: 'thread-receipt',
            title: 'Receipt proof thread',
            updated_at: '2026-06-13T12:00:00.000Z'
          }
        ],
        next_cursor: null
      });
    }
    if (path === '/api/webchat/v2/threads/thread-receipt/timeline') {
      return json(route, {
        messages: [
          {
            kind: 'capability_display_preview',
            sequence: 1,
            received_at: '2026-06-13T12:00:00.000Z',
            turn_run_id: 'run-receipt',
            content: JSON.stringify({
              invocation_id: 'receipt-1',
              title: 'Saved services agreement',
              capability_id: 'work_product.save',
              status: 'completed',
              subtitle: 'Generated document saved',
              input_summary: 'Draft services agreement from uploaded template',
              output_preview: 'DOCX ready to review',
              output_summary: 'DOCX ready to review',
              output_kind: 'document',
              output_bytes: 52428,
              result_ref: 'https://example.com/work/services-agreement.docx',
              updated_at: '2026-06-13T12:00:00.000Z',
              turn_run_id: 'run-receipt'
            })
          }
        ],
        summary_artifacts: [],
        next_cursor: null
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
