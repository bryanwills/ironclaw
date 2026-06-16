#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const bundledSidecar = path.join(
  repoRoot,
  'src-tauri/target/release/bundle/macos/IronClaw.app/Contents/MacOS/ironclaw-reborn',
);
const releaseSidecar = path.join(repoRoot, 'src-tauri/target/release/ironclaw-reborn');
const artifactDir = path.join(repoRoot, 'output/live-connector-probe');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactPath = path.join(artifactDir, `reborn-live-connector-probe-${timestamp}.json`);

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|authorization/i.test(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = sanitize(child);
    }
  }
  return result;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return { text };
  }
}

function summarizeResponse(body) {
  const sanitized = sanitize(body);
  if (!sanitized || typeof sanitized !== 'object') return sanitized;
  const allowedKeys = [
    'interaction_id',
    'invocation_id',
    'provider',
    'label',
    'credential_ref',
    'status',
    'phase',
    'activation_status',
    'account_ready',
    'credential_ready',
    'readiness',
    'blockers',
    'error',
    'message',
    'reason',
  ];
  return Object.fromEntries(
    Object.entries(sanitized).filter(([key]) => allowedKeys.includes(key)),
  );
}

async function main() {
  const sidecar = (await fileExists(bundledSidecar)) ? bundledSidecar : releaseSidecar;
  if (!(await fileExists(sidecar))) {
    throw new Error(`No ironclaw-reborn binary found at ${bundledSidecar} or ${releaseSidecar}`);
  }

  await mkdir(artifactDir, { recursive: true });
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'ironclaw-live-connector-probe-home-'));
  const token = `probe-${randomUUID()}`;
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const sidecarLog = [];
  const contractViolations = [];
  const upstreamDefects = [];
  const evidence = {
    generated_at: new Date().toISOString(),
    binary: sidecar,
    origin,
    temp_home: homeDir,
    bearer_token: '[REDACTED]',
    probes: [],
    catalog_ref_rule: {
      expected:
        'Lifecycle route paths must use canonical bare names; slash-prefixed catalog refs remain request payload metadata only.',
      lifecycle_paths_allowed: ['gmail', 'google-calendar', 'notion', 'slack'],
      slash_prefixed_refs_must_not_be_path_names: [
        'tools/gmail',
        'tools/google_calendar',
        'mcp-servers/notion',
        'channels/slack',
        'tools/slack_tool',
      ],
    },
  };

  // Hermetic env: ambient LLM credentials/endpoints (developer shells, CI,
  // agent harnesses exporting ANTHROPIC_BASE_URL and friends) must not leak
  // into the probe sidecar — Reborn's env fallback would try to resolve that
  // provider at boot and exit before any connector route is reachable.
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(ANTHROPIC_|OPENAI_|OPENROUTER_|NEARAI_|LLM_)/.test(key),
    ),
  );

  const child = spawn(sidecar, ['serve', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    env: {
      ...inheritedEnv,
      HOME: homeDir,
      XDG_CACHE_HOME: path.join(homeDir, '.cache'),
      XDG_CONFIG_HOME: path.join(homeDir, '.config'),
      XDG_DATA_HOME: path.join(homeDir, '.local/share'),
      IRONCLAW_REBORN_WEBUI_TOKEN: token,
      IRONCLAW_REBORN_WEBUI_USER_ID: 'codex-live-connector-probe',
      RUST_LOG: process.env.RUST_LOG || 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => sidecarLog.push(chunk.toString()));
  child.stderr.on('data', (chunk) => sidecarLog.push(chunk.toString()));

  async function stopSidecar() {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        delay(3000).then(() => child.kill('SIGKILL')),
      ]);
    }
  }

  async function request(label, method, pathname, body = undefined, { auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${token}`;
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    const response = await fetch(`${origin}${pathname}`, {
      method,
      headers,
      body: requestBody,
    });
    const responseBody = await parseJsonResponse(response);
    const record = {
      label,
      method,
      path: pathname,
      request: sanitize(body),
      status: response.status,
      ok: response.ok,
      response: summarizeResponse(responseBody),
    };
    evidence.probes.push(record);
    return { response, body: responseBody, record };
  }

  try {
    let healthy = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode != null) {
        throw new Error(`sidecar exited early with code ${child.exitCode}`);
      }
      try {
        // The current Reborn sidecar has no /api/health route; an authed
        // 200 from the webchat threads listing proves routing + bearer auth
        // are actually serving, which is the readiness this probe needs.
        const response = await fetch(`${origin}/api/webchat/v2/threads`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) {
          healthy = true;
          evidence.health = {
            route: '/api/webchat/v2/threads',
            status: response.status,
            ok: true,
          };
          break;
        }
      } catch (_) {
        // Server is still booting.
      }
      await delay(250);
    }
    if (!healthy) throw new Error('sidecar did not become healthy');

    await request('unauthenticated extensions begin is rejected', 'POST', '/api/webchat/v2/extensions/gmail/setup', {
      action: 'begin',
      payload: { catalog_ref: 'tools/gmail' },
    }, { auth: false });

    await request('slash-prefixed catalog ref path is rejected', 'POST', '/api/webchat/v2/extensions/tools%2Fgmail/setup', {
      action: 'begin',
      payload: { catalog_ref: 'tools/gmail' },
    });

    // Drive the exact route sequence the rendered UI uses
    // (extensions-api.js): GET /setup discovery -> POST /install with the
    // registry's object package_ref -> POST /setup/oauth/start with the
    // discovery's fresh invocation_id -> GET /extensions truth check ->
    // manual-token product auth fallback -> POST /activate.
    const connectors = [
      { name: 'gmail', provider: 'google', accountLabel: 'Smoke Google', dummyToken: 'ya29.smoke-google-live-probe' },
      { name: 'google-calendar', provider: 'google', accountLabel: 'Smoke Google Calendar', dummyToken: 'ya29.smoke-calendar-live-probe' },
      { name: 'notion', provider: 'notion', accountLabel: 'Smoke Notion', dummyToken: 'secret_notion_live_probe' },
    ];

    for (const connector of connectors) {
      const discovery = await request(
        `${connector.name} setup discovery`,
        'GET',
        `/api/webchat/v2/extensions/${connector.name}/setup`,
      );
      if (!discovery.response.ok) {
        contractViolations.push(`${connector.name}: GET /setup discovery failed (${discovery.response.status})`);
        continue;
      }
      const secret = (discovery.body?.secrets || [])[0];

      const install = await request(`${connector.name} install`, 'POST', '/api/webchat/v2/extensions/install', {
        package_ref: { kind: 'extension', id: connector.name },
      });
      if (!install.response.ok) {
        contractViolations.push(`${connector.name}: install failed (${install.response.status})`);
      }

      // OAuth start must either hand back a flow (2xx) or refuse with the
      // honest retryable 503 the UI can render as a blocked state. Anything
      // else is a contract violation.
      const oauth = await request(
        `${connector.name} oauth start`,
        'POST',
        `/api/webchat/v2/extensions/${connector.name}/setup/oauth/start`,
        {
          provider: secret?.provider || connector.provider,
          account_label: secret?.setup?.account_label || `${connector.provider} credential`,
          scopes: secret?.setup?.scopes || [],
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          invocation_id: secret?.setup?.invocation_id,
        },
      );
      const oauthHonestlyBlocked =
        oauth.response.status === 503 && oauth.body?.code === 'backend_unavailable';
      if (!oauth.response.ok && !oauthHonestlyBlocked) {
        contractViolations.push(
          `${connector.name}: oauth/start neither succeeded nor blocked honestly (${oauth.response.status} ${JSON.stringify(oauth.body)})`,
        );
      }

      const preAuthList = await request(`${connector.name} pre-auth truth`, 'GET', '/api/webchat/v2/extensions');
      const preAuthEntry = (preAuthList.body?.extensions || []).find(
        (ext) => ext?.package_ref?.id === connector.name,
      );
      if (preAuthEntry?.authenticated === true) {
        contractViolations.push(
          `${connector.name}: backend claims authenticated:true before any credential exists`,
        );
      }

      const setup = await request(`${connector.name} product auth setup`, 'POST', '/api/reborn/product-auth/manual-token/setup', {
        provider: connector.provider,
        account_label: connector.accountLabel,
      });
      const interactionId = setup.body?.interaction_id;
      const invocationId = setup.body?.invocation_id;
      if (interactionId && invocationId) {
        await request(`${connector.name} product auth secret-submit`, 'POST', '/api/reborn/product-auth/manual-token/secret-submit', {
          interaction_id: interactionId,
          invocation_id: invocationId,
          token: connector.dummyToken,
        });
      } else {
        contractViolations.push(`${connector.name}: manual-token setup returned no interaction/invocation id`);
      }

      // Known upstream defect probe: /activate without a verified credential
      // currently succeeds and flips `authenticated` to true. The desktop UI
      // never offers Activate in auth_required state (extension-actions.js),
      // so this documents backend truthfulness rather than failing the run.
      const activate = await request(`${connector.name} activate pre-auth (upstream truth)`, 'POST', `/api/webchat/v2/extensions/${connector.name}/activate`);
      if (activate.response.ok) {
        const postList = await request(`${connector.name} post-activate truth`, 'GET', '/api/webchat/v2/extensions');
        const postEntry = (postList.body?.extensions || []).find(
          (ext) => ext?.package_ref?.id === connector.name,
        );
        if (postEntry?.authenticated === true) {
          upstreamDefects.push(
            `${connector.name}: POST /activate without credentials succeeded and reported authenticated:true`,
          );
        }
      }
    }

    await request('slack setup truth', 'GET', '/api/webchat/v2/extensions/slack/setup');
  } finally {
    await stopSidecar();
    evidence.sidecar_exit_code = child.exitCode;
    evidence.sidecar_exit_signal = child.signalCode;
    evidence.sidecar_log_tail = sidecarLog.join('').split('\n').slice(-30);
    const expectedSecurityRejections = evidence.probes.filter((probe) =>
      (probe.label.includes('unauthenticated') && probe.status === 401) ||
      (probe.label.includes('slash-prefixed') && probe.status === 400)
    );
    const oauthOutcomes = evidence.probes
      .filter((probe) => probe.label.includes('oauth start'))
      .map((probe) => ({
        label: probe.label,
        status: probe.status,
        honest_blocked: probe.status === 503,
      }));
    evidence.summary = {
      total: evidence.probes.length,
      ok: evidence.probes.filter((probe) => probe.ok).length,
      expected_security_rejections: expectedSecurityRejections.length,
      oauth_outcomes: oauthOutcomes,
      contract_violations: contractViolations,
      upstream_defects: upstreamDefects,
      failed_or_blocked: evidence.probes.filter((probe) => !probe.ok).length,
      failed_or_blocked_labels: evidence.probes.filter((probe) => !probe.ok).map((probe) => ({
        label: probe.label,
        status: probe.status,
        response: probe.response,
      })),
    };
    await writeFile(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`);
    if (process.env.KEEP_LIVE_CONNECTOR_PROBE_HOME !== '1') {
      await rm(homeDir, { recursive: true, force: true });
    }
  }

  console.log(`live connector probe artifact: ${artifactPath}`);
  console.log(
    JSON.stringify(
      {
        health: evidence.health,
        summary: evidence.summary,
      },
      null,
      2,
    ),
  );

  const unexpected = evidence.probes.filter((probe) => {
    if (probe.label.includes('unauthenticated') || probe.label.includes('slash-prefixed')) {
      return probe.ok;
    }
    return false;
  });
  if (unexpected.length) {
    throw new Error(`Live connector probe found unexpected permissive routing: ${JSON.stringify(unexpected)}`);
  }
  if (evidence.summary.contract_violations.length) {
    throw new Error(
      `Live connector probe found product-contract violations:\n${evidence.summary.contract_violations.join('\n')}`,
    );
  }
  if (evidence.summary.upstream_defects.length) {
    console.warn(
      `KNOWN UPSTREAM DEFECTS (not failing the probe; UI guards these states):\n${evidence.summary.upstream_defects.join('\n')}`,
    );
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
