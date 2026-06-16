#!/usr/bin/env node
// Capture clean README screenshots of the CURRENT shipped static UI against a
// live sidecar. Unlike capture-design-surfaces.mjs, browser requests to the
// sidecar origin are intercepted and fulfilled node-side (page.route), so there
// is no cross-origin CORS failure — every data-backed surface renders fully.
//
// Prereqs: a sidecar on IRONCLAW_DESIGN_GATEWAY (default :3700) whose bearer is
// in IRONCLAW_DESIGN_TOKEN_FILE (default /tmp/ironclaw-design-token.txt).
import { chromium, request as pwRequest } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.env.DESIGN_PORT || '17656');
const gatewayOrigin = process.env.IRONCLAW_DESIGN_GATEWAY || 'http://127.0.0.1:3700';
const tokenFile = process.env.IRONCLAW_DESIGN_TOKEN_FILE || '/tmp/ironclaw-design-token.txt';
const appBasePath = '/v2';
const outDir = path.resolve('output/readme-shots');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/index.html`);
      if (r.ok) return;
    } catch {
      /* keep waiting */
    }
    await wait(250);
  }
  throw new Error('static server did not start');
}

function installShim(page, token) {
  return page.addInitScript(
    ({ gatewayOrigin, token }) => {
      window.localStorage.setItem('ironclaw:desktop-gateway-origin', gatewayOrigin);
      window.sessionStorage.setItem('ironclaw_token', token);
      window.localStorage.setItem('ironclaw:v2-theme', 'dark');
      const state = {
        settings: {
          activeProfileId: 'default',
          profiles: [
            {
              id: 'default',
              name: 'Default',
              mode: 'remote',
              remoteBaseUrl: gatewayOrigin,
              localBaseUrl: gatewayOrigin,
              llmBackend: 'nearai',
              llmProviderId: 'nearai',
              llmModelId: 'auto',
              apiVersion: 'v2'
            }
          ],
          onboardingComplete: true
        }
      };
      async function dispatch(command, args) {
        switch (command) {
          case 'get_settings':
            return JSON.parse(JSON.stringify(state.settings));
          case 'save_settings':
            state.settings = args?.settings || state.settings;
            return null;
          case 'sidecar_status':
            return { running: true, port: Number(new URL(gatewayOrigin).port) };
          case 'get_token':
          case 'get_or_create_local_token':
            return token;
          case 'gateway_http_fetch': {
            const req = args?.request;
            const res = await window.fetch(req.url, {
              method: req.method || 'GET',
              headers: req.headers ? Object.fromEntries(req.headers) : undefined,
              body: req.data ? new Uint8Array(req.data) : undefined
            });
            return {
              status: res.status,
              status_text: res.statusText,
              url: res.url,
              headers: Array.from(res.headers.entries()),
              data: Array.from(new Uint8Array(await res.arrayBuffer()))
            };
          }
          case 'diag_log':
            return null;
          default:
            return null;
        }
      }
      window.__TAURI_INTERNALS__ = {
        invoke: (command, args) => dispatch(command, args),
        transformCallback: () => 0,
        metadata: { currentWindow: { label: 'main' }, windows: [] }
      };
    },
    { gatewayOrigin, token }
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function buildContactSheet(browser, surfaces) {
  const tiles = [];
  for (const surface of surfaces) {
    const file = path.join(outDir, `${surface.name}.png`);
    try {
      const data = await readFile(file);
      tiles.push({
        name: surface.name,
        path: surface.path,
        src: `data:image/png;base64,${data.toString('base64')}`
      });
    } catch {
      /* CAPTURE_ONLY may intentionally leave a surface absent. */
    }
  }
  if (!tiles.length) return null;

  const sheet = await browser.newPage({
    viewport: { width: 1680, height: Math.max(1100, 420 * Math.ceil(tiles.length / 2) + 180) },
    deviceScaleFactor: 1
  });
  await sheet.setContent(
    `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <style>
            @font-face {
              font-family: "Inter Variable";
              src: local("Inter Variable"), local("Inter");
              font-weight: 100 900;
            }
            * { box-sizing: border-box; }
            body {
              margin: 0;
              padding: 32px;
              background: #090a0c;
              color: #f6f3ed;
              font-family: "Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            header {
              display: flex;
              align-items: end;
              justify-content: space-between;
              margin-bottom: 24px;
            }
            h1 {
              margin: 0;
              font-size: 28px;
              line-height: 1.05;
              letter-spacing: 0;
              font-weight: 760;
            }
            .stamp {
              color: #9b9388;
              font-size: 13px;
            }
            .grid {
              display: grid;
              grid-template-columns: repeat(2, minmax(0, 1fr));
              gap: 20px;
            }
            .tile {
              overflow: hidden;
              border: 1px solid rgba(246, 243, 237, 0.13);
              background: #111315;
              border-radius: 8px;
            }
            .label {
              display: flex;
              justify-content: space-between;
              gap: 16px;
              padding: 10px 12px;
              border-bottom: 1px solid rgba(246, 243, 237, 0.1);
              color: #d9d2c8;
              font-size: 12px;
              font-weight: 650;
              letter-spacing: 0;
            }
            .label span:last-child {
              color: #857d73;
              font-weight: 520;
            }
            img {
              display: block;
              width: 100%;
              height: auto;
            }
          </style>
        </head>
        <body>
          <header>
            <h1>IronClaw Desktop current surfaces</h1>
            <div class="stamp">Generated from shipped static UI</div>
          </header>
          <main class="grid">
            ${tiles
              .map(
                (tile) => `<section class="tile">
                  <div class="label"><span>${escapeHtml(tile.name)}</span><span>${escapeHtml(tile.path)}</span></div>
                  <img src="${tile.src}" alt="${escapeHtml(tile.name)}" />
                </section>`
              )
              .join('')}
          </main>
        </body>
      </html>`,
    { waitUntil: 'load' }
  );
  const file = path.join(outDir, 'contact-sheet.png');
  await sheet.screenshot({ path: file, fullPage: true });
  await sheet.close();
  return file;
}

async function main() {
  const token = (await readFile(tokenFile, 'utf8')).trim();
  await mkdir(outDir, { recursive: true });
  const server = spawn('node', ['scripts/serve-webui-static.mjs'], {
    env: { ...process.env, PORT: String(port), IRONCLAW_GATEWAY_ORIGIN: gatewayOrigin },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  // Node-side request context to fulfil intercepted sidecar calls (no CORS).
  const api = await pwRequest.newContext();
  try {
    await waitForServer();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 860 },
      deviceScaleFactor: 2
    });
    // Intercept every browser request to the sidecar origin and fulfil it
    // from node — same-origin to the page, so no CORS preflight failure.
    const forceReady = process.env.CAPTURE_READY === '1';
    const chatMode = process.env.CAPTURE_MODE === 'chat';
    await page.route(`${gatewayOrigin}/**`, async (route) => {
      const req = route.request();
      const u = req.url();
      // Chat-hero mode: force the desktop fallback (status/providers "fail" so
      // the UI renders the chat surface for nearai instead of the provider
      // gate), while listing endpoints return clean empties (no error banner).
      if (chatMode) {
        const json = (obj) =>
          route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(obj)
          });
        if (/\/api\/gateway\/status/.test(u)) {
          return json({
            engine_v2_enabled: true,
            restart_enabled: true,
            total_connections: 0,
            llm_backend: 'nearai',
            llm_model: 'auto',
            model_readiness: 'ready',
            model_execution_readiness: 'ready',
            model_execution_verified: true
          });
        }
        if (/\/auth\/providers/.test(u)) {
          return json({
            providers: [{ id: 'nearai', name: 'NEAR AI Cloud', enabled: true }]
          });
        }
        if (/\/llm\/providers/.test(u)) {
          return json({
            providers: [
              {
                id: 'nearai',
                name: 'NEAR AI',
                builtin: true,
                api_key_set: true,
                has_api_key: true,
                adapter: 'nearai',
                default_model: 'auto'
              }
            ],
            active: { provider_id: 'nearai', model: 'auto' }
          });
        }
        if (/\/llm\/active/.test(u)) {
          return json({ provider_id: 'nearai', model: 'auto' });
        }
        if (/\/llm\/list-models/.test(u)) {
          return json({
            ok: true,
            models: ['auto', 'nearai:gpt-oss-120b', 'nearai:llama-3.3-70b']
          });
        }
        if (/\/channels\/connectable/.test(u)) {
          return json({ channels: [] });
        }
        if (/\/extensions\/registry/.test(u)) {
          return json({
            entries: [
              {
                id: 'gmail',
                display_name: 'Gmail',
                kind: 'wasm_tool',
                description: 'Read, triage, draft, and prepare email work with approval gates.',
                package_ref: { kind: 'extension', id: 'tools/gmail' },
                installed: false,
                keywords: ['email', 'google', 'inbox']
              },
              {
                id: 'google-calendar',
                display_name: 'Google Calendar',
                kind: 'wasm_tool',
                description: 'Find meetings, protect focus blocks, and prepare schedule changes.',
                package_ref: { kind: 'extension', id: 'tools/google_calendar' },
                installed: false,
                keywords: ['calendar', 'google', 'schedule']
              },
              {
                id: 'notion',
                display_name: 'Notion',
                kind: 'mcp_server',
                description: 'Search team knowledge, draft pages, and keep decisions visible.',
                package_ref: { kind: 'extension', id: 'mcp-servers/notion' },
                installed: false,
                keywords: ['knowledge', 'docs', 'wiki']
              },
              {
                id: 'slack',
                display_name: 'Slack',
                kind: 'wasm_channel',
                description: 'Summarize channels, prepare replies, and surface urgent asks.',
                package_ref: { kind: 'extension', id: 'channels/slack' },
                installed: false,
                keywords: ['messages', 'team', 'channels']
              }
            ]
          });
        }
        if (/\/extensions$/.test(u)) {
          return json({ extensions: [] });
        }
        if (/\/threads(\?|$)|\/automations|\/timeline/.test(u)) {
          const empty = /\/automations/.test(u)
            ? '{"automations":[]}'
            : '{"threads":[],"messages":[],"next_cursor":null}';
          return route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: empty
          });
        }
        if (req.method() === 'OPTIONS') {
          return route.fulfill({ status: 204 });
        }
        return json({});
      }
      try {
        const headers = { ...req.headers(), authorization: `Bearer ${token}` };
        const resp = await api.fetch(req.url(), {
          method: req.method(),
          headers,
          data: req.postDataBuffer() || undefined
        });
        let body = await resp.body();
        const respHeaders = resp.headers();
        // For chat/extensions shots, present the provider as verified so the UI
        // renders the working surface instead of the provider-setup gate.
        if (forceReady && req.url().includes('/api/gateway/status')) {
          try {
            const status = JSON.parse(body.toString('utf8') || '{}');
            status.model_readiness = 'ready';
            status.model_execution_readiness = 'ready';
            status.model_execution_verified = true;
            delete status.model_execution_failure_category;
            delete status.model_execution_failure_summary;
            delete status.model_readiness_reason;
            status.llm_backend = status.llm_backend || 'nearai';
            status.llm_model = status.llm_model || 'auto';
            body = Buffer.from(JSON.stringify(status));
            respHeaders['content-length'] = String(body.length);
          } catch {
            /* leave body as-is */
          }
        }
        route.fulfill({ status: resp.status(), headers: respHeaders, body });
      } catch (e) {
        route.fulfill({ status: 502, body: String(e) });
      }
    });

    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    await installShim(page, token);

    const allSurfaces = [
      { name: 'chat', path: '/chat' },
      { name: 'extensions', path: '/extensions' },
      { name: 'extensions-registry', path: '/extensions/registry' },
      { name: 'settings-inference', path: '/settings/inference' },
      { name: 'onboarding-welcome', path: '/welcome' }
    ];
    // CAPTURE_ONLY="chat,extensions" lets a second (ready-mode) pass overwrite
    // just those surfaces without clobbering the welcome/settings shots.
    const only = (process.env.CAPTURE_ONLY || '').split(',').filter(Boolean);
    const surfaces = only.length ? allSurfaces.filter((s) => only.includes(s.name)) : allSurfaces;
    const results = [];
    for (const surface of surfaces) {
      await page.goto(`http://127.0.0.1:${port}${appBasePath}${surface.path}`, {
        waitUntil: 'networkidle'
      });
      await wait(2000);
      const file = path.join(outDir, `${surface.name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      results.push({ surface: surface.name, file });
    }
    const contactSheet = await buildContactSheet(browser, allSurfaces);
    if (contactSheet) results.push({ surface: 'contact-sheet', file: contactSheet });
    await browser.close();
    console.log(JSON.stringify({ results, consoleErrors: consoleErrors.slice(0, 6) }, null, 2));
  } finally {
    await api.dispose();
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
