#!/usr/bin/env node
// Render the real static UI against a live sidecar and screenshot the key
// design surfaces (onboarding, inference settings, extensions, chat). For a
// VERIFIED design review — not a blind one. Point at a running sidecar via
// IRONCLAW_DESIGN_GATEWAY (default http://127.0.0.1:3700) with its bearer in
// IRONCLAW_DESIGN_TOKEN_FILE (default /tmp/ironclaw-design-token.txt).
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.env.DESIGN_PORT || '17655');
const gatewayOrigin = process.env.IRONCLAW_DESIGN_GATEWAY || 'http://127.0.0.1:3700';
const tokenFile = process.env.IRONCLAW_DESIGN_TOKEN_FILE || '/tmp/ironclaw-design-token.txt';
const appBasePath = '/v2';
const outDir = path.resolve('output/design-capture');

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
          onboardingComplete: false
        }
      };
      async function dispatch(command, args) {
        switch (command) {
          case 'get_settings':
            return JSON.parse(JSON.stringify(state.settings));
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

async function main() {
  const token = (await readFile(tokenFile, 'utf8')).trim();
  await mkdir(outDir, { recursive: true });
  const server = spawn('node', ['scripts/serve-webui-static.mjs'], {
    env: { ...process.env, PORT: String(port), IRONCLAW_GATEWAY_ORIGIN: gatewayOrigin },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', (c) => (serverLog += c));
  server.stderr.on('data', (c) => (serverLog += c));

  try {
    await waitForServer();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    await installShim(page, token);

    const surfaces = [
      { name: 'onboarding-welcome', path: '/welcome' },
      { name: 'settings-inference', path: '/settings/inference' },
      { name: 'extensions-registry', path: '/extensions' },
      { name: 'chat-empty', path: '/chat' }
    ];
    const results = [];
    for (const surface of surfaces) {
      await page.goto(`http://127.0.0.1:${port}${appBasePath}${surface.path}`, {
        waitUntil: 'networkidle'
      });
      await wait(1500);
      const file = path.join(outDir, `${surface.name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      const heading = await page
        .locator('h1, h2')
        .first()
        .innerText()
        .catch(() => '');
      results.push({ surface: surface.name, path: surface.path, file, heading: heading.slice(0, 80) });
    }
    // Dark mode pass on onboarding for the hero typography check.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`http://127.0.0.1:${port}${appBasePath}/welcome`, { waitUntil: 'networkidle' });
    await wait(1200);
    await page.screenshot({ path: path.join(outDir, 'onboarding-welcome-dark.png') });

    await browser.close();
    console.log(JSON.stringify({ results, consoleErrors: consoleErrors.slice(0, 8) }, null, 2));
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
