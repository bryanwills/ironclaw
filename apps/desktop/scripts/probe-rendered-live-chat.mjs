#!/usr/bin/env node
// Rendered live-chat proof: drives the REAL static UI (Playwright-rendered DOM)
// against a REAL Reborn sidecar booted exactly like the desktop's first run
// (NEAR.AI default backend, no credential), then proves:
//   1. First-run gate: /welcome onboarding renders because /llm/providers has
//      no active provider — no fake-ready chat.
//   2. NEAR.AI sign-in surfaces a real auth_url from
//      /api/webchat/v2/llm/nearai/login.
//   3. A provider configured through the real Settings routes
//      (upsert + set-active) flips the providers snapshot, and a chat prompt
//      then produces a REAL assistant reply rendered in the thread.
//   4. The user turn stays visible across a full page reload.
//
// Requires OPENROUTER_API_KEY in the environment for step 3 (never written to
// disk; screenshots are taken only outside the key-entry dialog). Skips the
// live-model leg with exit 2 when the key is absent.
//
// Artifacts: output/rendered-live-proof/<timestamp>/
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const bundledSidecar = path.join(
  repoRoot,
  'src-tauri/target/release/bundle/macos/IronClaw.app/Contents/MacOS/ironclaw-reborn',
);
const uiPort = Number(process.env.RENDERED_LIVE_PROOF_UI_PORT || '17640');
const model = process.env.RENDERED_LIVE_PROOF_MODEL || 'deepseek/deepseek-v4-pro';
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactDir = path.join(repoRoot, 'output/rendered-live-proof', timestamp);

const openrouterKey = process.env.OPENROUTER_API_KEY || '';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await mkdir(artifactDir, { recursive: true });
  const proof = { generated_at: new Date().toISOString(), model, steps: [] };
  const step = (name, passed, detail = {}) => {
    proof.steps.push({ name, status: passed ? 'PASS' : 'FAIL', detail });
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail).slice(0, 200)}`);
    if (!passed) throw new Error(`${name} failed`);
  };

  const sidecarPort = await freePort();
  const sidecarOrigin = `http://127.0.0.1:${sidecarPort}`;
  const token = `rendered-proof-${randomUUID()}`;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'ironclaw-rendered-proof-home-'));

  // Mirror the desktop spawn: hermetic env (sidecar.rs inherited_sidecar_env)
  // + the BackendConfig::Nearai first-run block, credential-less.
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(ANTHROPIC_|OPENAI_|OPENROUTER_|NEARAI_|LLM_)/.test(key),
    ),
  );
  const sidecar = spawn(bundledSidecar, ['serve', '--host', '127.0.0.1', '--port', String(sidecarPort)], {
    cwd: repoRoot,
    env: {
      ...inheritedEnv,
      HOME: homeDir,
      IRONCLAW_REBORN_WEBUI_TOKEN: token,
      IRONCLAW_REBORN_WEBUI_USER_ID: 'owner',
      GATEWAY_AUTH_TOKEN: token,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(sidecarPort),
      DATABASE_BACKEND: 'libsql',
      AGENT_NAME: 'ironclaw',
      GATEWAY_ENABLED: 'true',
      CLI_ENABLED: 'false',
      LLM_BACKEND: 'nearai',
      NEARAI_BASE_URL: 'https://private.near.ai',
      NEARAI_API_URL: 'https://private.near.ai/v1',
      NEARAI_MODEL: 'auto',
      IRONCLAW_OAUTH_EXCHANGE_URL: 'https://ironclaw-oauth.up.railway.app',
      IRONCLAW_OAUTH_CALLBACK_URL: 'https://ironclaw-oauth.up.railway.app',
      RUST_LOG: process.env.RUST_LOG || 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sidecarLog = [];
  sidecar.stdout.on('data', (chunk) => sidecarLog.push(String(chunk)));
  sidecar.stderr.on('data', (chunk) => sidecarLog.push(String(chunk)));

  const ui = spawn('node', ['scripts/serve-webui-static.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(uiPort), IRONCLAW_GATEWAY_ORIGIN: sidecarOrigin },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  const nodeFetchSidecar = (pathname, init = {}) =>
    fetch(`${sidecarOrigin}${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });

  let browser = null;
  try {
    // Wait for both processes.
    let healthy = false;
    for (let i = 0; i < 80 && !healthy; i += 1) {
      if (sidecar.exitCode != null) throw new Error(`sidecar exited: ${sidecarLog.join('').slice(-800)}`);
      try {
        healthy = (await nodeFetchSidecar('/api/webchat/v2/threads')).ok;
      } catch (_) { /* booting */ }
      if (!healthy) await delay(250);
    }
    step('live sidecar healthy', healthy, { origin: sidecarOrigin });

    let uiUp = false;
    for (let i = 0; i < 40 && !uiUp; i += 1) {
      try {
        uiUp = (await fetch(`http://127.0.0.1:${uiPort}/index.html`)).ok;
      } catch (_) { /* booting */ }
      if (!uiUp) await delay(250);
    }
    step('static UI server up', uiUp, { port: uiPort });

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Tauri shim: desktop IPC surface backed by the live sidecar.
    await page.addInitScript(
      ({ sidecarPort, token, sidecarOrigin }) => {
        window.localStorage.setItem('ironclaw:desktop-gateway-origin', sidecarOrigin);
        async function dispatch(command, args) {
          switch (command) {
            case 'get_settings':
              return {
                activeProfileId: 'default',
                profiles: [
                  {
                    id: 'default',
                    name: 'Default',
                    mode: 'local',
                    remoteBaseUrl: sidecarOrigin,
                    localBaseUrl: sidecarOrigin,
                    llmBackend: 'nearai',
                    llmProviderId: 'nearai',
                    llmModelId: 'auto',
                    apiVersion: 'v2'
                  }
                ],
                onboardingComplete: false
              };
            case 'sidecar_status':
              return { running: true, port: sidecarPort };
            case 'get_token':
            case 'get_or_create_local_token':
              return token;
            case 'set_token':
            case 'diag_log':
              return null;
            case 'plugin:shell|open':
            case 'plugin:opener|open_url':
              window.__openedUrls = window.__openedUrls || [];
              window.__openedUrls.push(args?.path || args?.url || '');
              return null;
            case 'gateway_http_fetch': {
              const req = args?.request;
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
      { sidecarPort, token, sidecarOrigin },
    );

    // CORS bypass: fulfill sidecar requests from Node. SSE streams cannot be
    // fulfilled (buffered) — abort them so the app degrades to polling.
    await page.route(`${sidecarOrigin}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith('/events')) {
        await route.abort();
        return;
      }
      try {
        const response = await fetch(request.url(), {
          method: request.method(),
          headers: request.headers(),
          body: ['GET', 'HEAD'].includes(request.method()) ? undefined : request.postDataBuffer(),
        });
        const body = Buffer.from(await response.arrayBuffer());
        const headers = {};
        response.headers.forEach((value, key) => {
          if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
            headers[key] = value;
          }
        });
        await route.fulfill({ status: response.status, headers, body });
      } catch (err) {
        await route.abort();
      }
    });

    // ---- Step 1: honest first-run gate ----
    await page.goto(`http://127.0.0.1:${uiPort}/v2/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const welcomeVisible = await page
      .getByText(/Welcome to IronClaw/i)
      .first()
      .isVisible()
      .catch(() => false);
    await page.screenshot({ path: path.join(artifactDir, '01-first-run-onboarding.png'), fullPage: false });
    step('first-run renders onboarding (no active provider)', welcomeVisible, {
      url: page.url()
    });

    // ---- Step 2: NEAR.AI login surfaces a real auth_url ----
    const loginProbe = await nodeFetchSidecar('/api/webchat/v2/llm/nearai/login', {
      method: 'POST',
      body: JSON.stringify({ provider: 'github' }),
    });
    const loginBody = await loginProbe.json().catch(() => ({}));
    proof.nearai_login = { status: loginProbe.status, has_auth_url: Boolean(loginBody?.auth_url) };
    step('NEAR.AI login route returns auth_url', Boolean(loginBody?.auth_url), {
      status: loginProbe.status,
      auth_url_host: loginBody?.auth_url ? new URL(loginBody.auth_url).host : null,
    });

    const githubButton = page.getByRole('button', { name: 'GitHub' }).first();
    const githubVisible = await githubButton.isVisible().catch(() => false);
    step('NEAR.AI GitHub sign-in rendered in onboarding', githubVisible, {});

    if (!openrouterKey) {
      proof.live_model_leg = 'skipped: OPENROUTER_API_KEY not set';
      await writeFile(path.join(artifactDir, 'proof.json'), JSON.stringify(proof, null, 2));
      console.log(`artifacts: ${artifactDir}`);
      process.exitCode = 2;
      return;
    }

    // ---- Step 3: configure a real provider through the real routes ----
    const upsert = await nodeFetchSidecar('/api/webchat/v2/llm/providers', {
      method: 'POST',
      body: JSON.stringify({
        id: 'openrouter',
        name: 'OpenRouter',
        adapter: 'openai_compatible',
        base_url: 'https://openrouter.ai/api/v1',
        default_model: model,
        api_key: openrouterKey,
        set_active: true,
        model,
      }),
    });
    step('provider upsert + set-active accepted', upsert.ok, { status: upsert.status });

    const providers = await (await nodeFetchSidecar('/api/webchat/v2/llm/providers')).json();
    proof.active_provider = providers?.active || null;
    step('providers snapshot shows active provider', Boolean(providers?.active?.provider_id), {
      provider_id: providers?.active?.provider_id || null,
      model: providers?.active?.model || null,
    });

    // ---- Step 4: rendered chat send -> real assistant reply ----
    await page.goto(`http://127.0.0.1:${uiPort}/v2/index.html#/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(artifactDir, '02-chat-after-provider-active.png') });

    const composer = page.locator('textarea').first();
    const composerVisible = await composer.isVisible().catch(() => false);
    step('chat composer rendered once provider active', composerVisible, { url: page.url() });

    const promptText = 'Reply with exactly: IR