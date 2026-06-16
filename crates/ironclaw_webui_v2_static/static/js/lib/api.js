// WebChat v2 ingress client.
//
// Every function in this module targets a `/api/webchat/v2/*` route
// defined by issue #3815, a v2-owned `/auth/*` route mounted by
// `ironclaw_reborn_webui_ingress::webui_v2_auth_router`, or a
// Reborn product-auth route mounted by host composition. The module
// deliberately contains no `/api/chat`, `/api/engine`, or
// `/api/profile` paths — the hard non-goal of issue #3886 still
// stands for v1 gateway routes that lack a v2 counterpart.
//
// Request/response shapes mirror the Rust DTOs in
// `ironclaw_product_workflow::webui_inbound` and
// `ironclaw_product_workflow::reborn_services::types`. The error
// envelope mirrors `RebornServicesError`.
//
// This file is the single shared client for BOTH the hosted web SPA and
// the packaged desktop (Tauri) app. The desktop transport layer below is
// a strict no-op on web: outside a Tauri WebView `gatewayOrigin()` returns
// "", `gatewayUrl(path)` returns `path` unchanged, and `gatewayFetch`
// falls back to the global `fetch`, so web behavior is byte-for-byte the
// hosted client's. Desktop-only routing engages only behind
// `isDesktopRuntime()` / `gatewayOrigin()` gates.

const TOKEN_KEY = "ironclaw_token";
const V2_BASE = "/api/webchat/v2";
const DESKTOP_GATEWAY_ORIGIN_KEY = "ironclaw:desktop-gateway-origin";
const DEFAULT_DESKTOP_GATEWAY_ORIGIN = "http://127.0.0.1:3100";

// --- Desktop (Tauri) transport layer ---
//
// Everything in this section is inert on the web: each entry point first
// checks `inTauri()` and returns the web-equivalent value when false. The
// shared fetch paths (`apiFetch`, the SSE/WS connectors, the auth calls,
// the project-files API) route through `gatewayFetch(gatewayUrl(path), ...)`
// with credentials chosen by `gatewayOrigin()`. On web that resolves to
// `fetch(path, { credentials: "same-origin", ... })` — unchanged.

let tauriFetchPromise = null;
let bootstrappedDesktopGatewayOrigin = "";

function inTauri() {
  return Boolean(typeof window !== "undefined" && (window.__TAURI_INTERNALS__ || window.__TAURI__));
}

export function isDesktopRuntime() {
  return inTauri();
}

export async function tauriInvoke(command, args = {}) {
  const invoke = window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") {
    throw new Error("Tauri invoke is unavailable");
  }
  return invoke(command, args);
}

// Open a URL in the user's REAL browser. Inside the packaged WebView,
// `window.open` spawns a Tauri child webview (or nothing) with none of the
// user's cookies or passkeys — OAuth sign-in pages are unusable there. The
// shell plugin hands the URL to the system browser instead.
export async function openExternalUrl(url) {
  if (inTauri()) {
    try {
      await tauriInvoke("plugin:shell|open", { path: url });
      return true;
    } catch (_) {
      // Fall through to window.open so hosted/dev still works.
    }
  }
  try {
    const popup = window.open(url, "_blank", "noopener");
    return Boolean(popup);
  } catch (_) {
    return false;
  }
}

function normalizeOrigin(value) {
  const trimmed = (value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return url.origin;
  } catch (_) {
    return "";
  }
}

// On web this returns "" (no Tauri), which makes `gatewayUrl` a pass-through
// and `apiFetch` use `credentials: "same-origin"` — the hosted behavior.
export function gatewayOrigin() {
  if (!inTauri()) return "";
  return (
    bootstrappedDesktopGatewayOrigin ||
    normalizeOrigin(window.__IRONCLAW_GATEWAY_ORIGIN__) ||
    normalizeOrigin(localStorage.getItem(DESKTOP_GATEWAY_ORIGIN_KEY)) ||
    DEFAULT_DESKTOP_GATEWAY_ORIGIN
  );
}

// Resolve a same-origin app path to the desktop gateway origin. On web
// `gatewayOrigin()` is "" so the original `path` is returned unchanged.
export function gatewayUrl(path) {
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  const origin = gatewayOrigin();
  return origin ? `${origin}${path.startsWith("/") ? path : `/${path}`}` : path;
}

async function loadTauriFetch() {
  if (!inTauri()) return null;
  if (tauriFetchPromise) return tauriFetchPromise;
  tauriFetchPromise = Promise.resolve(tauriHttpFetch);
  return tauriFetchPromise;
}

// On web `loadTauriFetch()` returns null, so this is exactly the global
// `fetch`. In the desktop WebView it routes through the Tauri HTTP shim so
// requests reach the sidecar/gateway origin rather than the WebView origin.
export async function gatewayFetch(input, options = {}) {
  const fetchImpl = (await loadTauriFetch()) || fetch;
  return fetchImpl(input, options);
}

async function tauriHttpFetch(input, init = {}) {
  const signal = init?.signal;
  if (signal?.aborted) {
    throw new Error("Request cancelled");
  }

  const headers = init?.headers
    ? init.headers instanceof Headers
      ? init.headers
      : new Headers(init.headers)
    : new Headers();
  const request = new Request(input, init);
  const buffer = await request.arrayBuffer();
  const data = buffer.byteLength ? Array.from(new Uint8Array(buffer)) : null;

  for (const [key, value] of request.headers) {
    if (!headers.get(key)) headers.set(key, value);
  }

  const mappedHeaders = Array.from(headers.entries()).map(([name, value]) => [name, String(value)]);
  const accept = headers.get("accept") || headers.get("Accept") || "";
  if (!accept.includes("text/event-stream")) {
    return tauriBufferedHttpFetch(request, mappedHeaders, data);
  }

  const rid = await tauriInvoke("plugin:http|fetch", {
    clientConfig: {
      method: request.method,
      url: request.url,
      headers: mappedHeaders,
      data,
      connectTimeout: 10_000,
    },
  });
  const abort = () => tauriInvoke("plugin:http|fetch_cancel", { rid }).catch(() => {});
  if (signal?.aborted) {
    abort();
    throw new Error("Request cancelled");
  }
  signal?.addEventListener("abort", abort, { once: true });

  const {
    status,
    statusText,
    url,
    headers: responseHeaders,
    rid: responseRid,
  } = await tauriInvoke("plugin:http|fetch_send", { rid });

  const dropBody = () =>
    tauriInvoke("plugin:http|fetch_cancel_body", { rid: responseRid }).catch(() => {});
  const body = [101, 103, 204, 205, 304].includes(status)
    ? null
    : new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await tauriInvoke("plugin:http|fetch_read_body", {
              rid: responseRid,
            });
            const bytes = new Uint8Array(chunk);
            const last = bytes[bytes.byteLength - 1];
            const payload = bytes.slice(0, bytes.byteLength - 1);
            if (last === 1) {
              controller.close();
              return;
            }
            controller.enqueue(payload);
          } catch (err) {
            controller.error(err);
            dropBody();
          }
        },
        cancel: dropBody,
      });

  const response = new Response(body, { status, statusText });
  Object.defineProperty(response, "url", { value: url, writable: false });
  Object.defineProperty(response, "headers", {
    value: new Headers(responseHeaders),
    writable: false,
  });
  return response;
}

async function tauriBufferedHttpFetch(request, mappedHeaders, data) {
  const value = await tauriInvoke("gateway_http_fetch", {
    request: {
      method: request.method,
      url: request.url,
      headers: mappedHeaders,
      data,
    },
  });
  const body = value?.data ? new Uint8Array(value.data) : null;
  const response = new Response(body, {
    status: value?.status || 500,
    statusText: value?.status_text || value?.statusText || "",
  });
  Object.defineProperty(response, "url", { value: value?.url || request.url, writable: false });
  Object.defineProperty(response, "headers", {
    value: new Headers(value?.headers || []),
    writable: false,
  });
  return response;
}

function activeProfileFromSettings(settings) {
  const profiles = Array.isArray(settings?.profiles) ? settings.profiles : [];
  const activeId =
    typeof settings?.activeProfileId === "string"
      ? settings.activeProfileId
      : profiles[0]?.id || "default";
  return {
    activeId,
    profile: profiles.find((candidate) => candidate?.id === activeId) || profiles[0] || null,
  };
}

async function runningSidecarOrigin({ attempts = 1, delayMs = 0 } = {}) {
  if (!inTauri()) return "";
  // The bundled sidecar auto-boots asynchronously at app launch and needs a
  // couple of seconds to bind its port and pass /api/health. The WebView
  // bootstrap can win that race; finding no sidecar yet, it would fall back to
  // a stale profile baseUrl and strand the user on "connecting" (and "could
  // not load conversations") until a manual Retry. Poll sidecar_status briefly
  // so a normal launch connects on its own.
  const total = Math.max(1, attempts);
  for (let attempt = 0; attempt < total; attempt += 1) {
    try {
      const status = await tauriInvoke("sidecar_status");
      if (status?.running && Number.isFinite(Number(status.port))) {
        return normalizeOrigin(`http://127.0.0.1:${Number(status.port)}`);
      }
    } catch (err) {
      console.warn("[ironclaw] sidecar status bootstrap failed", err);
    }
    if (delayMs > 0 && attempt < total - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return "";
}

export async function bootstrapDesktopSession() {
  if (!inTauri()) return null;
  let settings = null;
  try {
    settings = await tauriInvoke("get_settings");
  } catch (err) {
    console.warn("[ironclaw] desktop settings bootstrap failed", err);
  }

  const { activeId, profile } = activeProfileFromSettings(settings);
  const baseUrl =
    (profile?.mode === "local" ? profile?.localBaseUrl : profile?.remoteBaseUrl) ||
    profile?.remoteBaseUrl ||
    profile?.localBaseUrl ||
    DEFAULT_DESKTOP_GATEWAY_ORIGIN;
  // Wait out the local sidecar's async auto-boot (~2-3s typical) before
  // settling on an origin, so a cold launch connects without a manual Retry.
  const sidecarOrigin = await runningSidecarOrigin({ attempts: 20, delayMs: 400 });
  const origin = sidecarOrigin || normalizeOrigin(baseUrl) || DEFAULT_DESKTOP_GATEWAY_ORIGIN;
  bootstrappedDesktopGatewayOrigin = origin;
  localStorage.setItem(DESKTOP_GATEWAY_ORIGIN_KEY, origin);

  let token = "";
  const looksLocal =
    Boolean(sidecarOrigin) ||
    origin.includes("127.0.0.1") ||
    origin.includes("localhost") ||
    profile?.mode === "local";
  if (looksLocal) {
    try {
      token = (await tauriInvoke("get_or_create_local_token")) || "";
    } catch (err) {
      console.warn("[ironclaw] local gateway token bootstrap failed", err);
    }
  }
  if (!token) {
    try {
      token = (await tauriInvoke("get_token", { profileId: activeId })) || "";
    } catch (err) {
      console.warn("[ironclaw] desktop profile token bootstrap failed", err);
    }
  }

  return { token, gatewayOrigin: origin, profileId: activeId };
}

export class ApiError extends Error {
  constructor(message, { status, statusText, body, headers, payload } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    this.headers = headers;
    // Parsed RebornServicesError when the server returned JSON in
    // the documented shape. Undefined for non-JSON 5xx / proxy errors.
    this.payload = payload;
  }
}

export function readStoredToken() {
  return sessionStorage.getItem(TOKEN_KEY) || "";
}

export function storeToken(token) {
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
  } else {
    sessionStorage.removeItem(TOKEN_KEY);
  }
}

// Generate a client action id (idempotency key) for mutating requests.
// Must be a non-empty token with no control characters; `crypto.randomUUID`
// satisfies the validator in `webui_inbound::parse_client_action_id`.
export function clientActionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  (crypto?.getRandomValues || ((b) => b))(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function parseErrorBody(response) {
  const text = await response.text().catch(() => "");
  if (!text) return { text: "", payload: undefined };
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return { text, payload: undefined };
  }
  try {
    return { text, payload: JSON.parse(text) };
  } catch (_) {
    return { text, payload: undefined };
  }
}

// Turn a snake_case / kebab-case wire token into a readable phrase, e.g.
// `service_unavailable` -> "Service unavailable".
function humanizeErrorToken(token) {
  return String(token)
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/^\w/, (char) => char.toUpperCase());
}

// Derive a human-readable message from a WebChat v2 error response.
//
// The wire envelope (`ironclaw_webui_v2::WebUiV2HttpErrorBody`) carries only
// snake_case enum codes — `kind` (the user-renderable family, e.g.
// `service_unavailable`), `error` (a coarse code), and an optional
// `validation_code` + `field` — never prose. Throwing the raw JSON body as the
// error message means a dialog shows `{"error":"...","kind":"..."}`, which reads
// as "no error" to a user. Humanize the most specific token instead, and only
// fall back to a non-JSON body when it is short enough to be a real message.
export function describeApiError({ payload, body, statusText } = {}) {
  if (payload && typeof payload === "object") {
    if (payload.validation_code) {
      const base = humanizeErrorToken(payload.validation_code);
      return payload.field ? `${base} (${payload.field})` : base;
    }
    const code = payload.kind || payload.error;
    if (code) {
      const base = humanizeErrorToken(code);
      return payload.field ? `${base} (${payload.field})` : base;
    }
  }
  const trimmed = (body || "").trim();
  if (
    trimmed &&
    trimmed.length <= 200 &&
    !trimmed.startsWith("{") &&
    !trimmed.startsWith("[")
  ) {
    return trimmed;
  }
  return statusText || "Request failed";
}

export async function apiFetch(path, options = {}) {
  const token = readStoredToken();
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  // Web: gatewayUrl(path) === path, gatewayFetch === fetch,
  // gatewayOrigin() === "" so credentials stay "same-origin" — identical to
  // the hosted client. Desktop: routes to the gateway origin with "omit".
  const response = await gatewayFetch(gatewayUrl(path), {
    credentials: gatewayOrigin() ? "omit" : "same-origin",
    ...options,
    headers,
  });

  if (!response.ok) {
    const { text, payload } = await parseErrorBody(response);
    throw new ApiError(
      describeApiError({ payload, body: text, statusText: response.statusText }),
      {
        status: response.status,
        statusText: response.statusText,
        body: text,
        headers: response.headers,
        payload,
      },
    );
  }

  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json")
    ? response.json()
    : response.text();
}

// --- Threads ---

export function fetchSession() {
  return apiFetch(`${V2_BASE}/session`);
}

export function createThread({ clientActionId: clientId, requestedThreadId } = {}) {
  const body = { client_action_id: clientId || clientActionId() };
  if (requestedThreadId) body.requested_thread_id = requestedThreadId;
  return apiFetch(`${V2_BASE}/threads`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function listThreads({ limit, cursor } = {}) {
  const url = new URL(`${V2_BASE}/threads`, window.location.origin);
  if (limit != null) url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);
  return apiFetch(url.pathname + url.search);
}

export function deleteThread({ threadId } = {}) {
  if (!threadId) {
    return Promise.reject(new Error("threadId is required"));
  }
  return apiFetch(`${V2_BASE}/threads/${encodeURIComponent(threadId)}`, {
    method: "DELETE",
  });
}

// --- Project filesystem (download / navigation) ---
//
// Desktop-only surface: the desktop frontend lists and downloads files from a
// thread's project workspace. The routes are served by the desktop sidecar.
// These build same-origin paths and go through `apiFetch` / the shared gateway
// transport, so on web they behave like any other v2 call (no special-casing).

function projectFilesBase(threadId) {
  return `${V2_BASE}/threads/${encodeURIComponent(threadId)}/files`;
}

// List a directory under the thread's project workspace. `path` defaults to the
// workspace root server-side when omitted.
export function listProjectFiles({ threadId, path } = {}) {
  if (!threadId) return Promise.reject(new Error("threadId is required"));
  const url = new URL(projectFilesBase(threadId), window.location.origin);
  if (path) url.searchParams.set("path", path);
  return apiFetch(url.pathname + url.search);
}

// Metadata for a single project path (used to show a chip's size/icon).
export function statProjectFile({ threadId, path } = {}) {
  if (!threadId || !path) {
    return Promise.reject(new Error("threadId and path are required"));
  }
  const url = new URL(`${projectFilesBase(threadId)}/stat`, window.location.origin);
  url.searchParams.set("path", path);
  return apiFetch(url.pathname + url.search);
}

// Same-origin relative URL for a project file's bytes. Feeds the shared
// `fetchAttachmentBlob` (which attaches the bearer) so project-file chips can
// reuse the message-attachment preview modal: it carries the same byte-fetch
// shape as `attachmentUrl(...)`.
export function projectFileContentUrl({ threadId, path } = {}) {
  if (!threadId || !path) {
    throw new Error("projectFileContentUrl requires threadId and path");
  }
  const url = new URL(`${projectFilesBase(threadId)}/content`, window.location.origin);
  url.searchParams.set("path", path);
  return url.pathname + url.search;
}

// Fetch a project file's bytes as a Blob directly. Used on desktop where
// the content route is behind the sidecar origin and `fetchAttachmentBlob`'s
// cross-origin guard must be bypassed via the gateway transport.
export async function fetchProjectFileBlob({ threadId, path } = {}) {
  if (!threadId || !path) {
    throw new Error("threadId and path are required");
  }
  const token = readStoredToken();
  const headers = new Headers();
  headers.set("Accept", "application/octet-stream");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const url = new URL(`${projectFilesBase(threadId)}/content`, window.location.origin);
  url.searchParams.set("path", path);
  const response = await gatewayFetch(gatewayUrl(url.pathname + url.search), {
    credentials: gatewayOrigin() ? "omit" : "same-origin",
    headers,
  });
  if (!response.ok) {
    const { text, payload } = await parseErrorBody(response);
    throw new ApiError(
      describeApiError({ payload, body: text, statusText: response.statusText }),
      {
        status: response.status,
        statusText: response.statusText,
        body: text,
        headers: response.headers,
        payload,
      },
    );
  }
  return response.blob();
}

// --- Automations ---

export function listAutomations({ limit, runLimit } = {}) {
  const params = new URLSearchParams();
  if (limit != null) params.set("limit", String(limit));
  if (runLimit != null) params.set("run_limit", String(runLimit));
  const query = params.toString();
  return apiFetch(`${V2_BASE}/automations${query ? `?${query}` : ""}`);
}

// --- Outbound delivery preferences ---

export function getOutboundPreferences() {
  return apiFetch(`${V2_BASE}/outbound/preferences`);
}

export function listOutboundDeliveryTargets() {
  return apiFetch(`${V2_BASE}/outbound/targets`);
}

export function setOutboundPreferences({ finalReplyTargetId } = {}) {
  return apiFetch(`${V2_BASE}/outbound/preferences`, {
    method: "POST",
    body: JSON.stringify({
      final_reply_target_id: finalReplyTargetId ?? null,
    }),
  });
}

// --- Operator logs ---

export function queryOperatorLogs({
  limit,
  cursor,
  level,
  target,
  threadId,
  runId,
  turnId,
  toolCallId,
  toolName,
  source,
} = {}) {
  const url = new URL(`${V2_BASE}/operator/logs`, window.location.origin);
  if (limit != null) url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);
  if (level) url.searchParams.set("level", level);
  if (target) url.searchParams.set("target", target);
  if (threadId) url.searchParams.set("thread_id", threadId);
  if (runId) url.searchParams.set("run_id", runId);
  if (turnId) url.searchParams.set("turn_id", turnId);
  if (toolCallId) url.searchParams.set("tool_call_id", toolCallId);
  if (toolName) url.searchParams.set("tool_name", toolName);
  if (source) url.searchParams.set("source", source);
  return apiFetch(url.pathname + url.search);
}

// --- Messages ---

// `attachments` is an array of `WebUiInboundAttachment`
// (`{ mime_type, filename, data_base64 }`). Omitted from the body when
// empty so a text-only send keeps the original wire shape.
export function sendMessage({
  threadId,
  content,
  attachments = [],
  clientActionId: clientId,
}) {
  const body = {
    client_action_id: clientId || clientActionId(),
    content,
  };
  if (attachments.length > 0) {
    body.attachments = attachments;
  }
  return apiFetch(
    `${V2_BASE}/threads/${encodeURIComponent(threadId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

// Desktop-only helper: the desktop composer collects attachments in a looser
// shape (`name`/`base64`/`data_base64`) and uses this to coerce them into the
// `WebUiInboundAttachment` wire shape with sanitized header values. The web
// composer already builds the wire shape and passes it straight to
// `sendMessage`, so this is unused on web but exported for the desktop frontend.
export function normalizeAttachmentPayloads(attachments) {
  return (attachments || [])
    .map((attachment) => ({
      filename: String(attachment?.filename || attachment?.name || "attachment").replace(
        /\r?\n/g,
        " ",
      ),
      mime_type: String(attachment?.mime_type || "application/octet-stream").replace(/\r?\n/g, " "),
      base64: String(attachment?.base64 || attachment?.data_base64 || "").replace(/\s+/g, ""),
    }))
    .filter((attachment) => attachment.base64 && attachment.filename);
}

// --- Timeline ---

export function fetchTimeline({ threadId, limit, cursor, signal } = {}) {
  const url = new URL(
    `${V2_BASE}/threads/${encodeURIComponent(threadId)}/timeline`,
    window.location.origin,
  );
  if (limit != null) url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);
  return apiFetch(url.pathname + url.search, { signal });
}

// --- Attachments ---

// Path for one landed attachment's bytes. The (thread, message, attachment)
// triple addresses it: an attachment id is only unique within its message.
// Fails fast on a missing part rather than building a path with the literal
// "undefined" — this URL feeds `fetchAttachmentBlob`, which attaches the bearer,
// so an unintended path must never be requested.
export function attachmentUrl({ threadId, messageId, attachmentId } = {}) {
  if (!threadId || !messageId || !attachmentId) {
    throw new Error("attachmentUrl requires threadId, messageId, and attachmentId");
  }
  return (
    `${V2_BASE}/threads/${encodeURIComponent(threadId)}` +
    `/messages/${encodeURIComponent(messageId)}` +
    `/attachments/${encodeURIComponent(attachmentId)}`
  );
}

// Fetch an attachment's bytes with the session bearer and return them as a
// `Blob`. `<img>`/`<audio>`/`<iframe>` cannot send an Authorization header, so
// (unlike SSE, which uses a `?token=` shim) the bytes are fetched here and the
// caller picks the CSP-appropriate representation (data URL for images/media,
// blob URL for PDF frames, text for text). Throws on a non-OK response so the
// caller can fall back to a placeholder.
export async function fetchAttachmentBlob(path) {
  // The bearer is a critical sink: never attach it to an off-origin URL. The
  // caller always passes a relative same-origin path (`attachmentUrl(...)`);
  // reject anything that resolves cross-origin before sending the token.
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) {
    throw new ApiError("Invalid attachment URL.", {
      status: 400,
      statusText: "Bad Request",
    });
  }
  const token = readStoredToken();
  const headers = new Headers();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  // Routes through the shared gateway transport so desktop reaches the sidecar
  // origin; on web `gatewayUrl` is a pass-through and `gatewayFetch` is `fetch`
  // with `credentials: "same-origin"`. The off-origin guard above runs against
  // the WebView/window origin and is unaffected by the transport rewrite.
  const requestPath = url.pathname + url.search;
  const response = await gatewayFetch(gatewayUrl(requestPath), {
    credentials: gatewayOrigin() ? "omit" : "same-origin",
    headers,
  });
  if (!response.ok) {
    const { text, payload } = await parseErrorBody(response);
    throw new ApiError(
      describeApiError({ payload, body: text, statusText: response.statusText }),
      { status: response.status, statusText: response.statusText, body: text, payload },
    );
  }
  return await response.blob();
}

// Read a `Blob` into a `data:` URL. Used for images and media, whose CSP
// directives (`img-src`/`media-src 'self' data:`) allow data URLs but not
// `blob:` — and a data URL needs no `revokeObjectURL` lifecycle.
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("attachment read failed"));
    reader.readAsDataURL(blob);
  });
}

// Convenience: fetch an attachment's bytes and return a `data:` URL for an
// `<img>` thumbnail. CSP-safe (`img-src 'self' data:`); never a `blob:` URL.
export async function fetchAttachmentDataUrl(path) {
  return blobToDataUrl(await fetchAttachmentBlob(path));
}

// --- Streaming (SSE) ---

// `EventSource` cannot set request headers, so the token rides as a
// query param. The composition middleware accepts `?token=` for this
// route specifically (in-scope "SSE query-token exception" from #3886).
//
// Web: `gatewayOrigin()` is "" so the URL is built against
// `window.location.origin` and a native `EventSource` is returned — the
// hosted behavior. Desktop: the URL targets the gateway origin and a
// `FetchEventStream` is used because the Tauri WebView's `EventSource` cannot
// reach the cross-origin sidecar (and cannot carry the bearer header).
export function openEventStream({ threadId, afterCursor } = {}) {
  const url = new URL(
    `${V2_BASE}/threads/${encodeURIComponent(threadId)}/events`,
    gatewayOrigin() || window.location.origin,
  );
  const token = readStoredToken();
  if (token) url.searchParams.set("token", token);
  if (afterCursor) url.searchParams.set("after_cursor", afterCursor);
  if (gatewayOrigin()) {
    return new FetchEventStream(url, token);
  }
  return new EventSource(url.toString());
}

// --- Streaming (WebSocket) ---

// Same-origin enforcement happens at the composition layer. The
// browser sends Origin automatically; the bearer travels via the
// `?token=` URL parameter (the WS handshake API in browsers has no
// way to set a custom request header).
//
// Web: base === `window.location.origin`, identical to the hosted client.
// Desktop: base === the gateway origin so the socket reaches the sidecar.
export function openEventSocket({ threadId } = {}) {
  const base = gatewayOrigin() || window.location.origin;
  const scheme = base.startsWith("https:") ? "wss:" : "ws:";
  const url = new URL(
    `${V2_BASE}/threads/${encodeURIComponent(threadId)}/ws`,
    base,
  );
  url.protocol = scheme;
  const token = readStoredToken();
  if (token) url.searchParams.set("token", token);
  return new WebSocket(url.toString());
}

// --- Run cancellation ---

export function cancelRun({
  threadId,
  runId,
  reason,
  clientActionId: clientId,
} = {}) {
  const body = { client_action_id: clientId || clientActionId() };
  if (reason) body.reason = reason;
  return apiFetch(
    `${V2_BASE}/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

// (No bare GET /threads/{id}/runs/{id}: the gateway registers only
// .../runs/{id}/cancel and .../gates/{ref}/resolve. Run completion is read from
// the registered timeline route — see runReplyLandedInTimeline + useChat's
// SSE-drop fallback — never a 404-guaranteed run-state GET.)

// --- Gate resolution ---

// `resolution` is one of "approved" | "denied" | "credential_provided" | "cancelled".
// `always` is only meaningful when `resolution === "approved"`.
// `credentialRef` is only meaningful when `resolution === "credential_provided"`.
export function resolveGate({
  threadId,
  runId,
  gateRef,
  resolution,
  always,
  credentialRef,
  clientActionId: clientId,
  signal,
} = {}) {
  const body = {
    client_action_id: clientId || clientActionId(),
    resolution,
  };
  if (always != null) body.always = always;
  if (credentialRef) body.credential_ref = credentialRef;
  return apiFetch(
    `${V2_BASE}/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gateRef)}/resolve`,
    {
      method: "POST",
      signal,
      body: JSON.stringify(body),
    },
  );
}

// --- Product auth ---

export function submitManualToken({
  provider,
  accountLabel,
  token,
  threadId,
  runId,
  gateRef,
  signal,
} = {}) {
  return apiFetch("/api/reborn/product-auth/manual-token/submit", {
    method: "POST",
    signal,
    body: JSON.stringify({
      provider,
      account_label: accountLabel,
      token,
      thread_id: threadId,
      run_id: runId,
      gate_ref: gateRef,
    }),
  });
}

// --- Extension setup ---

export function setupExtension(extensionName, { action, payload } = {}) {
  const body = {};
  if (action) body.action = action;
  if (payload !== undefined) body.payload = payload;
  return apiFetch(
    `${V2_BASE}/extensions/${encodeURIComponent(extensionName)}/setup`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

// --- Gateway status ---
//
// Issue #3886 Hard Non-Goal: the browser must not call legacy gateway routes
// without a v2 counterpart. On WEB this stays a pure no-op stub — it sends no
// HTTP request and returns a zeroed shape so any consumer reading
// `data.engine_v2_enabled`, `data.llm_backend`, etc. resolves cleanly to
// falsey values (byte-for-byte the hosted behavior). When a v2 equivalent
// lands, replace the web stub body with the real wire call.
//
// On DESKTOP the route exists on the local sidecar, so the desktop build
// queries the real `/api/gateway/status` via `apiFetch` and, when that route
// is absent (404), derives readiness from local settings + vaulted credentials
// instead of failing the page. Any other HTTP error propagates so callers can
// surface it.

export async function gatewayStatus() {
  if (!isDesktopRuntime()) {
    // TODO: requires v2 gateway-status endpoint. Returning a zeroed
    // shape so any consumer reading `data.engine_v2_enabled`,
    // `data.llm_backend`, etc. resolves cleanly to falsey values.
    return Promise.resolve({
      engine_v2_enabled: false,
      restart_enabled: false,
      total_connections: null,
      llm_backend: null,
      llm_model: null,
      todo: true,
    });
  }

  try {
    return await apiFetch("/api/gateway/status");
  } catch (err) {
    if (err?.status && err.status !== 404) {
      throw err;
    }
  }

  return desktopGatewayStatusFallback();
}

async function desktopGatewayStatusFallback() {
  const fallback = {
    engine_v2_enabled: true,
    restart_enabled: inTauri(),
    total_connections: null,
    llm_backend: null,
    llm_model: null,
    todo: true,
  };
  if (!inTauri()) return fallback;

  let settings = null;
  try {
    settings = await tauriInvoke("get_settings");
  } catch (_) {
    settings = null;
  }

  const { activeId, profile } = activeProfileFromSettings(settings);
  const providerId = String(profile?.llmProviderId || profile?.llmBackend || "nearai").trim();
  const modelId = String(profile?.llmModelId || (providerId === "nearai" ? "auto" : "")).trim();
  fallback.llm_backend = providerId || "nearai";
  fallback.llm_model = modelId || "auto";
  fallback.model_execution_verified = false;
  fallback.model_readiness = "unverified";
  fallback.model_readiness_reason =
    "Gateway status route is unavailable; desktop inferred provider/model from local settings.";

  // NEAR.AI is IronClaw's built-in cloud path. A missing vaulted NEAR token
  // must not block first-run send; the first WebChat run is the verification
  // surface and can surface any provider-side auth failure in the thread.
  const credentialProviderIds = new Set(["openai", "anthropic"]);
  if (!credentialProviderIds.has(fallback.llm_backend)) return fallback;

  let hasCredential = false;
  try {
    hasCredential = Boolean(
      await tauriInvoke("has_llm_provider_credential", {
        profileId: activeId,
        providerId: fallback.llm_backend,
      }),
    );
  } catch (_) {
    hasCredential = false;
  }

  if (!hasCredential) {
    const displayName = providerDisplayLabel(fallback.llm_backend);
    const reason = `${displayName} is selected, but no credential is available in this desktop install. Sign in or add an API key in Settings before sending.`;
    fallback.model_readiness = "blocked";
    fallback.model_execution_readiness = "blocked";
    fallback.model_execution_failure_category = "model_credentials_unavailable";
    fallback.model_execution_failure_summary = reason;
    fallback.model_readiness_reason = reason;
  }

  return fallback;
}

function providerDisplayLabel(providerId) {
  const raw = String(providerId || "nearai").trim();
  const normalized = raw.toLowerCase().replace(/[\s]+/g, "").replace(/[_-]+/g, "_");
  if (normalized === "nearai") return "NEAR AI Cloud";
  return "A non-NEAR model provider";
}

// --- v2 auth surface ---
//
// The host mounts `webui_v2_auth_router` from
// `ironclaw_reborn_webui_ingress` at the same origin as the SPA. The
// providers endpoint is public; the login + callback routes are
// reached via `<a href>` navigations from the login page (the SPA
// does not invoke them via fetch). The callback redirects back with
// a short-lived `login_ticket`; the SPA exchanges it over same-origin
// JSON for the real bearer. Logout sends the current bearer so the
// server-side session can be revoked.
//
// Each call routes through the shared gateway transport. On web that is the
// global `fetch` against the same origin with `credentials: "same-origin"` —
// identical to the hosted client.

export async function fetchAuthProviders() {
  // Unauthenticated GET — the server returns `{ providers: [] }`
  // when nothing is configured. Network failures collapse to an
  // empty list so a broken backend hides OAuth buttons rather than
  // surfacing a stack trace on the login page.
  try {
    const response = await gatewayFetch(gatewayUrl("/auth/providers"), {
      headers: { Accept: "application/json" },
      credentials: gatewayOrigin() ? "omit" : "same-origin",
    });
    if (!response.ok) return { providers: [] };
    const data = await response.json();
    return {
      providers: Array.isArray(data?.providers) ? data.providers : [],
    };
  } catch (_) {
    // silent-ok: login UI fail-safe — a broken /auth/providers hides
    // OAuth buttons rather than breaking the login page, which still
    // accepts manual token paste.
    return { providers: [] };
  }
}

export async function exchangeLoginTicket(ticket) {
  const response = await gatewayFetch(gatewayUrl("/auth/session/exchange"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    credentials: gatewayOrigin() ? "omit" : "same-origin",
    body: JSON.stringify({ ticket }),
  });
  if (!response.ok) {
    throw new ApiError("Could not complete sign-in.", {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const data = await response.json();
  const token = (data?.token || "").trim();
  if (!token) {
    throw new ApiError("Sign-in response did not include a token.", {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      payload: data,
    });
  }
  return token;
}

export async function logout() {
  const token = readStoredToken();
  if (!token) return;
  const headers = new Headers({ Accept: "application/json" });
  headers.set("Authorization", `Bearer ${token}`);
  try {
    await gatewayFetch(gatewayUrl("/auth/logout"), {
      method: "POST",
      headers,
      credentials: gatewayOrigin() ? "omit" : "same-origin",
    });
  } catch (_) {
    // Network failure should not block the SPA's local sign-out —
    // the caller still clears sessionStorage. Server-side cleanup
    // will eventually expire the session.
  }
}

// --- Desktop SSE transport ---
//
// Desktop-only. A WebView `EventSource` cannot reach the cross-origin sidecar
// and cannot carry a bearer header, so the desktop SSE path uses a
// fetch-backed reader (through `gatewayFetch`, which goes via the Tauri HTTP
// shim). `openEventStream` instantiates this only when `gatewayOrigin()` is
// set, so it is never constructed on web. Mirrors enough of the `EventSource`
// surface (`addEventListener`, `removeEventListener`, `onopen`/`onerror`/
// `onmessage`, `close`) for `useSSE` to consume it interchangeably.
export class FetchEventStream {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.controller = new AbortController();
    this.listeners = new Map();
    this.closed = false;
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
    queueMicrotask(() => this.start());
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
    this.controller.abort();
  }

  dispatch(type, event) {
    if (type === "message") this.onmessage?.(event);
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }

  dispatchError(error) {
    if (!this.closed) this.onerror?.(error);
  }

  async start() {
    try {
      const headers = { Accept: "text/event-stream" };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const response = await gatewayFetch(this.url.toString(), {
        method: "GET",
        headers,
        signal: this.controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new ApiError(`Event stream failed: ${response.status}`, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      this.onopen?.();
      await this.read(response.body);
      // A clean server-side stream end (reader `done`) is NOT a normal terminal
      // state for a long-lived SSE channel. Native EventSource treats a closed
      // connection as a disconnect and reconnects; without mirroring that, the
      // channel goes silently dead behind a "connected" badge. Dispatch an error
      // so useSSE's reconnect path fires. dispatchError is a no-op once closed
      // (user navigated away / close() called), so an intentional teardown stays
      // quiet.
      this.dispatchError(new ApiError("Event stream closed by server", { status: 0 }));
    } catch (err) {
      if (err?.name !== "AbortError") this.dispatchError(err);
    }
  }

  async read(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!this.closed) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let splitAt;
      while ((splitAt = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        this.dispatchSseChunk(chunk);
      }
    }
    if (buffer.trim()) this.dispatchSseChunk(buffer);
  }

  dispatchSseChunk(chunk) {
    let type = "message";
    let data = "";
    let lastEventId = "";
    for (const line of chunk.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const index = line.indexOf(":");
      const field = index >= 0 ? line.slice(0, index) : line;
      const rawValue = index >= 0 ? line.slice(index + 1) : "";
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") type = value || "message";
      if (field === "data") data += `${data ? "\n" : ""}${value}`;
      if (field === "id") lastEventId = value;
    }
    if (!data) return;
    this.dispatch(type, { type, data, lastEventId });
  }
}
