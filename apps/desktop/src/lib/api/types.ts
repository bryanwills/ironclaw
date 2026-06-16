// Type definitions for the IronClaw HTTP API.
//
// These shapes are aligned to the IronClaw gateway responses documented in
// `/tmp/ironclaw-api.md`. Where the wire format differs from the prompt's
// initial sketch, we follow the wire — the client maps wire fields onto
// these convenience shapes for the UI.

/**
 * Normalized chat event union consumed by the UI.
 *
 * Two producers feed this union:
 *
 *  - Legacy `/api/chat/events` SSE channel (default `message`, named
 *    `response`/`tool_start`/`tool_result`/`error`). Wire shapes per
 *    `/tmp/ironclaw-api.md`:
 *      event: response       → {type:"text_response", thread_id, message_id, content}
 *      event: tool_start     → {type:"tool_start", tool, args}
 *      event: tool_result    → {type:"tool_result", tool, result}
 *      event: error          → {type:"error", message}
 *    The legacy stream sends the FULL assistant content per `text_response`
 *    so each event clobbers the buffer — the messages-store heuristic
 *    handles both wire shapes (see `appendStreamingChunk`).
 *
 *  - Responses-API `/api/v1/responses` SSE (verified 2026-05-27 against the
 *    live gateway). Event taxonomy:
 *      event: response.created          → message_start
 *      event: response.output_item.added (item.type='message')   → message_start (assistant)
 *      event: response.output_item.added (item.type='function_call') → tool_call
 *      event: response.output_text.delta (delta: "...")          → content_delta (true delta)
 *      event: response.output_item.done (item.type='function_call') → tool_result (best-effort)
 *      event: response.completed        → message_end
 *      event: response.failed / error   → error
 *    These deltas are real incremental chunks, NOT cumulative — concat them.
 *
 * `tool_call_delta` is a placeholder for future streaming of function-call
 * arguments. The current gateway emits arguments only in the final
 * `output_item.done` envelope; the streaming-arguments shape (`function_call.delta`
 * with a `arguments_delta` chunk) is reserved here for forward compat without
 * forcing a union-shape refactor when it lands.
 */
export type ChatEvent =
  | { type: 'message_start'; thread_id: string; message_id: string }
  | { type: 'content_delta'; thread_id?: string; message_id?: string; delta: string }
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'tool_call_delta'; name?: string; arguments_delta: string }
  | { type: 'tool_result'; name: string; result: unknown }
  | {
      type: 'approval_needed';
      request_id: string;
      thread_id?: string;
      tool_name: string;
      description: string;
      parameters: unknown;
      allow_always: boolean;
    }
  | { type: 'message_end'; thread_id?: string; message_id?: string; finish_reason: string }
  | { type: 'error'; message: string };

export interface Thread {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  /**
   * Number of "messages" in the thread for UI display purposes. The gateway's
   * canonical wire field is `turn_count` (one turn = one user message + one
   * assistant response rolled into a single row); we surface it as
   * `message_count` because that's what the UI reads, and conceptually each
   * turn maps onto one "message" the user sent. If a future server flips the
   * field name to `message_count` directly, the client picks up either.
   */
  message_count: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at: string;
}

export type WidgetKind = 'chart' | 'table' | 'text' | 'mermaid' | 'comparison';

export interface Widget {
  id: string;
  kind: WidgetKind;
  title: string;
  source: {
    thread_id?: string;
    message_id?: string;
    query?: string;
  };
  payload: unknown;
  pinned_to: ('dashboard' | 'canvas' | string)[];
  created_at: string;
  updated_at: string;
}

export interface PromotableBlock {
  kind: WidgetKind;
  title?: string;
  payload: unknown;
  source: {
    thread_id?: string;
    message_id?: string;
    query?: string;
  };
}

/**
 * One attachment in a `POST /api/chat/send` payload.
 *
 * Wire shape (probed 2026-05-27 against IronClaw 0.28.2):
 *   `attachments: [{ name, mime_type, data_base64 }]`
 *
 * `data_base64` is the RAW base64 payload — NO `data:<mime>;base64,` prefix.
 * `mime_type` is required (server 400s with `missing field 'mime_type'`
 * when omitted).
 *
 * The desktop composer accepts images plus document/text formats and sends
 * them through the gateway's attachment block. Images also render as previews;
 * document/text attachments render as file chips and are scanned locally for
 * obvious approval-risk language before dispatch.
 */
export interface AttachmentInput {
  /** Filename as the user dropped/pasted it. Echoed back inside the
   *  `<attachments>` block the gateway prepends to the user turn. */
  name: string;
  /** RFC 2046 MIME type, e.g. `image/png`. Required by the wire. */
  mime_type: string;
  /** RAW base64-encoded bytes (NO `data:` prefix). */
  data_base64: string;
}

export interface ImageGenerationResult {
  images: Array<{
    url?: string;
    base64?: string;
    mime: string;
  }>;
  model_used: string;
  cost_tokens?: number;
}

export interface ImageGenerationOptions {
  size?: '256x256' | '512x512' | '1024x1024';
  n?: number;
  model?: string;
}

export interface MemoryHit {
  path: string;
  snippet: string;
  score: number;
}

export interface MemoryNode {
  path: string;
  type: 'file' | 'dir';
  size?: number;
  /** ISO-8601 timestamp of the last write, when the server reports it.
   *  `/api/memory/list` and `/api/memory/tree` may emit `updated_at` per
   *  entry; `null` from the wire is normalized to `undefined` so callers
   *  can use a simple `node.updated_at ?? '—'` ternary. */
  updated_at?: string;
}

export type SkillTrust = 'Bundled' | 'Verified' | 'Unverified' | string;

export interface Skill {
  name: string;
  description: string;
  version: string;
  installed: boolean;
  /** Provenance/trust level from the server. Server may emit any string; UI
   *  styles only the three documented cases and falls through for others. */
  trust?: SkillTrust;
  /** Raw debug-formatted source descriptor, e.g. `Bundled("code-review")` or
   *  `Git(url)`. Preserved verbatim from the gateway — do not parse. */
  source?: string;
  /** Absolute filesystem path of the skill bundle on the server. */
  bundle_path?: string;
  /** True if the skill declares external dependencies (e.g. requirements.txt). */
  has_requirements?: boolean;
  /** True if the skill ships executable scripts/. */
  has_scripts?: boolean;
  /** Human-friendly invocation hint (e.g. `/code-review`). Prefer over the
   *  client-derived `/${name}` heuristic. */
  usage_hint?: string;
}

export interface Routine {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  last_run?: string;
  next_run?: string;
}

/**
 * Request body for creating a routine via `POST /api/routines`.
 *
 * NOTE (2026-05-27): The gateway does not yet expose this endpoint —
 * `POST /api/routines` returns 405 Method Not Allowed against IronClaw
 * v0.29.x (verified by direct probe of the live server). The type and
 * the matching client method `IronClawClient.createRoutine` are
 * pre-wired so the UI surface can be added in a follow-up PR once the
 * server lands the handler. Until then, the client throws synchronously
 * and no UI exposes this call.
 */
export interface CreateRoutineRequest {
  /** Human-readable name; 1-128 chars after trim. */
  name: string;
  /** Cron string (e.g. `0 9 * * *`) or human form (e.g. `every 5m`,
   *  `daily 09:00`). The gateway is the source of truth for which
   *  forms it parses. */
  schedule: string;
  /** Agent instruction to execute on schedule. */
  prompt: string;
  /** Default true on the server side; clients can omit. */
  enabled?: boolean;
}

export interface RoutineSummary {
  total: number;
  enabled: number;
  running: number;
  failed_last_24h: number;
}

export interface RoutineRun {
  id: string;
  routine_id: string;
  started_at: string;
  finished_at?: string;
  status: 'running' | 'success' | 'failed';
  output?: string;
}

// ---- Jobs ------------------------------------------------------------------
//
// Job APIs are documented in `src/channels/web/features/jobs/mod.rs` on the
// IronClaw gateway. The wire types come from `JobListResponse`,
// `JobSummaryResponse`, `JobDetailResponse`, and the project file helpers.
//
// The gateway tracks TWO classes of jobs in one table:
//   - "sandbox" jobs: per-task containerized workers (Claude Code / ACP / worker
//     modes). These carry a `project_dir` and produce files.
//   - "agent" jobs: long-running agent contexts driven by the scheduler. No
//     project dir; transitions are recorded explicitly.
// Both kinds round-trip through the same /api/jobs endpoints and surface here
// as `Job` with `job_kind` identifying which side.
//
// State strings (wire): `pending` | `in_progress` | `completed` | `failed` |
//   `cancelled` | `stuck`. The summary endpoint also reports `stuck`.

/** Lifecycle state used by the UI. Server emits these verbatim from the
 *  `JobInfo.state` and `JobDetailResponse.state` fields; we keep them as
 *  literals on the union but tolerate unknown strings via the trailing
 *  `string` so a future server-side state doesn't blow up rendering. */
export type JobState =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stuck'
  | string;

/** Row shape returned by GET /api/jobs (one entry per job). The gateway emits
 *  a thin list: id, title, state, user_id, created_at, started_at. The detail
 *  endpoint enriches with completed_at, transitions, etc — see `JobDetail`. */
export interface Job {
  /** UUID v4. Mono-truncated in lists. */
  id: string;
  /** Free-text title; for sandbox jobs this is the `task` field, for agent
   *  jobs it's the user-supplied `title`. Used as the row label since the
   *  server does not emit a separate `kind` field. */
  title: string;
  state: JobState;
  /** Owner id. `"default"` for the single-tenant local owner. */
  user_id: string;
  /** RFC3339 / ISO8601 from server. */
  created_at: string;
  started_at?: string;
}

/** Summary tile counts. Wire: `{total, pending, in_progress, completed, failed, stuck}`.
 *  Note the wire field is `in_progress` (not `running`); we keep both names
 *  available so callers can read whichever fits their UI vocabulary. */
export interface JobSummary {
  total: number;
  /** Server's `pending` bucket. */
  pending: number;
  /** Server's `in_progress` bucket. Surfaced verbatim. */
  in_progress: number;
  /** Alias for `in_progress` — the UI's tile is labeled "Running" so we
   *  expose this convenience field too. Mirrors `in_progress` 1:1. */
  running: number;
  completed: number;
  failed: number;
  /** Agent jobs whose worker has stopped without a terminal transition.
   *  May stay zero on sandbox-only builds. */
  stuck: number;
}

/** Enriched per-job payload returned by GET /api/jobs/{id}. Adds completion,
 *  transitions, and capability flags (`can_restart`, `can_prompt`). */
export interface JobDetail extends Job {
  description: string;
  completed_at?: string;
  elapsed_secs?: number;
  /** Filesystem path for sandbox jobs (server-side). Undefined for agent jobs. */
  project_dir?: string;
  browse_url?: string;
  /** Job mode descriptor: `claude_code`, `acp:<agent>`, `worker`, or omitted
   *  for agent jobs. Verbatim from server. */
  job_mode?: string;
  transitions: JobTransition[];
  /** Server indicates whether the UI may offer a Restart button. */
  can_restart: boolean;
  /** Server indicates whether the UI may offer follow-up prompts (not used in
   *  v1 of the desktop client, but surfaced so the panel can stay current). */
  can_prompt: boolean;
  /** `"sandbox"` or `"agent"`. Undefined on very old gateways. */
  job_kind?: 'sandbox' | 'agent' | string;
}

/** Single state transition row inside the detail panel timeline. */
export interface JobTransition {
  from: string;
  to: string;
  /** RFC3339 timestamp. */
  timestamp: string;
  /** Failure / cancellation reason; absent on healthy transitions. */
  reason?: string;
}

/** Single event row returned by GET /api/jobs/{id}/events.
 *  Wire shape: `{id, event_type, data, created_at}`. The `data` payload is
 *  opaque JSON — different `event_type` values carry different shapes
 *  (e.g. `tool_call`, `output_text`, `status_change`). The UI renders
 *  `event_type` + a JSON-stringified `data` preview; consumers that want
 *  rich rendering should pattern-match on `event_type` themselves.
 *
 *  Note: the brief described this endpoint as an SSE stream but the live
 *  gateway exposes it as a plain JSON `GET` returning the historical event
 *  list. `streamJobEvents` polls this endpoint at a fixed cadence to give
 *  callers an `AsyncIterable` interface for live updates without forcing a
 *  refactor when the server eventually adds a real SSE channel. */
export interface JobEvent {
  /** Server-assigned event id (UUID). */
  id?: string;
  /** Coarse classifier (e.g. `tool_call`, `output_text`, `status_change`). */
  event_type: string;
  /** Opaque JSON payload. Render as a code snippet. */
  data?: unknown;
  /** RFC3339 timestamp. */
  created_at: string;
}

/** File entry inside a sandbox job's project directory.
 *  Wire shape: `ProjectFileEntry { name, path, is_dir }`.
 *  Size is NOT reported by the current gateway — we keep the field optional
 *  so the UI can surface it once the server starts emitting it. */
export interface JobFile {
  /** Last path segment (filename or directory name). */
  name: string;
  /** Path relative to the job's project root. */
  path: string;
  is_dir: boolean;
  /** Optional metadata — server doesn't emit these today but we keep the
   *  fields available so a richer files endpoint can land without a type
   *  break. */
  size?: number;
  created_at?: string;
}

/**
 * Log level emitted by the gateway's `tracing` filter. Matches the values
 * accepted by GET/POST /api/logs/level on IronClaw v0.29.0+.
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/**
 * A single log entry yielded by GET /api/logs/events (SSE).
 *
 * The gateway buffers a recent window of entries and replays them on
 * connect, then streams live. `timestamp` is RFC3339 / ISO8601 from the
 * server clock.
 */
export interface LogEntry {
  level: LogLevel;
  /** Module / crate path, e.g. "ironclaw_gateway::chat". */
  target: string;
  message: string;
  /** RFC3339 / ISO8601 timestamp from the server. */
  timestamp: string;
}

/** Convenience response shape returned by IronClawClient.health(). */
export interface HealthStatus {
  ok: boolean;
  status?: string;
  channel?: string;
}

/** Convenience response shape returned by IronClawClient.gatewayStatus().
 *
 * Wire fields (verified against IronClaw 0.28.2 on baremetal3, 2026-05-27):
 *   `{version, sse_connections, ws_connections, total_connections,
 *     uptime_secs, restart_enabled, daily_cost, actions_this_hour,
 *     model_usage, llm_backend, llm_model, enabled_channels, engine_v2_enabled}`
 *
 * Note the wire uses `uptime_secs`, not `uptime_seconds`. The client maps
 * either onto `uptime_seconds` so callers see a stable name.
 */
export interface GatewayStatus {
  version?: string;
  engine_v2_enabled?: boolean;
  llm_model?: string;
  /** LLM backend identifier (e.g. "nearai", "openrouter"). Wire: `llm_backend`. */
  llm_backend?: string;
  /** True only when the gateway has proven the configured model can execute. */
  model_execution_verified?: boolean;
  /** Execution readiness summary. GREEN means the chat composer may send. */
  model_execution_readiness?: unknown;
  /** Backward/alternate readiness field emitted by some Reborn builds. */
  model_readiness?: unknown;
  /** Human-readable reason for the current model readiness. */
  model_readiness_reason?: string;
  /** Optional terminal failure category from the latest execution probe. */
  model_execution_failure_category?: string;
  /** Optional terminal failure summary from the latest execution probe. */
  model_execution_failure_summary?: string;
  enabled_channels: string[];
  sse_connections: number;
  ws_connections: number;
  total_connections: number;
  /** Server uptime in seconds. Wire emits `uptime_secs`; client maps either. */
  uptime_seconds?: number;
  multi_tenant_mode?: boolean;
  /** Daily LLM spend in USD, as a string (server formats e.g. "0.0000"). */
  daily_cost?: string;
  /** Count of agent actions in the trailing hour. */
  actions_this_hour?: number;
  /** Whether the gateway can self-restart (true on supervisord-style installs). */
  restart_enabled?: boolean;
  /** Per-model usage breakdown; shape is opaque (server is the source of truth). */
  model_usage?: unknown[];
}

/**
 * Normalized extension descriptor. The wire shape varies between
 * `/api/extensions` (installed list) and `/api/extensions/registry`
 * (catalog) — both are merged into this single struct, with `installed`
 * indicating which side an entry came from.
 *
 * Wire fields the gateway emits today and the mapping we apply:
 *   - name, display_name, description, version — passed through
 *   - kind ("wasm_tool" | "wasm_channel" | "mcp_server" | …) → `category`
 *   - active, authenticated, needs_setup → `ready` (derived from
 *     `/api/extensions/readiness`'s `phase` when available)
 *   - source (registry vs local vs git) — not currently surfaced by the
 *     gateway; we preserve any string the server gives us
 *   - tool_count is joined in from `/api/extensions/tools`
 *
 * Anything the wire omits is filled with a safe default so the UI never
 * crashes on a missing field.
 */
export interface Extension {
  name: string;
  display_name?: string;
  description?: string;
  version?: string;
  installed: boolean;
  active?: boolean;
  /** True when the extension is ready (auth completed, deps installed). */
  ready?: boolean;
  /** Normalized category — UI uses this for the badge tint. */
  category?: 'mcp' | 'oauth' | 'channel' | string;
  /** Origin descriptor (registry, local, git, …). Wire may omit. */
  source?: string;
  requires_setup?: boolean;
  /** Number of tools this extension contributes (from /tools). */
  tool_count?: number;
  /** Human-readable readiness reason ("needs_auth", "needs_setup", …). */
  readiness_message?: string;
  /** Search keywords from the registry, used for client-side filtering. */
  keywords?: string[];
}

export interface ExtensionTool {
  /**
   * Owning extension name. The current gateway's `/api/extensions/tools`
   * endpoint emits `{name, description}` with NO `extension` field on each
   * tool — builtins and aggregated tools have no parent. The client
   * normalizes missing values to empty-string (`''`) so the field is
   * always typed as `string` and consumers can rely on it being a
   * groupable key. Empty-string means "builtin / no provider".
   */
  extension: string;
  name: string;
  description?: string;
}

/**
 * Admin tool-policy action.
 *
 * The UI surfaces a 3-way radio (allow / prompt / deny) per tool. Note that
 * the IronClaw gateway today only stores a binary policy (`disabled_tools`
 * is an allow-list-of-things-to-deny); `prompt` is the natural default for
 * any tool that isn't on the disabled list, and is treated as equivalent to
 * `allow` on serialization. If the gateway ever grows a per-tool
 * "ask-on-use" mode, this union is the place to thread it through.
 */
export type ToolPolicyAction = 'allow' | 'deny' | 'prompt';

/** Map of `<tool_name>` → action. UI-facing shape. */
export type ToolPolicy = Record<string, ToolPolicyAction>;

/** Field descriptor rendered in the setup drawer's form. */
export interface ExtensionSetupField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'oauth' | 'select' | 'boolean' | string;
  required?: boolean;
  placeholder?: string;
  default?: string;
  options?: Array<{ value: string; label: string }>;
  description?: string;
}

/** Schema returned by GET /api/extensions/{name}/setup. */
export interface ExtensionSetupSchema {
  fields: ExtensionSetupField[];
  /** If oauth-based, the URL to redirect the user to in the system browser. */
  oauth_url?: string;
  notes?: string;
}

/**
 * Admin usage summary — `GET /api/admin/usage/summary`.
 *
 * Wire shape verified against IronClaw 0.28.2 (2026-05-27):
 *   {
 *     "users":    { "total": 1, "active": 1, "suspended": 0, "admins": 1 },
 *     "jobs":     { "total": 0 },
 *     "usage_30d":{ "llm_calls": 0, "input_tokens": 0, "output_tokens": 0,
 *                   "total_cost": "0" },
 *     "uptime_seconds": 341446
 *   }
 *
 * The prompt's initial sketch flattened `users` to a number and combined
 * `input_tokens` + `output_tokens` into a single `tokens`. We surface the
 * wire's richer breakdown verbatim and additionally fold `tokens` so
 * callers that want a single number don't have to add the two halves.
 *
 * `total_cost` is a STRING on the wire (the server formats e.g. "0" or
 * "0.0312") — kept as `string` so we don't lose precision on cents.
 */
export interface UsageSummary {
  /** User counts. Wire `users: {total, active, suspended, admins}`. */
  users?: {
    total?: number;
    active?: number;
    suspended?: number;
    admins?: number;
  };
  /** Job counts. Wire `jobs: {total}`. */
  jobs?: { total?: number };
  /** 30-day rolling LLM usage window. Wire `usage_30d`. */
  usage_30d?: {
    llm_calls?: number;
    input_tokens?: number;
    output_tokens?: number;
    /** Sum of `input_tokens + output_tokens` (client-derived convenience). */
    tokens?: number;
    /** Server formats as a string (e.g. "0", "0.0312"). */
    total_cost?: string;
  };
  /** Gateway uptime in seconds. Wire `uptime_seconds`. */
  uptime?: number;
}

/**
 * Single row returned by `GET /api/admin/usage`.
 *
 * Wire shape (`AdminUsageEntry` in the gateway):
 *   { user_id, model, call_count, input_tokens, output_tokens, total_cost }
 *
 * The list endpoint envelope is `{period, since, usage: AdminUsageEntry[]}`
 * — we surface only the rows here; the period/since values are summary
 * metadata callers don't typically display.
 *
 * Each row is a pre-aggregated bucket (one entry per <user, model> pair
 * in the queried period), NOT a per-call event. The prompt's `ts` field
 * does not exist on the wire and is left out so callers don't expect one.
 *
 * `cost` is the client-side numeric coercion of `total_cost` for charting;
 * `total_cost` is preserved verbatim as the source-of-truth string.
 */
export interface UsageEvent {
  user_id?: string;
  model?: string;
  /** Number of LLM calls in this <user, model> bucket. */
  call_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  /** `input_tokens + output_tokens` (client-derived). */
  tokens?: number;
  /** Server-formatted cost string (verbatim from wire). */
  total_cost?: string;
  /** Numeric coercion of `total_cost`, or 0 if unparseable. */
  cost?: number;
}

/**
 * LLM provider catalog entry from `GET /api/llm/providers`.
 *
 * Wire shape (verified 2026-05-27) — each provider returns 16+ fields,
 * most of which the desktop UI doesn't yet render. We surface the ones
 * the prompt asked for plus the wire fields that materially affect
 * configuration (`adapter`, `base_url`, `can_list_models`, `has_credentials`).
 *
 * Wire fields the gateway emits:
 *   - `id`, `name`, `adapter`, `builtin`
 *   - `base_url`, `base_url_required`
 *   - `default_model`, `env_base_url`, `env_model`
 *   - `api_key_required`, `accepts_api_key`, `has_api_key`
 *   - `credential_kind`, `has_credentials`, `can_list_models`
 *
 * The client maps `has_credentials || has_api_key` onto `configured` so
 * the UI can render a "Configured" badge without caring about the auth
 * mode. Description is reserved (not currently emitted by the wire).
 */
export interface LlmProvider {
  /** Stable identifier, e.g. "nearai", "openrouter", "openai". */
  id: string;
  /** Display name for the configure dialog, e.g. "NEAR AI". */
  name: string;
  /** Description (reserved; gateway does not emit this today). */
  description?: string;
  /** True if any auth mode is satisfied — covers API key, session token,
   *  device-code OAuth, Bedrock profile, etc. */
  configured?: boolean;
  /** Default model id for first-run, e.g. "gpt-5-mini". */
  default_model?: string;
  /** Wire adapter discriminator — needed for `test_connection` and
   *  `list_models` request bodies. e.g. "open_ai_completions", "anthropic". */
  adapter?: string;
  /** Default base URL when the registry pins one (Ollama, Groq, etc.).
   *  Empty string for providers that take a host from the user. */
  base_url?: string;
  /** True if the user MUST supply a base URL (openai_compatible only). */
  base_url_required?: boolean;
  /** True when the registry knows how to query a `/models` endpoint. */
  can_list_models?: boolean;
  /** Wire-stable credential discriminator: "api_key", "session_token",
   *  "o_auth_device_code", "file_based_credentials", "aws_credentials",
   *  "ollama", "open_ai_compatible". */
  credential_kind?: string;
  /** True when the provider has an API key vaulted in secrets. */
  has_api_key?: boolean;
  /** Whether the provider is shipped builtin or user-defined. */
  builtin?: boolean;
}

/**
 * LLM model returned by `POST /api/llm/list_models`.
 *
 * The wire's `list_models` endpoint emits a flat string array of model ids
 * (e.g. `["llama3", "mistral"]`) wrapped in `{ok, models, message}`. The
 * gateway does NOT currently emit context windows, pricing, or descriptions
 * — those fields are reserved for forward compat in case the server grows
 * a richer catalog (similar to how Anthropic's `/v1/models` returns
 * `{display_name, max_tokens}` per model).
 *
 * The client maps each bare string onto `{id: <string>, name: <string>}` so
 * the UI can render a consistent list shape regardless of richness.
 */
export interface LlmModel {
  /** Model identifier passed to the API (e.g. "gpt-5-mini"). */
  id: string;
  /** Display name; defaults to `id` when the wire only ships an id. */
  name?: string;
  description?: string;
  /** Reserved — not emitted by today's gateway. */
  context_window?: number;
  /** Reserved — not emitted by today's gateway. */
  pricing?: { input: number; output: number };
}

/**
 * Per-tool permission as exposed by `GET /api/settings/tools`.
 *
 * The wire's three states are `'ask_each_time'`, `'always_allow'`, and
 * `'disabled'` (the prompt's initial sketch called the third state
 * `'locked'`, but that's actually the wire's per-entry `locked: bool` flag
 * — a separate axis that gates whether the user is ALLOWED to set
 * `always_allow`, not a state in its own right). The union below includes
 * `'locked'` as a forward-compat alias and tolerates any string so a
 * future server-side state doesn't break rendering.
 *
 * "Locked" tools (`locked: true`, e.g. `file_undo`, `pairing_approve`)
 * reject `always_allow` via 400 with `{error: "Tool '<name>' always
 * requires approval and cannot be set to always_allow"}`. Setting them
 * to `ask_each_time` or `disabled` works fine.
 */
export type ToolPermission = 'ask_each_time' | 'always_allow' | 'disabled' | 'locked' | string;

/**
 * One row of the per-tool permission list.
 *
 * Wire shape (verified 2026-05-27):
 *   {
 *     "name": "echo",
 *     "description": "Echoes back the input message...",
 *     "current_state": "always_allow",
 *     "default_state": "always_allow",
 *     "locked": false,
 *     "locked_reason": "<present only when locked: true>"
 *   }
 *
 * The client surfaces `current_state` as `permission` for naming parity
 * with the prompt; `default_state`, `locked`, and `locked_reason` are
 * preserved verbatim so an editor can render the lock indicator and
 * "reset to default" affordance.
 */
export interface ToolPermissionEntry {
  /** Tool name (registry key, e.g. "apply_patch", "shell"). */
  name: string;
  /** Current effective state — maps to wire's `current_state`. */
  permission: ToolPermission;
  description?: string;
  /** Whether this tool is destructive enough to default to ask-each-time.
   *  Reserved — not emitted by the wire today; left optional so the type
   *  doesn't force a placeholder value. */
  destructive?: boolean;
  /** Server's seeded default. `disabled` for nothing today; usually
   *  `ask_each_time` or `always_allow`. */
  default_state?: ToolPermission;
  /** True if the user cannot escalate this tool to `always_allow`. */
  locked?: boolean;
  /** Human-readable lock rationale (e.g. "always requires approval"). */
  locked_reason?: string;
}

// ---- Engine v2 -------------------------------------------------------------
//
// Endpoints (verified 2026-05-27 against IronClaw 0.28.2 on baremetal3, with
// `engine_v2_enabled: true`):
//
//   GET /api/engine/missions          → {missions: EngineMission[]}
//   GET /api/engine/missions/{uuid}   → {mission: EngineMission}    | 404 "Mission not found"
//                                       (500 with a parse error for malformed UUIDs)
//   GET /api/engine/projects          → {projects: EngineProject[]}
//   GET /api/engine/projects/{uuid}   → {project:  EngineProject}   | 404 "Project not found"
//   GET /api/engine/threads           → {threads:  EngineThread[]}
//
// All three list endpoints wrap the row array in a top-level key (`missions`,
// `projects`, `threads`). The "single resource" endpoints wrap in a singular
// key (`mission`, `project`). We surface only the rows / single resource and
// hide the envelope from callers.
//
// These types are deliberately permissive — the gateway's exact set of fields
// on the wire today is captured, plus a few forward-compat optionals. The
// engine v2 schema is the youngest surface in IronClaw and likely to grow; the
// alternative would be a strict schema that breaks on every server iteration.

/**
 * A mission row from `GET /api/engine/missions`.
 *
 * Wire shape (verified 2026-05-27):
 *   {
 *     "id": "<uuid>",
 *     "name": "<slug>",
 *     "goal": "<multi-line agent instruction>",
 *     "status": "Active" | "Paused" | "Archived" | ...,
 *     "cadence_type": "system_event" | "cron" | ...,
 *     "cadence_description": "<human-readable cadence>",
 *     "thread_count": <number>,
 *     "created_at": "<RFC3339>",
 *     "updated_at": "<RFC3339>"
 *   }
 *
 * The brief's sketch carried `title` and `project_id` — neither is present on
 * the wire today. `title` is left optional so a future server build that
 * surfaces a display name can land without a client change; `project_id` is
 * kept on the type because missions are scoped to a project conceptually,
 * even if today's `/api/engine/missions` endpoint omits it from the row.
 */
export interface EngineMission {
  /** UUID. Used as the path parameter for `GET /api/engine/missions/{id}`. */
  id: string;
  /** Slug-like name from the wire (e.g. "conversation-insights"). */
  name?: string;
  /** Display name (reserved; not emitted by the wire today). */
  title?: string;
  /** Full agent instruction body — often multi-line markdown. */
  goal?: string;
  /** Lifecycle marker (e.g. "Active", "Paused"). */
  status?: string;
  /** Cadence discriminator (e.g. `system_event`, `cron`). */
  cadence_type?: string;
  /** Human-readable cadence (e.g. "on system event: engine/foo_due"). */
  cadence_description?: string;
  /** Number of threads spawned by this mission. */
  thread_count?: number;
  /** Reserved — owning project id; not in the current wire row but plausible
   *  in a future schema. */
  project_id?: string;
  /** RFC3339 timestamps. */
  created_at?: string;
  updated_at?: string;
}

/**
 * A project row from `GET /api/engine/projects`.
 *
 * Wire shape (verified 2026-05-27):
 *   { "id": "<uuid>", "name": "<slug>", "description": "<string>",
 *     "created_at": "<RFC3339>" }
 *
 * The current install has exactly one project (`default`). `mission_count`
 * from the brief is not on the wire — kept optional for forward compat.
 */
export interface EngineProject {
  id: string;
  name?: string;
  /** Display name (reserved; the wire emits `name` not `title`). */
  title?: string;
  description?: string;
  /** Reserved — not emitted today. */
  mission_count?: number;
  /** RFC3339. */
  created_at?: string;
  updated_at?: string;
}

/**
 * A thread row from `GET /api/engine/threads` (Engine v2 — distinct from
 * `/api/chat/threads`, which is the chat-surface thread list).
 *
 * Wire shape (verified 2026-05-27):
 *   {
 *     "id": "<uuid>",
 *     "goal": "<multi-line agent instruction>",
 *     "title": "<short human-readable summary>",
 *     "thread_type": "Foreground" | "Background" | ...,
 *     "state": "Pending" | "Running" | "Done" | "Failed" | ...,
 *     "project_id": "<uuid>",
 *     "step_count": <number>,
 *     "total_tokens": <number>,
 *     "created_at": "<RFC3339>",
 *     "updated_at": "<RFC3339>"
 *   }
 *
 * Engine threads carry richer execution metadata than chat threads
 * (step counts, token totals, thread type) — they're closer to a "job"
 * than a conversation. We surface the wire fields verbatim.
 */
export interface EngineThread {
  id: string;
  /** Initial instruction / agent prompt. */
  goal?: string;
  /** Short human title (often the first line of `goal`). */
  title?: string;
  /** Execution discriminator (e.g. "Foreground", "Background"). */
  thread_type?: string;
  /** Lifecycle state (e.g. "Pending", "Running", "Done", "Failed"). */
  state?: string;
  /** Owning project. */
  project_id?: string;
  /** Owning mission, if this thread was spawned by one (reserved — not
   *  emitted on the current wire, but conceptually plausible). */
  mission_id?: string;
  /** Number of agent steps completed. */
  step_count?: number;
  /** Total LLM tokens consumed across all steps. */
  total_tokens?: number;
  /** RFC3339 timestamps. */
  created_at?: string;
  updated_at?: string;
}

/**
 * Single message inside an engine thread's `messages` array.
 *
 * Wire shape (verified 2026-05-27 against IronClaw 0.28.2):
 *   { content: string, role: "System"|"User"|"Assistant"|..., timestamp: "<RFC3339>" }
 *
 * The wire's `role` strings are PascalCase (`User`, `Assistant`, `System`) —
 * NOT the lowercase form used by the chat-surface `Message` type elsewhere
 * in this file. The detail view renders the wire value verbatim and folds
 * case for badge tinting; we don't rewrite the strings here so the panel
 * never lies about what the gateway said.
 */
export interface EngineThreadMessage {
  content: string;
  /** Wire emits PascalCase (`User`, `Assistant`, `System`) but tolerates any
   *  string for forward compat with new roles (`Tool`, `Action`, …). */
  role: string;
  /** RFC3339 timestamp from the server clock. */
  timestamp: string;
}

/**
 * Enriched detail returned by `GET /api/engine/threads/{id}`.
 *
 * Wire envelope: `{thread: {...}}` — the client unwraps this in
 * `getEngineThread`. The detail row carries everything the list row has,
 * plus:
 *   - `messages`: full transcript (system prompt + user turn(s) + assistant)
 *   - `max_iterations`: agent loop cap (default 50 on current gateway)
 *   - `total_cost_usd`: USD spend, as a number (the wire emits a JSON number,
 *     not a string — unlike `usage_30d.total_cost` which is a string)
 *   - `completed_at`: terminal timestamp when state ∈ {Done, Failed}
 *
 * Reserved for forward compat (not on the current wire):
 *   - `error`: failure detail when state == "Failed"
 *   - `mission_id`: owning mission once the gateway emits it on detail
 */
export interface EngineThreadDetail extends EngineThread {
  /** Full message transcript. May contain a very long system prompt as the
   *  first entry — the detail view collapses System messages by default. */
  messages?: EngineThreadMessage[];
  /** Agent-loop iteration cap (e.g. 50 on the default install). */
  max_iterations?: number;
  /** USD spend across this thread's LLM calls. Wire emits a JSON number. */
  total_cost_usd?: number;
  /** RFC3339 when the thread reached a terminal state. */
  completed_at?: string;
  /** Reserved — failure-mode detail string. */
  error?: string;
}

/**
 * A step entry returned by `GET /api/engine/threads/{id}/steps`.
 *
 * The wire envelope today is `{steps: []}` for every thread we've probed
 * (the gateway exposes the endpoint with a 200 + empty array — step data
 * is persisted but not yet projected into a steps payload). The richer
 * runtime story currently lives on the events endpoint
 * (`/api/engine/threads/{id}/events`); see `EngineThreadEvent` below.
 *
 * The fields below are anticipatory — once the gateway lights up the
 * steps endpoint, these are the shapes we expect based on the
 * `StepStarted` / `StepCompleted` / `ActionExecuted` events. They mirror
 * the brief's sketch so the UI is ready when the wire catches up.
 */
export interface EngineThreadStep {
  id?: string;
  /** Sequential 1-based index in the thread's execution timeline. */
  step_number?: number;
  /** Classifier: `thought` | `tool_call` | `response` | … */
  kind?: string;
  /** Free-text content (agent thought, response chunk). */
  content?: string;
  /** Tool name when `kind === 'tool_call'`. */
  tool_name?: string;
  /** Tool arguments (opaque JSON payload). */
  tool_args?: unknown;
  /** Tool result (opaque JSON payload). */
  tool_result?: unknown;
  /** Token count for this step (input+output sum). */
  tokens?: number;
  /** RFC3339. */
  created_at?: string;
}

/**
 * An event row returned by `GET /api/engine/threads/{id}/events`.
 *
 * Wire shape (verified 2026-05-27 on IronClaw 0.28.2):
 *   {
 *     id: "<uuid>",
 *     thread_id: "<uuid>",
 *     timestamp: "<RFC3339>",
 *     kind: { <EventKind>: { …event-specific payload… } }
 *   }
 *
 * `kind` is a one-key object whose key tags the variant and whose value
 * carries the variant's data. Variants observed today:
 *
 *   - `MessageAdded`   { content_preview: string, role: string }
 *   - `StateChanged`   { from: string, to: string, reason: string|null }
 *   - `StepStarted`    { step_id: string }
 *   - `StepCompleted`  { step_id: string, tokens: { input_tokens, output_tokens,
 *                       cache_read_tokens, cache_write_tokens, cost_usd } }
 *   - `ActionExecuted` { action_name: string, call_id: string,
 *                       duration_ms: number, params_summary: string,
 *                       step_id: string }
 *
 * The shape is preserved verbatim — the UI does a `Object.keys(kind)[0]`
 * lookup to read the variant tag and renders each variant differently.
 * Unknown variants render as a JSON snippet (forward-compat safety net).
 */
export interface EngineThreadEvent {
  /** Server-assigned event id (UUID). */
  id?: string;
  /** Owning thread (echoed in every event). */
  thread_id?: string;
  /** RFC3339. */
  timestamp: string;
  /**
   * Tagged-union payload. Single-key object where the key names the variant.
   * Treated as opaque JSON for unknown variants; the UI's known set is the
   * comment list above.
   */
  kind: Record<string, unknown>;
}

// ---- OAuth device flow ------------------------------------------------------
//
// Endpoints (probed 2026-05-27 against IronClaw 0.28.2):
//
//   POST /api/extensions/{name}/login/start  body: {session_id: string}
//     → {success: bool, status: "failed"|"pending"|"completed", message: string,
//        activated: bool, session_id?: string, verification_uri?: string,
//        user_code?: string, expires_in?: number, interval?: number}
//
//   POST /api/extensions/{name}/login/poll   body: {session_id: string}
//     → {success: bool, status: ..., message: string, activated: bool,
//        session_id: string}
//
// IMPORTANT: the wire's identifier is `session_id`, NOT the OAuth-spec
// `device_code`. The client accepts the brief's `device_code` name on the
// poll method and forwards it as `session_id` so the public surface follows
// the OAuth vocabulary while the wire's quirk is hidden.
//
// On this gateway today no installed extension actually supports interactive
// OAuth (`github` is a WASM tool, `nearai` is an MCP server with bundled
// auth) — so every call returns `{success: false, status: "failed", message:
// "Server does not support OAuth: ..."}`. The types and methods are wired
// because the WIRE is live; a future extension that supports OAuth will
// flip these to real responses without a client change.

/**
 * Response from `POST /api/extensions/{name}/login/start`.
 *
 * The OAuth 2.0 Device Authorization Grant (RFC 8628) shape is:
 *   {device_code, user_code, verification_uri, expires_in, interval}
 *
 * IronClaw's wire is a superset that adds `success`, `status`, `message`,
 * `activated`, and `session_id` (its internal identifier — used in poll
 * calls in place of the spec's `device_code`). For consumers that want the
 * RFC vocabulary, `device_code` mirrors `session_id` on this type.
 */
export interface DeviceLoginStart {
  /** True when the start call kicked off a flow (false when the extension
   *  doesn't support OAuth on this gateway). */
  success?: boolean;
  /** Coarse status: `pending`, `completed`, `failed`. Use this to decide
   *  whether to start polling. */
  status?: string;
  /** Human-readable detail; populated when `success=false` (e.g.
   *  "Server does not support OAuth: ..."). */
  message?: string;
  /** True when the extension is already authorized — start is a no-op. */
  activated?: boolean;
  /** Internal gateway identifier — pass back to `login/poll`. Treat as
   *  opaque. Aliased as `device_code` for RFC parity. */
  session_id?: string;
  /** RFC 8628 alias of `session_id` — same opaque token used to poll. */
  device_code?: string;
  /** URL the user opens in their browser to authorize the flow. */
  verification_uri: string;
  /** Short code the user types into the verification URL. */
  user_code: string;
  /** Seconds until the start request expires. */
  expires_in: number;
  /** Minimum seconds between poll calls. */
  interval?: number;
}

/**
 * Response from `POST /api/extensions/{name}/login/poll`.
 *
 * Status vocabulary (subset of what we tolerate via the trailing `string`):
 *   - `pending`   — user has not yet authorized; keep polling.
 *   - `authorized` / `completed` — flow finished; the extension is now active.
 *   - `denied`    — user explicitly denied.
 *   - `expired`   — the device_code expired before authorization completed.
 *   - `failed`    — server-side error (see `error` or `message`).
 *
 * The wire emits `status: "failed"` and `message: "..."` today for any
 * extension that doesn't support OAuth — surfaced as `status: "failed"` +
 * `error: <message>` so callers can render the wire error inline.
 */
export interface DeviceLoginPoll {
  status: 'pending' | 'authorized' | 'denied' | 'expired' | string;
  /** Populated when `status` is a failure mode (`failed`, `denied`,
   *  `expired`). Mirrors the wire's `message` field. */
  error?: string;
  /** Convenience: true when `status === 'authorized'` or `'completed'`. */
  authorized?: boolean;
}

// ---- User tokens ------------------------------------------------------------
//
// Endpoints (verified 2026-05-27 against IronClaw 0.28.2):
//
//   GET    /api/tokens            → {tokens: UserToken[]}
//   POST   /api/tokens            body: {name: string, scopes?: string[]}
//                                  → {id, name, created_at, expires_at,
//                                     token_prefix, token: <RAW VALUE>}
//                                     ^ `token` is returned ONLY on create.
//   DELETE /api/tokens/{id}       → {id, status: "revoked"}
//
// "Revoked" tokens stay in the list with a non-null `revoked_at`. The wire
// does NOT physically delete the row — clients showing only active tokens
// should filter on `revoked_at === null`.
//
// `scopes` is reserved on the wire (the gateway does not surface it today),
// but kept on the type because the create endpoint may grow scope support.

/**
 * A user-created API token. The raw `token` value is returned ONCE on
 * create and never again — the list endpoint only exposes the first few
 * chars via `preview`.
 *
 * Wire shape (list, verified 2026-05-27):
 *   {
 *     "id":          "<uuid>",
 *     "name":        "<user-supplied>",
 *     "created_at":  "<RFC3339>",
 *     "expires_at":  null | "<RFC3339>",
 *     "last_used_at":null | "<RFC3339>",
 *     "revoked_at":  null | "<RFC3339>",
 *     "token_prefix":"<8 hex chars>"
 *   }
 *
 * On create the response additionally carries `token: <full hex>` — the
 * raw value the user must save somewhere. Subsequent reads never see it.
 */
export interface UserToken {
  /** UUID. Used as the path parameter for `DELETE /api/tokens/{id}`. */
  id: string;
  /** User-supplied label. */
  name: string;
  /** RFC3339. */
  created_at: string;
  /** RFC3339, or undefined when the token has never been used. */
  last_used_at?: string;
  /** Optional expiry, when the gateway supports time-bound tokens. */
  expires_at?: string;
  /** Set to an RFC3339 timestamp on revocation. Active tokens have it
   *  undefined / null. */
  revoked_at?: string;
  /** Reserved — the wire does not emit scopes today. Surfaced for forward
   *  compat with a scoped-token gateway. */
  scopes?: string[];
  /** First 8 hex chars of the token (wire's `token_prefix`), surfaced as
   *  `preview` for the brief's vocabulary. */
  preview?: string;
}

/**
 * Active user identity, returned by GET /api/profile.
 *
 * Wire shape today (verified against IronClaw 0.28.2 on baremetal3):
 *   `{avatar_url, created_at, display_name, email, id, last_login_at, role, status}`
 *
 * Not every install carries the same fields — older builds or a single-tenant
 * gateway may omit several. The properties are defensive and tolerant of
 * absence; the consumer derives "is signed in" from whether `/api/profile`
 * returns 200 + a non-empty payload (the gateway answers 401 when no auth
 * cookie/bearer is in flight).
 *
 * `near_account` is forward-looking: today the gateway populates a generic
 * `id` like `"default"` for the local owner, but NEAR-cloud builds may grow
 * a dedicated `near_account` field. The client maps either path onto
 * `near_account` so the UI never has to know about the wire fork.
 */
export interface UserProfile {
  /** Stable user id. `"default"` is the single-tenant local owner marker. */
  user_id?: string;
  /** NEAR account name when signed in via NEAR sign-in, e.g. "dangwalvaidy.near". */
  near_account?: string;
  /** Human-friendly display name. */
  display_name?: string;
  /** Last login timestamp (RFC3339). Null/undefined when never logged in. */
  signed_in_at?: string;
  /** Permission role on the gateway. */
  role?: 'admin' | 'user' | string;
  /** Optional email if the provider supplies one (Google, Apple sign-in). */
  email?: string;
  /** Optional avatar URL. */
  avatar_url?: string;
}

// ---- Replay (R59 codex A6) -------------------------------------------------

export type ReplayEventKind =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning'
  | 'error';

export interface ReplayEvent {
  id: string;
  thread_id: string;
  turn_index: number;
  ts: string;
  kind: ReplayEventKind;
  actor: 'user' | 'assistant' | 'tool';
  payload: Record<string, unknown>;
}

// ---- Sub-agents (R56 lane A5) ----------------------------------------------

export interface SubAgentTask {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  prompt: string;
  result?: string;
  error?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  parent_thread_id?: string;
  model?: string;
}

export interface SubAgentDispatchInput {
  prompt: string;
  priority?: 'low' | 'normal' | 'high';
  parentThreadId?: string;
  model?: string;
}

export type SubAgentEvent =
  | { type: 'started'; taskId: string }
  | { type: 'progress'; taskId: string; text: string }
  | { type: 'completed'; taskId: string; result: string }
  | { type: 'failed'; taskId: string; error: string };

/** Thrown by the sub-agent client methods when the gateway doesn't
 *  implement the `/api/v1/tasks` family (404). The UI checks for this
 *  to show a "needs a newer IronClaw" hint rather than a generic error. */
export class SubAgentUnsupportedError extends Error {
  constructor() {
    super('Sub-agent dispatch is not available on this IronClaw gateway version.');
    this.name = 'SubAgentUnsupportedError';
  }
}

// ---- Reply-threads (R79 codex W2) ------------------------------------------

export interface ReplyThread {
  parent_message_id: string;
  parent_thread_id: string;
  replies: Message[];
  unread_count: number;
  last_updated_at: string;
}

export interface ReplyThreadStreamEvent {
  type: 'reply.started' | 'reply.delta' | 'reply.completed' | 'reply.failed';
  reply_id: string;
  parent_message_id: string;
  delta?: string;
  message?: Message;
  error?: string;
}
