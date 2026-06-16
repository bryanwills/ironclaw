import { expect, test, type Page } from '@playwright/test';
import http from 'node:http';
import type { Socket } from 'node:net';

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

const onePixelPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lBy1XwAAAABJRU5ErkJggg==';

for (const scenario of [
  {
    label: 'file picker',
    filename: 'picked-services-brief.txt',
    text: 'Picked services agreement terms: Acme Labs hires Northstar Ops for platform work.',
    attach: async (page: Page, file: AttachmentFixture) => {
      await page.locator('input[type="file"]').setInputFiles({
        name: file.filename,
        mimeType: 'text/plain',
        buffer: Buffer.from(file.text, 'utf8')
      });
    }
  },
  {
    label: 'clipboard paste',
    filename: 'pasted-services-brief.txt',
    text: 'Pasted services agreement terms: Helio DAO pays Aurora Strategy monthly.',
    attach: async (page: Page, file: AttachmentFixture) => {
      await page
        .locator('textarea')
        .first()
        .evaluate(
          (textarea, file) => {
            const data = new DataTransfer();
            data.items.add(new File([file.text], file.filename, { type: 'text/plain' }));
            const event = new Event('paste', { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'clipboardData', { value: data });
            textarea.dispatchEvent(event);
          },
          { filename: file.filename, text: file.text }
        );
    }
  },
  {
    label: 'drag and drop',
    filename: 'dropped-services-brief.txt',
    text: 'Dropped services agreement terms: Meridian Studio owes Atlas Cloud a fixed fee.',
    attach: async (page: Page, file: AttachmentFixture) => {
      await page.getByTestId('chat-composer').evaluate(
        (composer, file) => {
          const data = new DataTransfer();
          data.items.add(new File([file.text], file.filename, { type: 'text/plain' }));
          const event = new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: data
          });
          composer.dispatchEvent(event);
        },
        { filename: file.filename, text: file.text }
      );
    }
  }
]) {
  test(`static attachments: ${scenario.label} reaches Reborn send payload`, async ({ page }) => {
    const gateway = await startAttachmentGateway();
    try {
      await installAttachmentTauriShim(page, gateway.origin, gateway.port);
      await page.goto('/v2/chat/thread-attachments');
      await page.locator('textarea').first().waitFor({ timeout: 20_000 });

      const prompt = `Draft the services agreement from ${scenario.label}.`;
      await page.locator('textarea').first().fill(prompt);
      await scenario.attach(page, scenario);

      await expect(page.getByText(scenario.filename, { exact: true })).toBeVisible();
      await expect(page.getByText('Model can read this file')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
      await page.getByRole('button', { name: 'Send message' }).click();

      await expect.poll(() => gateway.state.messageRequests.length, { timeout: 20_000 }).toBe(1);
      const request = gateway.state.messageRequests[0];

      expect(request.authorization).toBe('Bearer attachment-static-token');
      expect(request.content).toContain(prompt);
      expect(request.content).toContain('<attachments ic="1">');
      expect(request.content).toContain(`filename: ${scenario.filename}`);
      expect(request.content).toContain('extraction_status: extracted_text');
      // The document reaches the model through the inlined durable text above —
      // its only channel. The wire carries NO bytes: the Reborn byte-landing
      // path (#4644) 500s on any data_base64 under the DevOnly composition, so
      // shipping bytes would fail the whole turn. See attachmentsForWire.
      expect(request.content).toContain(scenario.text);
      expect(request.attachments).toHaveLength(0);
    } finally {
      await gateway.close();
    }
  });
}

test('static attachments: image upload renders thumbnail above sent user bubble', async ({
  page
}) => {
  const gateway = await startAttachmentGateway();
  try {
    await installAttachmentTauriShim(page, gateway.origin, gateway.port);
    await page.goto('/v2/chat/thread-attachments');
    await page.locator('textarea').first().waitFor({ timeout: 20_000 });

    const prompt = 'Use this uploaded image as evidence in the draft.';
    await page.locator('textarea').first().fill(prompt);
    await page.locator('input[type="file"]').setInputFiles({
      name: 'signature-proof.png',
      mimeType: 'image/png',
      buffer: Buffer.from(onePixelPngBase64, 'base64')
    });

    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await page.getByRole('button', { name: 'Send message' }).click();

    await expect(page.getByText(prompt, { exact: true })).toBeVisible();
    const thumbnailStrip = page.getByTestId('message-image-thumbnails').first();
    await expect(thumbnailStrip).toBeVisible();
    await expect(thumbnailStrip.locator('img').first()).toHaveAttribute(
      'src',
      /^data:image\/png;base64,/
    );

    await expect.poll(() => gateway.state.messageRequests.length, { timeout: 20_000 }).toBe(1);
    const request = gateway.state.messageRequests[0];

    expect(request.content).toContain('filename: signature-proof.png');
    expect(request.content).not.toContain('data_base64');
    // Image bytes are not shipped either: the same landing path 500s on them.
    // The thumbnail above renders from the local dataUrl, not the wire.
    expect(request.attachments).toHaveLength(0);
  } finally {
    await gateway.close();
  }
});

test('static attachments: preview lightbox honors the modal keyboard contract', async ({
  page
}) => {
  // The attachment preview uses the shared design-system Modal. That primitive
  // now owns the full dialog keyboard contract centrally, so every Modal consumer
  // inherits it: focus moves in on open, Tab/Shift-Tab stay trapped behind the
  // backdrop, Esc closes from a non-input control, and focus returns to the chip
  // that opened it. This is the rendered proof for the modal.js fix.
  const gateway = await startAttachmentGateway();
  try {
    await installAttachmentTauriShim(page, gateway.origin, gateway.port);
    await page.goto('/v2/chat/thread-attachments');
    await page.locator('textarea').first().waitFor({ timeout: 20_000 });
    // Type a prompt so Send enables on text (matches the other scenarios) rather
    // than depending on attachment-extraction timing, which flakes under load.
    await page.locator('textarea').first().fill('Preview the attached contract.');

    const filename = 'preview-contract.txt';
    await page.locator('input[type="file"]').setInputFiles({
      name: filename,
      mimeType: 'text/plain',
      buffer: Buffer.from('Preview contract body for the keyboard a11y proof.', 'utf8')
    });

    // Send so the attachment lands as a sent-message chip — the Preview opener
    // only exists on sent attachments, not the composer draft (matches the
    // smoke + the other attachment scenarios in this file). Generous timeout:
    // upload + on-device extraction is CPU-heavy and slows under full-suite load.
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled({
      timeout: 20_000
    });
    await page.getByRole('button', { name: 'Send message' }).click();

    // Wait on the preview opener (its aria-label is the robust anchor — the
    // filename text alone can wrap).
    const opener = page.getByRole('button', { name: new RegExp(`^Preview ${filename}`) });
    await expect(opener).toBeVisible({ timeout: 20_000 });
    await opener.focus();
    await opener.press('Enter');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: filename })).toBeVisible();

    // Focus moved into the dialog on open (not stranded on the chip behind it).
    await expect
      .poll(() =>
        page.evaluate(() => {
          const d = document.querySelector('[role="dialog"]');
          return !!d && d.contains(document.activeElement);
        })
      )
      .toBe(true);

    // Tab cycles within the dialog; it never falls behind the modal.
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return !!d && d.contains(document.activeElement);
      });
      expect(inside, `focus stays inside the preview after ${i + 1} tab(s)`).toBe(true);
    }

    // Esc closes from the dialog's close button (a non-input control).
    await dialog.getByRole('button', { name: 'Close' }).focus();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Focus returns to the chip that opened the preview.
    await expect(opener).toBeFocused();
  } finally {
    await gateway.close();
  }
});

type AttachmentFixture = {
  filename: string;
  text: string;
};

type CapturedMessage = {
  authorization: string;
  content: string;
  attachments: Array<{ filename: string; mime_type: string; base64: string }>;
};

async function startAttachmentGateway() {
  const clients = new Set<http.ServerResponse>();
  const sockets = new Set<Socket>();
  const state: {
    messageRequests: CapturedMessage[];
  } = {
    messageRequests: []
  };
  let origin = '';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', origin || 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      send(res, 204, '');
      return;
    }
    if (url.pathname === '/api/gateway/status') {
      sendJson(res, 200, gatewayStatus);
      return;
    }
    if (url.pathname === '/api/webchat/v2/llm/providers') {
      sendJson(res, 200, llmProviders);
      return;
    }
    if (url.pathname === '/api/webchat/v2/llm/list-models' && req.method === 'POST') {
      sendJson(res, 200, { ok: true, models: ['auto', 'z-ai/glm-4.5', 'gpt-oss-120b'] });
      return;
    }
    if (url.pathname === '/api/webchat/v2/threads' && req.method === 'GET') {
      sendJson(res, 200, {
        threads: [
          {
            thread_id: 'thread-attachments',
            id: 'thread-attachments',
            title: 'Attachment proof thread'
          }
        ],
        next_cursor: null
      });
      return;
    }
    if (url.pathname === '/api/webchat/v2/threads/thread-attachments/timeline') {
      sendJson(res, 200, { messages: [], summary_artifacts: [], next_cursor: null });
      return;
    }
    if (url.pathname === '/api/webchat/v2/channels/connectable') {
      sendJson(res, 200, { channels: [] });
      return;
    }
    if (url.pathname === '/auth/providers') {
      sendJson(res, 200, { providers: [] });
      return;
    }
    if (url.pathname === '/api/webchat/v2/threads/thread-attachments/events') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization,content-type,accept',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream'
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (
      url.pathname === '/api/webchat/v2/threads/thread-attachments/messages' &&
      req.method === 'POST'
    ) {
      const body = (await readJson(req)) as {
        content?: string;
        attachments?: CapturedMessage['attachments'];
      };
      state.messageRequests.push({
        authorization: String(req.headers.authorization || ''),
        content: String(body?.content || ''),
        attachments: body?.attachments || []
      });
      sendJson(res, 200, {
        thread_id: 'thread-attachments',
        run_id: 'run-attachments',
        status: 'queued',
        accepted_message_ref: { id: 'msg-attachments' }
      });
      return;
    }

    sendJson(res, 404, { error: `unhandled ${req.method} ${url.pathname}` });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    port,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) client.end();
        for (const socket of sockets) socket.destroy();
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        server.close(finish);
        setTimeout(finish, 1_000).unref?.();
      })
  };
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {}
) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization,content-type,accept',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  send(res, status, JSON.stringify(body), {
    'Content-Type': 'application/json; charset=utf-8'
  });
}

async function readJson(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

async function installAttachmentTauriShim(page: Page, gatewayOrigin: string, gatewayPort: number) {
  await page.addInitScript(
    ({ gatewayOrigin, gatewayPort }) => {
      const state = {
        nextRid: 1,
        requests: new Map(),
        bodies: new Map()
      };

      window.localStorage.setItem('ironclaw:desktop-gateway-origin', gatewayOrigin);

      function pick(obj: Record<string, unknown> | null | undefined, key: string) {
        return obj && typeof obj === 'object' && key in obj ? obj[key] : undefined;
      }

      async function dispatch(command: string, args: Record<string, unknown> = {}) {
        switch (command) {
          case 'get_settings':
            return {
              activeProfileId: 'default',
              profiles: [
                {
                  id: 'default',
                  name: 'Default',
                  mode: 'local',
                  localBaseUrl: gatewayOrigin,
                  remoteBaseUrl: gatewayOrigin,
                  llmBackend: 'nearai',
                  llmProviderId: 'nearai',
                  llmModelId: 'auto',
                  apiVersion: 'v2'
                }
              ],
              onboardingComplete: true
            };
          case 'sidecar_status':
            return { running: true, port: gatewayPort };
          case 'get_token':
          case 'get_or_create_local_token':
            return 'attachment-static-token';
          case 'gateway_http_fetch': {
            const request = pick(args, 'request') as {
              url: string;
              method?: string;
              headers?: Iterable<readonly [string, string]>;
              data?: ArrayLike<number>;
            };
            const response = await window.fetch(request.url, {
              method: request.method || 'GET',
              headers: request.headers ? Object.fromEntries(request.headers) : undefined,
              body: request.data ? new Uint8Array(request.data) : undefined
            });
            return {
              status: response.status,
              status_text: response.statusText,
              url: response.url,
              headers: Array.from(response.headers.entries()),
              data: Array.from(new Uint8Array(await response.arrayBuffer()))
            };
          }
          case 'plugin:http|fetch': {
            const config = pick(args, 'clientConfig') as {
              url: string;
              method?: string;
              headers?: Iterable<readonly [string, string]>;
              data?: ArrayLike<number>;
            };
            const rid = state.nextRid++;
            state.requests.set(
              rid,
              window.fetch(config.url, {
                method: config.method || 'GET',
                headers: config.headers ? Object.fromEntries(config.headers) : undefined,
                body: config.data ? new Uint8Array(config.data) : undefined
              })
            );
            return rid;
          }
          case 'plugin:http|fetch_send': {
            const request = state.requests.get(pick(args, 'rid'));
            const response = await request;
            const responseRid = state.nextRid++;
            state.bodies.set(responseRid, response.body?.getReader() || null);
            return {
              status: response.status,
              statusText: response.statusText,
              url: response.url,
              headers: Array.from(response.headers.entries()),
              rid: responseRid
            };
          }
          case 'plugin:http|fetch_read_body': {
            const reader = state.bodies.get(pick(args, 'rid'));
            if (!reader) return [1];
            const { done, value } = await reader.read();
            if (done) return [1];
            const chunk = new Uint8Array(value.length + 1);
            chunk.set(value, 0);
            chunk[chunk.length - 1] = 0;
            return Array.from(chunk);
          }
          case 'plugin:http|fetch_cancel':
          case 'plugin:http|fetch_cancel_body':
            return null;
          default:
            throw new Error(`unhandled invoke ${command}`);
        }
      }

      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: (command: string, args: Record<string, unknown>) => dispatch(command, args),
        transformCallback: () => 0,
        metadata: { currentWindow: { label: 'main' }, windows: [] }
      };
    },
    { gatewayOrigin, gatewayPort }
  );
}
