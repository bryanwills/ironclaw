// Native security regression guard (review ICD-009).
//
// The desktop shell is trusted with tokens, a local sidecar, and tool
// execution, so its CSP + Tauri capability scopes are security-load-bearing.
// A few of those scopes are deliberately broad because they encode a real
// product need (the user can point a profile at ANY https gateway, and the
// app opens arbitrary https links in the OS browser). This test pins the
// security-relevant invariants so a future edit can't quietly WIDEN them
// (add `unsafe-eval`, a remote script host, a bare `http://*` wildcard, an
// unscoped sidecar exec, etc.) without a test failing. It is the
// "test preventing accidental expansion" half of ICD-009 — the other half
// (justification) lives in ARCHITECTURE.md, which this keeps honest.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}
function readJson(rel: string): any {
  return JSON.parse(read(rel));
}

const conf = readJson('../../src-tauri/tauri.conf.json');
const caps = readJson('../../src-tauri/capabilities/default.json');
const csp: string = conf.app.security.csp;

function directive(name: string): string {
  const m = csp.match(new RegExp(`${name} ([^;]*)`));
  return m ? m[1].trim() : '';
}
function permission(id: string): any {
  return caps.permissions.find(
    (p: unknown) =>
      typeof p === 'object' && p !== null && (p as { identifier?: string }).identifier === id
  );
}

describe('CSP hardening directives are present', () => {
  it('keeps the no-embed / no-redirect lockdowns', () => {
    expect(csp).toContain("default-src 'self' tauri:");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it('never allows unsafe-eval anywhere', () => {
    expect(csp).not.toContain("'unsafe-eval'");
  });
});

describe('script-src is pinned (XSS surface)', () => {
  // `'unsafe-inline'` is required by SvelteKit's inline hydration start script
  // AND the dev-only IPC shim in app.html (production-gated — see the dev-shim
  // test below). `'wasm-unsafe-eval'` is the WASM-only eval that tesseract.js
  // (fully-offline OCR) requires — it is NOT the general `'unsafe-eval'`, which
  // stays absent (asserted above). The loopback http origins are the bundled
  // sidecar that serves the static UI over 127.0.0.1; they are NOT remote
  // script hosts. Pin the exact value so adding a remote origin, a bare http
  // wildcard, or real unsafe-eval fails here.
  it('is exactly self + unsafe-inline + wasm-unsafe-eval + tauri: + loopback', () => {
    expect(directive('script-src')).toBe(
      "'self' 'unsafe-inline' 'wasm-unsafe-eval' tauri: http://127.0.0.1:* http://localhost:*"
    );
  });
  it('never widens script-src to a remote host or bare http wildcard', () => {
    const script = directive('script-src');
    expect(script).not.toMatch(/(^|\s)http:\/\/\*/);
    expect(script).not.toContain('https://');
  });
});

describe('worker-src stays loopback/blob-scoped (OCR + pdf.js workers)', () => {
  // tesseract OCR and pdf.js spawn workers from blob: URLs and the
  // sidecar-served bundle. Keep them pinned to self/blob/tauri + loopback,
  // never a remote or bare-http wildcard.
  const worker = directive('worker-src');
  it('allows self/blob/tauri + loopback only', () => {
    expect(worker).toBe("'self' blob: tauri: http://127.0.0.1:* http://localhost:*");
  });
  it('does not allow a bare insecure-http wildcard', () => {
    expect(worker).not.toMatch(/(^|\s)http:\/\/\*/);
  });
});

describe('connect-src http scheme stays localhost-scoped', () => {
  // `https://*` is intentional: profiles point at arbitrary remote gateways,
  // which cannot be enumerated ahead of time. The http scheme, by contrast,
  // is only for the bundled local sidecar — so it must stay pinned to
  // loopback and never widen to a bare `http://*` wildcard.
  const connect = directive('connect-src');
  it('allows the local sidecar over loopback http only', () => {
    expect(connect).toContain('http://127.0.0.1:*');
    expect(connect).toContain('http://localhost:*');
  });
  it('allows arbitrary https (remote gateway product need)', () => {
    expect(connect).toContain('https://*');
  });
  it('does not allow a bare insecure-http wildcard', () => {
    expect(connect).not.toMatch(/(^|\s)http:\/\/\*/);
  });
});

describe('Tauri http capability is scoped to loopback + https', () => {
  it('allows exactly loopback + https://** and nothing else', () => {
    const http = permission('http:default');
    const urls = http.allow.map((a: { url: string }) => a.url).sort();
    expect(urls).toEqual(['http://127.0.0.1:*', 'http://localhost:*', 'https://**']);
  });
});

describe('sidecar shell capabilities are pinned to the bundled binary', () => {
  it.each(['shell:allow-execute', 'shell:allow-kill'])(
    '%s only targets bundled IronClaw sidecars',
    (id) => {
      const perm = permission(id);
      expect(perm.allow).toEqual([
        { name: 'binaries/ironclaw-reborn', sidecar: true, args: true },
        { name: 'binaries/ironclaw', sidecar: true, args: true }
      ]);
    }
  );

  it('shell:allow-open is limited to https + loopback (no bare http wildcard)', () => {
    const open = permission('shell:allow-open');
    const urls = open.allow.map((a: { url: string }) => a.url).sort();
    expect(urls).toEqual(['http://127.0.0.1:*/', 'http://localhost:*/', 'https://**']);
  });
});

describe('dev IPC shim is production-gated', () => {
  // The dev-only Tauri IPC shim in app.html must refuse to install in the
  // production webview (tauri:/tauri-localhost: protocols). Without the
  // guard, an XSS payload could seed sessionStorage and swap the real IPC
  // bridge for a fake. The guard MUST run before the bridge is assigned.
  const html = read('../../src/app.html');
  it('checks the production protocols before touching the IPC bridge', () => {
    const guardIdx = html.indexOf("window.location.protocol === 'tauri:'");
    const installIdx = html.indexOf('window.__TAURI_INTERNALS__ =');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(html).toContain('tauri-localhost:');
    expect(installIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(installIdx);
  });
});
