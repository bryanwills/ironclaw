#!/usr/bin/env node
// Acceptance gate for a candidate ironclaw-reborn binary before we bundle it.
//
// Spawns the GIVEN binary (arg 1, or $CANDIDATE_SIDECAR) on a temp port with
// the same hermetic env the desktop uses, then checks every WebChat v2
// contract our static UI depends on — plus the specific risks in the
// reborn-integration -> main delta:
//   * #4623 CSRF/origin/CORS limits   -> our WebView requests must still pass
//   * #4624 sanitized error shapes     -> error envelope still { code, message }
//   * #4552/#4546 SSE projection path  -> run_status events still stream
//   * additive routes we want to gain  -> automations/runs, channels/slack/*
//
// Exit 0 = safe to swap. Non-zero = contract drift; do NOT swap.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const candidate =
  process.argv[2] ||
  process.env.CANDIDATE_SIDECAR ||
  '/tmp/ironclaw-main-target/release/ironclaw-reborn';
const artifactDir = path.join(repoRoot, 'output/new-sidecar-acceptance');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Mirror src-tauri/src/sidecar.rs: clear ambient provider vars, NEAR.AI block.
function hermeticEnv(extra) {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(ANTHROPIC_|OPENAI_|OPENROUTER_|NEARAI_|LLM_)/.test(k)
    )
  );
  return {
    ...base,
    LLM_BACKEND: 'nearai',
    NEARAI_BASE_URL: 'https://private.near.ai',
    NEARAI_API_URL: 'https://private.near.ai/v1',
    NEARAI_MODEL: 'auto',
    ...extra
  };
}

async function main() {
  await mkdir(artifactDir, { recursive: true });
  const home = await mkdtemp(path.join(os.tmpdir(), 'ironclaw-accept-'));
  const token = `accept-${randomUUID()}`;
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const checks = [];
  const log = [];
  const check = (name, pass, detail = {}) => {
    checks.push({ name, pass: Boolean(pass), detail });
  };

  const child = spawn(candidate, ['serve', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    env: hermeticEnv({
      HOME: home,
      IRONCLAW_REBORN_WEBUI_TOKEN: token,
      IRONCLAW_REBORN_WEBUI_USER_ID: 'owner',
      RUST_LOG: 'warn'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (c) => log.push(c.toString()));
  child.stderr.on('data', (c) => log.push(c.toString()));

  const api = async (method, pathname, { body, headers } = {}) => {
    const res = await fetch(`${origin}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let parsed = null;
    try {
      parsed = await res.json();
    } catch (_) {
      /* non-JSON */
    }
    return { res, body: parsed };
  };

  try {
    // Readiness.
    let healthy = false;
    for (let i = 0; i < 120; i += 1) {
      if (child.exitCode != null) throw new Error(`sidecar exited early code ${child.exitCode}`);
      try {
        const r = await fetch(`${origin}/api/webchat/v2/threads`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (r.ok) {
          healthy = true;
          break;
        }
      } catch (_) {
        /* booting */
      }
      await delay(500);
    }
    check('sidecar boots and serves authed /threads', healthy);
    if (!healthy) throw new Error('sidecar did not become healthy');

    // CORS / origin (#4623): the WebView sends requests that the desktop's
    // tauri http path delivers; the most representative is a bearer request
    // with NO browser Origin, and one with the tauri origin. Both must pass.
    const noOrigin = await api('GET', '/api/webchat/v2/threads');
    check('accepts bearer request with no Origin header', noOrigin.res.ok, {
      status: noOrigin.res.status
    });
    const tauriOrigin = await api('GET', '/api/webchat/v2/threads', {
      headers: { Origin: 'tauri://localhost' }
    });
    check('accepts request with tauri:// Origin', tauriOrigin.res.ok, {
      status: tauriOrigin.res.status
    });
    const localhostOrigin = await api('GET', '/api/webchat/v2/threads', {
      headers: { Origin: `http://localhost:${port}` }
    });
    check('accepts request with http://localhost Origin', localhostOrigin.res.ok, {
      status: localhostOrigin.res.status
    });

    // Auth envelope (#4624): unauthorized must still be a JSON { code, message }.
    const unauth = await fetch(`${origin}/api/webchat/v2/threads`);
    let unauthBody = null;
    try {
      unauthBody = await unauth.json();
    } catch (_) {
      /* */
    }
    check(
      'unauthorized returns sanitized JSON error envelope',
      unauth.status === 401 && unauthBody && typeof unauthBody.code === 'string',
      { status: unauth.status, body: unauthBody }
    );

    // Thread + message + attachment contract our UI uses.
    const requestedThreadId = randomUUID();
    const thread = await api('POST', '/api/webchat/v2/threads', {
      client_action_id: `accept-thread-${timestamp}`,
      requested_thread_id: requestedThreadId
    });
    const threadId = thread.body?.thread_id || thread.body?.thread?.thread_id || requestedThreadId;
    check('create thread returns a thread id', Boolean(threadId) && thread.res.ok, {
      status: thread.res.status
    });

    const sentinelBlock =
      '\n\n<attachments ic="1">\nAttachment 1:\nfilename: ledger.csv\nmime_type: text/plain\n' +
      'size: 30\nextraction_status: extracted_text\nextracted_text_chars: 26\nextracted_text:\n---\n' +
      'item,value\nalpha,12\nbeta,34\n---\n</attachments>';
    const prompt = 'Acceptance: confirm this send is accepted and echoed.';
    const send = await api(
      'POST',
      `/api/webchat/v2/threads/${encodeURIComponent(threadId)}/messages`,
      {
        client_action_id: `accept-msg-${timestamp}`,
        content: `${prompt}${sentinelBlock}`,
        attachments: [
          { name: 'ledger.csv', mime_type: 'text/plain', data_base64: Buffer.from('x').toString('base64') }
        ]
      }
    );
    check(
      'send message with sentinel-embedded attachment is accepted',
      send.res.ok && (send.body?.outcome === 'submitted' || Boolean(send.body?.run_id)),
      { status: send.res.status, outcome: send.body?.outcome || null }
    );

    await delay(1500);
    const timeline = await api(
      'GET',
      `/api/webchat/v2/threads/${encodeURIComponent(threadId)}/timeline?limit=50`
    );
    const tlText = JSON.stringify(timeline.body || {});
    check('timeline echoes the sent prompt (projection intact)', tlText.includes(prompt), {
      status: timeline.res.status
    });
    check('timeline preserves the embedded attachment block', tlText.includes('ledger.csv'));

    // SSE projection (#4552/#4546): the events stream must still emit
    // run_status transitions the UI consumes.
    let sseStatusSeen = false;
    const sseController = new AbortController();
    const ssePromise = (async () => {
      try {
        const res = await fetch(
          `${origin}/api/webchat/v2/threads/${encodeURIComponent(threadId)}/events?token=${encodeURIComponent(token)}`,
          { headers: { Accept: 'text/event-stream' }, signal: sseController.signal }
        );
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          if (/"run_status"|"status":"(queued|running|failed|completed)"/.test(buf)) {
            sseStatusSeen = true;
            break;
          }
          buf = buf.slice(-4000);
        }
      } catch (_) {
        /* aborted */
      }
    })();
    await Promise.race([ssePromise, delay(22000)]);
    sseController.abort();
    await ssePromise.catch(() => {});
    check('SSE events stream emits run_status (UI lifecycle source)', sseStatusSeen);

    // Routes we already depend on must remain.
    for (const route of ['llm/providers', 'automations', 'extensions/registry']) {
      const r = await api('GET', `/api/webchat/v2/${route}`);
      check(`existing route /${route} still serves`, r.res.ok, { status: r.res.status });
    }

    // Additive routes we WANT to gain from main (informational — not gating).
    const gained = {};
    for (const route of ['automations/runs', 'channels/slack/allowed', 'channels/slack/subjects']) {
      const r = await api('GET', `/api/webchat/v2/${route}`);
      gained[route] = r.res.status;
    }

    const required = checks.filter((c) => !c.pass);
    const verdict = required.length === 0 ? 'PASS' : 'FAIL';
    const report = {
      generated_at: new Date().toISOString(),
      candidate,
      verdict,
      checks,
      gained_routes: gained,
      sidecar_log_tail: log.join('').split('\n').slice(-15)
    };
    await writeFile(
      path.join(artifactDir, `acceptance-${timestamp}.json`),
      `${JSON.stringify(report, null, 2)}\n`
    );
    console.log(`verdict: ${verdict}`);
    for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'} - ${c.name}`);
    console.log('gained routes (want 200):', JSON.stringify(gained));
    if (verdict !== 'PASS') process.exitCode = 1;
  } catch (err) {
    console.error(err.stack || err.message || String(err));
    console.error('log tail:', log.join('').split('\n').slice(-15).join('\n'));
    process.exitCode = 1;
  } finally {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((r) => child.once('exit', r)), delay(3000).then(() => child.kill('SIGKILL'))]);
    }
    await rm(home, { recursive: true, force: true });
  }
}

main();
