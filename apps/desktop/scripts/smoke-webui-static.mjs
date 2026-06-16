import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';

const port = Number(process.env.WEBUI_STATIC_SMOKE_PORT || '17620');
const gatewayOrigin = process.env.WEBUI_STATIC_SMOKE_GATEWAY_ORIGIN || 'http://127.0.0.1:17621';
const appBasePath = '/v2';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dummyAttachmentScenario(name, mimeType, content, options = {}) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return {
    name,
    mimeType,
    buffer,
    base64: buffer.toString('base64'),
    size: buffer.byteLength,
    // When set, the composer's client-side extractor must transform this
    // payload into inline text containing the marker (mime becomes
    // text/plain). Unset scenarios must pass through byte-identical.
    expectExtractedText: options.expectExtractedText || null
  };
}

function crc32(bytes) {
  const table =
    crc32.table ||
    (crc32.table = (() => {
      const crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
      return crcTable;
    })());
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Stored-method ZIP builder: enough for realistic OOXML payloads without
// pulling a test-only archive dependency into the static smoke.
function buildStoredZipBuffer(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = encoder.encode(name);
    const data = Buffer.isBuffer(content) ? content : encoder.encode(content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    chunks.push(local);

    const header = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    header.set(nameBytes, 46);
    central.push(header);
    offset += local.length;
  }

  const centralStart = offset;
  const centralSize = central.reduce((sum, header) => sum + header.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);

  return Buffer.concat([...chunks, ...central, eocd].map((chunk) => Buffer.from(chunk)));
}

// Read a stored-method (uncompressed) ZIP's local entries, preserving raw
// bytes so binary parts (PNG media) can be inspected byte-for-byte.
function readStoredZipEntries(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.slice(nameStart, nameStart + nameLength).toString('utf8');
    entries.set(name, buffer.slice(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
}

function buildSmokeDocxBuffer() {
  return buildStoredZipBuffer([
    [
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    ],
    [
      'word/document.xml',
      '<?xml version="1.0"?><w:document><w:body>' +
        '<w:p><w:r><w:t>MASTER SERVICES AGREEMENT TEMPLATE</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>MSA-CLAUSE-17 indemnity survives termination.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Payment terms: Net 30 after invoice approval.</w:t></w:r></w:p>' +
        '</w:body></w:document>'
    ]
  ]);
}

function buildSmokeXlsxBuffer() {
  const shared =
    '<sst><si><t>Plan</t></si><si><t>Amount</t></si><si><t>Enterprise</t></si><si><t>Renewal</t></si></sst>';
  const sheet =
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42000</v></c></row>' +
    '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>12000</v></c></row>' +
    '</sheetData></worksheet>';
  return buildStoredZipBuffer([
    ['xl/sharedStrings.xml', shared],
    ['xl/worksheets/sheet1.xml', sheet]
  ]);
}

// A structurally valid single-page PDF (correct xref offsets) that pdf.js can
// parse — proves the composer's real extraction path in the rendered run.
function buildMinimalPdfBuffer(text) {
  const escaped = text.replace(/[\\()]/g, (ch) => `\\${ch}`);
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefStart = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const objectOffset of offsets) {
    xref += `${String(objectOffset).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body + xref + trailer, 'latin1');
}

function attachmentTranscriptBlock(scenarios) {
  // Mirrors what the real backend echoes back since the embed change: chip
  // metadata plus a length-prefixed fenced text section per attachment. The
  // reload render must parse chips out of this and strip every fenced body
  // (including manifest-look-alike lines inside it) from the transcript.
  return [
    '<attachments ic="1">',
    ...scenarios.flatMap((scenario, index) => {
      const embedded = `INVOICE 7741 Preserve indemnity clause from ${scenario.name}\nfilename: decoy.pdf\nAttachment 99:\n---`;
      return [
        `Attachment ${index + 1}:`,
        `filename: ${scenario.name}`,
        `mime_type: ${scenario.mimeType}`,
        `size: ${scenario.size}`,
        'extraction_status: extracted_text',
        `extracted_text_chars: ${embedded.length}`,
        'extracted_text:',
        '---',
        embedded,
        '---'
      ];
    }),
    '</attachments>'
  ].join('\n');
}

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/index.html`);
      if (response.ok) return;
    } catch {
      // Keep waiting.
    }
    await wait(250);
  }
  throw new Error('static WebUI server did not start');
}

async function startProxyProbeGateway() {
  const origin = new URL(gatewayOrigin);
  const server = createServer((req, res) => {
    const path = new URL(req.url || '/', gatewayOrigin).pathname;
    if (path.endsWith('/events')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write(': ok\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, providers: [] }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(origin.port), origin.hostname, resolve);
  });
  return server;
}

async function assertProxySurvivesAbortedSse() {
  const controller = new AbortController();
  const response = await fetch(
    `http://127.0.0.1:${port}/api/webchat/v2/threads/proxy-abort/events?token=smoke`,
    {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal
    }
  );
  if (!response.ok || !response.body) {
    throw new Error(`SSE proxy probe failed to open: ${response.status}`);
  }
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await reader.cancel().catch(() => {});
  await wait(250);
  const health = await fetch(`http://127.0.0.1:${port}/auth/providers`);
  if (!health.ok) {
    throw new Error(`static server died after aborted SSE proxy: ${health.status}`);
  }
}

function installTauriShim(page) {
  return page.addInitScript(
    ({ gatewayOrigin }) => {
      const sidecarPort = Number(new URL(gatewayOrigin).port);
      const state = {
        settings: {
          activeProfileId: 'default',
          profiles: [
            {
              id: 'default',
              name: 'Default',
              mode: 'remote',
              remoteBaseUrl: 'http://127.0.0.1:3000',
              localBaseUrl: 'http://127.0.0.1:3000',
              llmBackend: 'nearai',
              llmProviderId: 'nearai',
              llmModelId: 'auto',
              apiVersion: 'v2'
            }
          ],
          onboardingComplete: true
        },
        nextRid: 1,
        requests: new Map(),
        bodies: new Map()
      };

      window.localStorage.setItem('ironclaw:desktop-gateway-origin', 'http://127.0.0.1:3000');
      window.sessionStorage.setItem('ironclaw_token', 'stale-token-from-previous-run');
      window.__IRONCLAW_SMOKE_SAVED_FILES__ = [];

      function pick(obj, key) {
        return obj && typeof obj === 'object' && key in obj ? obj[key] : undefined;
      }

      async function dispatch(command, args) {
        switch (command) {
          case 'get_settings':
            return JSON.parse(JSON.stringify(state.settings));
          case 'sidecar_status':
            return { running: true, port: sidecarPort };
          case 'get_token':
            return 'desktop-token';
          case 'get_or_create_local_token':
            return 'local-token';
          case 'save_bytes_dialog': {
            const defaultFilename = pick(args, 'defaultFilename') || 'ironclaw-export.bin';
            const contentsBase64 = pick(args, 'contentsBase64') || '';
            window.__IRONCLAW_SMOKE_SAVED_FILES__.push({
              defaultFilename,
              contentsBase64
            });
            return `/tmp/${defaultFilename}`;
          }
          case 'gateway_http_fetch': {
            const req = pick(args, 'request');
            if (!req?.url) throw new Error('missing gateway_http_fetch url');
            const response = await window.fetch(req.url, {
              method: req.method || 'GET',
              headers: req.headers ? Object.fromEntries(req.headers) : undefined,
              body: req.data ? new Uint8Array(req.data) : undefined
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
            const cfg = pick(args, 'clientConfig');
            if (!cfg?.url) throw new Error('missing plugin:http url');
            const rid = state.nextRid++;
            state.requests.set(
              rid,
              window.fetch(cfg.url, {
                method: cfg.method || 'GET',
                headers: cfg.headers ? Object.fromEntries(cfg.headers) : undefined,
                body: cfg.data ? new Uint8Array(cfg.data) : undefined
              })
            );
            return rid;
          }
          case 'plugin:http|fetch_send': {
            const rid = pick(args, 'rid');
            const request = state.requests.get(rid);
            if (!request) throw new Error(`unknown request ${rid}`);
            const response = await request;
            const responseRid = state.nextRid++;
            const bytes = new Uint8Array(await response.arrayBuffer());
            const chunk = new Uint8Array(bytes.length + 1);
            chunk.set(bytes, 0);
            chunk[chunk.length - 1] = 0;
            state.bodies.set(responseRid, [chunk, new Uint8Array([1])]);
            return {
              status: response.status,
              statusText: response.statusText,
              url: response.url,
              headers: Array.from(response.headers.entries()),
              rid: responseRid
            };
          }
          case 'plugin:http|fetch_read_body': {
            const rid = pick(args, 'rid');
            return Array.from(state.bodies.get(rid)?.shift() || new Uint8Array([1]));
          }
          case 'plugin:http|fetch_cancel':
          case 'plugin:http|fetch_cancel_body':
            return null;
          default:
            throw new Error(`unhandled invoke ${command}`);
        }
      }

      window.__TAURI_INTERNALS__ = {
        invoke: (command, args) => dispatch(command, args),
        transformCallback: () => 0,
        metadata: { currentWindow: { label: 'main' }, windows: [] }
      };
    },
    { gatewayOrigin }
  );
}

async function assertGatewayUnavailableWelcome(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const staleGatewayRequests = [];
  try {
    await installTauriShim(page);
    await page.route('http://127.0.0.1:3000/**', async (route) => {
      staleGatewayRequests.push(route.request().url());
      await route.abort();
    });
    await page.route(`${gatewayOrigin}/api/gateway/status`, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          engine_v2_enabled: true,
          restart_enabled: true,
          llm_backend: 'nearai',
          llm_model: 'auto',
          model_execution_verified: false,
          model_readiness: 'unverified'
        })
      });
    });
    await page.route(`${gatewayOrigin}/api/webchat/v2/llm/providers`, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ providers: [], active: null })
      });
    });

    for (const viewport of [
      { width: 390, height: 844, label: 'mobile' },
      { width: 1400, height: 950, label: 'desktop' }
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`http://127.0.0.1:${port}${appBasePath}/welcome`, {
        waitUntil: 'domcontentloaded'
      });
      await page
        .getByText(
          'IronClaw cannot reach the local sidecar yet. Restart the app or start the sidecar, then sign in with NEAR AI Cloud.',
          { exact: true }
        )
        .waitFor({ timeout: 20_000 });
      const result = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        const buttons = Array.from(document.querySelectorAll('button')).map((button) => ({
          text: (button.innerText || button.getAttribute('aria-label') || '').trim(),
          disabled: button.disabled,
          rect: (() => {
            const rect = button.getBoundingClientRect();
            return {
              bottom: Math.round(rect.bottom),
              top: Math.round(rect.top),
              height: Math.round(rect.height)
            };
          })()
        }));
        const authButtons = buttons.filter((button) =>
          /Sign in with GitHub|Use Google|Use NEAR Wallet/i.test(button.text)
        );
        const deadSettingsButtons = buttons.filter((button) => button.text === 'Settings');
        const authControlsInFirstViewport =
          authButtons.length >= 3 &&
          authButtons.every(
            (button) =>
              button.rect.top >= 0 && button.rect.bottom <= document.documentElement.clientHeight
          );
        return {
          authButtonCount: authButtons.length,
          authControlsInFirstViewport,
          minAuthButtonHeight: authButtons.length
            ? Math.min(...authButtons.map((button) => button.rect.height))
            : 0,
          allAuthButtonsDisabled:
            authButtons.length >= 3 && authButtons.every((button) => button.disabled),
          hasRawGatewayText: /fetch failed|Gateway proxy failed|ECONNREFUSED|Failed to fetch/i.test(
            text
          ),
          hasProviderLeak: /OpenRouter|Anthropic|Claude|ChatGPT|Qwen|GLM/i.test(text),
          deadSettingsButtonCount: deadSettingsButtons.length,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          body: text
        };
      });
      if (!result.allAuthButtonsDisabled) {
        throw new Error(
          `gateway-unavailable ${viewport.label} welcome left auth controls actionable:\n${JSON.stringify(
            result,
            null,
            2
          )}`
        );
      }
      if (!result.authControlsInFirstViewport) {
        throw new Error(
          `gateway-unavailable ${viewport.label} welcome pushed auth controls below the first viewport:\n${JSON.stringify(
            result,
            null,
            2
          )}`
        );
      }
      // Every NEAR AI Cloud auth control must be a real tap target, not just the
      // primary. The shared Button `md` size floors at 40px on mobile and 44px on
      // desktop; the secondary Google/Wallet actions previously shipped at the
      // 32px `sm` size. 40 is the cross-viewport floor.
      if (result.minAuthButtonHeight < 40) {
        throw new Error(
          `gateway-unavailable ${viewport.label} welcome rendered an auth control below the 40px tap-target floor:\n${JSON.stringify(
            result,
            null,
            2
          )}`
        );
      }
      if (result.hasRawGatewayText || result.hasProviderLeak || result.overflow) {
        throw new Error(
          `gateway-unavailable ${viewport.label} welcome failed product-truth checks:\n${JSON.stringify(
            result,
            null,
            2
          )}`
        );
      }
      if (result.deadSettingsButtonCount > 0) {
        throw new Error(
          `gateway-unavailable ${viewport.label} welcome exposed a dead Settings button:\n${JSON.stringify(
            result,
            null,
            2
          )}`
        );
      }
    }
    if (staleGatewayRequests.length > 0) {
      throw new Error(
        `gateway-unavailable welcome requested stale :3000 origin: ${staleGatewayRequests.join(
          ', '
        )}`
      );
    }
  } finally {
    await page.close().catch(() => {});
  }
}

async function assertBrowserPreviewUnavailableWelcome(browser) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  try {
    await page.goto(`http://127.0.0.1:${port}${appBasePath}/welcome`, {
      waitUntil: 'domcontentloaded'
    });
    await page
      .getByText('Static preview needs a gateway', { exact: true })
      .waitFor({ timeout: 20_000 });
    await page
      .getByText(
        'This browser preview cannot start the desktop sidecar. Run the packaged app or npm run tauri dev for sign-in; use npm run dev:webui-static only for UI smoke tests against an already running gateway.',
        { exact: true }
      )
      .waitFor({ timeout: 20_000 });
    const result = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const authButtons = Array.from(document.querySelectorAll('button'))
        .map((button) => ({
          text: (button.innerText || button.getAttribute('aria-label') || '').trim(),
          disabled: button.disabled
        }))
        .filter((button) =>
          /Sign in with GitHub|Use Google|Use NEAR Wallet|Use API key/i.test(button.text)
        );
      return {
        authButtonCount: authButtons.length,
        allAuthButtonsDisabled:
          authButtons.length >= 3 && authButtons.every((button) => button.disabled),
        hasDesktopRetryCopy: text.includes('Restart the app or start the sidecar'),
        body: text
      };
    });
    if (!result.allAuthButtonsDisabled || result.hasDesktopRetryCopy) {
      throw new Error(
        `browser-preview welcome did not explain static preview limits:\n${JSON.stringify(
          result,
          null,
          2
        )}`
      );
    }
    await mkdir('output/playwright', { recursive: true });
    await page.screenshot({
      path: 'output/playwright/static-preview-gateway-unavailable.png',
      fullPage: true
    });
  } finally {
    await page.close().catch(() => {});
  }
}

const server = spawn('node', ['scripts/serve-webui-static.mjs'], {
  env: {
    ...process.env,
    PORT: String(port),
    IRONCLAW_GATEWAY_ORIGIN: gatewayOrigin
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk.toString();
});

let proxyProbeGateway = null;

try {
  await waitForServer();
  proxyProbeGateway = await startProxyProbeGateway();
  await assertProxySurvivesAbortedSse();
  const browser = await chromium.launch({ headless: true });
  await assertBrowserPreviewUnavailableWelcome(browser);
  await assertGatewayUnavailableWelcome(browser);
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('close', () => errors.push('page closed'));
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      errors.push(`${message.type()}: ${message.text()}`);
    }
  });

  await installTauriShim(page);
  const connectorRequests = [];
  let gmailSetupConfigured = false;
  const staleGatewayRequests = [];
  await page.route('http://127.0.0.1:3000/**', async (route) => {
    staleGatewayRequests.push(route.request().url());
    await route.abort();
  });
  let gatewayStatusPayload = {
    engine_v2_enabled: true,
    restart_enabled: true,
    llm_backend: 'nearai',
    llm_model: 'auto',
    model_execution_verified: false,
    model_readiness: 'unverified'
  };
  let llmProvidersPayload = {
    providers: [
      {
        id: 'nearai',
        name: 'NEAR.AI',
        description: 'IronClaw Cloud model routing through NEAR AI.',
        adapter: 'nearai',
        default_model: 'auto',
        builtin: true,
        api_key_required: false,
        accepts_api_key: true,
        api_key_set: false
      },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        description: 'Diagnostic fixture that must stay hidden in Desktop.',
        adapter: 'open_ai_completions',
        base_url: 'https://openrouter.ai/api/v1',
        default_model: 'z-ai/glm-4.5',
        builtin: true,
        api_key_required: true,
        api_key_set: false
      }
    ],
    active: null
  };
  const smokeAttachmentScenarios = [
    dummyAttachmentScenario(
      'services-template.pdf',
      'application/pdf',
      '%PDF-1.4\nstatic smoke services agreement template\n%%EOF\n'
    ),
    dummyAttachmentScenario(
      'redline-instructions.md',
      'text/markdown',
      '# Redline instructions\n\n- Preserve indemnity clause\n- Flag payment terms\n'
    ),
    dummyAttachmentScenario(
      'invoice-payload.json',
      'application/json',
      JSON.stringify({ invoice: 'INV-4242', amount: 1200, currency: 'USD' }, null, 2)
    ),
    dummyAttachmentScenario(
      'scope-summary.html',
      'text/html',
      '<!doctype html><h1>Scope Summary</h1><p>Export-ready HTML source.</p>'
    ),
    dummyAttachmentScenario(
      'acme-invoice.pdf',
      'application/pdf',
      buildMinimalPdfBuffer('INVOICE 7741 TOTAL 432.50 VENDOR ACME'),
      { expectExtractedText: 'INVOICE 7741' }
    ),
    dummyAttachmentScenario(
      'services-template.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buildSmokeDocxBuffer(),
      { expectExtractedText: 'MSA-CLAUSE-17' }
    ),
    dummyAttachmentScenario(
      'pricing-model.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buildSmokeXlsxBuffer(),
      { expectExtractedText: 'Enterprise\t42000' }
    )
  ];
  // A corrupt OOXML package (zip magic, no central directory) must be
  // REJECTED with an honest notice and never shipped as an unreadable blob —
  // the extraction hardening's contract.
  const corruptDocxScenario = dummyAttachmentScenario(
    'board-minutes.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    Buffer.from('PK\u0003\u0004dummy docx package bytes for static smoke', 'binary')
  );
  // VIZ-3: the assistant reply carries a mermaid fence so the rendered run can
  // click "Render diagram" and prove the DOCX export embeds the rasterized PNG
  // (browser canvas) while still preserving the diagram source.
  const SMOKE_MERMAID_SOURCE = [
    'graph TD',
    '  A[Client instructions] --> B[Draft DOCX]',
    '  B --> C[Review and export]'
  ].join('\n');
  const SMOKE_ASSISTANT_REPLY = [
    '# Services agreement',
    '',
    '## Scope',
    '',
    'Prepared from the uploaded template with export-ready sections.',
    '',
    '## Workflow diagram',
    '',
    '```mermaid',
    SMOKE_MERMAID_SOURCE,
    '```'
  ].join('\n');
  await page.route(`${gatewayOrigin}/api/gateway/status`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(gatewayStatusPayload)
    });
  });
  await page.route(`${gatewayOrigin}/api/webchat/v2/threads`, async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          thread: { thread_id: 'thread-smoke', title: 'Smoke thread' }
        })
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ threads: [], next_cursor: null })
    });
  });
  const chatMessageRequests = [];
  const timelineRequests = [];
  const llmProviderRequests = [];
  const llmListModelRequests = [];
  const llmActiveRequests = [];
  const registryFixtures = {
    gmail: {
      id: 'gmail',
      display_name: 'Gmail',
      kind: 'wasm_tool',
      description: 'Read, triage, draft, and prepare email work with approval gates.',
      package_ref: { kind: 'extension', id: 'tools/gmail' },
      installed: false,
      keywords: ['email', 'google', 'inbox']
    },
    'google-calendar': {
      id: 'google-calendar',
      display_name: 'Google Calendar',
      kind: 'wasm_tool',
      description: 'Find meetings, protect focus blocks, and prepare schedule changes.',
      package_ref: { kind: 'extension', id: 'tools/google_calendar' },
      installed: false,
      keywords: ['calendar', 'google', 'schedule']
    },
    slack: {
      id: 'slack',
      display_name: 'Slack',
      kind: 'wasm_channel',
      description: 'Summarize channels, prepare replies, and surface urgent asks.',
      package_ref: { kind: 'extension', id: 'channels/slack' },
      installed: false,
      keywords: ['messages', 'team', 'channels']
    },
    telegram: {
      id: 'telegram',
      display_name: 'Telegram',
      kind: 'wasm_channel',
      description: 'Send scheduled digests and bot messages through Telegram.',
      package_ref: { kind: 'extension', id: 'channels/telegram' },
      installed: false,
      keywords: ['bot', 'news', 'dm']
    },
    github: {
      id: 'github',
      display_name: 'GitHub',
      kind: 'wasm_tool',
      description: 'Watch releases, summarize changes, and route follow-up tasks.',
      package_ref: { kind: 'extension', id: 'tools/github' },
      installed: false,
      keywords: ['releases', 'issues', 'code']
    }
  };
  let registryEntriesPayload = [];
  await page.route(
    `${gatewayOrigin}/api/webchat/v2/threads/thread-smoke/messages`,
    async (route) => {
      chatMessageRequests.push(route.request().postDataJSON());
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          thread_id: 'thread-smoke',
          run_id: 'run-smoke',
          status: 'queued'
        })
      });
    }
  );
  await page.route(
    `${gatewayOrigin}/api/webchat/v2/threads/thread-smoke/timeline**`,
    async (route) => {
      timelineRequests.push(route.request().url());
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [
            {
              kind: 'user',
              message_id: 'msg-user-smoke',
              content: [
                'Draft a services agreement from this attachment.',
                '',
                attachmentTranscriptBlock(smokeAttachmentScenarios)
              ].join('\n'),
              sequence: 1,
              created_at: '2026-06-02T08:00:00.000Z'
            },
            {
              kind: 'assistant',
              message_id: 'msg-assistant-smoke',
              content: SMOKE_ASSISTANT_REPLY,
              sequence: 2,
              turn_run_id: 'run-smoke',
              created_at: '2026-06-02T08:00:01.000Z'
            }
          ],
          summary_artifacts: [],
          next_cursor: null
        })
      });
    }
  );
  await page.route(
    `${gatewayOrigin}/api/webchat/v2/threads/thread-smoke/events**`,
    async (route) => {
      const frames = [
        `event: accepted\ndata: ${JSON.stringify({
          type: 'accepted',
          ack: { run_id: 'run-smoke', thread_id: 'thread-smoke', status: 'accepted' }
        })}\n\n`,
        `event: final_reply\ndata: ${JSON.stringify({
          type: 'final_reply',
          reply: {
            turn_run_id: 'run-smoke',
            text: SMOKE_ASSISTANT_REPLY,
            generated_at: '2026-06-02T08:00:01.000Z'
          }
        })}\n\n`
      ].join('');
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache'
        },
        body: frames
      });
    }
  );
  const failedRunMessageRequests = [];
  const failedRunTimelineRequests = [];
  const failedRunStateRequests = [];
  let failedRunMessageSubmitted = false;
  await page.route(
    `${gatewayOrigin}/api/webchat/v2/threads/thread-fail/messages`,
    async (route) => {
      failedRunMessageSubmitted = true;
      failedRunMessageRequests.push(route.request().postDataJSON());
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          thread_id: 'thread-fail',
          run_id: 'run-fail',
          status: 'queued'
        })
      });
    }
  );
  await page.route(
    `${gatewayOrigin}/api/webchat/v2/threads/thread-fail/timeline**`,
    async (route) => {
      failedRunTimelineRequests.push(route.request().url());
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          // SSE is silent for this thread, so the chat loop falls back to
          // polling the (registered) timeline. Once the turn is submitted the
          // timeline carries the finalized assistant reply — proof the run
          // completed — which the fallback must detect (runReplyLandedInTimeline)
          // without ever hitting the unregistered bare GET /runs/{id}.
          messages: failedRunMessageSubmitted
            ? [
                {
                  kind: 'user',
                  message_id: 'msg-user-failed-run',
                  content: 'Trigger failed run-state recovery.',
                  sequence: 1,
                  turn_run_id: 'run-fail',
                  created_at: '2026-06-02T08:01:00.000Z'
                },
                {
                  kind: 'assistant',
                  message_id: 'msg-asst-failed-run',
                  content: 'Recovered from the timeline after the stream went quiet.',
                  status: 'finalized',
                  sequence: 2,
                  turn_run_id: 'run-fail',
                  created_at: '2026-06-02T08:01:05.000Z'
                }
              ]
            : [],
          summary_artifacts: [],
          next_cursor: null
        })
      });
    }
  );
  // Tripwire: the real gateway registers NO bare GET /runs/{id} (only
  // .../cancel and .../gates/.../resolve), so it 404s. Mirror that and record
  // any hit — the client must derive run state from the timeline and never call
  // this route. We assert failedRunStateRequests stays empty below.
  await page.route(
    `${gatewayOrigin}/api/webchat/v2/threads/thread-fail/runs/run-fail`,
    async (route) => {
      failedRunStateRequests.push(route.request().url());
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'not_found' })
      });
    }
  );
  await page.route(`${gatewayOrigin}/api/reborn/product-auth/manual-token/setup`, async (route) => {
    connectorRequests.push({
      url: route.request().url(),
      method: route.request().method(),
      body: route.request().postDataJSON(),
      authorization: route.request().headers().authorization || ''
    });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        interaction_id: 'interaction-smoke',
        provider: 'google',
        label: 'Smoke Google',
        expires_at: '2030-01-01T00:00:00Z',
        invocation_id: 'invocation-smoke'
      })
    });
  });
  await page.route(
    `${gatewayOrigin}/api/reborn/product-auth/manual-token/secret-submit`,
    async (route) => {
      connectorRequests.push({
        url: route.request().url(),
        method: route.request().method(),
        body: route.request().postDataJSON(),
        authorization: route.request().headers().authorization || ''
      });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          credential_ref: 'credential-google-smoke',
          status: 'configured',
          continuation: { type: 'setup_only' }
        })
      });
    }
  );
  await page.route(`${gatewayOrigin}/api/webchat/v2/**`, async (route) => {
    const webchatPath = new URL(route.request().url()).pathname;
    if (
      webchatPath === '/api/webchat/v2/threads' ||
      route.request().url().includes('/threads/thread-smoke/messages') ||
      route.request().url().includes('/threads/thread-smoke/timeline') ||
      route.request().url().includes('/threads/thread-smoke/events') ||
      route.request().url().includes('/threads/thread-fail/messages') ||
      route.request().url().includes('/threads/thread-fail/timeline') ||
      route.request().url().includes('/threads/thread-fail/runs/run-fail')
    ) {
      await route.fallback();
      return;
    }
    if (webchatPath === '/api/webchat/v2/extensions/registry') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ entries: registryEntriesPayload })
      });
      return;
    }
    if (webchatPath === '/api/webchat/v2/llm/providers') {
      llmProviderRequests.push({
        url: route.request().url(),
        active: llmProvidersPayload.active
      });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(llmProvidersPayload)
      });
      return;
    }
    if (webchatPath === '/api/webchat/v2/llm/list-models') {
      llmListModelRequests.push(route.request().postDataJSON());
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          models: ['auto', 'nearai:gpt-oss-120b', 'nearai:claude-sonnet-4.5']
        })
      });
      return;
    }
    if (webchatPath === '/api/webchat/v2/llm/active') {
      const body = route.request().postDataJSON();
      llmActiveRequests.push(body);
      llmProvidersPayload = {
        ...llmProvidersPayload,
        active: {
          provider_id: body.provider_id,
          model: body.model
        }
      };
      gatewayStatusPayload = {
        ...gatewayStatusPayload,
        llm_backend: body.provider_id,
        llm_model: body.model,
        model_execution_verified: true,
        model_readiness: 'verified'
      };
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          active: llmProvidersPayload.active
        })
      });
      return;
    }
    if (webchatPath === '/api/webchat/v2/channels/connectable') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          channels: [
            {
              channel: 'slack',
              display_name: 'Slack',
              command_aliases: ['slack']
            }
          ]
        })
      });
      return;
    }
    if (webchatPath === '/api/webchat/v2/extensions') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          extensions: [
            {
              display_name: 'Gmail',
              kind: 'wasm_tool',
              version: '0.2.0',
              active: false,
              needs_setup: true,
              has_auth: true,
              onboarding_state: gmailSetupConfigured ? 'failed' : 'auth_required',
              activation_error: gmailSetupConfigured
                ? 'Backend can store this credential, but this connector runtime is not wired in this build yet.'
                : undefined,
              description: 'Read and draft Gmail messages.',
              package_ref: { kind: 'extension', id: 'gmail' },
              tools: []
            },
            {
              display_name: 'Google Calendar',
              kind: 'wasm_tool',
              version: '0.2.0',
              active: false,
              needs_setup: true,
              has_auth: true,
              onboarding_state: 'auth_required',
              description: 'Inspect and draft calendar changes.',
              package_ref: { kind: 'extension', id: 'google-calendar' },
              tools: []
            },
            {
              display_name: 'Notion',
              kind: 'mcp_server',
              version: '0.2.0',
              active: false,
              needs_setup: true,
              has_auth: true,
              onboarding_state: 'auth_required',
              description: 'Connect Notion workspace context.',
              package_ref: { kind: 'extension', id: 'notion' },
              tools: []
            },
            {
              display_name: 'Slack',
              kind: 'wasm_channel',
              version: '0.2.0',
              active: false,
              needs_setup: true,
              has_auth: true,
              onboarding_state: 'pairing_required',
              description: 'Pair Slack as a workspace channel.',
              onboarding: {
                credential_instructions:
                  'Slack is blocked: channel pairing is not wired in this smoke backend.'
              },
              package_ref: { kind: 'extension', id: 'slack' },
              tools: []
            }
          ]
        })
      });
      return;
    }
    if (route.request().url().includes('/extensions/')) {
      const method = route.request().method();
      const extensionName =
        new URL(route.request().url()).pathname.match(/\/extensions\/([^/]+)\/setup$/)?.[1] ||
        'unknown';
      const body = method === 'GET' ? null : route.request().postDataJSON();
      connectorRequests.push({
        url: route.request().url(),
        method,
        body,
        authorization: route.request().headers().authorization || ''
      });
      if (method === 'GET' && route.request().url().endsWith('/setup')) {
        const setupCopy = {
          gmail: {
            prompt: 'Google OAuth token',
            instructions: 'Use the Product Auth token returned by Google sign-in for Gmail.'
          },
          'google-calendar': {
            prompt: 'Google Calendar OAuth token',
            instructions: 'Use the Product Auth token returned by Google sign-in for Calendar.'
          },
          notion: {
            prompt: 'Notion integration token',
            instructions: 'Paste a Notion integration token.'
          }
        }[extensionName] || {
          prompt: `${extensionName} token`,
          instructions: `Paste the ${extensionName} token.`
        };
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            secrets: [
              {
                name: 'token',
                prompt: setupCopy.prompt,
                optional: false,
                provided: false,
                setup: { kind: 'manual_token', provider: extensionName }
              }
            ],
            fields: [
              {
                name: 'account_label',
                prompt: 'Account label',
                optional: true,
                placeholder: `${extensionName} account`
              }
            ],
            onboarding: {
              credential_instructions: setupCopy.instructions,
              credential_next_step:
                'Save the token; this smoke keeps the runtime blocked so the UI cannot claim a live connector.'
            }
          })
        });
        return;
      }
      if (body?.action === 'submit') {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'invalid_request',
            message: 'Reborn lifecycle setup uses action "configure", not "submit".'
          })
        });
        return;
      }
      if (body?.action === 'configure') {
        if (extensionName === 'gmail') gmailSetupConfigured = true;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            extension_name: extensionName,
            phase: 'unsupported_or_legacy',
            blockers: [
              {
                kind: 'runtime',
                ref_id: 'extension_auth_and_configure_not_yet_wired'
              }
            ],
            package_ref: { kind: 'extension', id: extensionName },
            payload: {}
          })
        });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          extension_name: extensionName,
          phase: 'active',
          blockers: [],
          package_ref: { kind: 'extension', id: extensionName },
          payload: {}
        })
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true })
    });
  });
  await page.route(`${gatewayOrigin}/auth/providers`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ providers: ['google'] })
    });
  });

  await page.goto(`http://127.0.0.1:${port}${appBasePath}/`, {
    waitUntil: 'domcontentloaded'
  });
  try {
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText || '';
        return (
          text.includes('Welcome to IronClaw') ||
          text.includes('New') ||
          text.includes('Chat') ||
          text.includes('Extensions')
        );
      },
      null,
      { timeout: 20_000 }
    );
  } catch (err) {
    await mkdir('output/playwright', { recursive: true });
    await page
      .screenshot({
        path: 'output/playwright/static-bootstrap-failure.png',
        fullPage: true
      })
      .catch(() => {});
    const visibleBody = await page
      .locator('body')
      .innerText()
      .catch(() => '<body unavailable>');
    throw new Error(
      `static app did not bootstrap; errors=${JSON.stringify(errors)}; body=${JSON.stringify(visibleBody)}`,
      { cause: err }
    );
  }
  const bootstrappedOrigin = await page.evaluate(() =>
    window.localStorage.getItem('ironclaw:desktop-gateway-origin')
  );
  if (bootstrappedOrigin !== gatewayOrigin) {
    throw new Error(
      `desktop bootstrap did not replace stale gateway origin: ${bootstrappedOrigin}`
    );
  }
  const bootstrappedToken = await page.evaluate(() =>
    window.sessionStorage.getItem('ironclaw_token')
  );
  if (bootstrappedToken !== 'local-token') {
    throw new Error(`desktop bootstrap did not replace stale session token: ${bootstrappedToken}`);
  }
  if (staleGatewayRequests.length > 0) {
    throw new Error(`static app requested stale :3000 origin: ${staleGatewayRequests.join(', ')}`);
  }
  const bodyText = await page.locator('body').innerText();
  if (bodyText.includes('Gateway token')) {
    throw new Error('desktop bootstrap failed: login token form is still visible');
  }

  async function assertNoLegacyConnectionsClasses(rootLocator, label) {
    const legacyClasses = await rootLocator.evaluate((root) =>
      [root, ...Array.from(root.querySelectorAll('*'))]
        .flatMap((node) => String(node.getAttribute('class') || '').split(/\s+/))
        .filter((className) =>
          /^(text-iron-|border-white|bg-white\/|bg-white\[|text-signal|text-mint|border-mint|bg-mint|text-red-|border-red-|bg-red-|v2-panel$)/.test(
            className
          )
        )
    );
    if (legacyClasses.length > 0) {
      throw new Error(
        `${label} leaked legacy Connections styling classes: ${legacyClasses.join(', ')}`
      );
    }
  }

  const beforeEmptyCatalogRequestCount = connectorRequests.length;
  await page.goto(`http://127.0.0.1:${port}${appBasePath}/extensions/registry`, {
    waitUntil: 'domcontentloaded'
  });
  await page.getByText('Catalog unavailable', { exact: true }).waitFor({ timeout: 20_000 });
  await page
    .getByText('This gateway did not expose installable app catalog entries yet.', {
      exact: false
    })
    .waitFor({ timeout: 20_000 });
  const acceptanceConnectionNames = [
    'Gmail',
    'Google Calendar',
    'Google Drive',
    'Google Sheets',
    'Notion',
    'Slack',
    'Telegram',
    'GitHub',
    'Web & HTTP',
    'Routines',
    'Workspace files'
  ];
  for (const name of acceptanceConnectionNames) {
    await page.getByRole('heading', { name, exact: true }).waitFor({ timeout: 20_000 });
  }
  const acceptanceWorkflowNames = [
    'Daily news digest',
    'Calendar prep assistant',
    'Deployment health watcher',
    'Competitor release tracker',
    'AMA in Slack',
    'CRM inbound tracker',
    'Slack to Sheet bug logger',
    'HN keyword monitor'
  ];
  for (const name of acceptanceWorkflowNames) {
    await page.getByRole('heading', { name, exact: true }).waitFor({ timeout: 20_000 });
  }
  const acceptanceIconKinds = [
    'gmail',
    'google-calendar',
    'google-drive',
    'google-sheets',
    'notion',
    'slack',
    'telegram',
    'github',
    'web',
    'routine',
    'workspace'
  ];
  const renderedConnectorIcons = await page
    .locator('[data-testid="connector-app-icon"]')
    .evaluateAll((icons) => icons.map((icon) => icon.getAttribute('data-connector-icon')));
  for (const iconKind of acceptanceIconKinds) {
    if (!renderedConnectorIcons.includes(iconKind)) {
      throw new Error(
        `empty registry did not render ${iconKind} connector favicon: ${renderedConnectorIcons.join(
          ', '
        )}`
      );
    }
  }
  const unavailableConnectorButtons = page.getByRole('button', { name: 'Not available' });
  const unavailableConnectorCount = await unavailableConnectorButtons.count();
  if (unavailableConnectorCount < 8) {
    const visibleBody = await page.locator('body').innerText();
    throw new Error(
      `empty registry did not render disabled curated connector cards:\n${visibleBody}`
    );
  }
  for (let index = 0; index < unavailableConnectorCount; index += 1) {
    if (!(await unavailableConnectorButtons.nth(index).isDisabled())) {
      throw new Error(`empty registry curated connector ${index} was actionable`);
    }
  }
  if ((await page.getByRole('button', { name: 'Connect' }).count()) > 0) {
    const visibleBody = await page.locator('body').innerText();
    throw new Error(`empty registry exposed actionable synthetic Connect buttons:\n${visibleBody}`);
  }
  await assertNoLegacyConnectionsClasses(page.locator('body'), 'empty registry Connections');
  await page.screenshot({
    path: 'output/playwright/static-connections-registry-empty.png',
    fullPage: true
  });
  const acceptanceWorkflowsPanel = page.getByTestId('acceptance-workflows');
  await acceptanceWorkflowsPanel.scrollIntoViewIfNeeded();
  const acceptanceWorkflowIconKinds = [
    'gmail',
    'google-calendar',
    'google-drive',
    'google-sheets',
    'slack',
    'telegram',
    'github',
    'web',
    'routine'
  ];
  const renderedWorkflowIconKinds = await acceptanceWorkflowsPanel
    .locator('[data-testid="connector-app-icon"]')
    .evaluateAll((icons) => icons.map((icon) => icon.getAttribute('data-connector-icon')));
  for (const iconKind of acceptanceWorkflowIconKinds) {
    if (!renderedWorkflowIconKinds.includes(iconKind)) {
      throw new Error(
        `acceptance workflow chips did not render ${iconKind} connector favicon: ${renderedWorkflowIconKinds.join(
          ', '
        )}`
      );
    }
  }
  await page.screenshot({
    path: 'output/playwright/static-acceptance-workflows.png',
    fullPage: false
  });
  const emptyCatalogInstallRequests = connectorRequests
    .slice(beforeEmptyCatalogRequestCount)
    .filter((request) => request.url.endsWith('/api/webchat/v2/extensions/install'));
  if (emptyCatalogInstallRequests.length > 0) {
    throw new Error(
      `empty registry triggered synthetic install requests:\n${JSON.stringify(
        emptyCatalogInstallRequests,
        null,
        2
      )}`
    );
  }

  registryEntriesPayload = [
    registryFixtures.gmail,
    registryFixtures['google-calendar'],
    registryFixtures.slack,
    registryFixtures.telegram,
    registryFixtures.github
  ];
  await page.goto(`http://127.0.0.1:${port}${appBasePath}/extensions/registry?catalog=partial`, {
    waitUntil: 'domcontentloaded'
  });
  await page.getByText('Catalog loaded', { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByText('Ready to connect', { exact: true }).first().waitFor({ timeout: 20_000 });
  await page
    .getByText('1 app missing from catalog', { exact: true })
    .first()
    .waitFor({ timeout: 20_000 });
  const missingWorkflowSurfaces = await page
    .locator('[data-workflow-surface-state="missing"]')
    .count();
  if (missingWorkflowSurfaces < 3) {
    const visibleBody = await page.locator('body').innerText();
    throw new Error(
      `partial registry did not mark missing workflow connector chips:\n${visibleBody}`
    );
  }
  await page.getByTestId('acceptance-workflows').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'output/playwright/static-acceptance-workflows-partial-catalog.png',
    fullPage: false
  });
  await page.getByLabel('Draft prompt for Daily news digest').click();
  await page.waitForURL(`**${appBasePath}/chat`, { timeout: 20_000 });
  const workflowDraftComposer = page.locator('textarea').first();
  await workflowDraftComposer.waitFor({ timeout: 20_000 });
  const workflowDraft = await workflowDraftComposer.inputValue();
  if (
    !workflowDraft.includes('Telegram digest') ||
    !workflowDraft.includes('NEAR AI news') ||
    !workflowDraft.includes('schedule the routine')
  ) {
    throw new Error(`workflow recipe did not prefill a useful chat draft: ${workflowDraft}`);
  }
  await page.screenshot({
    path: 'output/playwright/static-acceptance-workflow-chat-prefill.png',
    fullPage: true
  });

  await page.goto(`http://127.0.0.1:${port}${appBasePath}/chat`, {
    waitUntil: 'domcontentloaded'
  });
  await page.getByLabel('Chat model settings').first().waitFor({ timeout: 20_000 });
  const firstRunUrl = new URL(page.url());
  if (!firstRunUrl.pathname.endsWith('/chat')) {
    throw new Error(`static chat front door did not stay on chat: ${page.url()}`);
  }
  await page
    .getByText('Connect NEAR AI Cloud before sending your first message.', { exact: true })
    .waitFor({ timeout: 20_000 });
  const firstRunBody = await page.locator('body').innerText();
  if (!firstRunBody.includes('Connect NEAR AI Cloud before sending your first message.')) {
    throw new Error(`static chat did not render honest setup-required copy:\n${firstRunBody}`);
  }

  llmProvidersPayload = {
    ...llmProvidersPayload,
    active: {
      provider_id: 'nearai',
      model: 'auto'
    }
  };

  await page.goto(`http://127.0.0.1:${port}${appBasePath}/settings/inference`, {
    waitUntil: 'domcontentloaded'
  });
  const activeModelPanel = page.getByTestId('active-model-panel');
  await activeModelPanel.waitFor({ state: 'visible', timeout: 20_000 });
  await activeModelPanel.getByText('Current model', { exact: true }).waitFor({ timeout: 10_000 });
  await activeModelPanel.getByText('NEAR AI Cloud', { exact: true }).waitFor({ timeout: 10_000 });
  await activeModelPanel
    .locator('span')
    .filter({ hasText: /^Auto$/ })
    .first()
    .waitFor({
      timeout: 10_000
    });
  const settingsModelSelect = activeModelPanel.getByLabel('Model');
  await settingsModelSelect
    .locator('option[value="nearai:gpt-oss-120b"]')
    .waitFor({ state: 'attached', timeout: 10_000 });
  await settingsModelSelect.selectOption('nearai:gpt-oss-120b');
  await activeModelPanel.getByRole('button', { name: 'Apply' }).click();
  await activeModelPanel
    .locator('span')
    .filter({ hasText: /^GPT OSS 120B$/ })
    .first()
    .waitFor({
      timeout: 20_000
    });
  const latestModelListRequest = llmListModelRequests.at(-1);
  if (
    latestModelListRequest?.provider_id !== 'nearai' ||
    latestModelListRequest?.adapter !== 'nearai'
  ) {
    throw new Error(
      `settings model picker did not request NEAR AI Cloud models: ${JSON.stringify(
        llmListModelRequests
      )}`
    );
  }
  const latestActiveRequest = llmActiveRequests.at(-1);
  if (
    latestActiveRequest?.provider_id !== 'nearai' ||
    latestActiveRequest?.model !== 'nearai:gpt-oss-120b'
  ) {
    throw new Error(
      `settings model picker did not set the active NEAR AI model: ${JSON.stringify(
        llmActiveRequests
      )}`
    );
  }
  const settingsInferenceBody = await page.locator('body').innerText();
  if (
    settingsInferenceBody.includes('OpenRouter') ||
    settingsInferenceBody.includes('deepseek/') ||
    settingsInferenceBody.includes('Anthropic')
  ) {
    throw new Error(
      `settings inference exposed provider-key complexity:\n${settingsInferenceBody}`
    );
  }
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({
    path: 'output/playwright/static-settings-active-model.png',
    fullPage: true
  });

  await page.goto(`http://127.0.0.1:${port}${appBasePath}/chat`, {
    waitUntil: 'domcontentloaded'
  });
  const modelControl = page.getByLabel('Chat model settings').first();
  await modelControl.waitFor({ timeout: 20_000 });
  try {
    await page.waitForFunction(
      () => {
        const control = document.querySelector('[aria-label="Chat model settings"]');
        return control?.textContent?.includes('NEAR AI Cloud · GPT OSS 120B');
      },
      null,
      { timeout: 20_000 }
    );
  } catch (err) {
    const visibleBody = await page
      .locator('body')
      .innerText()
      .catch(() => '<body unavailable>');
    throw new Error(
      `static chat model control never settled on active NEAR AI Cloud model; providerRequests=${JSON.stringify(
        llmProviderRequests
      )}; body=${visibleBody}`,
      { cause: err }
    );
  }
  const modelControlText = await modelControl.innerText();
  if (!modelControlText.includes('NEAR AI Cloud · GPT OSS 120B')) {
    throw new Error(
      `static chat model control did not show active NEAR AI Cloud model:\n${modelControlText}`
    );
  }
  // Readiness moved off the chip into the tooltip — keep it honest there.
  const modelControlTitle = await modelControl.getAttribute('title');
  if (!modelControlTitle || !modelControlTitle.length) {
    throw new Error('model chip lost its readiness tooltip');
  }
  // The model control is a popover trigger now: opening it must render the
  // model panel with a working manage link into inference settings.
  await modelControl.click();
  const manageLink = page.getByText('Manage NEAR AI Cloud in Settings', { exact: true });
  await manageLink.waitFor({ timeout: 10_000 });
  const modelPopoverBody = await page.locator('body').innerText();
  if (modelPopoverBody.includes('OpenRouter') || modelPopoverBody.includes('deepseek/')) {
    throw new Error(`static model popover exposed hidden provider:\n${modelPopoverBody}`);
  }
  const manageHref = await manageLink.getAttribute('href');
  if (manageHref !== `${appBasePath}/settings/inference`) {
    throw new Error(`model popover manage link did not target inference settings: ${manageHref}`);
  }
  await page.keyboard.press('Escape');
  const initialChatBody = await page.locator('body').innerText();
  if (modelControlText.includes('OpenRouter') || modelControlText.includes('deepseek/')) {
    throw new Error(
      `static chat model control exposed unconfigured provider:\n${modelControlText}`
    );
  }
  if (initialChatBody.includes('OpenRouter') || initialChatBody.includes('deepseek/')) {
    throw new Error(`static chat exposed unconfigured provider:\n${initialChatBody}`);
  }
  const verifiedComposer = page.locator('textarea').first();
  await verifiedComposer.waitFor({ timeout: 20_000 });
  await page.locator('input[type="file"]').setInputFiles(
    [...smokeAttachmentScenarios, corruptDocxScenario].map((scenario) => ({
      name: scenario.name,
      mimeType: scenario.mimeType,
      buffer: scenario.buffer
    }))
  );
  for (const scenario of smokeAttachmentScenarios) {
    await page.getByText(scenario.name, { exact: true }).waitFor({ timeout: 20_000 });
  }
  // The corrupt docx surfaces an honest rejection notice instead of a chip
  // that pretends it will be readable.
  await page
    .getByText('could not be opened — the file looks corrupted or incomplete', { exact: false })
    .waitFor({ timeout: 20_000 });
  const promptText = 'Draft a services agreement from this attachment.';
  await verifiedComposer.click();
  await verifiedComposer.pressSequentially(promptText);
  if ((await verifiedComposer.inputValue()) !== promptText) {
    throw new Error('static chat composer did not retain typed prompt text');
  }
  const sendButton = page.locator('button[aria-label="Send message"]').last();
  await page.waitForFunction(() => {
    const buttons = Array.from(document.querySelectorAll('button[aria-label="Send message"]'));
    const button = buttons.at(-1);
    return button && !button.disabled;
  });
  await sendButton.click();
  await page.getByText('Draft a services agreement from this attachment.').first().waitFor({
    timeout: 20_000
  });
  try {
    await page
      .getByText('Services agreement', { exact: true })
      .first()
      .waitFor({ timeout: 20_000 });
  } catch (err) {
    await mkdir('output/playwright', { recursive: true });
    let visibleBody = '<page closed>';
    if (!page.isClosed()) {
      await page
        .screenshot({
          path: 'output/playwright/static-work-product-attachment-chat-failure.png',
          fullPage: true
        })
        .catch(() => {});
      visibleBody = await page
        .locator('body')
        .innerText()
        .catch(() => '<body unavailable>');
    }
    throw new Error(
      `static chat did not render mocked work product reply; timelineRequests=${JSON.stringify(
        timelineRequests
      )}; errors=${JSON.stringify(errors)}; body=${JSON.stringify(visibleBody)}`,
      { cause: err }
    );
  }
  const workProductPanel = page.getByTestId('assistant-work-product').first();
  await workProductPanel.waitFor({ state: 'visible', timeout: 20_000 });
  const workProductBox = await workProductPanel.boundingBox();
  if (!workProductBox || workProductBox.width < 520) {
    throw new Error(
      `static chat work product rendered as a buried narrow chat bubble: ${JSON.stringify(
        workProductBox
      )}`
    );
  }
  const workProductText = await workProductPanel.innerText();
  if (!workProductText.includes('Services agreement') || !workProductText.includes('Scope')) {
    throw new Error(`static chat work product panel lost document content: ${workProductText}`);
  }
  const artifactChip = workProductPanel.getByTestId('assistant-artifact-chip');
  await artifactChip.waitFor({ state: 'visible', timeout: 20_000 });
  const artifactChipText = await artifactChip.innerText();
  const artifactChipTextLower = artifactChipText.toLowerCase();
  if (
    !artifactChipTextLower.includes('generated document') ||
    !artifactChipTextLower.includes('services agreement') ||
    !artifactChipTextLower.includes('exportable as docx, pdf, html, and json')
  ) {
    throw new Error(`static chat work product is not exposed as an artifact: ${artifactChipText}`);
  }
  const chatLayout = await page.evaluate(() => {
    const rectFor = (el) => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        height: rect.height,
        top: rect.top
      };
    };
    const scroll = document.querySelector('[data-testid="chat-message-scroll"]');
    const composer = document.querySelector('[data-testid="chat-composer"]');
    const jump = document.querySelector('[data-testid="chat-jump-to-latest"]');
    const scrollStyle = scroll ? getComputedStyle(scroll) : null;
    return {
      scroll: rectFor(scroll),
      composer: rectFor(composer),
      jump: rectFor(jump),
      scrollPaddingBottom: scrollStyle ? Number.parseFloat(scrollStyle.paddingBottom || '0') : 0
    };
  });
  if (!chatLayout.scroll || !chatLayout.composer) {
    throw new Error(`static chat layout hooks missing: ${JSON.stringify(chatLayout)}`);
  }
  if (chatLayout.scroll.bottom > chatLayout.composer.top + 1) {
    throw new Error(
      `static chat composer overlaps the transcript viewport: ${JSON.stringify(chatLayout)}`
    );
  }
  if (chatLayout.scrollPaddingBottom < 96) {
    throw new Error(
      `static chat transcript lacks bottom safe space for composer/jump controls: ${JSON.stringify(
        chatLayout
      )}`
    );
  }
  if (
    chatLayout.jump &&
    (chatLayout.jump.top < chatLayout.scroll.bottom - 40 ||
      chatLayout.jump.bottom > chatLayout.composer.top + 40)
  ) {
    throw new Error(
      `static chat jump-to-latest is not pinned to the transcript/composer boundary: ${JSON.stringify(
        chatLayout
      )}`
    );
  }
  const chatPost = chatMessageRequests.at(-1);
  if (!chatPost) {
    throw new Error('static chat did not POST a message request');
  }
  // Content leads with the prompt, then carries a base64-free durable
  // attachment manifest so the Reborn timeline preserves chips on reload.
  const postedContent = String(chatPost.content || '');
  if (!postedContent.startsWith(promptText) || postedContent.includes('data_base64')) {
    throw new Error(`static chat posted attachment data in content: ${JSON.stringify(chatPost)}`);
  }
  if (!postedContent.includes('<attachments ic="1">')) {
    throw new Error(
      `static chat did not append a durable attachment manifest: ${JSON.stringify(chatPost)}`
    );
  }
  for (const scenario of smokeAttachmentScenarios) {
    if (!postedContent.includes(`filename: ${scenario.name}`)) {
      throw new Error(`static chat manifest missing ${scenario.name}: ${JSON.stringify(chatPost)}`);
    }
  }
  // The wire carries NO attachment bytes. The Reborn byte-landing path (#4644)
  // fails the whole turn with HTTP 500 on any data_base64 under the DevOnly
  // composition ("permission denied for write_file on scoped /workspace/
  // attachments/..."), and the model never reads attachment bytes regardless —
  // it reads each document only through the durable manifest embedded in
  // `content` (verified below). So the composer strips bytes off the wire (see
  // attachmentsForWire) and the api layer omits the now-empty attachments field.
  // The corrupt docx is subsumed: nothing rides the wire at all.
  const wireAttachments = Array.isArray(chatPost.attachments) ? chatPost.attachments : [];
  if (wireAttachments.length !== 0) {
    throw new Error(
      `static chat shipped attachment bytes the gateway cannot land yet: ${JSON.stringify(chatPost)}`
    );
  }
  // The durable block must also EMBED text content — the bundled sidecar
  // never feeds attachment bytes to the model, so message content is the
  // only channel the model can actually read a document through.
  if (!postedContent.includes('extraction_status: extracted_text')) {
    throw new Error(
      `static chat did not embed extracted text sections in content: ${postedContent.slice(0, 400)}`
    );
  }
  const expectedEmbeds = [
    'INVOICE 7741', // extracted from acme-invoice.pdf client-side
    'MSA-CLAUSE-17', // extracted from services-template.docx client-side
    'Enterprise\t42000', // extracted from pricing-model.xlsx client-side
    'Preserve indemnity clause', // text/markdown raw payload
    'INV-4242' // application/json raw payload
  ];
  for (const embed of expectedEmbeds) {
    if (!postedContent.includes(embed)) {
      throw new Error(`static chat content missing embedded document text: ${embed}`);
    }
  }
  const compactAttachmentStack = page.getByTestId('compact-attachment-stack').last();
  await compactAttachmentStack.waitFor({ state: 'visible', timeout: 20_000 });
  const compactStackText = await compactAttachmentStack.innerText();
  const hiddenAttachmentCount = smokeAttachmentScenarios.length - 3;
  if (
    !compactStackText.includes(`${smokeAttachmentScenarios.length} files attached`) ||
    !compactStackText.includes(`Show ${hiddenAttachmentCount} more files`)
  ) {
    throw new Error(`static chat did not compact the large attachment stack: ${compactStackText}`);
  }
  if (compactStackText.includes(corruptDocxScenario.name)) {
    throw new Error(
      `static chat rendered a rejected attachment in the sent stack: ${compactStackText}`
    );
  }
  for (const scenario of smokeAttachmentScenarios.slice(0, 3)) {
    if (!compactStackText.includes(scenario.name)) {
      throw new Error(`static chat compact stack hid leading attachment: ${scenario.name}`);
    }
  }
  for (const scenario of smokeAttachmentScenarios.slice(3)) {
    if (compactStackText.includes(scenario.name)) {
      throw new Error(
        `static chat compact stack showed hidden attachment too early: ${scenario.name}`
      );
    }
  }
  let visibleChatBody = await page.locator('body').innerText();
  // Embedded document text is for the model, never for the transcript —
  // parseDurableAttachmentBlock must strip it from the rendered bubble.
  for (const embed of [
    'INVOICE 7741',
    'Preserve indemnity clause',
    'extraction_status:',
    'decoy.pdf'
  ]) {
    if (visibleChatBody.includes(embed)) {
      throw new Error(`embedded attachment text leaked into the visible transcript: ${embed}`);
    }
  }
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({
    path: 'output/playwright/static-work-product-attachment-chat-collapsed.png',
    fullPage: true
  });
  await compactAttachmentStack.getByTestId('attachment-stack-expand').click();
  await compactAttachmentStack
    .getByText(smokeAttachmentScenarios.at(-1).name, { exact: true })
    .waitFor({
      timeout: 5000
    });
  const expandedStackText = await compactAttachmentStack.innerText();
  for (const scenario of smokeAttachmentScenarios) {
    if (!expandedStackText.includes(scenario.name)) {
      throw new Error(`static chat expand did not reveal attachment metadata: ${scenario.name}`);
    }
  }
  if (expandedStackText.includes(corruptDocxScenario.name)) {
    throw new Error(
      `static chat expand revealed a rejected attachment in the sent stack: ${expandedStackText}`
    );
  }
  visibleChatBody = await page.locator('body').innerText();

  // Chip click opens the document preview with the captured embedded text;
  // Escape closes it and the text leaves the transcript again.
  const previewChip = page.locator('button[aria-label^="Preview "]').first();
  await previewChip.click();
  const previewText = page.locator('[data-testid="attachment-preview-text"]');
  await previewText.waitFor({ state: 'visible', timeout: 5000 });
  const previewContent = await previewText.innerText();
  if (!previewContent.includes('INVOICE 7741')) {
    throw new Error(
      `attachment preview did not show the embedded text: ${previewContent.slice(0, 120)}`
    );
  }
  // Tap-target floor on the SHARED dialog close button: the attachment preview
  // is built on design-system ModalHeader, whose close (X) was 32px (grid h-8
  // w-8) in every dialog before this pass. One shared fix lifted it to the 44px
  // mobile tap-target floor; assert it on a real rendered dialog so it cannot
  // silently regress to a sub-floor target across the whole modal surface.
  const previewDialog = page.locator('[role="dialog"][aria-modal="true"]', {
    has: page.locator('[data-testid="attachment-preview-text"]')
  });
  const previewClose = previewDialog.getByRole('button', { name: 'Close' }).first();
  await previewClose.waitFor({ state: 'visible', timeout: 5000 });
  const previewCloseBox = await previewClose.boundingBox();
  if (!previewCloseBox) {
    throw new Error('attachment preview close button had no layout box');
  }
  if (previewCloseBox.height < 44 || previewCloseBox.width < 44) {
    throw new Error(
      `shared modal close button is below the 44px tap-target floor: ${JSON.stringify(
        previewCloseBox
      )}`
    );
  }
  await page.keyboard.press('Escape');
  await page
    .locator('[data-testid="attachment-preview-text"]')
    .waitFor({ state: 'detached', timeout: 5000 });
  const bodyAfterPreview = await page.locator('body').innerText();
  if (bodyAfterPreview.includes('INVOICE 7741')) {
    throw new Error('preview text remained in the transcript after closing the modal');
  }
  await page.screenshot({
    path: 'output/playwright/static-work-product-attachment-chat.png',
    fullPage: true
  });

  async function downloadAssistantExport(label, expectedFilename) {
    const beforeCount = await page.evaluate(
      () => window.__IRONCLAW_SMOKE_SAVED_FILES__?.length || 0
    );
    await page.getByRole('button', { name: 'Export generated document' }).first().click();
    await page.getByRole('button', { name: new RegExp(`^${label}\\b`) }).click();
    await page.waitForFunction(
      ([count, filename]) => {
        const files = window.__IRONCLAW_SMOKE_SAVED_FILES__ || [];
        return files.length > count && files.at(-1)?.defaultFilename === filename;
      },
      [beforeCount, expectedFilename],
      { timeout: 10_000 }
    );
    const saved = await page.evaluate(
      (index) => (window.__IRONCLAW_SMOKE_SAVED_FILES__ || [])[index],
      beforeCount
    );
    if (!saved?.contentsBase64) {
      throw new Error(`${label} export did not call save_bytes_dialog`);
    }
    return Buffer.from(saved.contentsBase64, 'base64');
  }

  const markdownExport = (
    await downloadAssistantExport('Markdown', 'assistant-response.md')
  ).toString('utf8');
  if (!markdownExport.includes('# Services agreement') || !markdownExport.includes('## Scope')) {
    throw new Error(`Markdown export lost the assistant draft:\n${markdownExport}`);
  }

  const htmlExport = (await downloadAssistantExport('HTML', 'assistant-response.html')).toString(
    'utf8'
  );
  if (
    !htmlExport.startsWith('<!doctype html>') ||
    !htmlExport.includes('<h1>Services agreement</h1>') ||
    !htmlExport.includes('<h2>Scope</h2>')
  ) {
    throw new Error(`HTML export did not render markdown headings:\n${htmlExport}`);
  }

  const pdfExport = await downloadAssistantExport('PDF', 'assistant-response.pdf');
  const pdfText = pdfExport.toString('latin1');
  if (
    !pdfText.startsWith('%PDF-1.4') ||
    !pdfText.includes('SERVICES AGREEMENT') ||
    !pdfText.includes('startxref')
  ) {
    throw new Error(`PDF export is not a readable PDF work product: ${pdfText.slice(0, 200)}`);
  }

  const docxExport = await downloadAssistantExport('DOCX', 'assistant-response.docx');
  const docxText = docxExport.toString('utf8');
  if (
    docxExport[0] !== 0x50 ||
    docxExport[1] !== 0x4b ||
    !docxText.includes('word/document.xml') ||
    !docxText.includes('Services agreement') ||
    !docxText.includes('Prepared from the uploaded template')
  ) {
    throw new Error(`DOCX export is not a parseable Word package: ${docxText.slice(0, 300)}`);
  }

  // VIZ-3: render the mermaid diagram, then export DOCX again — it must now
  // embed the rasterized PNG as a real media part AND keep the source. Reload
  // the thread first so the assistant bubble is freshly mounted (the long
  // attachment/preview flow above can re-render the message and reset the
  // markdown body's innerHTML before its enhancement runs).
  await page.goto(`http://127.0.0.1:${port}${appBasePath}/chat/thread-smoke`, {
    waitUntil: 'domcontentloaded'
  });
  const mermaidCard = page.locator('[data-md-renderer="mermaid"]').first();
  try {
    await mermaidCard.waitFor({ state: 'attached', timeout: 20_000 });
  } catch (err) {
    await mkdir('output/playwright', { recursive: true });
    await page
      .screenshot({ path: 'output/playwright/static-mermaid-card-missing.png', fullPage: true })
      .catch(() => {});
    const diag = await page.evaluate(() => ({
      cards: document.querySelectorAll('[data-md-renderer="mermaid"]').length,
      mermaidCode: document.querySelectorAll('code.language-mermaid').length,
      bodyHasGraph: (document.body?.innerText || '').includes('graph TD')
    }));
    throw new Error(`mermaid diagram card never mounted: ${JSON.stringify(diag)}`, { cause: err });
  }
  await mermaidCard.getByRole('button', { name: 'Render diagram' }).click();
  await mermaidCard.locator('.v2-mermaid-card__output svg').waitFor({
    state: 'attached',
    timeout: 20_000
  });
  const diagramDocxExport = await downloadAssistantExport('DOCX', 'assistant-response.docx');
  const diagramDocxEntries = readStoredZipEntries(diagramDocxExport);
  const mediaEntry = [...diagramDocxEntries.entries()].find(([name]) =>
    name.startsWith('word/media/')
  );
  if (!mediaEntry) {
    throw new Error('rendered-diagram DOCX export did not embed a word/media image part');
  }
  const [mediaName, mediaBytes] = mediaEntry;
  // The media part must be real PNG bytes (magic 0x89 P N G).
  if (
    !/^word\/media\/image\d+\.png$/.test(mediaName) ||
    mediaBytes[0] !== 0x89 ||
    mediaBytes[1] !== 0x50 ||
    mediaBytes[2] !== 0x4e ||
    mediaBytes[3] !== 0x47
  ) {
    throw new Error(
      `rendered-diagram DOCX media part is not a PNG: ${mediaName} ${Array.from(
        mediaBytes.slice(0, 4)
      )}`
    );
  }
  const diagramDocumentXml = diagramDocxEntries.get('word/document.xml')?.toString('utf8') || '';
  const diagramContentTypes = diagramDocxEntries.get('[Content_Types].xml')?.toString('utf8') || '';
  if (
    !diagramDocumentXml.includes('<w:drawing>') ||
    !/<a:blip r:embed="rIdImage\d+"\/>/.test(diagramDocumentXml) ||
    !diagramDocumentXml.includes('graph TD') ||
    !diagramDocumentXml.includes('Mermaid diagram source') ||
    !diagramContentTypes.includes('Extension="png" ContentType="image/png"')
  ) {
    throw new Error(
      `rendered-diagram DOCX missing inline drawing, source, or PNG content-type:\n${diagramDocumentXml.slice(
        0,
        400
      )}`
    );
  }

  // VIZ-3: with the same diagram rendered, the PDF export must embed the
  // rasterized diagram as a real /DCTDecode image XObject (above the preserved
  // source) and still parse as a PDF. The mermaid card stays rendered from the
  // DOCX assertion above, so this just exports PDF and inspects the bytes.
  const diagramPdfExport = await downloadAssistantExport('PDF', 'assistant-response.pdf');
  const diagramPdfText = diagramPdfExport.toString('latin1');
  if (
    !diagramPdfText.startsWith('%PDF-1.4') ||
    !diagramPdfText.includes('startxref') ||
    !diagramPdfText.includes('%%EOF')
  ) {
    throw new Error(
      `rendered-diagram PDF export is not a parseable PDF: ${diagramPdfText.slice(0, 200)}`
    );
  }
  if (
    !diagramPdfText.includes('/Subtype /Image') ||
    !diagramPdfText.includes('/Filter /DCTDecode') ||
    !/\/XObject << \/Im1 \d+ 0 R >>/.test(diagramPdfText) ||
    !/\/Im1 Do/.test(diagramPdfText) ||
    !diagramPdfText.includes('Mermaid diagram source') ||
    !diagramPdfText.includes('graph TD')
  ) {
    throw new Error(
      'rendered-diagram PDF missing image XObject, resource wiring, draw op, or source'
    );
  }
  // The embedded JPEG /Length must match the real stream byte length so the
  // dynamic xref stays exact (the most delicate part of the PDF builder).
  const pdfLengthMatch = diagramPdfText.match(/\/Filter \/DCTDecode \/Length (\d+) >>\nstream\n/);
  if (!pdfLengthMatch) {
    throw new Error('rendered-diagram PDF image XObject did not declare a /Length');
  }
  {
    const declaredLength = Number(pdfLengthMatch[1]);
    const streamStart =
      diagramPdfText.indexOf('stream\n', pdfLengthMatch.index) + 'stream\n'.length;
    const streamEnd = diagramPdfText.indexOf('\nendstream', streamStart);
    if (streamEnd - streamStart !== declaredLength) {
      throw new Error(
        `rendered-diagram PDF image /Length ${declaredLength} != actual stream length ${
          streamEnd - streamStart
        }`
      );
    }
    // The embedded stream must be real JPEG bytes (SOI 0xFF 0xD8).
    if (diagramPdfExport[streamStart] !== 0xff || diagramPdfExport[streamStart + 1] !== 0xd8) {
      throw new Error('rendered-diagram PDF image stream is not JPEG (missing SOI marker)');
    }
  }

  const jsonExport = JSON.parse(
    (await downloadAssistantExport('JSON', 'assistant-response.json')).toString('utf8')
  );
  if (
    jsonExport.role !== 'assistant' ||
    !String(jsonExport.content || '').includes('Services agreement')
  ) {
    throw new Error(`JSON export lost assistant content: ${JSON.stringify(jsonExport)}`);
  }

  const threadMarkdownExport = (
    await downloadAssistantExport('Thread MD', 'ironclaw-chat-thread.md')
  ).toString('utf8');
  if (
    !threadMarkdownExport.includes('Draft a services agreement from this attachment.') ||
    !threadMarkdownExport.includes('services-template.docx') ||
    !threadMarkdownExport.includes('pricing-model.xlsx')
  ) {
    throw new Error(`Thread Markdown export lost prompt or attachments:\n${threadMarkdownExport}`);
  }

  const threadJsonExport = JSON.parse(
    (await downloadAssistantExport('Thread JSON', 'ironclaw-chat-thread.json')).toString('utf8')
  );
  const exportedAttachmentNames = JSON.stringify(threadJsonExport);
  if (
    threadJsonExport.thread?.message_count < 2 ||
    !exportedAttachmentNames.includes('services-template.docx') ||
    !exportedAttachmentNames.includes('pricing-model.xlsx') ||
    exportedAttachmentNames.includes('data_base64')
  ) {
    throw new Error(
      `Thread JSON export lost reload-safe attachment metadata:\n${exportedAttachmentNames}`
    );
  }

  await page.goto(`http://127.0.0.1:${port}${appBasePath}/chat/thread-fail`, {
    waitUntil: 'domcontentloaded'
  });
  const failureComposer = page.locator('textarea').first();
  await failureComposer.waitFor({ timeout: 20_000 });
  const failurePromptText = 'Trigger failed run-state recovery.';
  await failureComposer.click();
  await failureComposer.pressSequentially(failurePromptText);
  await page.waitForFunction(() => {
    const buttons = Array.from(document.querySelectorAll('button[aria-label="Send message"]'));
    const button = buttons.at(-1);
    return button && !button.disabled;
  });
  await page.locator('button[aria-label="Send message"]').last().click();
  try {
    // The SSE-drop fallback recovers the completed run from the timeline.
    await page
      .getByText(/Recovered from the timeline after the stream went quiet\./i)
      .first()
      .waitFor({
        timeout: 30_000
      });
  } catch (err) {
    await mkdir('output/playwright', { recursive: true });
    await page
      .screenshot({
        path: 'output/playwright/static-run-state-recovery-missing.png',
        fullPage: true
      })
      .catch(() => {});
    const visibleBody = await page
      .locator('body')
      .innerText()
      .catch(() => '<body unavailable>');
    throw new Error(
      `SSE-drop fallback did not recover the completed run from the timeline; requests=${JSON.stringify(
        {
          failedRunMessageRequests,
          failedRunTimelineRequests,
          failedRunStateRequests
        }
      )}; errors=${JSON.stringify(errors)}; body=${JSON.stringify(visibleBody)}`,
      { cause: err }
    );
  }
  if (!failedRunMessageRequests.length || !failedRunTimelineRequests.length) {
    throw new Error(
      `SSE-drop fallback did not exercise message+timeline routes: ${JSON.stringify({
        failedRunMessageRequests,
        failedRunTimelineRequests
      })}`
    );
  }
  // The client must read run state from the registered timeline, never the
  // unregistered bare GET /runs/{id} (which 404s on the real gateway).
  if (failedRunStateRequests.length) {
    throw new Error(
      `client hit the unregistered bare GET /runs/{id}: ${JSON.stringify(failedRunStateRequests)}`
    );
  }
  await page.screenshot({
    path: 'output/playwright/static-run-state-recovery-visible.png',
    fullPage: true
  });

  async function assertNoCatalogRefLifecycle() {
    const leaked = connectorRequests.find(
      (request) =>
        request.url.includes('tools%2F') ||
        request.url.includes('tools/') ||
        request.url.includes('mcp-servers%2F') ||
        request.url.includes('mcp-servers/') ||
        request.url.includes('channels%2F') ||
        request.url.includes('channels/')
    );
    if (leaked) {
      throw new Error(`connector lifecycle leaked catalog ref into ExtensionName: ${leaked.url}`);
    }
  }

  async function expectDeepLinkSetup(path, expectedLifecycleSuffix, expectedTitle, expectedCopy) {
    await page.goto(`http://127.0.0.1:${port}${appBasePath}${path}`, {
      waitUntil: 'domcontentloaded'
    });
    await page.getByText(expectedTitle, { exact: true }).waitFor({ timeout: 20_000 });
    if (expectedCopy) {
      await page.getByText(expectedCopy).waitFor({ timeout: 20_000 });
    }
    await page.locator('input[type="password"]').waitFor({ timeout: 20_000 });
    const lifecycleRequest = connectorRequests.find((request) =>
      request.url.endsWith(expectedLifecycleSuffix)
    );
    if (!lifecycleRequest) {
      throw new Error(
        `missing lifecycle request for ${expectedLifecycleSuffix}:\n${JSON.stringify(connectorRequests, null, 2)}`
      );
    }
    await assertNoCatalogRefLifecycle();
    await page.getByLabel('Close setup').click();
    await page.locator('input[type="password"]').waitFor({ state: 'detached', timeout: 20_000 });
  }

  await expectDeepLinkSetup(
    '/extensions/installed?focus=tools%2Fgmail&setup=1',
    '/api/webchat/v2/extensions/gmail/setup',
    'Configure Gmail',
    /Product Auth token returned by Google sign-in for Gmail/
  );
  await expectDeepLinkSetup(
    '/extensions/installed?focus=tools%2Fgoogle_calendar&setup=1',
    '/api/webchat/v2/extensions/google-calendar/setup',
    'Configure Google Calendar',
    /Product Auth token returned by Google sign-in for Calendar/
  );
  await expectDeepLinkSetup(
    '/extensions/mcp?focus=mcp-servers%2Fnotion&setup=1',
    '/api/webchat/v2/extensions/notion/setup',
    'Configure Notion',
    /Paste a Notion integration token/
  );

  const beforeSlackRequestCount = connectorRequests.length;
  await page.goto(
    `http://127.0.0.1:${port}${appBasePath}/extensions/channels?focus=channels%2Fslack&setup=1`,
    {
      waitUntil: 'domcontentloaded'
    }
  );
  await page.getByText('Slack', { exact: true }).first().waitFor({ timeout: 20_000 });
  await page.getByText('Configure Slack', { exact: true }).waitFor({ timeout: 20_000 });
  const slackLifecycleRequest = connectorRequests.find(
    (request, index) =>
      index >= beforeSlackRequestCount &&
      request.url.endsWith('/api/webchat/v2/extensions/slack/setup')
  );
  if (!slackLifecycleRequest) {
    throw new Error(
      `Slack deep link did not call bare lifecycle setup: ${JSON.stringify(connectorRequests, null, 2)}`
    );
  }
  await assertNoCatalogRefLifecycle();
  await page.getByLabel('Close setup').click();
  await page.locator('input[type="password"]').waitFor({ state: 'detached', timeout: 20_000 });

  await page.goto(`http://127.0.0.1:${port}${appBasePath}/extensions/installed`, {
    waitUntil: 'domcontentloaded'
  });
  await page.getByText('Gmail', { exact: true }).waitFor({ timeout: 20_000 });
  await assertNoLegacyConnectionsClasses(page.locator('body'), 'installed Connections');
  await page.screenshot({
    path: 'output/playwright/static-connections-installed-polished.png',
    fullPage: true
  });
  const preSetupText = await page.locator('body').innerText();
  if (preSetupText.includes('Gmail\nactive') || preSetupText.includes('Gmail\nACTIVE')) {
    throw new Error(
      `static connector UI claimed account readiness from package lifecycle only:\n${preSetupText}`
    );
  }
  await page.getByText('auth needed', { exact: true }).first().waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Configure' }).first().click();
  await page.getByText('Configure Gmail', { exact: true }).waitFor({ timeout: 20_000 });
  const connectorSetupModal = page.getByTestId('connector-setup-modal');
  await connectorSetupModal.waitFor({ state: 'visible', timeout: 20_000 });
  const legacySetupClasses = await connectorSetupModal.evaluate((modal) =>
    [modal, ...Array.from(modal.querySelectorAll('*'))]
      .flatMap((node) => String(node.getAttribute('class') || '').split(/\s+/))
      .filter((className) =>
        /^(text-iron-|border-white|bg-white\/|bg-white\[|v2-panel$)/.test(className)
      )
  );
  if (legacySetupClasses.length > 0) {
    throw new Error(
      `connector setup modal leaked old dark styling classes: ${legacySetupClasses.join(', ')}`
    );
  }
  await page.screenshot({
    path: 'output/playwright/static-connector-setup-modal.png',
    fullPage: true
  });
  await page.locator('input[type="password"]').fill('ya29.smoke-token');
  await page.locator('input[type="text"]').fill('Smoke Google');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('input[type="password"]').waitFor({
    state: 'detached',
    timeout: 20_000
  });
  await page.getByText('failed', { exact: true }).first().waitFor({ timeout: 20_000 });
  await page
    .getByText(
      'Backend can store this credential, but this connector runtime is not wired in this build yet.',
      {
        exact: true
      }
    )
    .waitFor({ timeout: 20_000 });
  const postSetupText = await page.locator('body').innerText();
  if (postSetupText.includes('Gmail connected') || postSetupText.includes('ready')) {
    throw new Error(
      `static connector UI claimed backend readiness from local credential state:\n${postSetupText}`
    );
  }
  const activateButtonsAfterBlockedConfigure = await page
    .getByRole('button', { name: 'Activate' })
    .count();
  if (activateButtonsAfterBlockedConfigure > 0) {
    throw new Error(
      `static connector UI exposed Activate after backend returned runtime blocker:\n${postSetupText}`
    );
  }

  const gmailConfigureRequest = connectorRequests.find(
    (request) =>
      request.url.endsWith('/api/webchat/v2/extensions/gmail/setup') &&
      request.body?.action === 'configure'
  );
  if (!gmailConfigureRequest) {
    throw new Error(
      `connector setup configure request missing:\n${JSON.stringify(connectorRequests, null, 2)}`
    );
  }
  if (
    gmailConfigureRequest.body.payload?.secrets?.token !== 'ya29.smoke-token' ||
    gmailConfigureRequest.body.payload?.fields?.account_label !== 'Smoke Google'
  ) {
    throw new Error(
      `connector setup configure body was wrong: ${JSON.stringify(gmailConfigureRequest.body)}`
    );
  }
  await assertNoCatalogRefLifecycle();
  if (!connectorRequests.every((request) => request.authorization === 'Bearer local-token')) {
    throw new Error(
      `connector requests missed local sidecar bearer:\n${JSON.stringify(connectorRequests, null, 2)}`
    );
  }
  if (errors.length) {
    throw new Error(`browser console errors:\n${errors.join('\n')}`);
  }
  await browser.close();
  console.log('PASS webui static desktop bootstrap smoke');
} catch (err) {
  console.error(serverOutput);
  throw err;
} finally {
  proxyProbeGateway?.close();
  server.kill();
}
