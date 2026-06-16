// Typed HTTP client for the IronClaw gateway.
//
// Endpoints are documented in /tmp/ironclaw-api.md. Where the wire format
// differs from the TS types we expose, this client maps fields explicitly
// in the consumer-facing methods so callers see a stable interface.

import type {
  AttachmentInput,
  ChatEvent,
  CreateRoutineRequest,
  DeviceLoginPoll,
  DeviceLoginStart,
  EngineMission,
  EngineProject,
  EngineThread,
  EngineThreadDetail,
  EngineThreadEvent,
  EngineThreadStep,
  Extension,
  ExtensionSetupSchema,
  ExtensionTool,
  GatewayStatus,
  HealthStatus,
  ImageGenerationOptions,
  ImageGenerationResult,
  Job,
  JobDetail,
  JobEvent,
  JobFile,
  JobSummary,
  LlmModel,
  LlmProvider,
  LogEntry,
  LogLevel,
  MemoryHit,
  MemoryNode,
  Message,
  Routine,
  RoutineRun,
  RoutineSummary,
  ReplyThreadStreamEvent,
  SubAgentDispatchInput,
  SubAgentEvent,
  SubAgentTask,
  Skill,
  Thread,
  ToolPermission,
  ToolPermissionEntry,
  ToolPolicy,
  ToolPolicyAction,
  UsageEvent,
  UsageSummary,
  UserProfile,
  UserToken
} from './types';
// Value import (class) — kept separate from the type-only block above.
import { SubAgentUnsupportedError } from './types';
import { containsSecret, redactJsonObject, redactSecrets } from '$lib/utils/redact';
import { diagEnabled, inTauri } from '$lib/utils/runtime';
import { extensionTarget } from '$lib/util/extension-identity';
import { unwrapDocumentAssignment } from '$lib/util/work-product-normalize';
import {
  V2_BASE,
  clientActionId,
  type CancelRunRequest,
  type CreateThreadRequest,
  type CreateThreadResponse,
  type GateResolution,
  type ListThreadsResponse,
  type RebornRunStateResponse,
  type RebornTimelineResponse,
  type ResolveGateRequest,
  type SendMessageRequest,
  type SendMessageResponse,
  type WebChatV2EventFrame
} from './reborn';

// Single-call wrapper around the `diag_log` IPC. Gated on `diagEnabled()`
// so release builds stay quiet unless the user opts in via Settings
// → Debug mode. Drops every failure on the floor — diagnostics must
// never block a real request.
async function diag(msg: string): Promise<void> {
  if (!diagEnabled()) return;
  try {
    // @ts-expect-error — Tauri global at runtime
    await window.__TAURI_INTERNALS__?.invoke?.('diag_log', { msg });
  } catch {
    /* ignore */
  }
}

// Default timeout for non-streaming JSON requests. Applied only when the
// caller supplies no AbortSignal of their own, so a hung gateway can't wedge
// the UI indefinitely (e.g. onboarding stuck at "Connecting…"). Streaming
// methods own their own signal and don't route through `request()`.
const REQUEST_TIMEOUT_MS = 15_000;

// Lazy load of Tauri http plugin. Top-level static import crashed the
// entire JS bundle on production webview load (Webview JS never
// executed, app stuck on "Disconnected" with no keychain reads or
// fetches). Going back to a dynamic import gated on inTauri(), but
// caching the promise so we only resolve once per session.
let tauriFetchPromise: Promise<typeof fetch | null> | null = null;
function loadTauriFetch(): Promise<typeof fetch | null> {
  if (!inTauri()) return Promise.resolve(null);
  if (tauriFetchPromise) return tauriFetchPromise;
  tauriFetchPromise = import('@tauri-apps/plugin-http')
    .then((m) => (m && typeof m.fetch === 'function' ? (m.fetch as typeof fetch) : null))
    .catch((err) => {
      console.warn(
        '[ironclaw] Tauri http plugin failed to load; falling back to native fetch',
        err
      );
      return null;
    });
  return tauriFetchPromise;
}

export interface IronClawClientOptions {
  baseUrl: string;
  token: string;
}

class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class IronClawClient {
  readonly baseUrl: string;
  readonly token: string;

  constructor(opts: IronClawClientOptions) {
    // Strip trailing slash so we never produce // in paths.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
  }

  // ---- Internal HTTP plumbing ------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInit
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...((init?.headers as Record<string, string>) ?? {})
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    // Route through the Tauri http plugin when running inside the Tauri
    // webview — it goes through Rust and bypasses CORS, which the
    // production webview (tauri://localhost) otherwise fails on against
    // any gateway that doesn't whitelist that origin. Falls back to
    // native fetch in browser / vitest / dev contexts where the plugin
    // isn't available.
    const maybeTauri = await loadTauriFetch();
    const fetchImpl = maybeTauri ?? fetch;
    await diag(`request ${method} ${url} via ${maybeTauri ? 'tauriFetch' : 'nativeFetch'}`);
    // Spread `init` LAST for signal/etc., but strip its `headers` first —
    // they're already merged into `headers` above, and re-spreading the
    // raw `init.headers` here would clobber the merged set (dropping the
    // Authorization/Accept headers). Keeping headers merge-only lets
    // callers add request-specific headers (e.g. X-Confirm-Action) safely.
    const { headers: _mergedAlready, ...restInit } = init ?? {};

    // Apply a default timeout ONLY when the caller passed no signal — we
    // attach either the caller's signal or our internal timeout signal, never
    // both, so there's no double-abort.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    if (restInit.signal == null) {
      const ctrl = new AbortController();
      timeoutId = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, REQUEST_TIMEOUT_MS);
      restInit.signal = ctrl.signal;
    }

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        ...restInit
      });
    } catch (err) {
      if (timedOut) {
        await diag(`request TIMEOUT ${method} ${url} after ${REQUEST_TIMEOUT_MS}ms`);
        throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${method} ${path}`);
      }
      await diag(
        `request FAILED ${method} ${url}: ${err instanceof Error ? err.message : String(err)}`
      );
      throw err;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    await diag(`request OK ${method} ${url} status=${res.status}`);

    if (!res.ok) {
      let detail = res.statusText;
      try {
        const text = await res.text();
        if (text) detail = text.slice(0, 500);
      } catch {
        // ignore body-read failures; fall back to status text
      }
      throw new HttpError(res.status, url, `${res.status} ${detail}`);
    }

    // Some endpoints (DELETE, 204) may have empty bodies; guard parse.
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  // ---- Health & connection ---------------------------------------------------

  async health(): Promise<HealthStatus> {
    const res = await this.request<{ status?: string; channel?: string }>('GET', '/api/health');
    const status = res?.status;
    return {
      ok: status === 'ok' || status === 'healthy',
      status,
      channel: res?.channel
    };
  }

  async gatewayStatus(): Promise<GatewayStatus> {
    // Wire (verified 2026-05-27 against IronClaw 0.28.2):
    //   {version, sse_connections, ws_connections, total_connections,
    //    uptime_secs, restart_enabled, daily_cost, actions_this_hour,
    //    model_usage, llm_backend, llm_model, enabled_channels, engine_v2_enabled}
    // Note `uptime_secs` (not `uptime_seconds`). We accept either for
    // forward/backward compat and map onto `uptime_seconds` so callers
    // see a stable field name.
    const res = await this.request<{
      version?: string;
      engine_v2_enabled?: boolean;
      llm_model?: string;
      llm_backend?: string;
      model_execution_verified?: boolean;
      model_execution_readiness?: unknown;
      model_readiness?: unknown;
      model_readiness_reason?: string;
      model_execution_failure_category?: string;
      model_execution_failure_summary?: string;
      enabled_channels?: string[];
      ws_connections?: number;
      sse_connections?: number;
      total_connections?: number;
      uptime_secs?: number;
      uptime_seconds?: number;
      multi_tenant_mode?: boolean;
      daily_cost?: string;
      actions_this_hour?: number;
      restart_enabled?: boolean;
      model_usage?: unknown[];
    }>('GET', '/api/gateway/status');
    const ws = res?.ws_connections ?? 0;
    const sse = res?.sse_connections ?? 0;
    return {
      version: res?.version,
      engine_v2_enabled: res?.engine_v2_enabled,
      llm_model: res?.llm_model,
      llm_backend: res?.llm_backend,
      model_execution_verified: res?.model_execution_verified,
      model_execution_readiness: res?.model_execution_readiness,
      model_readiness: res?.model_readiness,
      model_readiness_reason: res?.model_readiness_reason,
      model_execution_failure_category: res?.model_execution_failure_category,
      model_execution_failure_summary: res?.model_execution_failure_summary,
      enabled_channels: res?.enabled_channels ?? [],
      sse_connections: sse,
      ws_connections: ws,
      total_connections: res?.total_connections ?? ws + sse,
      uptime_seconds: res?.uptime_secs ?? res?.uptime_seconds,
      multi_tenant_mode: res?.multi_tenant_mode,
      daily_cost: res?.daily_cost,
      actions_this_hour: res?.actions_this_hour,
      restart_enabled: res?.restart_enabled,
      model_usage: res?.model_usage
    };
  }

  // ---- Profile / sign-in -----------------------------------------------------

  /**
   * Fetch the currently-signed-in user via GET /api/profile.
   *
   * Wire shape verified against IronClaw 0.28.2:
   *   `{avatar_url, created_at, display_name, email, id, last_login_at, role, status}`
   *
   * Returns `null` on 401/403 — "not signed in" is a valid app state, not an
   * error worth throwing. Network/5xx failures still throw HttpError so the
   * sign-in store can surface them as `status: 'error'`.
   *
   * Map fields defensively: the gateway may emit `near_account`, `account_id`,
   * or `user_id` in different builds; we land all of them on the same struct
   * and let the consumer pick the most-specific value via UI logic.
   */
  async getProfile(): Promise<UserProfile | null> {
    try {
      const raw = await this.request<{
        // current gateway shape
        id?: string;
        display_name?: string;
        email?: string | null;
        avatar_url?: string | null;
        role?: string;
        last_login_at?: string | null;
        status?: string;
        // forward-compat fields (NEAR-cloud builds)
        near_account?: string;
        account_id?: string;
        user_id?: string;
        signed_in_at?: string;
      }>('GET', '/api/profile');

      if (!raw) return null;

      // The local single-tenant gateway uses `id: "default"` for the owner —
      // pass it through verbatim. A NEAR-cloud sign-in surfaces either as a
      // dedicated `near_account` field or as an `id` that ends in `.near` /
      // `.testnet`; treat any of those as the NEAR-account answer.
      const near = (() => {
        if (typeof raw.near_account === 'string' && raw.near_account.length > 0) {
          return raw.near_account;
        }
        if (typeof raw.account_id === 'string' && raw.account_id.length > 0) {
          return raw.account_id;
        }
        const id = raw.id ?? raw.user_id;
        if (typeof id === 'string' && (id.endsWith('.near') || id.endsWith('.testnet'))) {
          return id;
        }
        return undefined;
      })();

      return {
        user_id: raw.user_id ?? raw.id,
        near_account: near,
        display_name: raw.display_name ?? undefined,
        signed_in_at: raw.signed_in_at ?? raw.last_login_at ?? undefined,
        role: raw.role as UserProfile['role'],
        email: raw.email ?? undefined,
        avatar_url: raw.avatar_url ?? undefined
      };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        return null;
      }
      throw err;
    }
  }

  // ---- Logs ------------------------------------------------------------------

  /** GET /api/logs/level → current effective tracing level. */
  async getLogLevel(): Promise<{ level: LogLevel }> {
    const res = await this.request<{ level?: string }>('GET', '/api/logs/level');
    const level = normalizeLogLevel(res?.level);
    return { level };
  }

  /** POST /api/logs/level → set the gateway's effective tracing level. */
  async setLogLevel(level: LogLevel): Promise<{ ok: boolean }> {
    const res = await this.request<{ ok?: boolean; status?: string }>('POST', '/api/logs/level', {
      level
    });
    return { ok: res?.ok === true || res?.status === 'ok' };
  }

  /**
   * Stream log entries from the gateway via Server-Sent Events.
   *
   * Routes through `loadTauriFetch()` for the same reason as
   * `streamEvents`: the production webview (`tauri://localhost`) hits
   * CORS on the gateway, and `EventSource` cannot route through the
   * Tauri http plugin. Auth is via the `?token=` query string per the
   * gateway's `/api/logs/events` doc.
   *
   * Gateway emits a named event `log` whose payload is a JSON object
   * `{level, target, message, timestamp}`. On connect the server replays
   * its buffered window of recent entries, then streams live.
   */
  async *streamLogs(signal: AbortSignal): AsyncIterable<LogEntry> {
    // Token-free path for any error / log surface; the live URL carries the
    // bearer as a `?token=` param so it must never reach an HttpError or log.
    const safeUrl = `${this.baseUrl}/api/logs/events`;
    const url = new URL(safeUrl);
    if (this.token) url.searchParams.set('token', this.token);

    const maybeTauri = await loadTauriFetch();
    const fetchImpl = maybeTauri ?? fetch;
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal
    });
    if (!res.ok) {
      throw new HttpError(res.status, safeUrl, `${res.status} ${res.statusText}`);
    }
    if (!res.body) {
      throw new Error('logs/events: empty body');
    }
    yield* parseSseStream<LogEntry>(res.body, signal, (raw) => {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return [
          {
            level: normalizeLogLevel(parsed.level),
            target: String(parsed.target ?? ''),
            message: String(parsed.message ?? ''),
            timestamp: String(parsed.timestamp ?? '')
          }
        ];
      } catch {
        // Best-effort: drop malformed payloads rather than poison the stream.
        return [];
      }
    });
  }

  // ---- Chat ------------------------------------------------------------------

  async sendMessage(
    threadId: string | null,
    content: string,
    attachments?: AttachmentInput[],
    instructions?: string
  ): Promise<{ thread_id: string; message_id: string }> {
    // POST /api/chat/send accepts {content, thread_id?, attachments?[]} and
    // returns {message_id, status}. Thread ID may be created server-side; if
    // the caller didn't pass one, we surface the originally-provided value
    // (often null) — phase 3 will reconcile this against the SSE stream.
    //
    // Attachments — probed 2026-05-27 against IronClaw 0.28.2:
    //   attachments: [{ name: string, mime_type: string, data_base64: string }]
    //
    // `data_base64` is the RAW base64 payload (no `data:` prefix). The
    // gateway saves each attachment to
    //   `.ironclaw/attachments/<owner>/<thread>/<date>/<msg>-<name>`
    // and rewrites the user's `content` to append an `<attachments>` block
    // listing each saved file with type/filename/mime/project_path/size — so
    // the model sees the file location alongside the user's prose AND, for
    // images, the vision pipeline picks them up directly from memory.
    //
    // Omit the field entirely when there are no attachments — the wire
    // doesn't require it and an empty array would be a needless wire round.
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    const cleanInstructions =
      typeof instructions === 'string' && instructions.trim() !== '' ? instructions : undefined;
    const res = await this.request<{ message_id: string; thread_id?: string }>(
      'POST',
      '/api/chat/send',
      {
        content,
        ...(threadId ? { thread_id: threadId } : {}),
        ...(hasAttachments ? { attachments } : {}),
        ...(cleanInstructions ? { instructions: cleanInstructions } : {})
      }
    );
    return {
      thread_id: res.thread_id ?? threadId ?? '',
      message_id: res.message_id
    };
  }

  async resolveLegacyChatApproval(input: {
    threadId: string;
    requestId: string;
    action: 'approve' | 'always' | 'deny';
  }): Promise<void> {
    await this.request<unknown>('POST', '/api/chat/approval', {
      thread_id: input.threadId,
      request_id: input.requestId,
      action: input.action
    });
  }

  async generateImage(
    prompt: string,
    options: ImageGenerationOptions = {}
  ): Promise<ImageGenerationResult> {
    void prompt;
    void options;
    throw new Error('Image generation unavailable on this gateway version');
  }

  async postReplyThread(
    parentMessageId: string,
    parentThreadId: string,
    content: string,
    attachments?: AttachmentInput[]
  ): Promise<{ message_id: string }> {
    const url = `${this.baseUrl}/api/chat/send`;
    const maybeTauri = await loadTauriFetch();
    const fetchImpl = maybeTauri ?? fetch;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      body: JSON.stringify({
        content,
        thread_id: parentThreadId,
        reply_to_message_id: parentMessageId,
        ...(attachments && attachments.length > 0 ? { attachments } : {})
      })
    });
    if (!res.ok) throw new Error(`postReplyThread ${res.status}`);
    return await res.json();
  }

  async listReplyThread(parentMessageId: string): Promise<Message[]> {
    const url = `${this.baseUrl}/api/chat/messages/${encodeURIComponent(parentMessageId)}/replies`;
    const maybeTauri = await loadTauriFetch();
    const fetchImpl = maybeTauri ?? fetch;
    const res = await fetchImpl(url, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}
    });
    if (!res.ok) {
      if (res.status === 404) return [];
      throw new Error(`listReplyThread ${res.status}`);
    }
    const body = (await res.json()) as { replies?: Message[] };
    return body.replies ?? [];
  }

  async *streamReplyThread(
    parentMessageId: string,
    parentThreadId: string,
    signal: AbortSignal
  ): AsyncIterable<ReplyThreadStreamEvent> {
    const url = `${this.baseUrl}/api/chat/threads/${encodeURIComponent(parentThreadId)}/events`;
    const maybeTauri = await loadTauriFetch();
    const fetchImpl = maybeTauri ?? fetch;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      signal
    });
    if (!res.ok) {
      throw new HttpError(res.status, url, `${res.status} ${res.statusText}`);
    }
    if (!res.body) {
      throw new Error('reply thread events: empty body');
    }
    yield* parseSseStream<ReplyThreadStreamEvent>(res.body, signal, (raw, event) => {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed.type && event !== 'message') parsed.type = event;
        const ev = normalizeReplyThreadEvent(parsed, parentMessageId);
        return ev ? [ev] : [];
      } catch (e) {
        return [
          {
            type: 'reply.failed',
            reply_id: '',
            parent_message_id: parentMessageId,
            error: `parse error: ${(e as Error).message}`
          }
        ];
      }
    });
  }

  /**
   * Stream chat events for a thread via Server-Sent Events.
   *
   * Originally used `EventSource` for the browser's built-in
   * reconnect-on-disconnect. That broke in production builds because
   * `EventSource` doesn't route through the Tauri http plugin — it goes
   * directly through WKWebView, hits CORS (gateway doesn't whitelist
   * `tauri://localhost`), and surfaces a generic `error` event with no
   * detail (the "SSE connection error" toast).
   *
   * Now uses fetch + a manual SSE parser via `loadTauriFetch()` so the
   * stream goes through Rust. We lose EventSource's auto-reconnect but
   * the upstream callers (chat surface) drive their own retry loops
   * already, and the gateway doesn't drop connections in practice.
   */
  async *streamEvents(threadId: string, signal: AbortSignal): AsyncIterable<ChatEvent> {
    // Token-free path for any error / log surface; the live URL carries the
    // bearer as a `?token=` param so it must never reach an HttpError or log.
    const safeUrl = `${this.baseUrl}/api/chat/events${
      threadId ? `?thread_id=${encodeURIComponent(threadId)}` : ''
    }`;
    const url = new URL(`${this.baseUrl}/api/chat/events`);
    if (threadId) url.searchParams.set('thread_id', threadId);
    if (this.token) url.searchParams.set('token', this.token);

    const maybeTauri = await loadTauriFetch();
    const fetchImpl = maybeTauri ?? fetch;
    await diag(`streamEvents GET ${safeUrl} via ${maybeTauri ? 'tauriFetch' : 'nativeFetch'}`);
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal
    });
    if (!res.ok) {
      throw new HttpError(res.status, safeUrl, `${res.status} ${res.statusText}`);
    }
    if (!res.body) {
      throw new Error('chat/events: empty body');
    }
    yield* parseSseStream<ChatEvent>(res.body, signal, (raw) => {
      try {
        const ev = normalizeEvent(JSON.parse(raw) as Record<string, unknown>);
        return ev === null ? [] : [ev];
      } catch (e) {
        return [{ type: 'error', message: `parse error: ${(e as Error).message}` }];
      }
    });
  }

  /**
   * Stream a single user turn through the OpenAI-compatible Responses API
   * (`POST /api/v1/responses` with `stream: true`).
   *
   * Unlike the legacy `/api/chat/send` + `/api/chat/events` pair which delivers
   * the full assistant content per event (and so feels jumpy as each new
   * "delta" clobbers the buffer), the Responses-API emits real incremental
   * `response.output_text.delta` chunks. The messages-store heuristic
   * concatenates these correctly because each chunk is small and does not
   * start with the current buffer.
   *
   * Probe (2026-05-27) of the live gateway confirmed the event taxonomy and
   * shape — see `ChatEvent` in `types.ts` for the full mapping. Tool/function
   * calls come back as `response.output_item.{added,done}` envelopes with
   * `item.type === "function_call"`; we synthesize a `tool_call` on `added`
   * and a `tool_result` on `done` so the existing right-rail tool inspector
   * continues to render.
   *
   * The gateway today does NOT accept a `model` parameter (a 400 "Model
   * selection is not yet supported" comes back if one is sent); we omit it.
   * Thread membership is carried via `metadata.thread_id` — the wire schema
   * accepts arbitrary metadata so this is forward-compatible with whatever
   * thread-resolution logic the gateway grows.
   *
   * Uses `fetch` + a manual SSE parser rather than `EventSource` because:
   *   1. `EventSource` cannot attach `Authorization` headers (we'd have to
   *      smuggle the token through a query string and the gateway only
   *      honours headers for `/api/v1/responses` today), and
   *   2. The Responses-API endpoint is POST + body, which `EventSource`
   *      cannot do at all.
   */
  async *streamResponse(
    input: string,
    threadId: string | null,
    signal: AbortSignal,
    /**
     * Per-call system-prompt override (R43). The gateway may or may
     * not honor this; older gateways ignore the field, newer ones
     * layer it on top of the admin SYSTEM.md. The Responses API spec
     * uses `instructions` for per-call system-prompt overrides, so
     * we wire it onto the request body at the top level (not under
     * `metadata`).
     *
     * Omitted entirely when undefined so a non-overriding send hits
     * the same wire shape the gateway has been seeing — keeps the
     * change strictly additive for legacy gateways.
     */
    systemPrompt?: string
  ): AsyncIterable<ChatEvent> {
    const url = `${this.baseUrl}/api/v1/responses`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
    };
    const body: Record<string, unknown> = {
      input,
      stream: true,
      // Gateway rejects an explicit `model` field today (400 invalid_request).
      // Omit and let the server pick. If a future build accepts `"default"`,
      // we can pass it through.
      ...(threadId ? { metadata: { thread_id: threadId } } : {}),
      // Per-call system-prompt override (R43). The gateway may or may not
      // honor this; older gateways ignore the field, newer ones layer it on
      // top of the admin SYSTEM.md. Only include when a non-empty prompt is
      // supplied so the wire shape stays identical to the pre-R43 send for
      // threads with no override.
      ...(typeof systemPrompt === 'string' && systemPrompt.trim() !== ''
        ? { instructions: systemPrompt }
        : {})
    };

    // SSE streaming MUST also go through the Tauri http plugin in
    // production — the gateway doesn't whitelist `tauri://localhost` in its
    // CORS allowlist, so a direct browser fetch returns a CORS-blocked
    // response that surfaces as "SSE connection error" with no body. The
    // Tauri http plugin routes through Rust → bypasses CORS → response body
    // (incl. SSE chunks) flows back as a normal ReadableStream.
    const maybeTauri = await loadTauriFetch();
    const fetchImpl = maybeTauri ?? fetch;
    await diag(`streamResponse POST ${url} via ${maybeTauri ? 'tauriFetch' : 'nativeFetch'}`);
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    });

    if (!res.ok) {
      // Pull the body once for the error message; the stream is dead either
      // way after a non-2xx so reading it is safe.
      let detail = res.statusText;
      try {
        const text = await res.text();
        if (text) detail = text.slice(0, 500);
      } catch {
        // ignore
      }
      throw new HttpError(res.status, url, `${res.status} ${detail}`);
    }
    if (!res.body) {
      throw new Error('Responses API: empty body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        if (signal.aborted) {
          // Cancel the underlying stream so the gateway can stop generating.
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by blank lines (\n\n or \r\n\r\n). Pull
        // each complete frame out of the buffer and parse it; leave any
        // partial trailing frame in `buf` for the next read.
        let frameEnd: number;
        // eslint-disable-next-line no-cond-assign
        while ((frameEnd = findFrameEnd(buf)) !== -1) {
          const rawFrame = buf.slice(0, frameEnd);
          // Advance past the delimiter (\n\n or \r\n\r\n).
          buf = buf.slice(frameEnd + (buf.startsWith('\r\n', frameEnd) ? 2 : 0) + 2);
          const ev = parseSseFrame(rawFrame);
          if (!ev) continue;
          for (const out of mapResponsesEvent(ev)) {
            yield out;
          }
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      // Surface as a single error event so the caller's existing handler
      // path renders it without a try/catch around the for-await.
      yield { type: 'error', message: (err as Error).message };
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Detect which streaming endpoints this gateway supports.
   *
   * The OpenAI-compatible Responses API was added to IronClaw v0.29.x.
   * Older gateways only expose `/api/chat/send` + `/api/chat/events`. We
   * probe with a cheap method-mismatch (`GET /api/v1/responses`) so we
   * never actually start a generation just to find out — the gateway
   * answers 405 Method Not Allowed (with `Allow: POST`) when the route
   * exists and 404 when it doesn't. Either of these signals what we need
   * without spending tokens.
   *
   * Result is cached on the client instance for the lifetime of the
   * connection so repeated sends don't re-probe. A fresh
   * `IronClawClient` (e.g. after a profile switch) re-probes from scratch.
   */
  async getServerCapabilities(): Promise<{ responses_api: boolean }> {
    if (this._capabilitiesCache) return this._capabilitiesCache;
    const url = `${this.baseUrl}/api/v1/responses`;
    try {
      // MUST route through the Tauri http plugin in production — the gateway
      // doesn't whitelist `tauri://localhost` in its CORS allowlist, so a
      // direct webview fetch fails CORS, the catch below kicks in, and
      // `responses_api: false` is cached on the client. The chat surface
      // would then never use the Responses branch (incl. the per-thread
      // `instructions` override added in R43). R45 codex P1.
      const maybeTauri = await loadTauriFetch();
      const fetchImpl = maybeTauri ?? fetch;
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}
      });
      // 405 = route exists but doesn't accept GET → supports POST streaming.
      // 401/403 = route exists and would have served us if we'd been authed
      //   for it — still counts as "available" (the streaming POST carries
      //   the bearer and will succeed).
      // 200 = unexpected, but treat as available.
      // 404 = no such route → fall back to legacy /api/chat path.
      // Anything else (5xx, network) → conservative: report unavailable so
      //   the caller uses the well-trodden legacy path.
      const available =
        res.status === 405 ||
        res.status === 401 ||
        res.status === 403 ||
        (res.status >= 200 && res.status < 300);
      this._capabilitiesCache = { responses_api: available };
      return this._capabilitiesCache;
    } catch {
      this._capabilitiesCache = { responses_api: false };
      return this._capabilitiesCache;
    }
  }

  private _capabilitiesCache: { responses_api: boolean } | null = null;

  /**
   * One-shot, non-streaming completion via `POST /api/v1/responses`
   * (`stream: false`). Returns the concatenated assistant text. Used by the
   * generative-missions store to propose grounded actions from live context;
   * the proposal output is small (a JSON array), so a blocking call is fine.
   * Prefers the OpenAI Responses `output[].content[].text` shape, with an
   * `output_text` convenience fallback.
   */
  async createResponse(
    input: string,
    opts?: { model?: string; signal?: AbortSignal }
  ): Promise<string> {
    const body: Record<string, unknown> = { input, stream: false };
    if (opts?.model) body.model = opts.model;
    const res = await this.request<{
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    }>('POST', '/api/v1/responses', body, { signal: opts?.signal });
    if (typeof res.output_text === 'string' && res.output_text.trim()) {
      return res.output_text.trim();
    }
    const chunks: string[] = [];
    for (const o of res.output ?? []) {
      for (const c of o.content ?? []) {
        if (c?.type === 'output_text' && typeof c.text === 'string') chunks.push(c.text);
      }
    }
    return chunks.join('\n').trim();
  }

  async listThreads(signal?: AbortSignal): Promise<Thread[]> {
    // Wire (verified 2026-05-27): each thread carries `turn_count` (one turn =
    // one user msg + one assistant response rolled into one row). Older /
    // future server builds may emit `message_count`; accept either. The
    // server also returns an `assistant_thread` field at the top level (a
    // long-running assistant scratch thread, distinct from the user threads);
    // we ignore it here — callers can probe `/api/chat/threads` directly if
    // they need it.
    const res = await this.request<{
      threads?: Array<{
        id: string;
        title?: string;
        created_at: string;
        last_message_at?: string;
        updated_at?: string;
        turn_count?: number;
        message_count?: number;
      }>;
    }>('GET', '/api/chat/threads', undefined, { signal });
    return (res?.threads ?? []).map((t) => ({
      id: t.id,
      title: t.title ?? '',
      created_at: t.created_at,
      updated_at: t.last_message_at ?? t.updated_at ?? t.created_at,
      message_count: t.turn_count ?? t.message_count ?? 0
    }));
  }

  async pollThreadChanges(
    since: number,
    signal?: AbortSignal
  ): Promise<{
    changed: Thread[];
    deleted: string[];
    nextSince: number;
  }> {
    const url = `${this.baseUrl}/api/chat/threads/poll?since=${since}`;
    const maybeTauri = await loadTauriFetch();
    const fetchImpl = maybeTauri ?? fetch;
    const res = await fetchImpl(url, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      signal
    });
    if (!res.ok) throw new Error(`pollThreadChanges ${res.status}`);
    const body = await res.json();
    return {
      changed: (body.changed ?? []).map(
        (t: {
          id: string;
          title?: string;
          created_at?: string;
          updated_at?: string;
          last_message_at?: string;
          turn_count?: number;
          message_count?: number;
        }) => ({
          id: t.id,
          title: t.title ?? '',
          created_at: t.created_at ?? t.updated_at ?? t.last_message_at ?? '',
          updated_at: t.last_message_at ?? t.updated_at ?? t.created_at ?? '',
          message_count: t.turn_count ?? t.message_count ?? 0
        })
      ),
      deleted: body.deleted ?? [],
      nextSince: body.next_since ?? Date.now()
    };
  }

  /**
   * Fetch a slice of a thread's history. The optional `offset` is forwarded
   * verbatim to the gateway's `offset` query parameter for paginated loads;
   * the gateway returns the *most recent* `limit` messages starting that many
   * rows back from the head (offset 0 = newest page, offset 30 = the page
   * before that, etc.). Default offset of 0 preserves the original behaviour
   * for callers that just want the latest slice.
   *
   * The gateway is documented to support `?thread_id=...&limit=...&offset=...`
   * (see /tmp/ironclaw-api.md §GET /api/chat/history). If a future revision
   * starts returning a `next_cursor`-style token, swap this for cursor-based
   * paging without changing callers — `loadMoreHistory` in the store layer
   * abstracts over the wire shape.
   */
  async getHistory(threadId: string, limit = 50, offset = 0): Promise<Message[]> {
    const qs = new URLSearchParams({ thread_id: threadId, limit: String(limit) });
    if (offset > 0) qs.set('offset', String(offset));
    // Wire (verified 2026-05-27): server returns
    //   {thread_id, turns: [{turn_number, user_message_id, user_input,
    //                        response, response_id?, state, started_at,
    //                        completed_at, tool_calls}], has_more, oldest_timestamp}
    // Each turn = ONE user message + ONE assistant response, rolled into a
    // single row. Expand into the flat [user, assistant, …] sequence the UI
    // expects, ordered by turn_number.
    //
    // Older / future server builds may emit a flat `messages: [{id, role,
    // content, …}]` directly; we accept either shape and fall through to a
    // verbatim mapping when present.
    const res = await this.request<{
      messages?: Array<{
        id: string;
        role: 'user' | 'assistant' | 'tool';
        content: string;
        timestamp?: string;
        created_at?: string;
      }>;
      turns?: Array<{
        turn_number?: number;
        user_message_id?: string;
        user_input?: string;
        response?: string;
        response_id?: string;
        started_at?: string;
        completed_at?: string;
      }>;
    }>('GET', `/api/chat/history?${qs.toString()}`);

    // Flat messages path (forward/back compat with hypothetical server build).
    if (Array.isArray(res?.messages)) {
      return res.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.role === 'assistant' ? unwrapDocumentAssignment(m.content) : m.content,
        created_at: m.created_at ?? m.timestamp ?? ''
      }));
    }

    // Canonical wire today: turns[] expanded to messages[].
    const turns = (res?.turns ?? [])
      .slice()
      .sort((a, b) => (a.turn_number ?? 0) - (b.turn_number ?? 0));

    const messages: Message[] = [];
    for (const t of turns) {
      const userTs = t.started_at ?? '';
      const asstTs = t.completed_at ?? t.started_at ?? '';
      const turnNo = t.turn_number ?? messages.length;
      // User half. Always emit; an empty user_input is still a row so the
      // ordering stays right.
      messages.push({
        id: t.user_message_id ?? `turn-${turnNo}-user`,
        role: 'user',
        content: t.user_input ?? '',
        created_at: userTs
      });
      // Assistant half. Skip when the turn has no response yet (in-flight
      // turns can land here mid-stream).
      if (typeof t.response === 'string' && t.response.length > 0) {
        messages.push({
          id: t.response_id ?? `turn-${turnNo}-asst`,
          role: 'assistant',
          content: unwrapDocumentAssignment(t.response),
          created_at: asstTs
        });
      }
    }
    return messages;
  }

  async newThread(title?: string): Promise<{ id: string }> {
    const res = await this.request<{ thread_id: string; id?: string }>(
      'POST',
      '/api/chat/thread/new',
      title ? { title } : {}
    );
    return { id: res.thread_id ?? res.id ?? '' };
  }

  /**
   * Delete a conversation thread.
   *
   * NOTE (2026-05-27): The gateway does not currently expose this endpoint.
   * Direct probe of the live server confirms `DELETE /api/chat/threads/{id}`
   * returns 404 (no matching route in
   * `src/channels/web/platform/router.rs`). The method is pre-wired so the
   * delete affordance can be added in one PR once the server lands the
   * handler; right now it falls through to the gateway and returns the
   * 404 as an HttpError so any caller fails loudly rather than silently
   * "succeeding". No UI surfaces this call yet.
   *
   * Expected wire shape once implemented (mirrors `DELETE /api/routines/{id}`):
   *   Response: 200 OK
   *   Body: {"status": "deleted", "id": "thread-uuid"}
   */
  async deleteThread(threadId: string): Promise<{ ok: boolean }> {
    const res = await this.request<{ status?: string; id?: string }>(
      'DELETE',
      `/api/chat/threads/${encodeURIComponent(threadId)}`
    );
    return { ok: res?.status === 'deleted' || res?.status === 'ok' };
  }

  // ---- Memory / knowledge ----------------------------------------------------

  async searchMemory(query: string, limit = 10): Promise<MemoryHit[]> {
    const res = await this.request<{
      results: Array<{ path: string; content?: string; snippet?: string; score: number }>;
    }>('POST', '/api/memory/search', { query, limit });
    return (res?.results ?? []).map((r) => ({
      path: r.path,
      snippet: r.snippet ?? r.content ?? '',
      score: r.score
    }));
  }

  async listMemory(prefix?: string): Promise<MemoryNode[]> {
    const qs = prefix ? `?path=${encodeURIComponent(prefix)}` : '';
    const res = await this.request<{
      entries: Array<{
        path: string;
        is_dir: boolean;
        size?: number;
        updated_at?: string | null;
      }>;
    }>('GET', `/api/memory/list${qs}`);
    return (res?.entries ?? []).map((e) => ({
      path: e.path,
      type: e.is_dir ? 'dir' : 'file',
      size: e.size,
      // Normalize `null` → `undefined` so the field stays "missing" rather
      // than carrying an explicit null through the UI's `?? '—'` checks.
      updated_at: e.updated_at ?? undefined
    }));
  }

  /**
   * Flatten the entire memory store into one list via `/api/memory/tree`.
   *
   * Wire: `GET /api/memory/tree[?depth=N]` returns `{ entries: Array<{
   * path, is_dir, updated_at? }> }`. Depth is omitted by default so the
   * caller gets every file in one round-trip — the inspector surface uses
   * this for its flat card list. For the knowledge tree we keep using
   * `listMemory(prefix)` because that page wants per-level expansion.
   *
   * Directories are included as entries (mirrors the wire shape); callers
   * filter to `type === 'file'` when they only care about leaf docs.
   */
  async getMemoryTree(depth?: number): Promise<MemoryNode[]> {
    const qs = depth !== undefined ? `?depth=${depth}` : '';
    const res = await this.request<{
      entries: Array<{
        path: string;
        is_dir: boolean;
        size?: number;
        updated_at?: string | null;
      }>;
    }>('GET', `/api/memory/tree${qs}`);
    return (res?.entries ?? []).map((e) => ({
      path: e.path,
      type: e.is_dir ? 'dir' : 'file',
      size: e.size,
      updated_at: e.updated_at ?? undefined
    }));
  }

  async readMemory(path: string): Promise<{ content: string; metadata?: unknown }> {
    const qs = new URLSearchParams({ path });
    const res = await this.request<{ path: string; content: string; updated_at?: string }>(
      'GET',
      `/api/memory/read?${qs.toString()}`
    );
    return {
      content: res.content ?? '',
      metadata: res.updated_at ? { updated_at: res.updated_at } : undefined
    };
  }

  /**
   * Write or replace a memory document at `path` with `content`.
   *
   * Wire shape: gateway returns `{path, status: "written", redirected?, actual_layer?}`.
   * We normalize to `{ok, path}` so callers don't have to know the server's
   * status vocabulary; `ok` is true whenever the server reported a write.
   *
   * Path validation lives on the caller side (the route enforces "no leading
   * slash / no `..` / no empty segments") so the gateway only sees clean paths,
   * but the gateway itself also rejects traversal — this is defense in depth,
   * not a substitute.
   */
  async writeMemory(path: string, content: string): Promise<{ ok: boolean; path?: string }> {
    const res = await this.request<{
      path?: string;
      status?: string;
    }>('POST', '/api/memory/write', { path, content });
    return {
      ok: res?.status === 'written' || res?.status === 'ok',
      path: res?.path ?? path
    };
  }

  /**
   * Delete a memory document at `path`.
   *
   * NOTE (2026-05-27): The gateway does not currently expose this endpoint.
   * Direct probe of the live server confirms BOTH attempted shapes return
   * 404 (no matching route in `src/channels/web/platform/router.rs`):
   *   - `DELETE /api/memory?path=...`
   *   - `POST   /api/memory/delete`  (body `{path}`)
   *
   * The method is pre-wired so the delete affordance can be added in one PR
   * once the server lands the handler. It tries DELETE first and falls back
   * to POST on 404/405 (per the prompt's preferred wire shapes); the final
   * HttpError is rethrown so callers fail loudly rather than silently
   * succeeding. No UI surfaces this call yet.
   */
  async deleteMemory(path: string): Promise<{ ok: boolean }> {
    // Try DELETE /api/memory?path=... first (preferred RESTful shape).
    const qs = new URLSearchParams({ path });
    try {
      const res = await this.request<{ status?: string; path?: string }>(
        'DELETE',
        `/api/memory?${qs.toString()}`
      );
      return { ok: res?.status === 'deleted' || res?.status === 'ok' };
    } catch (err) {
      // Fall back to POST /api/memory/delete on Method Not Allowed (405) or
      // 404 — the latter covers the case where the route shape is different
      // than expected.
      if (err instanceof HttpError && (err.status === 405 || err.status === 404)) {
        const res = await this.request<{ status?: string; path?: string }>(
          'POST',
          '/api/memory/delete',
          { path }
        );
        return { ok: res?.status === 'deleted' || res?.status === 'ok' };
      }
      throw err;
    }
  }

  // ---- Skills ----------------------------------------------------------------

  async listSkills(): Promise<Skill[]> {
    // The gateway returns the rich shape documented in /tmp/ironclaw-api.md:
    // { name, description, version, trust, source, bundle_path,
    //   has_requirements, has_scripts, usage_hint, keywords, setup_hint,
    //   install_source_url }. We pass the enrichment fields through verbatim;
    // `source` is the Rust Debug-formatted SkillSource string and must NOT be
    // parsed client-side.
    const res = await this.request<{
      skills: Array<{
        name: string;
        description: string;
        version: string;
        trust?: string;
        source?: string;
        bundle_path?: string | null;
        has_requirements?: boolean;
        has_scripts?: boolean;
        usage_hint?: string | null;
      }>;
    }>('GET', '/api/skills');
    return (res?.skills ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      version: s.version,
      // Anything returned by /api/skills is by definition installed locally.
      installed: true,
      trust: s.trust,
      source: s.source,
      bundle_path: s.bundle_path ?? undefined,
      has_requirements: s.has_requirements,
      has_scripts: s.has_scripts,
      usage_hint: s.usage_hint ?? undefined
    }));
  }

  async searchSkills(query: string): Promise<Skill[]> {
    const res = await this.request<{
      catalog?: Array<{
        slug: string;
        name?: string;
        description: string;
        version: string;
        installed?: boolean;
        trust?: string;
        source?: string;
        bundle_path?: string | null;
        has_requirements?: boolean;
        has_scripts?: boolean;
        usage_hint?: string | null;
      }>;
      installed?: Array<{
        name: string;
        description: string;
        version: string;
        trust?: string;
        source?: string;
        bundle_path?: string | null;
        has_requirements?: boolean;
        has_scripts?: boolean;
        usage_hint?: string | null;
      }>;
    }>('POST', '/api/skills/search', { query });

    // Prefer catalog entries (richer metadata), fall back to installed list.
    // Both shapes carry the same enrichment fields where the server populates them.
    const catalog = (res?.catalog ?? []).map((c) => ({
      name: c.name ?? c.slug,
      description: c.description,
      version: c.version,
      installed: c.installed ?? false,
      trust: c.trust,
      source: c.source,
      bundle_path: c.bundle_path ?? undefined,
      has_requirements: c.has_requirements,
      has_scripts: c.has_scripts,
      usage_hint: c.usage_hint ?? undefined
    }));
    if (catalog.length > 0) return catalog;
    return (res?.installed ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      version: s.version,
      installed: true,
      trust: s.trust,
      source: s.source,
      bundle_path: s.bundle_path ?? undefined,
      has_requirements: s.has_requirements,
      has_scripts: s.has_scripts,
      usage_hint: s.usage_hint ?? undefined
    }));
  }

  async installSkill(source: string): Promise<{ ok: boolean }> {
    // Verified live against IronClaw v0.29 (2026-05-28): the install body
    // field is `name` (the catalog slug value, e.g. "web"), and the request
    // MUST carry an `X-Confirm-Action: true` header — installs mutate the
    // workspace and the gateway refuses them otherwise (400 "Skill install
    // requires X-Confirm-Action: true header"). The earlier `{slug}` body
    // without the header returned 400 "missing field `name`". The response
    // is `{success, message}` on v0.29, `{status}` on older builds — accept
    // both.
    const res = await this.request<{ status?: string; success?: boolean; message?: string }>(
      'POST',
      '/api/skills/install',
      { name: source },
      { headers: { 'X-Confirm-Action': 'true' } }
    );
    return { ok: res?.success === true || res?.status === 'queued' || res?.status === 'installed' };
  }

  // ---- Routines --------------------------------------------------------------

  async listRoutines(): Promise<Routine[]> {
    const res = await this.request<{
      routines: Array<{
        id: string;
        name: string;
        enabled: boolean;
        trigger_summary?: string;
        trigger_raw?: string;
        last_run_at?: string;
        next_fire_at?: string;
      }>;
    }>('GET', '/api/routines');
    return (res?.routines ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      schedule: r.trigger_summary ?? r.trigger_raw ?? '',
      enabled: r.enabled,
      last_run: r.last_run_at,
      next_run: r.next_fire_at
    }));
  }

  async routinesSummary(): Promise<RoutineSummary> {
    const res = await this.request<{
      total?: number;
      enabled?: number;
      failing?: number;
      runs_today?: number;
    }>('GET', '/api/routines/summary');
    return {
      total: res?.total ?? 0,
      enabled: res?.enabled ?? 0,
      // Gateway doesn't currently expose a 'running' count; approximate as 0.
      running: 0,
      failed_last_24h: res?.failing ?? 0
    };
  }

  async getRoutine(id: string): Promise<Routine> {
    const res = await this.request<{
      id: string;
      name: string;
      enabled: boolean;
      trigger_summary?: string;
      trigger_raw?: string;
      last_run_at?: string;
      next_fire_at?: string;
    }>('GET', `/api/routines/${encodeURIComponent(id)}`);
    return {
      id: res.id,
      name: res.name,
      schedule: res.trigger_summary ?? res.trigger_raw ?? '',
      enabled: res.enabled,
      last_run: res.last_run_at,
      next_run: res.next_fire_at
    };
  }

  async triggerRoutine(id: string): Promise<{ run_id: string }> {
    const res = await this.request<{ run_id: string }>(
      'POST',
      `/api/routines/${encodeURIComponent(id)}/trigger`
    );
    return { run_id: res.run_id };
  }

  /**
   * Create a new routine via `POST /api/routines`.
   *
   * NOTE (2026-05-27): The gateway does not yet implement this endpoint.
   * Direct probe of the live server returns 405 Method Not Allowed against
   * IronClaw v0.29.x — the route exists for GET (list) but no POST handler
   * is registered. The method is pre-wired so the create-routine UI can be
   * added in one PR once the server lands the handler; until then it falls
   * through to the gateway and rethrows the 405 as an HttpError so any
   * caller fails loudly rather than silently "succeeding". No UI surfaces
   * this call yet.
   *
   * Expected wire shape once implemented (best-guess; the server-side schema
   * is the source of truth):
   *   Request:  {name, schedule, prompt, enabled?}
   *   Response: 201 CREATED
   *   Body:     {id, name, schedule, enabled, ...the same shape as GET /api/routines}
   *
   * If the server eventually accepts a richer trigger shape (e.g.
   * `{trigger: {type: "cron", cron_expr: "0 9 * * *"}, action: {prompt: "…"}}`),
   * remap inside this method — keep the client-facing `CreateRoutineRequest`
   * stable so route code doesn't need to know the wire details.
   */
  async createRoutine(req: CreateRoutineRequest): Promise<Routine> {
    const body: Record<string, unknown> = {
      name: req.name,
      schedule: req.schedule,
      prompt: req.prompt
    };
    if (req.enabled !== undefined) body.enabled = req.enabled;
    const res = await this.request<{
      id: string;
      name?: string;
      enabled?: boolean;
      trigger_summary?: string;
      trigger_raw?: string;
      last_run_at?: string;
      next_fire_at?: string;
    }>('POST', '/api/routines', body);
    return {
      id: res.id,
      name: res.name ?? req.name,
      schedule: res.trigger_summary ?? res.trigger_raw ?? req.schedule,
      enabled: res.enabled ?? req.enabled ?? true,
      last_run: res.last_run_at,
      next_run: res.next_fire_at
    };
  }

  async toggleRoutine(id: string, enabled: boolean): Promise<{ ok: boolean }> {
    const res = await this.request<{ status: string; enabled?: boolean }>(
      'POST',
      `/api/routines/${encodeURIComponent(id)}/toggle`,
      { enabled }
    );
    return { ok: res?.status === 'toggled' };
  }

  async getRoutineRuns(id: string, limit = 20): Promise<RoutineRun[]> {
    const qs = new URLSearchParams({ limit: String(limit) });
    const res = await this.request<{
      runs: Array<{
        id: string;
        started_at: string;
        completed_at?: string;
        status: 'completed' | 'failed' | 'timeout' | 'running';
        result_summary?: string;
      }>;
    }>('GET', `/api/routines/${encodeURIComponent(id)}/runs?${qs.toString()}`);
    return (res?.runs ?? []).map((r) => ({
      id: r.id,
      routine_id: id,
      started_at: r.started_at,
      finished_at: r.completed_at,
      status: mapRunStatus(r.status),
      output: r.result_summary
    }));
  }

  // ---- Jobs ------------------------------------------------------------------
  //
  // Background-job queue handlers. The gateway routes are documented in
  // `src/channels/web/features/jobs/mod.rs` and verified against IronClaw
  // 0.28.2 on 2026-05-27.
  //
  // Two important wire deviations from the original brief:
  //   1. The summary endpoint uses `in_progress` (not `running`) and adds a
  //      `stuck` bucket for stalled agent jobs. We expose both `in_progress`
  //      AND a `running` alias for backwards-compatible UI vocabulary.
  //   2. `/api/jobs/{id}/events` is a plain JSON GET that replays the
  //      historical event list — NOT an SSE stream. `streamJobEvents` polls
  //      the endpoint and yields newly-observed events so callers see the
  //      AsyncIterable interface the brief asked for; when the server adds a
  //      real SSE channel we can swap the body without touching callers.

  /** GET /api/jobs → list of jobs (newest first). The server scopes by user
   *  automatically. Optional `status` filter is passed verbatim — the
   *  gateway today returns the full list regardless, so we also apply a
   *  client-side filter as a defensive belt-and-suspenders. The `limit` is
   *  client-side only for the same reason (the server has no `limit` param). */
  async listJobs(opts?: { status?: string; limit?: number }): Promise<Job[]> {
    const qs = new URLSearchParams();
    if (opts?.status) qs.set('status', opts.status);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const res = await this.request<{
      jobs?: Array<{
        id: string;
        title?: string;
        state?: string;
        user_id?: string;
        created_at?: string;
        started_at?: string;
      }>;
    }>('GET', `/api/jobs${suffix}`);
    let jobs: Job[] = (res?.jobs ?? []).map((j) => ({
      id: String(j.id ?? ''),
      title: typeof j.title === 'string' ? j.title : '',
      state: typeof j.state === 'string' ? j.state : 'pending',
      user_id: typeof j.user_id === 'string' ? j.user_id : '',
      created_at: typeof j.created_at === 'string' ? j.created_at : '',
      started_at: typeof j.started_at === 'string' ? j.started_at : undefined
    }));
    if (opts?.status) {
      jobs = jobs.filter((j) => j.state === opts.status);
    }
    if (opts?.limit !== undefined && jobs.length > opts.limit) {
      jobs = jobs.slice(0, opts.limit);
    }
    return jobs;
  }

  /** GET /api/jobs/summary → aggregate counts.
   *
   *  Wire (verified 2026-05-27): `{total, pending, in_progress, completed,
   *  failed, stuck}`. We map verbatim AND expose `running` as an alias for
   *  `in_progress` so the UI's "Running" tile doesn't need to know about the
   *  server's vocabulary. */
  async jobsSummary(): Promise<JobSummary> {
    const res = await this.request<{
      total?: number;
      pending?: number;
      in_progress?: number;
      completed?: number;
      failed?: number;
      stuck?: number;
    }>('GET', '/api/jobs/summary');
    const inProgress = res?.in_progress ?? 0;
    return {
      total: res?.total ?? 0,
      pending: res?.pending ?? 0,
      in_progress: inProgress,
      running: inProgress,
      completed: res?.completed ?? 0,
      failed: res?.failed ?? 0,
      stuck: res?.stuck ?? 0
    };
  }

  /** GET /api/jobs/{id} → enriched detail with transitions + capability flags. */
  async getJob(id: string): Promise<JobDetail> {
    const res = await this.request<{
      id: string;
      title?: string;
      description?: string;
      state?: string;
      user_id?: string;
      created_at?: string;
      started_at?: string;
      completed_at?: string;
      elapsed_secs?: number;
      project_dir?: string;
      browse_url?: string;
      job_mode?: string;
      job_kind?: string;
      can_restart?: boolean;
      can_prompt?: boolean;
      transitions?: Array<{
        from?: string;
        to?: string;
        timestamp?: string;
        reason?: string;
      }>;
    }>('GET', `/api/jobs/${encodeURIComponent(id)}`);
    return {
      id: String(res.id ?? id),
      title: typeof res.title === 'string' ? res.title : '',
      description: typeof res.description === 'string' ? res.description : '',
      state: typeof res.state === 'string' ? res.state : 'pending',
      user_id: typeof res.user_id === 'string' ? res.user_id : '',
      created_at: typeof res.created_at === 'string' ? res.created_at : '',
      started_at: res.started_at,
      completed_at: res.completed_at,
      elapsed_secs: res.elapsed_secs,
      project_dir: res.project_dir,
      browse_url: res.browse_url,
      job_mode: res.job_mode,
      job_kind: res.job_kind as 'sandbox' | 'agent' | undefined,
      can_restart: res.can_restart === true,
      can_prompt: res.can_prompt === true,
      transitions: (res.transitions ?? []).map((t) => ({
        from: typeof t.from === 'string' ? t.from : '',
        to: typeof t.to === 'string' ? t.to : '',
        timestamp: typeof t.timestamp === 'string' ? t.timestamp : '',
        reason: t.reason
      }))
    };
  }

  /** POST /api/jobs/{id}/cancel → request the gateway cancel a running job.
   *
   *  Wire response: `{status: "cancelled", job_id}` on success; HTTP error
   *  (404, 409, 500) otherwise. We accept any 2xx as success and derive `ok`
   *  from the presence of `status === "cancelled"` so a future server
   *  message tweak doesn't break the call. */
  async cancelJob(id: string): Promise<{ ok: boolean }> {
    const res = await this.request<{ status?: string; job_id?: string }>(
      'POST',
      `/api/jobs/${encodeURIComponent(id)}/cancel`
    );
    return { ok: res?.status === 'cancelled' || res?.status === 'ok' };
  }

  /** POST /api/jobs/{id}/restart → spawn a fresh job from a failed/interrupted
   *  one. Server-side this allocates a NEW UUID and copies the original
   *  task / project / mode / mcp filter forward. We surface `ok` to the
   *  caller; if the route ever returns the new job id we'll bubble it up
   *  via an additional field rather than a breaking change here.
   *
   *  Server today returns `{status, job_id, ...}` after queuing; the exact
   *  status string is mode-dependent (`"queued"`, `"started"`, `"ok"`). We
   *  treat any successful HTTP status as ok and don't inspect the payload
   *  strictly. */
  async restartJob(id: string): Promise<{ ok: boolean }> {
    await this.request<{ status?: string; job_id?: string }>(
      'POST',
      `/api/jobs/${encodeURIComponent(id)}/restart`
    );
    return { ok: true };
  }

  /** GET /api/jobs/{id}/events → historical event list for a job.
   *
   *  Wire: `{job_id, events: [{id, event_type, data, created_at}]}`. Each
   *  event row is opaque JSON keyed by `event_type` — render at the
   *  caller. */
  async getJobEvents(id: string): Promise<JobEvent[]> {
    const res = await this.request<{
      job_id?: string;
      events?: Array<{
        id?: string;
        event_type?: string;
        data?: unknown;
        created_at?: string;
      }>;
    }>('GET', `/api/jobs/${encodeURIComponent(id)}/events`);
    return (res?.events ?? []).map((e) => ({
      id: typeof e.id === 'string' ? e.id : undefined,
      event_type: typeof e.event_type === 'string' ? e.event_type : 'unknown',
      data: e.data,
      created_at: typeof e.created_at === 'string' ? e.created_at : ''
    }));
  }

  /**
   * Poll `/api/jobs/{id}/events` and yield NEW events as they appear.
   *
   * The brief asked for an `AsyncIterable<JobEvent>` backed by SSE. The
   * live gateway exposes the events endpoint as a JSON GET (not SSE) — see
   * `/tmp/ironclaw-origin-main/src/channels/web/features/jobs/mod.rs`
   * around the `jobs_events_handler` definition. We honor the brief's
   * signature by polling every `intervalMs` (default 2s) and diffing
   * against the last-seen event id so callers only receive *new* events.
   *
   * The first iteration yields the full historical replay so a fresh
   * panel opens with context. Subsequent ticks yield only deltas.
   *
   * Abort via the passed `AbortSignal`. The loop checks `signal.aborted`
   * between ticks AND between fetch + sleep so cancellation is quick.
   */
  async *streamJobEvents(
    id: string,
    signal: AbortSignal,
    intervalMs = 2000
  ): AsyncIterable<JobEvent> {
    const seen = new Set<string>();
    let bootstrap = true;
    while (!signal.aborted) {
      let batch: JobEvent[] = [];
      try {
        batch = await this.getJobEvents(id);
      } catch {
        // Network/auth blips: skip this tick. The next iteration retries.
        batch = [];
      }
      if (signal.aborted) return;
      for (const evt of batch) {
        // Identity key: prefer the server id; fall back to type+timestamp
        // for older builds that don't emit a per-event id.
        const key = evt.id ?? `${evt.event_type}@${evt.created_at}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // On bootstrap we yield everything to seed the panel. Subsequent
        // ticks only yield new keys (the `continue` above filters duplicates).
        yield evt;
      }
      bootstrap = false;
      void bootstrap; // silence unused-warning while keeping the bookkeeping
      // Sleep `intervalMs` with abort-awareness so callers see prompt
      // teardown when the panel closes.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, intervalMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true }
        );
      });
    }
  }

  /** GET /api/jobs/{id}/files/list → entries inside the job's project
   *  directory. Only sandbox jobs have a project dir; agent jobs 404.
   *  The optional `path` query parameter scopes to a subdirectory; this
   *  surface only renders the root so we don't accept it here. */
  async getJobFiles(id: string): Promise<JobFile[]> {
    const res = await this.request<{
      entries?: Array<{
        name?: string;
        path?: string;
        is_dir?: boolean;
        size?: number;
        created_at?: string;
      }>;
    }>('GET', `/api/jobs/${encodeURIComponent(id)}/files/list`);
    return (res?.entries ?? []).map((f) => ({
      name: typeof f.name === 'string' ? f.name : '',
      path: typeof f.path === 'string' ? f.path : '',
      is_dir: f.is_dir === true,
      size: f.size,
      created_at: f.created_at
    }));
  }

  // ---- Settings (server-side) ------------------------------------------------

  /**
   * Fetch the server's full settings document.
   *
   * Wire (verified 2026-05-27 against IronClaw 0.28.2):
   *   `{settings: [{key, value, updated_at}, …]}`  — an ARRAY of rows.
   * The earlier client typed the wire as `{settings: Record<string, unknown>}`
   * and returned it verbatim; consumers iterating keys received numeric
   * array indexes instead. We now fold the array into a `{<key>: <value>}`
   * map so callers see the object shape they expect.
   *
   * Older / hypothetical server builds may emit the map shape directly;
   * we accept both for defense-in-depth.
   *
   * SECURITY (defense-in-depth, 2026-05-27): this method is the
   * REDACTED-by-default path. The server's `mcp_servers` value embeds
   * raw bearer tokens (e.g. `Authorization: Bearer sk-agent-…`) in
   * single-tenant owner installs — the smoke test (Round 7e) confirmed
   * this against baremetal3. We unconditionally run the response
   * through `redactJsonObject` IF any string leaf matches a known
   * secret pattern (Bearer / sk- / api-key / JWT / GitHub PAT). Most
   * UIs that just display the settings document should call this and
   * never see a raw token cross the seam.
   *
   * Surfaces that need to EDIT and round-trip secrets back to the
   * server (admin save flows, settings backup/restore) must use
   * `getSettingsRaw()` instead — that path is unredacted but only
   * available to callers who explicitly opt in.
   *
   * This is a second layer behind the UI's `MaskedValue` wrapper.
   * Even if a future agent forgets to wrap the value in `MaskedValue`,
   * the default API path is safe. The cost is one extra pass through
   * the redactor on a small JSON object — negligible.
   */
  async getSettings(): Promise<Record<string, unknown>> {
    const raw = await this.getSettingsRaw();
    // Cheap probe first — only walk the structure when at least one
    // string in it looks like a secret. JSON.stringify is faster than
    // a recursive walk for the no-secret case (the common path).
    const serialized = JSON.stringify(raw);
    if (!containsSecret(serialized)) {
      return raw;
    }
    const redacted = redactJsonObject(raw);
    // redactJsonObject preserves shape; the cast is safe because the
    // input is `Record<string, unknown>` and the redactor only swaps
    // string leaves for masked strings.
    return redacted as Record<string, unknown>;
  }

  /**
   * Unredacted variant of `getSettings()`. Returns the server's settings
   * document with bearer tokens / api keys / JWTs intact.
   *
   * Use this ONLY when the consumer needs the raw bytes — e.g. to round-trip
   * a value back to the server via `putSetting`, or to write a complete
   * settings backup to disk that the user explicitly initiated. UI display
   * surfaces should call `getSettings()` (the redacted path) instead.
   *
   * Wire (verified 2026-05-27 against IronClaw 0.28.2):
   *   `{settings: [{key, value, updated_at}, …]}` — an ARRAY of rows.
   * The earlier client typed the wire as `{settings: Record<string, unknown>}`
   * and returned it verbatim; consumers iterating keys received numeric
   * array indexes instead. We fold the array into a `{<key>: <value>}`
   * map so callers see the object shape they expect.
   *
   * Older / hypothetical server builds may emit the map shape directly;
   * we accept both for defense-in-depth.
   */
  async getSettingsRaw(): Promise<Record<string, unknown>> {
    const res = await this.request<{
      settings?:
        | Array<{ key: string; value: unknown; updated_at?: string }>
        | Record<string, unknown>;
    }>('GET', '/api/settings');
    const raw = res?.settings;
    if (Array.isArray(raw)) {
      return Object.fromEntries(
        raw
          .filter(
            (row): row is { key: string; value: unknown; updated_at?: string } =>
              !!row && typeof row.key === 'string'
          )
          .map((row) => [row.key, row.value])
      );
    }
    if (raw && typeof raw === 'object') {
      return raw;
    }
    return {};
  }

  async getSetting(key: string): Promise<unknown> {
    const res = await this.request<{ key: string; value: unknown }>(
      'GET',
      `/api/settings/${encodeURIComponent(key)}`
    );
    return res?.value;
  }

  async putSetting(key: string, value: unknown): Promise<{ ok: boolean }> {
    const res = await this.request<{ key: string; value: unknown }>(
      'PUT',
      `/api/settings/${encodeURIComponent(key)}`,
      { value }
    );
    return { ok: res?.key === key };
  }

  // ---- Extensions ------------------------------------------------------------

  /**
   * List installed extensions. Joins three endpoints into a single normalized
   * list:
   *   - /api/extensions          — base list (name, kind, active, …)
   *   - /api/extensions/readiness — per-extension `phase` ("ready", "needs_auth",
   *                                 "needs_setup", "error")
   *   - /api/extensions/tools     — list of tools; counted per extension
   *
   * The latter two are fetched in parallel and joined opportunistically — if
   * either side errors the base list still renders, just without enrichment.
   */
  async listExtensions(): Promise<Extension[]> {
    type ExtensionWire = {
      name: string;
      display_name?: string;
      kind?: string;
      description?: string | null;
      version?: string;
      active?: boolean;
      authenticated?: boolean;
      needs_setup?: boolean;
      has_auth?: boolean;
      activation_status?: string;
      tools?: unknown[];
      keywords?: string[];
      source?: string;
    };
    const base = await this.request<{ extensions?: ExtensionWire[] }>('GET', '/api/extensions');

    // Best-effort enrichment — neither failure should block the list.
    type ReadinessWire = {
      extensions?: Array<{
        name: string;
        phase?: string;
        authenticated?: boolean;
        active?: boolean;
      }>;
      // legacy shape per /tmp/ironclaw-api.md
      ready?: string[];
      not_ready?: string[];
      errors?: Record<string, string>;
    };
    const [readiness, tools] = await Promise.all([
      this.request<ReadinessWire>('GET', '/api/extensions/readiness').catch(
        () => ({}) as ReadinessWire
      ),
      this.extensionTools().catch(() => [] as ExtensionTool[])
    ]);

    const readinessByName = new Map<string, { ready: boolean; message?: string }>();
    if (Array.isArray(readiness?.extensions)) {
      for (const r of readiness.extensions ?? []) {
        const phase = String(r.phase ?? '');
        let normalized = '';
        try {
          normalized = extensionTarget(r.name).name;
        } catch {
          continue;
        }
        const boolReady = r.authenticated === true && (r.active === true || r.active === undefined);
        const value = {
          ready: phase === 'ready' || boolReady,
          message: phase || (boolReady ? 'ready' : undefined)
        };
        readinessByName.set(r.name, value);
        if (normalized) readinessByName.set(normalized, value);
      }
    } else {
      // Legacy fallback (ready/not_ready/errors triples).
      for (const n of readiness?.ready ?? []) {
        let normalized = '';
        try {
          normalized = extensionTarget(n).name;
        } catch {
          continue;
        }
        const value = { ready: true, message: 'ready' };
        readinessByName.set(n, value);
        if (normalized) readinessByName.set(normalized, value);
      }
      for (const n of readiness?.not_ready ?? []) {
        const err = readiness?.errors?.[n];
        let normalized = '';
        try {
          normalized = extensionTarget(n).name;
        } catch {
          continue;
        }
        const value = {
          ready: false,
          message: err ? `error: ${err}` : 'not_ready'
        };
        readinessByName.set(n, value);
        if (normalized) readinessByName.set(normalized, value);
      }
    }

    // Count tools per extension. The current gateway emits a flat
    // `/api/extensions/tools` list with NO `extension` field on each tool
    // (verified 2026-05-27), so this map is empty in practice — every
    // extension falls through to the inline `e.tools` count below. Kept
    // because a future server build may surface `extension` again and the
    // join becomes meaningful at that point. We skip empty-string entries
    // ("builtin / no provider") since they're not attributable.
    const toolCounts = new Map<string, number>();
    for (const t of tools) {
      if (t.extension.length === 0) continue;
      let owner = '';
      try {
        owner = extensionTarget(t.extension).name;
      } catch {
        continue;
      }
      toolCounts.set(owner, (toolCounts.get(owner) ?? 0) + 1);
    }

    // Drop blank names + dedupe by name (keep first) — the installed grid
    // keys `{#each … (ext.name)}`, so a blank/duplicate would throw the same
    // uncaught keyed-each error the registry tab hit. Defensive: the gateway
    // has returned unique names so far, but a render crash from one bad row
    // shouldn't be possible.
    const seen = new Set<string>();
    const out: Extension[] = [];
    for (const e of base?.extensions ?? []) {
      const rawName = (e.name ?? '').trim();
      let target: ReturnType<typeof extensionTarget>;
      try {
        target = extensionTarget(rawName, e.kind);
      } catch {
        continue;
      }
      const name = target.name;
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      const rd = readinessByName.get(name) ?? readinessByName.get(rawName);
      out.push({
        name,
        display_name: e.display_name,
        description: e.description ?? '',
        version: e.version,
        installed: true,
        active: e.active ?? false,
        ready: rd?.ready,
        category: mapExtensionKind(e.kind),
        source: e.source,
        requires_setup: e.needs_setup ?? false,
        // Prefer the joined count from /api/extensions/tools when present,
        // otherwise fall back to the inline `tools[]` array the base list
        // emits (currently the only path that yields a non-zero count).
        tool_count: toolCounts.get(name) ?? (Array.isArray(e.tools) ? e.tools.length : 0),
        readiness_message: rd?.message,
        keywords: e.keywords
      } satisfies Extension);
    }
    return out;
  }

  /** List installable extensions from the catalog. */
  async listRegistry(): Promise<Extension[]> {
    type RegistryWire = {
      name: string;
      slug?: string;
      display_name?: string;
      kind?: string;
      description?: string | null;
      version?: string;
      installed?: boolean;
      keywords?: string[];
      source?: string;
      requires_setup?: boolean;
    };
    // Registry returns {entries:[…]} on the wire today, but older versions
    // expose {available:[…]} or {registry:[…]}. Accept all three.
    const res = await this.request<{
      entries?: RegistryWire[];
      available?: RegistryWire[];
      registry?: RegistryWire[];
    }>('GET', '/api/extensions/registry');
    const list = res?.entries ?? res?.available ?? res?.registry ?? [];
    // Drop entries with no resolvable name and dedupe by name (keep first).
    // The registry grid renders `{#each … (ext.name)}`; a blank or duplicate
    // name makes Svelte's keyed-each throw uncaught, which surfaces as a
    // generic global error and silently reverts the tab. Guaranteeing unique,
    // non-empty names here keeps that render safe regardless of what the
    // gateway returns.
    const seen = new Set<string>();
    const out: Extension[] = [];
    for (const e of list) {
      let name = '';
      try {
        name = extensionTarget((e.name ?? e.slug ?? '').trim(), e.kind).name;
      } catch {
        continue;
      }
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        display_name: e.display_name,
        description: e.description ?? '',
        version: e.version,
        installed: e.installed ?? false,
        category: mapExtensionKind(e.kind),
        source: e.source,
        requires_setup: e.requires_setup ?? false,
        keywords: e.keywords
      } satisfies Extension);
    }
    return out;
  }

  /** Flat list of tools provided by installed extensions.
   *
   * Wire (verified 2026-05-27): server returns `{tools: [{name, description}]}`
   * with NO `extension` field on each tool — the current gateway aggregates
   * builtins + MCP-server tools into a single flat list without provenance.
   * The earlier client filtered to `t.extension` truthy and silently dropped
   * every entry, collapsing every extension's `tool_count` display to 0. We
   * now accept the bare `{name, description}` shape and normalise the
   * missing `extension` to empty-string (`''`) so consumers always get a
   * groupable string key.
   *
   * NOTE: because the wire doesn't carry provenance today, `listExtensions`'s
   * per-extension `tool_count` join via this method will yield 0 for every
   * extension and fall through to each extension's own `tools[]` array
   * (populated by `/api/extensions`). The count is still meaningful for
   * extensions that publish their tool list inline.
   */
  async extensionTools(): Promise<ExtensionTool[]> {
    const res = await this.request<{
      tools?: Array<{
        name: string;
        extension?: string;
        description?: string;
      }>;
    }>('GET', '/api/extensions/tools');
    return (res?.tools ?? [])
      .filter((t) => typeof t?.name === 'string' && t.name.length > 0)
      .map((t) => ({
        // Empty-string `extension` ("") means "builtin / no provider" —
        // a stable key consumers can group on without nullable handling.
        extension: typeof t.extension === 'string' ? extensionTarget(t.extension).name : '',
        name: t.name,
        description: t.description
      }));
  }

  /**
   * Install an extension from the registry. The gateway accepts either
   * `{name}` or `{slug}` depending on version — we send both for safety.
   */
  async installExtension(name: string, kindHint?: string): Promise<{ ok: boolean }> {
    const target = extensionTarget(name, kindHint);
    const res = await this.request<{ status?: string }>('POST', '/api/extensions/install', {
      name: target.name,
      slug: target.name,
      ...(target.kind ? { kind: target.kind } : {})
    });
    const status = res?.status;
    return { ok: status === 'queued' || status === 'installed' || status === 'ok' || !status };
  }

  async activateExtension(name: string): Promise<{
    ok: boolean;
    message?: string;
    auth_url?: string;
    instructions?: string;
    activated?: boolean;
    awaiting_token?: boolean;
  }> {
    const target = extensionTarget(name);
    const res = await this.request<{
      success?: boolean;
      status?: string;
      message?: string;
      auth_url?: string;
      instructions?: string;
      activated?: boolean;
      awaiting_token?: boolean;
    }>('POST', `/api/extensions/${encodeURIComponent(target.name)}/activate`);
    const status = res?.status;
    return {
      ok:
        res?.success === true ||
        res?.activated === true ||
        typeof res?.auth_url === 'string' ||
        status === 'activated' ||
        status === 'ok',
      message: res?.message,
      auth_url: res?.auth_url,
      instructions: res?.instructions,
      activated: res?.activated === true,
      awaiting_token: res?.awaiting_token === true
    };
  }

  async removeExtension(name: string): Promise<{ ok: boolean }> {
    const target = extensionTarget(name);
    const res = await this.request<{ status?: string }>(
      'POST',
      `/api/extensions/${encodeURIComponent(target.name)}/remove`
    );
    const status = res?.status;
    return { ok: status === 'removed' || status === 'ok' || !status };
  }

  /**
   * Fetch the setup-form schema for an extension. The gateway's wire shape
   * combines two field families:
   *   - `secrets`: named credentials (mapped to password fields)
   *   - `fields`: structured form fields (already in our target shape)
   * Both are merged into a single field list keyed by `key`.
   */
  async getExtensionSetup(name: string): Promise<ExtensionSetupSchema> {
    const target = extensionTarget(name);
    type SetupWire = {
      // current gateway shape
      secrets?: Array<{
        name: string;
        prompt?: string;
        optional?: boolean;
        provided?: boolean;
      }>;
      fields?: Array<{
        name?: string;
        key?: string;
        label?: string;
        type?: string;
        required?: boolean;
        placeholder?: string;
        default?: string;
        options?: Array<{ value: string; label: string }>;
        description?: string;
      }>;
      onboarding_state?: unknown;
      oauth_url?: string;
      notes?: string;
      // legacy shape per /tmp/ironclaw-api.md
      form?: {
        fields?: Array<{
          name?: string;
          key?: string;
          label?: string;
          type?: string;
          required?: boolean;
          placeholder?: string;
        }>;
        oauth_url?: string;
      };
    };
    const res = await this.request<SetupWire>(
      'GET',
      `/api/extensions/${encodeURIComponent(target.name)}/setup`
    );

    const fields: ExtensionSetupSchema['fields'] = [];

    // Map secrets → password fields. Skip already-provided optional ones to
    // avoid asking the user to re-enter a stored key.
    for (const s of res?.secrets ?? []) {
      if (s.provided && s.optional) continue;
      fields.push({
        key: s.name,
        label: s.prompt ?? s.name,
        type: 'password',
        required: s.optional === false,
        placeholder: s.provided ? '••••••••  (re-enter to replace)' : ''
      });
    }

    // Structured fields (current + legacy nested under `form`). The legacy
    // shape doesn't carry placeholder/default/options/description but TS
    // would still let us read those props as `undefined` from a union, so
    // we collapse to a single union and just `?? undefined` everywhere.
    type FieldWire = NonNullable<SetupWire['fields']>[number] & {
      default?: string;
      options?: Array<{ value: string; label: string }>;
      description?: string;
      placeholder?: string;
    };
    const rawFields: FieldWire[] = [
      ...(res?.fields ?? []),
      ...((res?.form?.fields ?? []) as FieldWire[])
    ];
    for (const f of rawFields) {
      const key = f.key ?? f.name ?? '';
      if (!key) continue;
      fields.push({
        key,
        label: f.label ?? key,
        type: (f.type as ExtensionSetupSchema['fields'][number]['type']) ?? 'text',
        required: f.required ?? false,
        placeholder: f.placeholder,
        default: f.default,
        options: f.options,
        description: f.description
      });
    }

    return {
      fields,
      oauth_url: res?.oauth_url ?? res?.form?.oauth_url,
      notes: res?.notes
    };
  }

  async submitExtensionSetup(
    name: string,
    fields: Record<string, unknown>
  ): Promise<{
    ok: boolean;
    message?: string;
    auth_url?: string;
    instructions?: string;
    activated?: boolean;
  }> {
    const target = extensionTarget(name);
    const res = await this.request<{
      success?: boolean;
      status?: string;
      message?: string;
      auth_url?: string;
      instructions?: string;
      activated?: boolean;
    }>('POST', `/api/extensions/${encodeURIComponent(target.name)}/setup`, fields);
    const status = res?.status;
    return {
      ok:
        res?.success === true ||
        res?.activated === true ||
        typeof res?.auth_url === 'string' ||
        status === 'configured' ||
        status === 'ok',
      message: res?.message,
      auth_url: res?.auth_url,
      instructions: res?.instructions,
      activated: res?.activated === true
    };
  }

  // ---- Admin: tool policy + system prompt ------------------------------
  //
  // The gateway's admin surface (multi-tenant only) is intentionally narrow:
  //   - GET/PUT /api/admin/tool-policy   — global disabled-tools list
  //   - GET/PUT /api/admin/system-prompt — admin-scoped SYSTEM.md
  //
  // The wire shape DIFFERS from the prompt's initial sketch and is the
  // source of truth:
  //   - tool-policy wire is `{disabled_tools: string[], user_disabled_tools: {…}}`,
  //     not `{policy: {<tool>: 'allow'|'deny'|'prompt'}}`. The client maps
  //     between the two — the UI-facing 3-way action collapses to a flat
  //     `disabled_tools` set on save (anything not `'deny'` is omitted from
  //     the list).
  //   - system-prompt wire is `{content: string, updated_at?: string}`, not
  //     `{prompt: string}`. We expose `prompt` on the client return for the
  //     route's convenience but accept either field name defensively in
  //     case the gateway changes its mind.
  //
  // 404 from the gateway means single-tenant mode (or the route is gone);
  // 401/403 means the bearer isn't an admin. Both surface as HttpError;
  // callers map status codes to user-facing copy.

  /**
   * Fetch the admin tool policy. Returns the wire shape unchanged so callers
   * can present whatever subset they care about (the UI editor turns
   * `disabled_tools` into a per-tool 3-way action).
   */
  async getToolPolicy(): Promise<{
    policy: ToolPolicy;
    disabled_tools: string[];
    user_disabled_tools: Record<string, string[]>;
  }> {
    // Accept several shapes defensively: the documented `{disabled_tools, …}`
    // raw form, an envelope `{policy: {…}}` (in case the gateway ever wraps
    // its response), and the prompt's original `{policy: {<tool>: action}}`
    // mapping (if a future server version exposes a true 3-state model).
    const raw = await this.request<{
      disabled_tools?: string[];
      user_disabled_tools?: Record<string, string[]>;
      policy?:
        | Record<string, ToolPolicyAction>
        | {
            disabled_tools?: string[];
            user_disabled_tools?: Record<string, string[]>;
          };
    }>('GET', '/api/admin/tool-policy');

    // Unwrap `{policy: {…}}` envelope if present, otherwise treat the root
    // as the policy object directly.
    const root: {
      disabled_tools?: string[];
      user_disabled_tools?: Record<string, string[]>;
    } = (() => {
      if (raw?.policy && typeof raw.policy === 'object') {
        const p = raw.policy as Record<string, unknown>;
        if (Array.isArray(p.disabled_tools) || p.user_disabled_tools) {
          return p as {
            disabled_tools?: string[];
            user_disabled_tools?: Record<string, string[]>;
          };
        }
      }
      return raw as {
        disabled_tools?: string[];
        user_disabled_tools?: Record<string, string[]>;
      };
    })();

    const disabled = Array.isArray(root.disabled_tools)
      ? root.disabled_tools.filter((s) => typeof s === 'string')
      : [];
    const userOverrides =
      root.user_disabled_tools && typeof root.user_disabled_tools === 'object'
        ? (root.user_disabled_tools as Record<string, string[]>)
        : {};

    // Build the UI-facing policy map. Only `deny` entries are recorded;
    // unknown tools default to `'prompt'` at the editor level.
    const policy: ToolPolicy = {};
    for (const name of disabled) policy[name] = 'deny';

    // Last-chance fallback: if the server ever emits the prompt's original
    // `{policy: {<tool>: 'allow'|'deny'|'prompt'}}` shape, surface it verbatim.
    if (
      raw?.policy &&
      typeof raw.policy === 'object' &&
      !Array.isArray((raw.policy as Record<string, unknown>).disabled_tools) &&
      !(raw.policy as Record<string, unknown>).user_disabled_tools
    ) {
      for (const [k, v] of Object.entries(raw.policy)) {
        if (v === 'allow' || v === 'deny' || v === 'prompt') {
          policy[k] = v;
        }
      }
    }

    return {
      policy,
      disabled_tools: disabled,
      user_disabled_tools: userOverrides
    };
  }

  /**
   * Replace the admin tool policy. Accepts the UI's 3-way map and
   * serializes to the wire shape — `deny` becomes part of `disabled_tools`,
   * `allow`/`prompt` are omitted (the gateway treats absence as enabled).
   *
   * `userOverrides` lets the caller round-trip the (per-user) overrides
   * that the bulk editor doesn't currently expose; pass the value returned
   * by `getToolPolicy()` to preserve it.
   */
  async setToolPolicy(
    policy: ToolPolicy,
    userOverrides: Record<string, string[]> = {}
  ): Promise<{ ok: boolean }> {
    const disabled_tools = Object.entries(policy)
      .filter(([, action]) => action === 'deny')
      .map(([name]) => name)
      .sort();
    const body = {
      disabled_tools,
      user_disabled_tools: userOverrides
    };
    // The gateway echoes the saved policy on PUT, but we don't surface it —
    // the caller re-reads via getToolPolicy() if it wants the canonical
    // post-save state. Treat any 2xx as success.
    await this.request<unknown>('PUT', '/api/admin/tool-policy', body);
    return { ok: true };
  }

  /**
   * Fetch the admin system prompt (admin-scoped SYSTEM.md), REDACTED.
   *
   * SECURITY (defense-in-depth, 2026-05-27): the system prompt is free-text
   * the admin authors directly, and historically includes API keys or
   * bearer tokens copy-pasted by operators while iterating. The smoke test
   * (Round 7e) flagged this surface alongside `/api/settings`. This method
   * runs the returned prompt through `redactSecrets` before returning, so
   * any UI that just displays the prompt never sees raw secrets even if
   * the agent forgot to wrap it in `MaskedValue`.
   *
   * Surfaces that EDIT the prompt (the admin SystemPromptEditor) must
   * use `getSystemPromptRaw()` — otherwise the editor would persist
   * the redacted bullets back to the server, replacing the real secrets
   * with `•••` on the next save.
   *
   * Returns `prompt: ''` if no prompt has been configured — the gateway
   * maps the "document missing" case to an empty string already.
   */
  async getSystemPrompt(): Promise<{ prompt: string; updated_at?: string }> {
    const { prompt, updated_at } = await this.getSystemPromptRaw();
    // Cheap probe before the regex walk — same shape as getSettings.
    if (!containsSecret(prompt)) {
      return { prompt, updated_at };
    }
    return { prompt: redactSecrets(prompt), updated_at };
  }

  /**
   * Unredacted variant of `getSystemPrompt()`. Returns the raw bytes of
   * the admin SYSTEM.md as the server has them.
   *
   * The editor MUST call this — the redacted variant would overwrite the
   * real prompt with bullet-masked secrets on the next save. Display-only
   * surfaces (e.g. a read-only preview elsewhere in the app) should call
   * the redacted `getSystemPrompt()` instead.
   */
  async getSystemPromptRaw(): Promise<{ prompt: string; updated_at?: string }> {
    const res = await this.request<{
      content?: string;
      prompt?: string;
      updated_at?: string | null;
    }>('GET', '/api/admin/system-prompt');
    // Wire is `{content}`; accept the prompt's original `{prompt}` shape too.
    const prompt = res?.content ?? res?.prompt ?? '';
    return {
      prompt,
      updated_at: res?.updated_at ?? undefined
    };
  }

  /**
   * Replace the admin system prompt. Server caps the body at 64 KB and
   * returns 413 over that; callers should validate length client-side as
   * well to surface a friendlier error.
   *
   * Sends both `content` (wire shape) and `prompt` (prompt's original) so a
   * server build that flipped the field name still accepts the write.
   */
  async setSystemPrompt(prompt: string): Promise<{ ok: boolean }> {
    await this.request<unknown>('PUT', '/api/admin/system-prompt', {
      content: prompt,
      prompt
    });
    return { ok: true };
  }

  /**
   * List every tool name the agent can invoke — including builtins that
   * don't have an `extension` field on the wire (which `extensionTools()`
   * filters out). Used by the admin tool-policy editor so the table shows
   * a complete picture, not just MCP-provided tools.
   *
   * Shape: `{name, description?, extension?}`. `extension` is undefined for
   * builtins. Sorted by name for stable rendering.
   */
  async listAllTools(): Promise<ExtensionTool[]> {
    const res = await this.request<{
      tools?: Array<{
        name: string;
        extension?: string;
        description?: string;
      }>;
    }>('GET', '/api/extensions/tools');
    return (res?.tools ?? [])
      .filter((t) => typeof t?.name === 'string' && t.name.length > 0)
      .map((t) => ({
        // Empty-string `extension` ("") is preserved as "" so callers can
        // distinguish "builtin / no provider" from "unknown" via length.
        extension: typeof t.extension === 'string' ? t.extension : '',
        name: t.name,
        description: t.description
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- Admin: usage / cost --------------------------------------------------
  //
  // Two endpoints, both admin-scoped:
  //   - GET /api/admin/usage/summary  → system-wide rollup tile
  //   - GET /api/admin/usage          → per-<user, model> aggregated rows
  //
  // The wire shape (verified 2026-05-27 against IronClaw 0.28.2) is richer
  // than the prompt's initial sketch:
  //   summary  → {users: {total, active, suspended, admins},
  //               jobs:  {total},
  //               usage_30d: {llm_calls, input_tokens, output_tokens,
  //                           total_cost: <string>},
  //               uptime_seconds: <number>}
  //   list     → {period, since, usage: AdminUsageEntry[]}  where each entry is
  //               {user_id, model, call_count, input_tokens, output_tokens,
  //                total_cost: <string>}
  //
  // The list is NOT per-call events — it's a pre-aggregated grouping the
  // gateway does server-side. There is no individual-event endpoint today.
  // Querying with no LLM activity returns `usage: []` (verified — current
  // server has not logged any calls yet).
  //
  // Defensive shape: both methods accept absent fields and tolerate the
  // prompt's flatter sketch (`users` as a bare number, `tokens` instead of
  // input/output split, etc.) so a future server-side flattening lands
  // without a client refactor.

  /**
   * Fetch the admin usage summary rollup.
   *
   * Returns the wire shape mapped onto `UsageSummary` — see types.ts for
   * the field-by-field documentation. `tokens` is client-derived as
   * `input_tokens + output_tokens` so the UI can show a single "tokens"
   * tile without juggling the breakdown.
   *
   * `uptime` mirrors wire `uptime_seconds` (admin endpoint emits the long
   * name; the gateway-status endpoint emits the short `uptime_secs`. We
   * map both onto seconds in their respective callers).
   *
   * Returns `null` on any failure (network, 401, 403, 5xx) so the admin
   * tile can render an "unavailable" state without poisoning the panel.
   */
  async getUsageSummary(): Promise<UsageSummary | null> {
    try {
      const raw = await this.request<{
        users?:
          | number
          | {
              total?: number;
              active?: number;
              suspended?: number;
              admins?: number;
            };
        jobs?: number | { total?: number };
        usage_30d?: {
          llm_calls?: number;
          tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
          total_cost?: number | string;
        };
        uptime?: number;
        uptime_seconds?: number;
      }>('GET', '/api/admin/usage/summary');

      if (!raw) return null;

      // `users` may be the wire's struct or the prompt's flat number.
      const users = (() => {
        if (typeof raw.users === 'number') {
          return { total: raw.users };
        }
        if (raw.users && typeof raw.users === 'object') {
          return {
            total: raw.users.total ?? 0,
            active: raw.users.active ?? 0,
            suspended: raw.users.suspended ?? 0,
            admins: raw.users.admins ?? 0
          };
        }
        return undefined;
      })();

      // Same trick for `jobs` — wire is `{total}`, prompt sketch was a
      // flat number.
      const jobs = (() => {
        if (typeof raw.jobs === 'number') return { total: raw.jobs };
        if (raw.jobs && typeof raw.jobs === 'object') {
          return { total: raw.jobs.total ?? 0 };
        }
        return undefined;
      })();

      const usage = raw.usage_30d;
      let usage30d: UsageSummary['usage_30d'];
      if (usage && typeof usage === 'object') {
        const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
        const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
        const totalCost =
          typeof usage.total_cost === 'string'
            ? usage.total_cost
            : typeof usage.total_cost === 'number'
              ? String(usage.total_cost)
              : undefined;
        usage30d = {
          llm_calls: usage.llm_calls ?? 0,
          input_tokens: input,
          output_tokens: output,
          // Convenience: prefer wire `tokens` if a future server emits it,
          // otherwise fold input + output into a single number.
          tokens: typeof usage.tokens === 'number' ? usage.tokens : input + output,
          total_cost: totalCost
        };
      }

      return {
        users,
        jobs,
        usage_30d: usage30d,
        // Server emits `uptime_seconds`; the prompt's sketch called it
        // `uptime`. Accept either.
        uptime: raw.uptime_seconds ?? raw.uptime
      };
    } catch (err) {
      console.warn('[ironclaw] getUsageSummary failed:', err);
      return null;
    }
  }

  /**
   * List per-<user, model> usage aggregates.
   *
   * Wire envelope is `{period, since, usage: AdminUsageEntry[]}`. The
   * gateway accepts `period=hour|day|week|month|year` and `user_id=...`;
   * `since` is computed server-side from `period` and is NOT honored as
   * a query parameter (verified 2026-05-27: passing `since=...` returns
   * `period: "day"` regardless). We expose `limit` and `since` from the
   * prompt's signature anyway:
   *   - `since` is mapped onto `period`: anything ≥30 days ago → "month",
   *     ≥7 days → "week", ≥1 day → "day", otherwise "hour". This gives
   *     the caller a stable "events since timestamp T" interface without
   *     forcing them to know the wire's bucket vocabulary.
   *   - `limit` is applied client-side after the response.
   *
   * Returns `[]` on any failure so the admin route can render an empty
   * state without throwing.
   */
  async getUsageEvents(opts?: { limit?: number; since?: string }): Promise<UsageEvent[]> {
    try {
      // Map `since` → period bucket.
      const period = sinceToPeriod(opts?.since);

      const params = new URLSearchParams();
      if (period) params.set('period', period);

      const path = params.toString() ? `/api/admin/usage?${params.toString()}` : '/api/admin/usage';

      const raw = await this.request<{
        period?: string;
        since?: string;
        usage?: Array<{
          user_id?: string;
          model?: string;
          call_count?: number;
          input_tokens?: number;
          output_tokens?: number;
          tokens?: number;
          total_cost?: string | number;
          cost?: number;
        }>;
      }>('GET', path);

      const rows = Array.isArray(raw?.usage) ? raw.usage : [];

      const mapped: UsageEvent[] = rows.map((row) => {
        const input = typeof row.input_tokens === 'number' ? row.input_tokens : 0;
        const output = typeof row.output_tokens === 'number' ? row.output_tokens : 0;
        const totalCost =
          typeof row.total_cost === 'string'
            ? row.total_cost
            : typeof row.total_cost === 'number'
              ? String(row.total_cost)
              : undefined;
        const numericCost = (() => {
          if (typeof row.cost === 'number') return row.cost;
          if (totalCost === undefined) return 0;
          const n = Number(totalCost);
          return Number.isFinite(n) ? n : 0;
        })();
        return {
          user_id: row.user_id,
          model: row.model,
          call_count: row.call_count ?? 0,
          input_tokens: input,
          output_tokens: output,
          tokens: typeof row.tokens === 'number' ? row.tokens : input + output,
          total_cost: totalCost,
          cost: numericCost
        };
      });

      const limit = opts?.limit;
      if (typeof limit === 'number' && limit > 0 && mapped.length > limit) {
        return mapped.slice(0, limit);
      }
      return mapped;
    } catch (err) {
      console.warn('[ironclaw] getUsageEvents failed:', err);
      return [];
    }
  }

  // ---- LLM providers / models -----------------------------------------------
  //
  // Three endpoints, all admin-scoped:
  //   - GET  /api/llm/providers       → registry catalog (always public to admins)
  //   - POST /api/llm/test_connection → probe a provider with given creds
  //   - POST /api/llm/list_models     → enumerate models for a provider
  //
  // The wire request body for the POST endpoints is:
  //   {adapter, base_url, model, api_key?, provider_id?, provider_type?}
  // — `adapter` and `base_url` are REQUIRED on every call; `model` is
  // required for `test_connection` only. The prompt's looser signature
  // (`testLlmConnection(provider, config)`) is preserved on the client
  // surface, but the implementation pulls `adapter` and `base_url` out of
  // the catalog entry so the caller only has to pass the provider id +
  // any user-supplied overrides (api key, custom base url).
  //
  // Defensive shape: failing list/test calls surface as
  // `{ok: false, message}` rather than throwing, so the configure UI can
  // present the error inline.

  /**
   * Fetch the LLM provider catalog (`GET /api/llm/providers`).
   *
   * Wire is a flat array of provider entries — 16+ fields each. We map
   * onto `LlmProvider` and fold `has_credentials || has_api_key` into a
   * single `configured` boolean so the configure dialog has a stable
   * "is this provider ready" gate without caring about which auth mode.
   *
   * Returns `[]` on any failure.
   */
  async listLlmProviders(): Promise<LlmProvider[]> {
    try {
      const raw = await this.request<unknown>('GET', '/api/llm/providers');
      const arr = Array.isArray(raw) ? raw : [];

      const out: LlmProvider[] = [];
      for (const entry of arr) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const id = typeof e.id === 'string' ? e.id : undefined;
        if (!id) continue;
        const hasApiKey = e.has_api_key === true;
        const hasCreds = e.has_credentials === true;
        out.push({
          id,
          name: typeof e.name === 'string' ? e.name : id,
          description: typeof e.description === 'string' ? e.description : undefined,
          configured: hasCreds || hasApiKey,
          default_model: typeof e.default_model === 'string' ? e.default_model : undefined,
          adapter: typeof e.adapter === 'string' ? e.adapter : undefined,
          base_url: typeof e.base_url === 'string' ? e.base_url : undefined,
          base_url_required: e.base_url_required === true,
          can_list_models: e.can_list_models === true,
          credential_kind: typeof e.credential_kind === 'string' ? e.credential_kind : undefined,
          has_api_key: hasApiKey,
          builtin: e.builtin === true
        });
      }
      return out;
    } catch (err) {
      console.warn('[ironclaw] listLlmProviders failed:', err);
      return [];
    }
  }

  /**
   * Test the connection to a provider with the supplied credentials.
   *
   * The wire body requires `{adapter, base_url, model, api_key?}`. Callers
   * pass `provider` (the catalog id) plus `config` containing any subset
   * of those fields. If `adapter` / `base_url` / `model` aren't supplied
   * in `config`, the client falls through to `provider_id` / `provider_type`
   * so the gateway can resolve adapter + base URL from its registry and
   * pull the vaulted API key from secrets.
   *
   * Even when `provider_id` is used, the gateway STILL deserializes the
   * body as `{adapter, base_url, model}` — so we synthesize sensible
   * defaults (empty strings; the gateway responds with a clear error if
   * `base_url` ends up empty for a base-url-required provider).
   *
   * Response shape (wire): `{ok: bool, message: string}`. We expose
   * `error` as a convenience mirror of `message` when `ok=false`, and
   * `model` is reserved for forward compat (the server may eventually
   * echo back which model the test ran against).
   */
  async testLlmConnection(
    provider: string,
    config: Record<string, unknown>
  ): Promise<{ ok: boolean; error?: string; model?: string }> {
    try {
      const body: Record<string, unknown> = {
        // Adapter / base_url / model can be passed explicitly by the
        // caller; otherwise the gateway resolves via provider_id +
        // provider_type. The wire requires these keys regardless, so we
        // emit empty strings as a fallback.
        adapter: typeof config.adapter === 'string' ? config.adapter : '',
        base_url: typeof config.base_url === 'string' ? config.base_url : '',
        model: typeof config.model === 'string' ? config.model : '',
        // The catalog id maps onto wire `provider_id`; let the caller
        // override either name.
        provider_id: typeof config.provider_id === 'string' ? config.provider_id : provider,
        provider_type: typeof config.provider_type === 'string' ? config.provider_type : 'builtin'
      };
      if (typeof config.api_key === 'string') {
        body.api_key = config.api_key;
      }

      const res = await this.request<{
        ok?: boolean;
        message?: string;
        model?: string;
      }>('POST', '/api/llm/test_connection', body);

      const ok = res?.ok === true;
      return {
        ok,
        error: ok ? undefined : (res?.message ?? 'Connection test failed'),
        model: res?.model
      };
    } catch (err) {
      console.warn('[ironclaw] testLlmConnection failed:', err);
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Connection test failed'
      };
    }
  }

  /**
   * List models available for a provider (`POST /api/llm/list_models`).
   *
   * Wire response is `{ok: bool, models: string[], message: string}` —
   * each model is a bare string id, not a richer object. We wrap each one
   * onto `{id, name}` so the UI has a consistent list shape regardless of
   * whether a future server emits richer per-model metadata (display
   * name, context window, pricing).
   *
   * Request body requires `{adapter, base_url, api_key?}`. The client
   * pulls `adapter` and `base_url` from the catalog if available;
   * otherwise the caller can pass them via a custom overload (not exposed
   * here — the prompt's signature is just `(provider)`).
   *
   * Note: this method has to fetch the provider catalog first to resolve
   * adapter + base_url. If the catalog fetch fails we still attempt the
   * call with empty strings — the gateway responds with a clear error.
   *
   * Returns `[]` on any failure or when the wire reports `ok: false`.
   */
  async listLlmModels(provider: string): Promise<LlmModel[]> {
    try {
      // Resolve adapter + base_url from the catalog. If the catalog is
      // unavailable, fall back to empty strings; the gateway answers
      // with a clear `ok:false` message that we surface as `[]`.
      let adapter = '';
      let base_url = '';
      const catalog = await this.listLlmProviders();
      const match = catalog.find((p) => p.id === provider);
      if (match) {
        adapter = match.adapter ?? '';
        base_url = match.base_url ?? '';
      }

      const body: Record<string, unknown> = {
        adapter,
        base_url,
        provider_id: provider,
        provider_type: 'builtin'
      };

      const res = await this.request<{
        ok?: boolean;
        models?: unknown[];
        message?: string;
      }>('POST', '/api/llm/list_models', body);

      if (res?.ok !== true) {
        if (res?.message) {
          console.warn(`[ironclaw] listLlmModels(${provider}): ${res.message}`);
        }
        return [];
      }

      const models = Array.isArray(res.models) ? res.models : [];
      const out: LlmModel[] = [];
      for (const m of models) {
        // Wire emits bare strings today; tolerate a future object shape
        // with {id, name, description, context_window, pricing}.
        if (typeof m === 'string' && m.length > 0) {
          out.push({ id: m, name: m });
        } else if (m && typeof m === 'object') {
          const obj = m as Record<string, unknown>;
          const id =
            typeof obj.id === 'string'
              ? obj.id
              : typeof obj.name === 'string'
                ? obj.name
                : undefined;
          if (!id) continue;
          const pricing = (() => {
            if (
              obj.pricing &&
              typeof obj.pricing === 'object' &&
              typeof (obj.pricing as Record<string, unknown>).input === 'number' &&
              typeof (obj.pricing as Record<string, unknown>).output === 'number'
            ) {
              const p = obj.pricing as Record<string, number>;
              return { input: p.input, output: p.output };
            }
            return undefined;
          })();
          out.push({
            id,
            name: typeof obj.name === 'string' ? obj.name : id,
            description: typeof obj.description === 'string' ? obj.description : undefined,
            context_window: typeof obj.context_window === 'number' ? obj.context_window : undefined,
            pricing
          });
        }
      }
      return out;
    } catch (err) {
      console.warn('[ironclaw] listLlmModels failed:', err);
      return [];
    }
  }

  // ---- Per-tool permissions (3-state) ---------------------------------------
  //
  // Sister surface to the binary `getToolPolicy`/`setToolPolicy` admin API.
  // This surface is per-USER (not admin global) and exposes a 3-state
  // permission model: `ask_each_time`, `always_allow`, `disabled`.
  //
  // Wire shape (verified 2026-05-27 against IronClaw 0.28.2):
  //   GET  /api/settings/tools
  //     → {tools: [{name, description, current_state, default_state,
  //                  locked, locked_reason?}, …]}
  //   PUT  /api/settings/tools/:name body {state: "ask_each_time" |
  //                                          "always_allow" | "disabled"}
  //     → echoes the updated ToolPermissionEntry on 200.
  //     → 400 if tool is locked AND state is "always_allow".
  //     → 404 if tool name unknown.
  //     → 422 if state string is not one of the three valid values.
  //
  // The prompt's third state was called `locked`, but the wire's third
  // state is actually `disabled`; `locked` on the wire is a separate
  // per-entry boolean flag indicating whether the user is allowed to
  // ESCALATE the tool to `always_allow`. We translate `'locked'` →
  // `'disabled'` on write so callers using the prompt's name still hit
  // the right wire value.
  //
  // The two surfaces (admin tool-policy vs per-tool settings) coexist —
  // the README note in this client points out that they cover different
  // axes. The admin disabled_tools list is a global deny-list that
  // overrides everything; the per-tool settings layer is the user's own
  // 3-state preference for tools that aren't globally disabled.

  /**
   * Fetch the user's per-tool permission state.
   *
   * Returns the wire shape mapped onto `ToolPermissionEntry[]`. Sorted
   * alphabetically by name for stable rendering.
   *
   * Returns `[]` on any failure so the editor can render empty rather
   * than throw.
   */
  async listToolPermissions(): Promise<ToolPermissionEntry[]> {
    try {
      const res = await this.request<{
        tools?: Array<{
          name?: unknown;
          description?: unknown;
          current_state?: unknown;
          default_state?: unknown;
          locked?: unknown;
          locked_reason?: unknown;
          destructive?: unknown;
        }>;
      }>('GET', '/api/settings/tools');

      const rows = Array.isArray(res?.tools) ? res.tools : [];
      const out: ToolPermissionEntry[] = [];
      for (const row of rows) {
        const name = typeof row.name === 'string' ? row.name : '';
        if (!name) continue;
        const permission: ToolPermission =
          typeof row.current_state === 'string' ? row.current_state : 'ask_each_time';
        const defaultState =
          typeof row.default_state === 'string' ? (row.default_state as ToolPermission) : undefined;
        out.push({
          name,
          permission,
          description: typeof row.description === 'string' ? row.description : undefined,
          destructive: row.destructive === true ? true : undefined,
          default_state: defaultState,
          locked: row.locked === true,
          locked_reason: typeof row.locked_reason === 'string' ? row.locked_reason : undefined
        });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.warn('[ironclaw] listToolPermissions failed:', err);
      return [];
    }
  }

  /**
   * Set a single tool's permission state.
   *
   * The wire's three valid states are `ask_each_time`, `always_allow`,
   * `disabled`. The prompt's `ToolPermission` union also accepts `locked`
   * — we translate `'locked'` → `'disabled'` so callers using the
   * prompt's name still hit the right wire value.
   *
   * Returns `{ok: false}` on any failure (network, 400 for locked
   * tools, 404 for unknown names, 422 for invalid state). The error
   * detail is dropped on the floor here — the editor should refresh
   * via `listToolPermissions()` afterwards to see the canonical state.
   * If you need the error string, catch via the underlying `request`.
   */
  async setToolPermission(name: string, permission: ToolPermission): Promise<{ ok: boolean }> {
    try {
      // Map the prompt's `'locked'` alias onto the wire's `'disabled'`.
      const wireState = permission === 'locked' ? 'disabled' : permission;
      await this.request<unknown>('PUT', `/api/settings/tools/${encodeURIComponent(name)}`, {
        state: wireState
      });
      return { ok: true };
    } catch (err) {
      console.warn(`[ironclaw] setToolPermission(${name}) failed:`, err);
      return { ok: false };
    }
  }

  // ---- Engine v2 ------------------------------------------------------------
  //
  // Five endpoints, all gated by `engine_v2_enabled` on the gateway status
  // (verified true on baremetal3, 2026-05-27):
  //
  //   GET /api/engine/missions          → {missions: EngineMission[]}
  //   GET /api/engine/missions/{id}     → {mission: EngineMission} | 404
  //   GET /api/engine/projects          → {projects: EngineProject[]}
  //   GET /api/engine/projects/{id}     → {project:  EngineProject} | 404
  //   GET /api/engine/threads           → {threads:  EngineThread[]}
  //
  // The single-resource endpoints return 404 with `"Mission not found"` /
  // `"Project not found"` body for missing rows, and 500 with a UUID-parse
  // error for syntactically-bad ids. The client maps BOTH the 404 case AND
  // the 500-on-malformed-id case onto `null` so callers can use a single
  // "did we get it?" check.
  //
  // The list endpoints throw on transport errors (network / 5xx for other
  // reasons), since "no missions" is a valid `{missions: []}` payload and
  // a thrown HttpError signals a real outage worth surfacing.

  /**
   * List missions defined on the gateway. Wire envelope: `{missions: [...]}`.
   *
   * Returns rows verbatim — the consumer is responsible for any sorting /
   * filtering. Empty arrays come back as `[]`, never `null`.
   */
  async listMissions(): Promise<EngineMission[]> {
    const res = await this.request<{ missions?: EngineMission[] }>('GET', '/api/engine/missions');
    return Array.isArray(res?.missions) ? res.missions : [];
  }

  /**
   * Fetch a single mission by UUID. Wire envelope: `{mission: {...}}`.
   *
   * Returns `null` for:
   *   - 404 "Mission not found" (id is well-formed but the row is gone)
   *   - 500 "engine v2 parse mission_id: invalid character: …"
   *     (id isn't a valid UUID — the server emits 500 here, not 400)
   *
   * Other HTTP errors (401, 403, transport) propagate via HttpError.
   */
  async getMission(id: string): Promise<EngineMission | null> {
    try {
      const res = await this.request<{ mission?: EngineMission }>(
        'GET',
        `/api/engine/missions/${encodeURIComponent(id)}`
      );
      return res?.mission ?? null;
    } catch (err) {
      if (err instanceof HttpError) {
        // 404 = missing; 500 with a parse-error message = malformed id.
        // Both are "no such mission" from the caller's perspective.
        if (err.status === 404) return null;
        if (err.status === 500 && /parse mission_id|invalid character/i.test(err.message)) {
          return null;
        }
      }
      throw err;
    }
  }

  /** List projects. Wire envelope: `{projects: [...]}`. */
  async listProjects(): Promise<EngineProject[]> {
    const res = await this.request<{ projects?: EngineProject[] }>('GET', '/api/engine/projects');
    return Array.isArray(res?.projects) ? res.projects : [];
  }

  /**
   * Fetch a single project by UUID. Wire envelope: `{project: {...}}`.
   *
   * Same 404 / 500-on-malformed-id handling as `getMission`.
   */
  async getProject(id: string): Promise<EngineProject | null> {
    try {
      const res = await this.request<{ project?: EngineProject }>(
        'GET',
        `/api/engine/projects/${encodeURIComponent(id)}`
      );
      return res?.project ?? null;
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 404) return null;
        if (err.status === 500 && /parse project_id|invalid character/i.test(err.message)) {
          return null;
        }
      }
      throw err;
    }
  }

  /**
   * List Engine v2 threads. Distinct from `/api/chat/threads`: engine
   * threads carry execution metadata (step count, total tokens, thread
   * type) and represent agent runs, not conversations.
   *
   * Wire envelope: `{threads: [...]}`.
   */
  async listEngineThreads(): Promise<EngineThread[]> {
    const res = await this.request<{ threads?: EngineThread[] }>('GET', '/api/engine/threads');
    return Array.isArray(res?.threads) ? res.threads : [];
  }

  /**
   * Fetch a single engine thread by UUID, with its full transcript.
   *
   * Wire envelope: `{thread: {...}}`. The detail row extends `EngineThread`
   * with `messages`, `max_iterations`, `total_cost_usd`, and `completed_at`
   * (see `EngineThreadDetail`).
   *
   * Returns `null` for:
   *   - 404 "Thread not found" (id is well-formed but the row is gone)
   *   - 500 with a UUID-parse error (id isn't a valid UUID)
   * Both cases mirror the `getMission`/`getProject` handling so callers
   * use a single "did we get it?" check.
   *
   * Other HTTP errors propagate via HttpError.
   */
  async getEngineThread(id: string): Promise<EngineThreadDetail | null> {
    try {
      const res = await this.request<{ thread?: EngineThreadDetail }>(
        'GET',
        `/api/engine/threads/${encodeURIComponent(id)}`
      );
      return res?.thread ?? null;
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 404) return null;
        if (err.status === 500 && /parse thread_id|invalid character/i.test(err.message)) {
          return null;
        }
      }
      throw err;
    }
  }

  /**
   * List steps for a thread. Wire envelope: `{steps: [...]}`.
   *
   * The current gateway returns `{steps: []}` for every thread we've probed
   * — the persisted step data isn't yet projected onto this endpoint. The
   * richer runtime story lives on `listEngineThreadEvents` (see below).
   * The method is wired so the UI is ready when the wire fills in.
   *
   * Same null-mapping as `getEngineThread` for 404 / 500-on-malformed-id —
   * callers receive `[]` for both. Network/5xx for other reasons still
   * throws so the panel can surface an error banner.
   */
  async getEngineThreadSteps(id: string): Promise<EngineThreadStep[]> {
    try {
      const res = await this.request<{ steps?: EngineThreadStep[] }>(
        'GET',
        `/api/engine/threads/${encodeURIComponent(id)}/steps`
      );
      return Array.isArray(res?.steps) ? res.steps : [];
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 404) return [];
        if (err.status === 500 && /parse thread_id|invalid character/i.test(err.message)) {
          return [];
        }
      }
      throw err;
    }
  }

  /**
   * List events for a thread. Wire envelope: `{events: [...]}`.
   *
   * Each event has a tagged-union `kind` field — see `EngineThreadEvent`
   * for the variants observed today (`MessageAdded`, `StateChanged`,
   * `StepStarted`, `StepCompleted`, `ActionExecuted`).
   *
   * On the current gateway the events endpoint is the richest source of
   * timeline data (step starts/completions with token usage, tool calls
   * with duration_ms + params_summary, state transitions) — the
   * EngineThreadDetail panel uses this as the primary timeline backing
   * store until `/steps` lights up.
   *
   * Same 404 / 500-on-malformed-id → `[]` handling as the other engine v2
   * detail methods.
   *
   * The brief mentioned a possible SSE channel for engine-thread events.
   * The current gateway exposes this as a plain JSON GET (verified
   * 2026-05-27). The panel polls at a fixed cadence while the thread is
   * `Running`; the polling cadence is the consumer's call.
   */
  async listEngineThreadEvents(id: string): Promise<EngineThreadEvent[]> {
    try {
      const res = await this.request<{ events?: EngineThreadEvent[] }>(
        'GET',
        `/api/engine/threads/${encodeURIComponent(id)}/events`
      );
      return Array.isArray(res?.events) ? res.events : [];
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 404) return [];
        if (err.status === 500 && /parse thread_id|invalid character/i.test(err.message)) {
          return [];
        }
      }
      throw err;
    }
  }

  // ---- OAuth device flow (extensions) ---------------------------------------
  //
  // Two endpoints, both per-extension:
  //
  //   POST /api/extensions/{name}/login/start  body: {session_id: string}
  //     → {success, status, message, activated, session_id?, …}
  //
  //   POST /api/extensions/{name}/login/poll   body: {session_id: string}
  //     → {success, status, message, activated, session_id}
  //
  // The wire identifier is `session_id`, NOT the OAuth-spec `device_code`.
  // The poll method accepts the brief's `deviceCode` parameter and forwards
  // it as `session_id`, so the public surface follows the RFC vocabulary.
  //
  // No extension on this gateway today supports interactive OAuth (`github`
  // is a WASM tool, `nearai` is an MCP server with bundled auth) — every
  // call returns `{success: false, status: "failed", message: "Server does
  // not support OAuth: ..."}`. The wire is live; the methods are wired so a
  // future OAuth-capable extension drops in without a client change.
  //
  // The start method generates a fresh `session_id` client-side (UUID-ish)
  // because the wire requires one but doesn't return one on a failed call.
  // The generated id is returned on the response so the caller can pass it
  // to the matching `pollExtensionLogin`.

  /**
   * Initiate the device-code OAuth flow for an extension.
   *
   * The wire requires a `session_id` in the request body (it's the gateway's
   * internal flow identifier, equivalent to the OAuth spec's `device_code`).
   * We generate one client-side via `crypto.randomUUID()` so the caller
   * doesn't have to.
   *
   * On a successful response the wire SHOULD emit `verification_uri`,
   * `user_code`, `expires_in`, and `interval` — none of these are observed
   * on the current gateway because no installed extension supports OAuth,
   * but they're documented on `DeviceLoginStart` for forward compat. We
   * synthesize empty-string / 0 fallbacks for the required RFC 8628 fields
   * (`verification_uri`, `user_code`, `expires_in`) so the type stays
   * strict for the happy path.
   *
   * `device_code` mirrors `session_id` for RFC parity — callers using
   * the spec vocabulary can read either.
   */
  async startExtensionLogin(name: string): Promise<DeviceLoginStart> {
    const target = extensionTarget(name);
    // The wire requires a session_id. crypto.randomUUID is available in
    // every browser context Tauri runs in (and in modern Node). If the
    // runtime somehow doesn't provide it we fall back to a timestamp-based
    // id — the wire only requires opaqueness, not cryptographic strength.
    const sessionId = (() => {
      const g = globalThis as { crypto?: { randomUUID?: () => string } };
      if (typeof g.crypto?.randomUUID === 'function') {
        return g.crypto.randomUUID();
      }
      return `ironclaw-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    })();

    const res = await this.request<{
      success?: boolean;
      status?: string;
      message?: string;
      activated?: boolean;
      session_id?: string;
      device_code?: string;
      verification_uri?: string;
      user_code?: string;
      expires_in?: number;
      interval?: number;
    }>('POST', `/api/extensions/${encodeURIComponent(target.name)}/login/start`, {
      session_id: sessionId
    });

    const returnedId = res?.session_id ?? res?.device_code ?? sessionId;
    const wireStatus = String(res?.status ?? '').toLowerCase();
    const hasDeviceFields =
      typeof res?.verification_uri === 'string' &&
      res.verification_uri.length > 0 &&
      typeof res?.user_code === 'string' &&
      res.user_code.length > 0 &&
      returnedId.length > 0;
    return {
      success:
        res?.success === true ||
        wireStatus === 'pending' ||
        wireStatus === 'completed' ||
        hasDeviceFields,
      status: res?.status,
      message: res?.message,
      activated: res?.activated === true,
      session_id: returnedId,
      device_code: returnedId,
      // RFC 8628 fields — fall through to safe defaults if the gateway
      // didn't emit them (today's failure path doesn't).
      verification_uri: typeof res?.verification_uri === 'string' ? res.verification_uri : '',
      user_code: typeof res?.user_code === 'string' ? res.user_code : '',
      expires_in: typeof res?.expires_in === 'number' ? res.expires_in : 0,
      interval: typeof res?.interval === 'number' ? res.interval : undefined
    };
  }

  /**
   * Poll for completion of an in-progress OAuth flow.
   *
   * The brief's parameter name is `deviceCode`; on the wire this is the
   * `session_id` value returned by `startExtensionLogin`. We forward it as
   * `session_id` to match the wire schema.
   *
   * Returns a `DeviceLoginPoll` with `status` mapped to the RFC-ish
   * vocabulary (`pending`, `authorized`, `denied`, `expired`, `failed`)
   * via simple aliasing from the wire's `success`/`status` pair. Failure
   * cases populate `error` from the wire's `message`.
   */
  async pollExtensionLogin(name: string, deviceCode: string): Promise<DeviceLoginPoll> {
    const target = extensionTarget(name);
    const res = await this.request<{
      success?: boolean;
      status?: string;
      message?: string;
      activated?: boolean;
      session_id?: string;
    }>('POST', `/api/extensions/${encodeURIComponent(target.name)}/login/poll`, {
      session_id: deviceCode
    });

    const wireStatus = String(res?.status ?? '').toLowerCase();
    // Map the wire's vocabulary onto RFC 8628 status names. The wire
    // emits `failed` for "no such session" / "extension does not support
    // OAuth"; we keep that name as-is so the caller can distinguish a
    // hard failure from a transient `pending`.
    let status: DeviceLoginPoll['status'];
    if (res?.success === true || res?.activated === true) {
      status = 'authorized';
    } else if (wireStatus === 'pending') {
      status = 'pending';
    } else if (wireStatus === 'denied') {
      status = 'denied';
    } else if (wireStatus === 'expired') {
      status = 'expired';
    } else if (wireStatus === 'completed') {
      // Wire emits 'completed' on the success path of some flows even
      // when `success` isn't set — treat as authorized.
      status = 'authorized';
    } else {
      status = wireStatus || 'failed';
    }

    return {
      status,
      error:
        status === 'authorized' || status === 'pending' ? undefined : (res?.message ?? undefined),
      authorized: status === 'authorized'
    };
  }

  // ---- User API tokens ------------------------------------------------------
  //
  // Three endpoints (verified 2026-05-27 against IronClaw 0.28.2):
  //
  //   GET    /api/tokens            → {tokens: UserToken[]}
  //   POST   /api/tokens            body: {name, scopes?}
  //                                  → {id, name, created_at, token, …}
  //                                     `token` is the raw value — ONLY
  //                                     returned on create.
  //   DELETE /api/tokens/{id}       → {id, status: "revoked"}
  //
  // Revoked tokens stay in the list with `revoked_at` set; callers showing
  // only active tokens should filter `revoked_at == null`. The list method
  // surfaces ALL rows verbatim — filtering is a UI concern.
  //
  // The create method returns the full token in plaintext exactly once.
  // Callers MUST hand the raw value to the user before discarding the
  // response (the only other path is for the user to revoke + recreate).

  /**
   * List the user's API tokens (active and revoked).
   *
   * Returns wire-shape rows mapped onto `UserToken`. Sorted by `created_at`
   * descending so the newest token surfaces first.
   */
  async listUserTokens(): Promise<UserToken[]> {
    const res = await this.request<{
      tokens?: Array<{
        id: string;
        name: string;
        created_at: string;
        expires_at?: string | null;
        last_used_at?: string | null;
        revoked_at?: string | null;
        token_prefix?: string;
        scopes?: string[];
      }>;
    }>('GET', '/api/tokens');

    const rows = Array.isArray(res?.tokens) ? res.tokens : [];
    const mapped: UserToken[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      last_used_at: row.last_used_at ?? undefined,
      expires_at: row.expires_at ?? undefined,
      revoked_at: row.revoked_at ?? undefined,
      scopes: Array.isArray(row.scopes) ? row.scopes : undefined,
      preview: typeof row.token_prefix === 'string' ? row.token_prefix : undefined
    }));

    // Newest-first for the UI; equal timestamps tie-break by id for
    // a stable sort.
    return mapped.sort((a, b) => {
      const ta = Date.parse(a.created_at);
      const tb = Date.parse(b.created_at);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
        return tb - ta;
      }
      return b.id.localeCompare(a.id);
    });
  }

  /**
   * Create a new user token.
   *
   * Returns `{id, token}` — the `token` value is the raw plaintext key the
   * server returns ONCE on create. Callers MUST surface it to the user
   * immediately; once dropped it cannot be recovered without revoking and
   * creating a new one.
   *
   * `scopes` is reserved — the wire accepts it in the body, but the
   * gateway does not yet enforce or echo per-token scopes back. Pass
   * through anyway so a future scope-aware gateway lights up without a
   * client change.
   */
  async createUserToken(name: string, scopes?: string[]): Promise<{ id: string; token: string }> {
    const body: Record<string, unknown> = { name };
    if (Array.isArray(scopes) && scopes.length > 0) {
      body.scopes = scopes;
    }
    const res = await this.request<{
      id?: string;
      token?: string;
      name?: string;
      created_at?: string;
      token_prefix?: string;
    }>('POST', '/api/tokens', body);

    // The wire always returns `token` on a successful create; the
    // fallbacks here are defensive against a hypothetical future schema
    // shift (and keep TypeScript strict).
    return {
      id: typeof res?.id === 'string' ? res.id : '',
      token: typeof res?.token === 'string' ? res.token : ''
    };
  }

  /**
   * Revoke a user token.
   *
   * Wire returns `{id, status: "revoked"}`. The row stays in the list with
   * `revoked_at` set; this method does NOT physically delete it.
   *
   * Returns `{ok: false}` on any failure (network, 401, 404 unknown id) —
   * the caller should refresh via `listUserTokens` to see the canonical
   * state. The underlying error is dropped here; surface via the request
   * helper directly if you need the message.
   */
  async revokeUserToken(id: string): Promise<{ ok: boolean }> {
    try {
      const res = await this.request<{ id?: string; status?: string }>(
        'DELETE',
        `/api/tokens/${encodeURIComponent(id)}`
      );
      const ok = res?.status === 'revoked' || res?.id === id;
      return { ok };
    } catch (err) {
      console.warn(`[ironclaw] revokeUserToken(${id}) failed:`, err);
      return { ok: false };
    }
  }

  // ---- IronClaw Reborn WebChat v2 -------------------------------------------
  //
  // These hit `/api/webchat/v2/*` on a Reborn backend (the `webui-v2-beta`
  // feature). They reuse the same request()/parseSseStream() plumbing as the
  // v1 methods but speak the projection-driven v2 contract: every mutating
  // call carries a `client_action_id` idempotency key, and the live event
  // stream is driven off `projection_snapshot`/`projection_update` frames.
  // The pure reducers/mappers that interpret those frames live in `./reborn`;
  // these methods are thin transport wrappers. Request shapes mirror the
  // WebChat v2 SPA's own client (`ironclaw_webui_v2_static/.../lib/api.js`).

  /** Create a thread. `requestedThreadId` lets the caller pin an id. */
  async createThreadV2(requestedThreadId?: string): Promise<CreateThreadResponse> {
    const body: CreateThreadRequest = { client_action_id: clientActionId() };
    if (requestedThreadId) body.requested_thread_id = requestedThreadId;
    return this.request<CreateThreadResponse>('POST', `${V2_BASE}/threads`, body);
  }

  /** List threads (most-recent first). `cursor` paginates. */
  async listThreadsV2(
    opts: { limit?: number; cursor?: string } = {}
  ): Promise<ListThreadsResponse> {
    return this.request<ListThreadsResponse>('GET', `${V2_BASE}/threads${buildV2Query(opts)}`);
  }

  /**
   * Cheap capability probe for the Reborn WebChat v2 routes. Some gateways
   * advertise Engine v2 but do not expose `/api/webchat/v2/*`; when that
   * happens the desktop client must keep the legacy chat path alive instead
   * of mounting a dead Reborn surface.
   */
  async probeWebChatV2(timeoutMs = 2500): Promise<boolean> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      await this.request<ListThreadsResponse>('GET', `${V2_BASE}/threads?limit=1`, undefined, {
        signal: ctrl.signal
      });
      return true;
    } catch (err) {
      // 401/403 still prove the route exists; the normal request path will
      // surface auth problems. 404/405/5xx/network failures should fall back
      // to the legacy chat surface, which is broadly supported by older local
      // gateways.
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        return true;
      }
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Post a user message; returns `{ run_id, thread_id?, status? }`. */
  async sendMessageV2(
    threadId: string,
    content: string,
    attachments: AttachmentInput[] = [],
    instructions?: string
  ): Promise<SendMessageResponse> {
    const body: SendMessageRequest = { client_action_id: clientActionId(), content };
    if (attachments.length > 0) body.attachments = attachments;
    if (typeof instructions === 'string' && instructions.trim() !== '') {
      body.instructions = instructions;
    }
    return this.request<SendMessageResponse>(
      'POST',
      `${V2_BASE}/threads/${encodeURIComponent(threadId)}/messages`,
      body
    );
  }

  /** Fetch the projection timeline for a thread. */
  async fetchTimelineV2(
    threadId: string,
    opts: { limit?: number; cursor?: string } = {}
  ): Promise<RebornTimelineResponse> {
    return this.request<RebornTimelineResponse>(
      'GET',
      `${V2_BASE}/threads/${encodeURIComponent(threadId)}/timeline${buildV2Query(opts)}`
    );
  }

  /** Fetch the current state of an accepted/running WebChat v2 run. */
  async getRunStateV2(threadId: string, runId: string): Promise<RebornRunStateResponse> {
    return this.request<RebornRunStateResponse>(
      'GET',
      `${V2_BASE}/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}`
    );
  }

  /** Cancel an in-flight run. */
  async cancelRunV2(threadId: string, runId: string, reason?: string): Promise<void> {
    const body: CancelRunRequest = { client_action_id: clientActionId() };
    if (reason) body.reason = reason;
    await this.request<void>(
      'POST',
      `${V2_BASE}/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/cancel`,
      body
    );
  }

  /** Resolve a gate (approval / denial / credential / cancellation). */
  async resolveGateV2(
    threadId: string,
    runId: string,
    gateRef: string,
    resolution: GateResolution,
    opts: { always?: boolean; credentialRef?: string } = {}
  ): Promise<void> {
    const body: ResolveGateRequest = { client_action_id: clientActionId(), resolution };
    if (opts.always !== undefined) body.always = opts.always;
    if (opts.credentialRef) body.credential_ref = opts.credentialRef;
    await this.request<void>(
      'POST',
      `${V2_BASE}/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(
        runId
      )}/gates/${encodeURIComponent(gateRef)}/resolve`,
      body
    );
  }

  /**
   * Open the WebChat v2 live event stream (SSE). Yields decoded
   * `WebChatV2EventFrame` envelopes — feed each into `reduceEvent` (./reborn)
   * to fold it into chat state. The token rides as a `?token=` query param
   * (the SPA uses EventSource, which can't set headers) AND as a bearer
   * header for the Tauri-fetch path. `afterCursor` resumes after reconnect.
   */
  async *streamWebChatV2Events(
    threadId: string,
    opts: { afterCursor?: string; signal: AbortSignal }
  ): AsyncIterable<WebChatV2EventFrame> {
    // Token-free path for any error / log surface. The live URL carries the
    // bearer token as a `?token=` query param (EventSource can't set headers),
    // so it must never land in an HttpError message or a console log.
    const safeUrl = `${this.baseUrl}${V2_BASE}/threads/${encodeURIComponent(threadId)}/events`;
    const url = new URL(safeUrl);
    if (this.token) url.searchParams.set('token', this.token);
    if (opts.afterCursor) url.searchParams.set('after_cursor', opts.afterCursor);

    const maybeTauri = await loadTauriFetch();
    const fetchImpl = maybeTauri ?? fetch;
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      signal: opts.signal
    });
    if (!res.ok || !res.body) {
      throw new HttpError(res.status, safeUrl, `WebChat v2 SSE open failed: ${res.status}`);
    }
    // SSE contract (mirrors the WebChat v2 SPA's `useSSE`): the `event:` line
    // names the frame type and the `data:` payload is the frame body. The body
    // may itself carry a `type` (the default `message` channel) — prefer that,
    // else synthesize the envelope type from the event name. Malformed frames
    // decode to [] (never throw) so one bad frame can't kill the stream.
    yield* parseSseStream<WebChatV2EventFrame>(res.body, opts.signal, (raw, event) => {
      try {
        const frame = JSON.parse(raw) as Record<string, unknown>;
        if (!frame || typeof frame !== 'object') return [];
        return [{ type: (frame.type as string) || event, frame } as WebChatV2EventFrame];
      } catch {
        return [];
      }
    });
  }
}

// ---- Helpers ----------------------------------------------------------------

/**
 * Build a `?limit=&cursor=` query string for the v2 list/timeline endpoints.
 * Returns '' (not '?') when no params are set so the path stays clean.
 */
export function buildV2Query(opts: { limit?: number; cursor?: string }): string {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', opts.cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Map an ISO-8601 `since` timestamp onto the wire's coarse `period` bucket.
 *
 * The gateway's `/api/admin/usage` endpoint computes `since` server-side
 * from `period` (one of `hour`, `day`, `week`, `month`, `year`) and
 * ignores any caller-supplied `since=` parameter. We pick the smallest
 * bucket that brackets the caller's requested cutoff so the response
 * contains "everything since T" without overshooting too far.
 *
 *   T ≥ now-1h  → "hour"
 *   T ≥ now-1d  → "day"
 *   T ≥ now-7d  → "week"
 *   T ≥ now-30d → "month"
 *   otherwise   → "year"
 *
 * Returns `undefined` for unparseable input so the request falls back to
 * the gateway's default ("day").
 */
export function sinceToPeriod(since: string | undefined): string | undefined {
  if (!since) return undefined;
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return undefined;
  const now = Date.now();
  const ageMs = Math.max(0, now - t);
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (ageMs <= hour) return 'hour';
  if (ageMs <= day) return 'day';
  if (ageMs <= 7 * day) return 'week';
  if (ageMs <= 30 * day) return 'month';
  return 'year';
}

export function normalizeLogLevel(raw: unknown): LogLevel {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'trace' || s === 'debug' || s === 'info' || s === 'warn' || s === 'error') {
    return s;
  }
  // Tracing sometimes emits "warning" or numeric levels; treat the
  // unknown case as `info` so we don't lose entries on the floor.
  if (s === 'warning') return 'warn';
  return 'info';
}

export function mapRunStatus(s: string): 'running' | 'success' | 'failed' {
  if (s === 'completed') return 'success';
  if (s === 'running') return 'running';
  // 'failed', 'timeout', and any unknown values surface as failed so UI flags them.
  return 'failed';
}

/**
 * Map the gateway's `kind` field onto the UI's normalized category tag.
 * The current gateway emits values like `wasm_tool`, `wasm_channel`, and
 * `mcp_server`. We collapse anything channel-like to "channel" and
 * MCP-like to "mcp"; everything else passes through verbatim so future
 * categories show up rather than getting silently dropped.
 */
export function mapExtensionKind(kind: unknown): string | undefined {
  const k = String(kind ?? '').toLowerCase();
  if (!k) return undefined;
  if (k.includes('channel')) return 'channel';
  if (k.includes('mcp')) return 'mcp';
  if (k.includes('oauth')) return 'oauth';
  // wasm_tool, builtin, etc. — keep the raw value so the badge can still
  // render something sensible.
  return k;
}

/**
 * Find the index of the end of the first complete SSE frame in `buf`, where
 * a frame is delimited by `\n\n` or `\r\n\r\n`. Returns -1 if no complete
 * frame is buffered yet. The returned index points at the FIRST byte of the
 * delimiter — caller skips two bytes past it (and an extra two for CRLF) to
 * advance.
 */
export function findFrameEnd(buf: string): number {
  const lf = buf.indexOf('\n\n');
  const crlf = buf.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return -1;
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/**
 * Generic SSE chunk parser shared by `streamEvents`, `streamLogs`, and any
 * future SSE endpoint. Takes a `ReadableStream<Uint8Array>` (what the Tauri
 * http plugin's `fetch` returns) and a per-frame `decode` hook that turns
 * a raw `data:` payload into zero, one, or more typed events.
 *
 * Honours the abort signal between frames so closing the chat surface
 * (or navigating away) cancels the upstream generation.
 */
async function* parseSseStream<T>(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  decode: (raw: string, event: string) => T[]
): AsyncIterable<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal.aborted) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let frameEnd: number;
      // eslint-disable-next-line no-cond-assign
      while ((frameEnd = findFrameEnd(buf)) !== -1) {
        const rawFrame = buf.slice(0, frameEnd);
        buf = buf.slice(frameEnd + (buf.startsWith('\r\n', frameEnd) ? 2 : 0) + 2);
        const parsed = parseSseFrame(rawFrame);
        if (!parsed) continue;
        for (const out of decode(parsed.data, parsed.event)) yield out;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Parse a single SSE frame (one or more `field: value` lines) into
 * `{event, data}`. Multi-line `data:` continuations are joined with `\n`
 * per the SSE spec; everything else is ignored — we don't need `id:` or
 * `retry:` for the chat stream.
 *
 * Returns null for empty frames (just a comment / heartbeat).
 */
export function parseSseFrame(frame: string): { event: string; data: string } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine;
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // SSE spec: a single leading space after the colon is stripped.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    // id, retry, and unknown fields ignored.
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * Map a Responses-API SSE frame onto zero, one, or more ChatEvent values.
 *
 * Emits multiple events in a few cases:
 *   - `response.completed` with a non-empty `content` already streamed via
 *     `output_text.delta` does NOT re-emit (the delta path is canonical).
 *   - `response.output_item.added` of `function_call` synthesizes a single
 *     `tool_call` (the matching `done` envelope synthesizes a `tool_result`).
 *
 * Returns [] for control events that don't carry UI-relevant state
 * (e.g. `output_item.added` for an assistant `message` shell — the
 * subsequent `output_text.delta` is what we render).
 */
function mapResponsesEvent(ev: { event: string; data: string }): ChatEvent[] {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(ev.data) as Record<string, unknown>;
  } catch (e) {
    return [{ type: 'error', message: `parse error: ${(e as Error).message}` }];
  }
  const type = String(raw.type ?? ev.event ?? '');
  switch (type) {
    case 'response.created': {
      const resp = (raw.response as Record<string, unknown> | undefined) ?? {};
      const id = String(resp.id ?? '');
      return [
        {
          type: 'message_start',
          thread_id: '',
          message_id: id
        }
      ];
    }
    case 'response.output_item.added': {
      const item = (raw.item as Record<string, unknown> | undefined) ?? {};
      const itemType = String(item.type ?? '');
      if (itemType === 'function_call') {
        // The wire packs both `name` and `arguments` in this envelope.
        // `arguments` is empty here on this gateway today; the final
        // shape lives in `output_item.done` instead. Surface whatever
        // arrived so the right-rail can render the call shell.
        const argsStr = String(item.arguments ?? '');
        let args: unknown = argsStr;
        if (argsStr.length > 0) {
          try {
            args = JSON.parse(argsStr);
          } catch {
            // Keep raw string if arguments aren't JSON (e.g. the
            // demo gateway emits `memory_search(hermes)` as the name
            // with empty args).
          }
        }
        return [
          {
            type: 'tool_call',
            name: String(item.name ?? ''),
            args
          }
        ];
      }
      // Assistant message shell — nothing to render yet; deltas follow.
      return [];
    }
    case 'response.output_text.delta': {
      // Real incremental chunk; concat path in messages store.
      const delta = String(raw.delta ?? '');
      if (delta.length === 0) return [];
      return [{ type: 'content_delta', delta }];
    }
    case 'response.function_call.arguments.delta': {
      // Forward-compat: a future gateway version may stream tool arguments
      // incrementally. The shape isn't observed in production today but is
      // documented in OpenAI's Responses API; if it shows up, surface it as
      // a `tool_call_delta` for any consumer that wants to render partial
      // arguments.
      const delta = String(raw.delta ?? raw.arguments_delta ?? '');
      if (delta.length === 0) return [];
      return [{ type: 'tool_call_delta', arguments_delta: delta }];
    }
    case 'response.output_item.done': {
      const item = (raw.item as Record<string, unknown> | undefined) ?? {};
      const itemType = String(item.type ?? '');
      if (itemType === 'function_call') {
        // The gateway doesn't emit a dedicated tool_result event today —
        // synthesize one from the completed call envelope. `result` is
        // unknown to us at this point (the model runs the tool server-side
        // and emits the next assistant message), so we record an empty
        // result; the right-rail flips the call from "Running…" to "done".
        const argsStr = String(item.arguments ?? '');
        let result: unknown = argsStr;
        if (argsStr.length > 0) {
          try {
            result = JSON.parse(argsStr);
          } catch {
            // keep raw
          }
        } else {
          result = '';
        }
        return [
          {
            type: 'tool_result',
            name: String(item.name ?? ''),
            result
          }
        ];
      }
      return [];
    }
    case 'response.completed': {
      const resp = (raw.response as Record<string, unknown> | undefined) ?? {};
      return [
        {
          type: 'message_end',
          message_id: String(resp.id ?? ''),
          finish_reason: String(resp.status ?? 'completed')
        }
      ];
    }
    case 'response.failed':
    case 'response.error':
    case 'error': {
      const err = (raw.error as Record<string, unknown> | undefined) ?? raw;
      const message = String(err.message ?? raw.message ?? 'Responses API error');
      return [{ type: 'error', message }];
    }
    default:
      // Unknown event type — drop silently. We don't want to spam the UI
      // with errors when the gateway adds a new event kind we don't
      // recognize (e.g. a future `response.reasoning.delta`).
      return [];
  }
}

/**
 * Normalize a raw SSE payload from the gateway into our tagged ChatEvent.
 *
 * Wire (verified 2026-05-27 against IronClaw 0.28.2):
 *   - `type: "response"`     — assistant content (FULL content per event,
 *                              not incremental). Mapped to `content_delta`;
 *                              the messages-store heuristic handles the
 *                              clobber-vs-append duality.
 *   - `type: "thinking"`     — progress chatter ("Calling LLM…", "Step
 *                              complete — 1234 in / 56 out tokens"). DROPPED.
 *   - `type: "status"`       — short status pings ("Done"). DROPPED.
 *   - `type: "tool_start"`   — tool invocation start.
 *   - `type: "tool_result"`  — tool invocation result.
 *   - `type: "error"`        — server-side error.
 *   - `type: "text_response"`— LEGACY (kept for older gateways).
 *   - `type: "message_start"`/`message_end` — forward-compat.
 *
 * Returns `null` for dropped event types so the SSE handler can skip
 * pushing them onto the consumer queue without producing UI noise.
 */
function normalizeEvent(raw: Record<string, unknown>): ChatEvent | null {
  const type = String(raw.type ?? '');
  switch (type) {
    case 'response':
    case 'text_response':
      // Server emits the FULL assistant content per event (not an
      // incremental delta). Surface as `content_delta` — the messages-store
      // heuristic handles full-clobber vs. true-delta. `text_response` is
      // retained for older gateways that haven't switched to the bare
      // `response` type yet.
      return {
        type: 'content_delta',
        thread_id: raw.thread_id as string | undefined,
        message_id: raw.message_id as string | undefined,
        delta: unwrapDocumentAssignment(String(raw.content ?? ''))
      };
    case 'thinking':
    case 'status':
      // Progress / status chatter — drop silently. The UI shows its own
      // streaming spinner; this stream isn't the place to surface
      // "Calling LLM…" or per-step token counts.
      return null;
    case 'tool_start':
    case 'tool_started':
    case 'tool_called':
      return {
        type: 'tool_call',
        name: String(raw.tool ?? raw.name ?? ''),
        args: raw.args
      };
    case 'tool_result':
    case 'tool_completed':
    case 'tool_finished':
      // `tool_started` / `tool_completed` are the IronClaw v0.29+ names
      // for what older gateways called `tool_start` / `tool_result`.
      // Payload shape is the same: `{tool|name, result|output}`. Mapped
      // identically — the UI doesn't care which name the wire used.
      return {
        type: 'tool_result',
        name: String(raw.tool ?? raw.name ?? ''),
        result: raw.result ?? raw.output
      };
    case 'approval_needed':
      return {
        type: 'approval_needed',
        request_id: String(raw.request_id ?? ''),
        thread_id: raw.thread_id as string | undefined,
        tool_name: String(raw.tool_name ?? raw.tool ?? raw.name ?? ''),
        description: String(raw.description ?? 'Tool approval required'),
        parameters: normalizeApprovalParameters(raw.parameters),
        allow_always: raw.allow_always === true
      };
    case 'message_start':
      return {
        type: 'message_start',
        thread_id: String(raw.thread_id ?? ''),
        message_id: String(raw.message_id ?? '')
      };
    case 'message_end':
      return {
        type: 'message_end',
        thread_id: raw.thread_id as string | undefined,
        message_id: raw.message_id as string | undefined,
        finish_reason: String(raw.finish_reason ?? 'stop')
      };
    case 'error':
      return { type: 'error', message: String(raw.message ?? 'Unknown error') };
    default:
      // Unknown event type — drop silently to match mapResponsesEvent.
      // Previously surfaced as a user-visible error chip + toast spam
      // (e.g. v0.2.10 hit a flood of `tool_started` errors before that
      // alias was wired). The UI is not the right place to discover
      // wire-format drift; that's a job for ironclaw_diag at the
      // request layer + the gateway's own changelog.
      return null;
  }
}

function normalizeApprovalParameters(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

// ---- Replay events (R59 codex A6) -----------------------------------------

export interface IronClawClient {
  getThreadEvents(
    threadId: string,
    sinceTs?: number,
    limit?: number
  ): Promise<{
    events: import('./types').ReplayEvent[];
    nextSinceTs: number;
  }>;
}

IronClawClient.prototype.getThreadEvents = async function getThreadEvents(
  this: IronClawClient,
  threadId: string,
  sinceTs?: number,
  limit = 500
): Promise<{
  events: import('./types').ReplayEvent[];
  nextSinceTs: number;
}> {
  const params = new URLSearchParams();
  if (sinceTs) params.set('since_ts', String(sinceTs));
  params.set('limit', String(limit));
  const url = `${this.baseUrl}/api/chat/threads/${encodeURIComponent(threadId)}/events?${params}`;
  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}
  });
  if (!res.ok) throw new Error(`getThreadEvents ${res.status}`);
  const body = await res.json();
  return {
    events: body.events ?? [],
    nextSinceTs: body.next_since_ts ?? Date.now()
  };
};

// ---- Reply-thread events (R79 codex W2) ----------------------------------

function normalizeReplyThreadEvent(
  raw: Record<string, unknown>,
  fallbackParentMessageId: string
): ReplyThreadStreamEvent | null {
  const type = String(raw.type ?? '');
  const replyId = String(raw.reply_id ?? raw.message_id ?? raw.id ?? '');
  const parentMessageId = String(
    raw.parent_message_id ?? raw.reply_to_message_id ?? fallbackParentMessageId
  );

  switch (type) {
    case 'reply.started':
      return {
        type: 'reply.started',
        reply_id: replyId,
        parent_message_id: parentMessageId
      };
    case 'reply.delta':
    case 'reply.streamed':
      return {
        type: 'reply.delta',
        reply_id: replyId,
        parent_message_id: parentMessageId,
        delta: String(raw.delta ?? raw.content_delta ?? raw.content ?? '')
      };
    case 'reply.completed':
    case 'reply.posted': {
      const wireMessage = (raw.message ?? raw.reply ?? raw) as Record<string, unknown>;
      return {
        type: 'reply.completed',
        reply_id: replyId || String(wireMessage.id ?? ''),
        parent_message_id: parentMessageId,
        message: normalizeReplyMessage(wireMessage, replyId)
      };
    }
    case 'reply.failed':
      return {
        type: 'reply.failed',
        reply_id: replyId,
        parent_message_id: parentMessageId,
        error: String(raw.error ?? raw.message ?? 'Reply thread stream failed')
      };
    default:
      return null;
  }
}

function normalizeReplyMessage(raw: Record<string, unknown>, fallbackId: string): Message {
  const role =
    raw.role === 'user' || raw.role === 'assistant' || raw.role === 'tool' ? raw.role : 'assistant';
  return {
    id: String(raw.id ?? raw.message_id ?? fallbackId),
    role,
    content: String(raw.content ?? raw.delta ?? ''),
    created_at: String(raw.created_at ?? raw.timestamp ?? new Date().toISOString())
  };
}

// ---- Sub-agents (R56 lane A5) ----------------------------------------------
//
// Dispatch a one-shot background agent task from inside a chat. The
// gateway endpoint `/api/v1/tasks` may not exist on older IronClaw
// builds (probed 2026-05-28 against baremetal3 v0.29: 404), so every
// method maps a 404 to `SubAgentUnsupportedError` and the UI degrades
// to a clear "needs a newer gateway" hint instead of a broken flow.

export interface IronClawClient {
  dispatchSubAgent(input: SubAgentDispatchInput): Promise<SubAgentTask>;
  getSubAgentTask(id: string): Promise<SubAgentTask>;
  streamSubAgentEvents(id: string, signal?: AbortSignal): AsyncIterable<SubAgentEvent>;
  cancelSubAgentTask(id: string): Promise<void>;
}

IronClawClient.prototype.dispatchSubAgent = async function dispatchSubAgent(
  this: IronClawClient,
  input: SubAgentDispatchInput
): Promise<SubAgentTask> {
  const url = `${this.baseUrl}/api/v1/tasks`;
  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
    },
    body: JSON.stringify({
      prompt: input.prompt,
      priority: input.priority ?? 'normal',
      parent_thread_id: input.parentThreadId,
      model: input.model
    })
  });
  if (res.status === 404 || res.status === 405) throw new SubAgentUnsupportedError();
  if (!res.ok) throw new Error(`dispatchSubAgent ${res.status}`);
  return (await res.json()) as SubAgentTask;
};

IronClawClient.prototype.getSubAgentTask = async function getSubAgentTask(
  this: IronClawClient,
  id: string
): Promise<SubAgentTask> {
  const url = `${this.baseUrl}/api/v1/tasks/${encodeURIComponent(id)}`;
  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}
  });
  if (res.status === 404 || res.status === 405) throw new SubAgentUnsupportedError();
  if (!res.ok) throw new Error(`getSubAgentTask ${res.status}`);
  return (await res.json()) as SubAgentTask;
};

IronClawClient.prototype.streamSubAgentEvents = async function* streamSubAgentEvents(
  this: IronClawClient,
  id: string,
  signal?: AbortSignal
): AsyncIterable<SubAgentEvent> {
  const url = `${this.baseUrl}/api/v1/tasks/${encodeURIComponent(id)}/events`;
  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    headers: {
      Accept: 'text/event-stream',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
    },
    signal
  });
  if (res.status === 404 || res.status === 405) throw new SubAgentUnsupportedError();
  if (!res.ok || !res.body) throw new Error(`streamSubAgentEvents ${res.status}`);
  // parseSseStream requires a non-optional AbortSignal + a decode fn
  // that maps each SSE record into an array of T. We decode the data
  // payload as JSON and normalize the gateway's event taxonomy.
  const sig = signal ?? new AbortController().signal;
  yield* parseSseStream<SubAgentEvent>(res.body, sig, (raw, event) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    // The SSE `event:` name (when present) wins over an in-body `type`.
    if (event && event !== 'message') parsed.type = event;
    const norm = normalizeSubAgentEvent(parsed, id);
    return norm ? [norm] : [];
  });
};

IronClawClient.prototype.cancelSubAgentTask = async function cancelSubAgentTask(
  this: IronClawClient,
  id: string
): Promise<void> {
  const url = `${this.baseUrl}/api/v1/tasks/${encodeURIComponent(id)}/cancel`;
  const maybeTauri = await loadTauriFetch();
  const fetchImpl = maybeTauri ?? fetch;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}
  });
  // A 404 on cancel is fine — the task is gone or the gateway lacks
  // the endpoint; either way there's nothing to cancel.
  if (!res.ok && res.status !== 404 && res.status !== 405) {
    throw new Error(`cancelSubAgentTask ${res.status}`);
  }
};

function normalizeSubAgentEvent(
  raw: Record<string, unknown>,
  fallbackTaskId: string
): SubAgentEvent | null {
  const type = String(raw.type ?? '');
  const taskId = String(raw.task_id ?? raw.id ?? fallbackTaskId);
  switch (type) {
    case 'task.started':
    case 'started':
      return { type: 'started', taskId };
    case 'task.progress':
    case 'progress':
      return { type: 'progress', taskId, text: String(raw.text ?? raw.delta ?? '') };
    case 'task.completed':
    case 'completed':
      return { type: 'completed', taskId, result: String(raw.result ?? raw.output ?? '') };
    case 'task.failed':
    case 'failed':
      return { type: 'failed', taskId, error: String(raw.error ?? raw.message ?? 'task failed') };
    default:
      return null;
  }
}
