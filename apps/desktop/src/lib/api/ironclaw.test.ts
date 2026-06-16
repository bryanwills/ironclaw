// Wire-shape tests for `IronClawClient`. Focus on the parse paths
// that have bug-fix history — `turns[]` → `messages[]` expansion,
// `turn_count` → `message_count` mapping, `uptime_secs` aliasing,
// and the settings array → map fold. Real HTTP is mocked via
// `global.fetch`; tests do not run the gateway.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { IronClawClient } from './ironclaw';

// Build a Response-shaped object that `fetch` can return.
function fetchOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function makeClient(): IronClawClient {
  return new IronClawClient({ baseUrl: 'http://example.test', token: 'tok' });
}

describe('IronClawClient.getHistory', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      fetchOk({
        thread_id: 't1',
        turns: [
          {
            turn_number: 1,
            user_message_id: 'u1',
            user_input: 'hello',
            response: 'hi there',
            response_id: 'a1',
            started_at: '2026-05-27T00:00:00Z',
            completed_at: '2026-05-27T00:00:01Z'
          },
          {
            turn_number: 2,
            user_message_id: 'u2',
            user_input: 'follow up',
            response: 'sure',
            response_id: 'a2',
            started_at: '2026-05-27T00:00:02Z',
            completed_at: '2026-05-27T00:00:03Z'
          }
        ]
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('expands turns[] into a flat user→assistant message sequence', async () => {
    const c = makeClient();
    const msgs = await c.getHistory('t1');
    expect(msgs).toHaveLength(4);
    expect(msgs[0]).toMatchObject({ id: 'u1', role: 'user', content: 'hello' });
    expect(msgs[1]).toMatchObject({
      id: 'a1',
      role: 'assistant',
      content: 'hi there'
    });
    expect(msgs[2]).toMatchObject({ id: 'u2', role: 'user', content: 'follow up' });
    expect(msgs[3]).toMatchObject({ id: 'a2', role: 'assistant', content: 'sure' });
  });

  it('skips the assistant half when the turn has no response yet', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      fetchOk({
        turns: [
          {
            turn_number: 1,
            user_message_id: 'u1',
            user_input: 'mid-flight',
            // no `response` field — turn is still streaming
            started_at: '2026-05-27T00:00:00Z'
          }
        ]
      })
    );
    const c = makeClient();
    const msgs = await c.getHistory('t1');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'mid-flight' });
  });

  it('falls through to the flat messages[] shape when the server emits it', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      fetchOk({
        messages: [
          { id: 'm1', role: 'user', content: 'a', created_at: 't1' },
          { id: 'm2', role: 'assistant', content: 'b', timestamp: 't2' }
        ]
      })
    );
    const c = makeClient();
    const msgs = await c.getHistory('t1');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ id: 'm1', role: 'user', created_at: 't1' });
    // `timestamp` fallback → `created_at`
    expect(msgs[1]).toMatchObject({ id: 'm2', role: 'assistant', created_at: 't2' });
  });
});

describe('IronClawClient.sendMessage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts legacy chat instructions alongside attachment payloads', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return fetchOk({ thread_id: 't1', message_id: 'm1' });
    }) as unknown as typeof fetch);

    const c = makeClient();
    const res = await c.sendMessage(
      't1',
      'review this',
      [{ name: 'contract.md', mime_type: 'text/markdown', data_base64: 'IyBNU0E=' }],
      'thread persona'
    );

    expect(res).toEqual({ thread_id: 't1', message_id: 'm1' });
    expect(capturedUrl).toBe('http://example.test/api/chat/send');
    expect(capturedInit?.method).toBe('POST');
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      content: 'review this',
      thread_id: 't1',
      attachments: [{ name: 'contract.md', mime_type: 'text/markdown', data_base64: 'IyBNU0E=' }],
      instructions: 'thread persona'
    });
  });
});

describe('IronClawClient legacy approval handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes approval_needed SSE frames from the legacy chat stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        `event: approval_needed\ndata: ${JSON.stringify({
          type: 'approval_needed',
          request_id: 'req-1',
          thread_id: 't1',
          tool_name: 'read_file',
          description: "Tool 'read_file' requires approval",
          parameters: '{"path":".ironclaw/attachments/u/t/doc.pdf"}',
          allow_always: true
        })}\n\n`,
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        }
      )
    );

    const events = [];
    for await (const ev of makeClient().streamEvents('t1', new AbortController().signal)) {
      events.push(ev);
    }

    expect(events).toEqual([
      {
        type: 'approval_needed',
        request_id: 'req-1',
        thread_id: 't1',
        tool_name: 'read_file',
        description: "Tool 'read_file' requires approval",
        parameters: { path: '.ironclaw/attachments/u/t/doc.pdf' },
        allow_always: true
      }
    ]);
  });

  it('posts legacy chat approval resolutions to /api/chat/approval', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return fetchOk({ message_id: 'approval-msg', status: 'accepted' });
    }) as unknown as typeof fetch);

    await makeClient().resolveLegacyChatApproval({
      threadId: 't1',
      requestId: '0b0b0b0b-1111-2222-3333-444444444444',
      action: 'approve'
    });

    expect(capturedUrl).toBe('http://example.test/api/chat/approval');
    expect(capturedInit?.method).toBe('POST');
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      thread_id: 't1',
      request_id: '0b0b0b0b-1111-2222-3333-444444444444',
      action: 'approve'
    });
  });
});

describe('IronClawClient.listThreads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps turn_count → message_count', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fetchOk({
        threads: [
          {
            id: 't1',
            title: 'first',
            created_at: '2026-05-27T00:00:00Z',
            last_message_at: '2026-05-27T00:01:00Z',
            turn_count: 3
          }
        ]
      })
    );
    const c = makeClient();
    const threads = await c.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: 't1',
      title: 'first',
      message_count: 3,
      updated_at: '2026-05-27T00:01:00Z'
    });
  });

  it('falls back to message_count when the server emits the new name', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fetchOk({
        threads: [
          {
            id: 't2',
            created_at: '2026-05-27T00:00:00Z',
            message_count: 7
          }
        ]
      })
    );
    const c = makeClient();
    const threads = await c.listThreads();
    expect(threads[0].message_count).toBe(7);
    // No title → empty string default.
    expect(threads[0].title).toBe('');
    // No last_message_at → falls back to created_at.
    expect(threads[0].updated_at).toBe('2026-05-27T00:00:00Z');
  });
});

describe('IronClawClient.generateImage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws a clear gateway-version error while the endpoint is not wired', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const c = makeClient();
    await expect(c.generateImage('a red apple')).rejects.toThrow(
      'Image generation unavailable on this gateway version'
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('IronClawClient.gatewayStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps uptime_secs onto uptime_seconds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fetchOk({
        version: '0.28.2',
        uptime_secs: 1234,
        ws_connections: 1,
        sse_connections: 2,
        enabled_channels: ['http']
      })
    );
    const c = makeClient();
    const s = await c.gatewayStatus();
    expect(s.uptime_seconds).toBe(1234);
    expect(s.total_connections).toBe(3);
    expect(s.enabled_channels).toEqual(['http']);
  });

  it('still reads uptime_seconds when the server emits the long-form name', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fetchOk({ uptime_seconds: 99 }));
    const c = makeClient();
    const s = await c.gatewayStatus();
    expect(s.uptime_seconds).toBe(99);
  });
});

describe('IronClawClient.getSettings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('folds settings array → key/value map', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fetchOk({
        settings: [
          { key: 'system_prompt', value: 'be helpful', updated_at: 't1' },
          { key: 'max_tokens', value: 2048, updated_at: 't2' }
        ]
      })
    );
    const c = makeClient();
    const s = await c.getSettings();
    expect(s.system_prompt).toBe('be helpful');
    expect(s.max_tokens).toBe(2048);
  });

  it('accepts a server emitting the map shape directly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fetchOk({ settings: { foo: 'bar', n: 1 } })
    );
    const c = makeClient();
    const s = await c.getSettings();
    expect(s).toMatchObject({ foo: 'bar', n: 1 });
  });

  it('returns the empty object when the server omits the settings field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fetchOk({}));
    const c = makeClient();
    const s = await c.getSettings();
    expect(s).toEqual({});
  });

  it('redacts secret-shaped string values', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fetchOk({
        settings: [
          {
            key: 'mcp_servers',
            value: 'Authorization: Bearer sk-foofoofoofoofoo',
            updated_at: 't1'
          }
        ]
      })
    );
    const c = makeClient();
    const s = await c.getSettings();
    expect(JSON.stringify(s)).not.toContain('foofoofoofoofoo');
    expect(JSON.stringify(s)).toContain('Bearer ');
  });
});

describe('IronClawClient.installSkill', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Verified live against IronClaw v0.29: install needs the body field
  // `name` (the slug value) AND an `X-Confirm-Action: true` header. The
  // previous client sent `{slug}` and no header → 400. This locks the
  // contract + proves the request() header-merge keeps the auth header.
  it('POSTs {name} with X-Confirm-Action and preserves the auth header', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return fetchOk({ success: true, message: "Skill 'web' installed" });
    }) as unknown as typeof fetch);

    const c = makeClient();
    const res = await c.installSkill('web');

    expect(res.ok).toBe(true);
    expect(capturedUrl).toMatch(/\/api\/skills\/install$/);
    expect(capturedInit?.method).toBe('POST');
    expect(JSON.parse(String(capturedInit?.body))).toEqual({ name: 'web' });
    const h = capturedInit?.headers as Record<string, string>;
    expect(h['X-Confirm-Action']).toBe('true');
    // The merged Authorization header must survive (request() header fix).
    expect(h.Authorization).toBe('Bearer tok');
  });

  it('treats a legacy {status:"installed"} response as ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fetchOk({ status: 'installed' }));
    const c = makeClient();
    expect((await c.installSkill('web')).ok).toBe(true);
  });
});

describe('IronClawClient.listRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Regression: a blank or duplicate `name` made the registry grid's keyed
  // `{#each … (ext.name)}` throw uncaught, surfacing as a generic global
  // error and silently reverting the tab. listRegistry must guarantee
  // unique, non-empty names. (R107)
  it('drops blank names and dedupes by name', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fetchOk({
        entries: [
          { name: 'slack', display_name: 'Slack', kind: 'wasm_channel' },
          { slug: 'slack', display_name: 'Slack (dup)', kind: 'wasm_channel' }, // dup name
          { display_name: 'Nameless' }, // no name/slug → blank → dropped
          { name: '   ', display_name: 'Whitespace' }, // blank after trim → dropped
          { name: 'gmail', display_name: 'Gmail', kind: 'mcp_server' }
        ]
      })
    );
    const c = makeClient();
    const list = await c.listRegistry();
    expect(list.map((e) => e.name)).toEqual(['slack', 'gmail']);
  });

  it('accepts the legacy {available:[…]} wire shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fetchOk({ available: [{ name: 'x', kind: 'mcp_server' }] })
    );
    const c = makeClient();
    const list = await c.listRegistry();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('x');
  });

  it('accepts the helper/Reborn {registry:[…]} wire shape and normalizes catalog refs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fetchOk({ registry: [{ name: 'mcp-servers/notion', kind: 'mcp_server' }] })
    );
    const c = makeClient();
    const list = await c.listRegistry();
    expect(list).toMatchObject([{ name: 'notion', category: 'mcp' }]);
  });
});

describe('IronClawClient extension identity compatibility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('installs prefixed registry refs as Reborn bare ExtensionName values with kind hints', async () => {
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init: RequestInit) => {
      capturedInit = init;
      return fetchOk({ status: 'queued' });
    }) as unknown as typeof fetch);

    const c = makeClient();
    await expect(c.installExtension('channels/slack')).resolves.toEqual({ ok: true });

    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      name: 'slack',
      slug: 'slack',
      kind: 'wasm_channel'
    });
  });

  it('maps UI category hints to Reborn install kind strings', async () => {
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init: RequestInit) => {
      capturedInit = init;
      return fetchOk({ status: 'queued' });
    }) as unknown as typeof fetch);

    const c = makeClient();
    await expect(c.installExtension('notion', 'mcp')).resolves.toEqual({ ok: true });

    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
      name: 'notion',
      slug: 'notion',
      kind: 'mcp_server'
    });
  });

  it('drops UI-only category hints rather than posting invalid Reborn kinds', async () => {
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init: RequestInit) => {
      capturedInit = init;
      return fetchOk({ status: 'queued' });
    }) as unknown as typeof fetch);

    const c = makeClient();
    await expect(c.installExtension('gmail', 'oauth')).resolves.toEqual({ ok: true });

    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      name: 'gmail',
      slug: 'gmail'
    });
  });

  it('rejects malformed catalog refs before lifecycle requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fetchOk({ status: 'queued' }));
    const c = makeClient();

    await expect(c.installExtension('mcp-servers/../gmail')).rejects.toThrow(/invalid extension/i);
    await expect(c.getExtensionSetup('tools//gmail')).rejects.toThrow(/invalid extension/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('normalizes setup and login URLs so no slash-bearing identity reaches Reborn', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
      urls.push(String(url));
      return fetchOk({ fields: [], status: 'pending', session_id: 's1' });
    }) as unknown as typeof fetch);

    const c = makeClient();
    await c.getExtensionSetup('mcp-servers/notion');
    await c.startExtensionLogin('tools/gmail');

    expect(urls).toEqual([
      'http://example.test/api/extensions/notion/setup',
      'http://example.test/api/extensions/gmail/login/start'
    ]);
  });

  it('normalizes activate, remove, setup submit, and login poll URLs', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
      urls.push(String(url));
      return fetchOk({ status: 'ok', session_id: 's1' });
    }) as unknown as typeof fetch);

    const c = makeClient();
    await c.activateExtension('channels/slack');
    await c.removeExtension('tools/gmail');
    await c.submitExtensionSetup('mcp-servers/notion', {});
    await c.pollExtensionLogin('tools/gmail', 's1');

    expect(urls).toEqual([
      'http://example.test/api/extensions/slack/activate',
      'http://example.test/api/extensions/gmail/remove',
      'http://example.test/api/extensions/notion/setup',
      'http://example.test/api/extensions/gmail/login/poll'
    ]);
  });

  it('preserves activation auth URLs for browser-based connector sign-in', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fetchOk({
        success: false,
        message: 'Gmail requires authentication.',
        auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=hosted',
        instructions: 'Finish sign-in in the browser.',
        awaiting_token: false
      })
    );

    const c = makeClient();
    await expect(c.activateExtension('tools/gmail')).resolves.toMatchObject({
      ok: true,
      message: 'Gmail requires authentication.',
      auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=hosted',
      instructions: 'Finish sign-in in the browser.',
      awaiting_token: false
    });
  });

  it('does not treat an empty activation response as connected', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fetchOk({}));

    const c = makeClient();
    await expect(c.activateExtension('tools/gmail')).resolves.toMatchObject({
      ok: false,
      activated: false
    });
  });

  it('preserves setup-submit auth URLs for connector OAuth after saving fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fetchOk({
        success: true,
        message: 'Configuration saved. Complete OAuth in your browser.',
        auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=setup',
        instructions: 'Finish sign-in in the browser.',
        activated: false
      })
    );

    const c = makeClient();
    await expect(
      c.submitExtensionSetup('tools/gmail', { client_secret: 'redacted' })
    ).resolves.toMatchObject({
      ok: true,
      message: 'Configuration saved. Complete OAuth in your browser.',
      auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=setup',
      instructions: 'Finish sign-in in the browser.',
      activated: false
    });
  });

  it('normalizes installed/readiness/tool owner refs to bare names', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/extensions') {
        return fetchOk({
          extensions: [{ name: 'tools/gmail', kind: 'wasm_tool', tools: ['gmail.list'] }]
        });
      }
      if (path === '/api/extensions/readiness') {
        return fetchOk({ extensions: [{ name: 'tools/gmail', phase: 'ready' }] });
      }
      if (path === '/api/extensions/tools') {
        return fetchOk({ tools: [{ name: 'gmail.list', extension: 'tools/gmail' }] });
      }
      return fetchOk({});
    }) as unknown as typeof fetch);

    const c = makeClient();
    await expect(c.listExtensions()).resolves.toMatchObject([
      { name: 'gmail', ready: true, readiness_message: 'ready', tool_count: 1 }
    ]);
  });

  it('treats authenticated active readiness as ready even without a phase', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/extensions') {
        return fetchOk({ extensions: [{ name: 'gmail', kind: 'wasm_tool' }] });
      }
      if (path === '/api/extensions/readiness') {
        return fetchOk({ extensions: [{ name: 'gmail', authenticated: true, active: true }] });
      }
      if (path === '/api/extensions/tools') {
        return fetchOk({ tools: [] });
      }
      return fetchOk({});
    }) as unknown as typeof fetch);

    const c = makeClient();
    await expect(c.listExtensions()).resolves.toMatchObject([
      { name: 'gmail', ready: true, readiness_message: 'ready' }
    ]);
  });

  it('accepts RFC-style device_code OAuth start responses without explicit success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      fetchOk({
        device_code: 'device-1',
        verification_uri: 'https://accounts.example.test/device',
        user_code: 'ABCD-EFGH',
        expires_in: 600
      })
    );

    const c = makeClient();
    await expect(c.startExtensionLogin('tools/gmail')).resolves.toMatchObject({
      success: true,
      session_id: 'device-1',
      device_code: 'device-1',
      verification_uri: 'https://accounts.example.test/device',
      user_code: 'ABCD-EFGH'
    });
  });
});

describe('IronClawClient.request timeout', () => {
  // Mirrors REQUEST_TIMEOUT_MS in ironclaw.ts (not exported).
  const TIMEOUT_MS = 15_000;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('aborts a no-signal request after the default timeout', async () => {
    vi.useFakeTimers();
    // fetch never resolves on its own; it rejects only when its signal aborts.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const c = makeClient();
    const p = c.health();
    // Attach the rejection assertion before advancing so there's no unhandled
    // rejection warning, then drive the fake clock past the deadline.
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await assertion;
  });

  it('does not time out a request that resolves before the deadline', async () => {
    // Real timers: the request resolves immediately and clears its own timer.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fetchOk({ status: 'ok' }));
    const c = makeClient();
    const h = await c.health();
    expect(h.ok).toBe(true);
  });
});
