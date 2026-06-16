import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function readWorkspaceJson(pathFromStaticJs) {
  const url = new URL(`../../../../../${pathFromStaticJs}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

function readWorkspaceText(pathFromStaticJs) {
  const url = new URL(`../../../../../${pathFromStaticJs}`, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}

const conf = readWorkspaceJson('src-tauri/tauri.conf.json');
const caps = readWorkspaceJson('src-tauri/capabilities/default.json');
const entitlements = readWorkspaceText('src-tauri/Entitlements.plist');
const csp = conf.app.security.csp;
const expectedSidecars = [
  'binaries/ironclaw-reborn',
  'binaries/ironclaw',
  'binaries/sandbox_daemon'
];

function directive(name) {
  const entry = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  return entry ? entry.slice(name.length).trim().split(/\s+/).filter(Boolean) : [];
}

function permission(identifier) {
  return caps.permissions.find(
    (entry) => entry && typeof entry === 'object' && entry.identifier === identifier
  );
}

test('static shipped UI owns the native security guard', () => {
  assert.equal(conf.build.frontendDist, '../crates/ironclaw_webui_v2_static/static');
  assert.deepEqual(directive('default-src'), ["'self'", 'tauri:']);
  assert.ok(csp.includes("frame-src 'none'"));
  assert.ok(csp.includes("object-src 'none'"));
  assert.ok(csp.includes("base-uri 'self'"));
});

test('CSP rejects broad eval, remote scripts, and insecure HTTP wildcards', () => {
  assert.ok(!csp.includes("'unsafe-eval'"));
  assert.ok(!csp.match(/(^|\s)http:\/\/\*(?=[:/\s;]|$)/));
  assert.ok(!directive('script-src').some((source) => source.startsWith('https://')));
  assert.deepEqual(directive('img-src'), [
    "'self'",
    'data:',
    'blob:',
    'tauri:',
    'http://127.0.0.1:*',
    'http://localhost:*',
    'https://*'
  ]);
  assert.deepEqual(directive('script-src'), [
    "'self'",
    "'unsafe-inline'",
    "'wasm-unsafe-eval'",
    'tauri:',
    'http://127.0.0.1:*',
    'http://localhost:*'
  ]);
  assert.deepEqual(directive('worker-src'), [
    "'self'",
    'blob:',
    'tauri:',
    'http://127.0.0.1:*',
    'http://localhost:*'
  ]);
  assert.deepEqual(directive('connect-src'), [
    "'self'",
    'tauri:',
    'ipc:',
    'http://127.0.0.1:*',
    'http://localhost:*',
    'https://*',
    'ws://127.0.0.1:*',
    'ws://localhost:*',
    'wss://*'
  ]);
});

test('Tauri capability manifest only allows loopback HTTP and HTTPS', () => {
  const http = permission('http:default');
  assert.ok(http, 'missing http:default permission');
  assert.deepEqual(http.allow.map((entry) => entry.url).sort(), [
    'http://127.0.0.1:*',
    'http://localhost:*',
    'https://**'
  ]);
});

test('shell execute/kill capability stays pinned to the IronClaw sidecars', () => {
  const shellSidecars = expectedSidecars.filter((name) => name !== 'binaries/sandbox_daemon');
  for (const identifier of ['shell:allow-execute', 'shell:allow-kill']) {
    const shell = permission(identifier);
    assert.ok(shell, `missing ${identifier}`);
    assert.deepEqual(
      shell.allow.map((entry) => entry.name),
      shellSidecars
    );
    for (const entry of shell.allow) {
      assert.equal(entry.sidecar, true);
      assert.equal(entry.args, true);
      assert.ok(!entry.name.startsWith('/'), `${identifier} must not allow absolute paths`);
      assert.ok(
        !/(^|\/)(node|npm|npx|python|python3|ruby|bash|sh|zsh)$/.test(entry.name),
        `${identifier} must not allow interpreter execution`
      );
    }
  }
});

test('bundled external binaries stay explicit and do not grant interpreter paths', () => {
  assert.deepEqual(conf.bundle.externalBin, expectedSidecars);
  for (const name of conf.bundle.externalBin) {
    assert.ok(name.startsWith('binaries/'), `externalBin must be bundled: ${name}`);
    assert.ok(!name.startsWith('/'), `externalBin must not be absolute: ${name}`);
    assert.ok(
      !/(^|\/)(node|npm|npx|python|python3|ruby|bash|sh|zsh)$/.test(name),
      `externalBin must not bundle an interpreter: ${name}`
    );
  }
});

test('macOS release signing keeps hardened runtime and minimal entitlements', () => {
  assert.equal(conf.bundle.macOS.hardenedRuntime, true);
  assert.equal(conf.bundle.macOS.entitlements, './Entitlements.plist');
  for (const denied of [
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
    'com.apple.security.cs.allow-jit',
    'com.apple.security.app-sandbox'
  ]) {
    assert.ok(!entitlements.includes(denied), `entitlements must not grant ${denied}`);
  }
});

test('shell open cannot launch arbitrary insecure HTTP URLs', () => {
  const open = permission('shell:allow-open');
  assert.ok(open, 'missing shell:allow-open');
  assert.deepEqual(open.allow.map((entry) => entry.url).sort(), [
    'http://127.0.0.1:*/',
    'http://localhost:*/',
    'https://**'
  ]);
});
