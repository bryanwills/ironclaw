#!/usr/bin/env node
// Work-product proof against a REAL model.
//
// Spawns the bundled `ironclaw-reborn` sidecar with the (fixed) OpenRouter
// backend, then runs the existing multi-file assistant-run probe against it
// with IRONCLAW_EXPECT_ASSISTANT=1. Proves the model reads five dummy file
// types (csv/md/json/html/txt), drafts a real answer, and that every
// attachment name + extracted text survives a timeline reload. (RED 3.)
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const bundledSidecar = path.join(
  repoRoot,
  'src-tauri/target/release/bundle/macos/IronClaw.app/Contents/MacOS/ironclaw-reborn'
);
const releaseSidecar = path.join(repoRoot, 'src-tauri/target/release/ironclaw-reborn');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function fileExists(p) {
  try {
    await readFile(p);
    return true;
  } catch (_) {
    return false;
  }
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');
  const sidecar = (await fileExists(bundledSidecar)) ? bundledSidecar : releaseSidecar;
  if (!(await fileExists(sidecar))) throw new Error('no ironclaw-reborn binary');

  const home = await mkdtemp(path.join(os.tmpdir(), 'ironclaw-workproduct-'));
  const token = `probe-${randomUUID()}`;
  const tokenFile = path.join(home, 'gateway.token');
  await writeFile(tokenFile, token);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|OPENAI_|NEARAI_|LLM_)/.test(k))
  );
  const child = spawn(sidecar, ['serve', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    env: {
      ...env,
      HOME: home,
      IRONCLAW_REBORN_WEBUI_TOKEN: token,
      IRONCLAW_REBORN_WEBUI_USER_ID: 'owner',
      RUST_LOG: process.env.RUST_LOG || 'warn',
      LLM_BACKEND: 'openrouter',
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      OPENROUTER_MODEL:
        process.env.IRONCLAW_PROBE_OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3-0324'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  child.stdout.on('data', (c) => log.push(c.toString()));
  child.stderr.on('data', (c) => log.push(c.toString()));

  try {
    let healthy = false;
    for (let i = 0; i < 80 && !healthy; i += 1) {
      if (child.exitCode != null) throw new Error(`sidecar exited early: ${log.join('').slice(-400)}`);
      try {
        const r = await fetch(`${origin}/api/webchat/v2/threads`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        healthy = r.ok;
      } catch (_) {
        /* booting */
      }
      if (!healthy) await delay(250);
    }
    if (!healthy) throw new Error('sidecar not healthy');

    const probe = spawn('node', ['scripts/probe-live-reborn-assistant-run.mjs'], {
      cwd: repoRoot,
      env: {
        ...env,
        IRONCLAW_LIVE_PROBE_ORIGIN: origin,
        IRONCLAW_LIVE_PROBE_TOKEN_FILE: tokenFile,
        IRONCLAW_EXPECT_ASSISTANT: '1'
      },
      stdio: 'inherit'
    });
    const code = await new Promise((resolve) => probe.on('exit', resolve));
    if (code !== 0) throw new Error(`assistant-run work-product probe failed (exit ${code})`);
    console.log('work-product (openrouter) proof: PASS');
  } finally {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((r) => child.once('exit', r)),
        delay(3000).then(() => child.kill('SIGKILL'))
      ]);
    }
    await rm(home, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
