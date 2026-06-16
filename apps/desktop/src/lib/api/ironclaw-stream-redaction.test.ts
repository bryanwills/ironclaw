// Security regression guard (Codex audit P0): the legacy SSE stream methods
// (`streamEvents`, `streamLogs`) carry the bearer token as a `?token=` query
// param on the live request (EventSource-style auth), but that token must
// NEVER reach an `HttpError` message — those bubble into logs, crash reports,
// and error toasts. Both methods now throw with a token-free `safeUrl`
// (mirroring the v2 stream path). These tests open each stream against a
// stubbed 401 and assert the thrown error's `.url` keeps the path but drops
// the token.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IronClawClient } from './ironclaw';

const TOKEN = 'super-secret-bearer-abc123';

function client() {
  return new IronClawClient({ baseUrl: 'https://gw.example', token: TOKEN });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SSE stream error URLs never leak the bearer token', () => {
  it('streamEvents throws a token-free error url on a non-OK open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, statusText: 'Unauthorized', body: null }))
    );
    let caught: { url?: string } | null = null;
    try {
      await client()
        .streamEvents('thread-42', new AbortController().signal)
        [Symbol.asyncIterator]()
        .next();
    } catch (err) {
      caught = err as { url?: string };
    }
    expect(caught).not.toBeNull();
    expect(caught?.url).toContain('/api/chat/events');
    expect(caught?.url).toContain('thread-42'); // non-secret context preserved
    expect(caught?.url).not.toContain(TOKEN);
    expect(caught?.url ?? '').not.toMatch(/token=/i);
  });

  it('streamLogs throws a token-free error url on a non-OK open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, statusText: 'Forbidden', body: null }))
    );
    let caught: { url?: string } | null = null;
    try {
      await client().streamLogs(new AbortController().signal)[Symbol.asyncIterator]().next();
    } catch (err) {
      caught = err as { url?: string };
    }
    expect(caught).not.toBeNull();
    expect(caught?.url).toContain('/api/logs/events');
    expect(caught?.url).not.toContain(TOKEN);
    expect(caught?.url ?? '').not.toMatch(/token=/i);
  });
});
