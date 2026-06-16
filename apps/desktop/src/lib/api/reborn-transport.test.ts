// Wire-contract tests for the IronClaw Reborn WebChat v2 transport methods on
// `IronClawClient` (created during the v1→Reborn migration). Real HTTP is
// mocked via `global.fetch`; these lock the exact path, method, query string,
// idempotency-key injection, and request body for each v2 endpoint, plus the
// SSE decode path. The pure mappers/reducers are covered separately in
// `reborn.test.ts`; this file is the I/O boundary.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IronClawClient, buildV2Query } from './ironclaw';

function fetchOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function makeClient(): IronClawClient {
  return new IronClawClient({ baseUrl: 'http://example.test', token: 'tok' });
}

// Capture the (url, init) of the single request a method makes, returning a
// canned JSON body. Returns getters for the captured values.
function captureFetch(body: unknown = {}) {
  let url = '';
  let init: RequestInit | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (u: string, i: RequestInit) => {
    url = String(u);
    init = i;
    return fetchOk(body);
  }) as unknown as typeof fetch);
  return {
    get url() {
      return url;
    },
    get init() {
      return init;
    },
    get parsedBody() {
      return init?.body ? JSON.parse(String(init.body)) : undefined;
    }
  };
}

describe('buildV2Query', () => {
  it('returns empty string when no params set', () => {
    expect(buildV2Query({})).toBe('');
  });
  it('encodes limit and cursor', () => {
    expect(buildV2Query({ limit: 20 })).toBe('?limit=20');
    expect(buildV2Query({ cursor: 'c1' })).toBe('?cursor=c1');
    const both = buildV2Query({ limit: 5, cursor: 'c2' });
    expect(both).toContain('limit=5');
    expect(both).toContain('cursor=c2');
    expect(both.startsWith('?')).toBe(true);
  });
  it('treats limit=0 as a real value but drops empty cursor', () => {
    expect(buildV2Query({ limit: 0 })).toBe('?limit=0');
    expect(buildV2Query({ cursor: '' })).toBe('');
  });
});

describe('IronClawClient.createThreadV2', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs /threads with a client_action_id and preserves auth', async () => {
    const cap = captureFetch({ thread: { thread_id: 't9' } });
    const c = makeClient();
    const res = await c.createThreadV2();
    expect(res.thread?.thread_id).toBe('t9');
    expect(cap.url).toBe('http://example.test/api/webchat/v2/threads');
    expect(cap.init?.method).toBe('POST');
    expect(typeof cap.parsedBody.client_action_id).toBe('string');
    expect(cap.parsedBody.client_action_id.length).toBeGreaterThan(0);
    expect('requested_thread_id' in cap.parsedBody).toBe(false);
    expect((cap.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('includes requested_thread_id when pinned', async () => {
    const cap = captureFetch({ thread: { thread_id: 'pinned' } });
    await makeClient().createThreadV2('pinned');
    expect(cap.parsedBody.requested_thread_id).toBe('pinned');
  });
});

describe('IronClawClient.listThreadsV2', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GETs /threads with no query when no opts', async () => {
    const cap = captureFetch({ threads: [] });
    await makeClient().listThreadsV2();
    expect(cap.url).toBe('http://example.test/api/webchat/v2/threads');
    expect(cap.init?.method).toBe('GET');
  });

  it('appends limit + cursor', async () => {
    const cap = captureFetch({ threads: [{ thread_id: 't1' }], next_cursor: 'n' });
    const res = await makeClient().listThreadsV2({ limit: 10, cursor: 'c0' });
    expect(res.threads).toHaveLength(1);
    expect(cap.url).toContain('/api/webchat/v2/threads?');
    expect(cap.url).toContain('limit=10');
    expect(cap.url).toContain('cursor=c0');
  });
});

describe('IronClawClient.probeWebChatV2', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns true when the v2 thread list route answers', async () => {
    const cap = captureFetch({ threads: [] });
    await expect(makeClient().probeWebChatV2()).resolves.toBe(true);
    expect(cap.url).toBe('http://example.test/api/webchat/v2/threads?limit=1');
    expect(cap.init?.method).toBe('GET');
  });

  it('returns false for older gateways where the v2 route 404s', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return new Response('', { status: 404, statusText: 'Not Found' });
    }) as unknown as typeof fetch);
    await expect(makeClient().probeWebChatV2()).resolves.toBe(false);
  });

  it('treats auth failures as route-present capability signals', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return new Response('', { status: 401, statusText: 'Unauthorized' });
    }) as unknown as typeof fetch);
    await expect(makeClient().probeWebChatV2()).resolves.toBe(true);
  });
});

describe('IronClawClient.sendMessageV2', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs the message with client_action_id + content and url-encodes the thread id', async () => {
    const cap = captureFetch({ run_id: 'r1', thread_id: 't 1', status: 'queued' });
    const res = await makeClient().sendMessageV2('t 1', 'hello world');
    expect(res.run_id).toBe('r1');
    expect(cap.url).toBe('http://example.test/api/webchat/v2/threads/t%201/messages');
    expect(cap.init?.method).toBe('POST');
    expect(cap.parsedBody.content).toBe('hello world');
    expect(typeof cap.parsedBody.client_action_id).toBe('string');
  });

  it('includes attachments only when supplied', async () => {
    const cap = captureFetch({ run_id: 'r1', thread_id: 't1', status: 'queued' });
    await makeClient().sendMessageV2('t1', 'see attached', [
      { name: 'brief.pdf', mime_type: 'application/pdf', data_base64: 'cGRm' }
    ]);
    expect(cap.parsedBody.attachments).toEqual([
      { name: 'brief.pdf', mime_type: 'application/pdf', data_base64: 'cGRm' }
    ]);
  });

  it('includes per-thread instructions with attachments when supplied', async () => {
    const cap = captureFetch({ run_id: 'r1', thread_id: 't1', status: 'queued' });
    await makeClient().sendMessageV2(
      't1',
      'see attached',
      [{ name: 'brief.pdf', mime_type: 'application/pdf', data_base64: 'cGRm' }],
      'custom thread instructions'
    );
    expect(cap.parsedBody).toMatchObject({
      content: 'see attached',
      attachments: [{ name: 'brief.pdf', mime_type: 'application/pdf', data_base64: 'cGRm' }],
      instructions: 'custom thread instructions'
    });
  });
});

describe('IronClawClient.fetchTimelineV2', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GETs the timeline with pagination params', async () => {
    const cap = captureFetch({ records: [], next_cursor: null });
    await makeClient().fetchTimelineV2('t1', { limit: 50, cursor: 'cur' });
    expect(cap.url).toContain('/api/webchat/v2/threads/t1/timeline?');
    expect(cap.url).toContain('limit=50');
    expect(cap.url).toContain('cursor=cur');
    expect(cap.init?.method).toBe('GET');
  });
});

describe('IronClawClient.cancelRunV2', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs the cancel route with client_action_id only when no reason', async () => {
    const cap = captureFetch({});
    await makeClient().cancelRunV2('t1', 'r1');
    expect(cap.url).toBe('http://example.test/api/webchat/v2/threads/t1/runs/r1/cancel');
    expect(cap.init?.method).toBe('POST');
    expect(typeof cap.parsedBody.client_action_id).toBe('string');
    expect('reason' in cap.parsedBody).toBe(false);
  });

  it('includes reason when supplied', async () => {
    const cap = captureFetch({});
    await makeClient().cancelRunV2('t1', 'r1', 'user aborted');
    expect(cap.parsedBody.reason).toBe('user aborted');
  });
});

describe('IronClawClient.resolveGateV2', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs the resolve route with resolution + idempotency key', async () => {
    const cap = captureFetch({});
    await makeClient().resolveGateV2('t1', 'r1', 'g1', 'approved');
    expect(cap.url).toBe('http://example.test/api/webchat/v2/threads/t1/runs/r1/gates/g1/resolve');
    expect(cap.init?.method).toBe('POST');
    expect(cap.parsedBody.resolution).toBe('approved');
    expect(typeof cap.parsedBody.client_action_id).toBe('string');
    // Optional fields omitted when not passed.
    expect('always' in cap.parsedBody).toBe(false);
    expect('credential_ref' in cap.parsedBody).toBe(false);
  });

  it('threads always + credential_ref and url-encodes the gate ref', async () => {
    const cap = captureFetch({});
    await makeClient().resolveGateV2('t1', 'r1', 'g/1', 'credential_provided', {
      always: true,
      credentialRef: 'cred-9'
    });
    expect(cap.url).toContain('/gates/g%2F1/resolve');
    expect(cap.parsedBody.always).toBe(true);
    expect(cap.parsedBody.credential_ref).toBe('cred-9');
    expect(cap.parsedBody.resolution).toBe('credential_provided');
  });
});

describe('IronClawClient.streamWebChatV2Events', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reconstructs the envelope from named SSE frames (event: line + data body)', async () => {
    // The Reborn runtime tags each SSE frame with `event: <name>` and puts the
    // frame BODY (not a {type,frame} wrapper) in `data:`. The decoder must
    // synthesize `{ type: <event name>, frame: <body> }`.
    const encoder = new TextEncoder();
    const frames =
      'event: projection_update\ndata: {"state":{"items":[{"run_status":{"run_id":"r1","status":"running"}}]}}\n\n' +
      'event: keep_alive\ndata: {}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frames));
        controller.close();
      }
    });
    let capturedUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (u: string) => {
      capturedUrl = String(u);
      return { ok: true, status: 200, body: stream } as unknown as Response;
    }) as unknown as typeof fetch);

    const c = makeClient();
    const ctrl = new AbortController();
    const out: Array<{ type?: string; frame?: { state?: { items?: unknown[] } } }> = [];
    for await (const ev of c.streamWebChatV2Events('t1', { signal: ctrl.signal })) {
      out.push(ev as (typeof out)[number]);
    }

    expect(capturedUrl).toContain('/api/webchat/v2/threads/t1/events');
    expect(capturedUrl).toContain('token=tok');
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe('projection_update');
    // The body landed under `frame`, so reduceEvent's `frame.state.items` works.
    expect(out[0].frame?.state?.items).toHaveLength(1);
    expect(out[1].type).toBe('keep_alive');
  });

  it('prefers a body-level type on the default (unnamed) message channel', async () => {
    const encoder = new TextEncoder();
    // No `event:` line → SSE event name defaults to "message"; the body's own
    // `type` must win so a runtime that does not tag frames still routes.
    const frames = 'data: {"type":"final_reply","reply":{"text":"done"}}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frames));
        controller.close();
      }
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return { ok: true, status: 200, body: stream } as unknown as Response;
    }) as unknown as typeof fetch);

    const c = makeClient();
    const out: Array<{ type?: string; frame?: { reply?: { text?: string } } }> = [];
    for await (const ev of c.streamWebChatV2Events('t1', {
      signal: new AbortController().signal
    })) {
      out.push(ev as (typeof out)[number]);
    }
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('final_reply');
    expect(out[0].frame?.reply?.text).toBe('done');
  });

  it('passes after_cursor when resuming', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      }
    });
    let capturedUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (u: string) => {
      capturedUrl = String(u);
      return { ok: true, status: 200, body: stream } as unknown as Response;
    }) as unknown as typeof fetch);

    const c = makeClient();
    const ctrl = new AbortController();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ev of c.streamWebChatV2Events('t1', {
      afterCursor: 'cur-42',
      signal: ctrl.signal
    })) {
      // drain
    }
    expect(capturedUrl).toContain('after_cursor=cur-42');
  });

  it('throws when the stream fails to open', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return { ok: false, status: 503, body: null } as unknown as Response;
    }) as unknown as typeof fetch);
    const c = makeClient();
    const ctrl = new AbortController();
    await expect(async () => {
      for await (const _ev of c.streamWebChatV2Events('t1', { signal: ctrl.signal })) {
        void _ev;
      }
    }).rejects.toThrow(/503/);
  });
});
