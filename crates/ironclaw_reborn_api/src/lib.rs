//! Shared HTTP API infrastructure for IronClaw Reborn product surfaces.
//!
//! This crate provides reusable building blocks for product-specific HTTP
//! surfaces (WebChat v2 per #3282, OpenAI-compatible API per #3283, and any
//! future protocol-bridge daemon) without itself defining any concrete route
//! shape. Concrete `/api/chat/v2/*`, `/v1/chat/completions`, etc. live in
//! follow-up consumer PRs that import this crate.
//!
//! ## Modules
//!
//! - [`error`] — `ApiError` enum + `axum::response::IntoResponse` impl, with
//!   conversion from `ProductAdapterError`. Wire envelope matches the
//!   OpenAI-compat error shape (`{ "error": { "type", "message", … } }`) so a
//!   single mapper serves both surfaces.
//! - [`auth`] — `CallerAuthenticator` trait + `AuthenticatedCaller` extractor.
//!   The crate defines the contract; production wiring (per surface) provides
//!   the concrete bearer/OIDC implementation. The crate itself does **not**
//!   import v1 auth code (would be a forbidden cross-layer dep).
//! - [`idempotency`] — middleware that supports both `Idempotency-Key` HTTP
//!   header (OpenAI-compat style) and `client_action_id` JSON body field
//!   (WebChat v2 style), and delegates to [`ironclaw_product_workflow::IdempotencyLedger`].
//! - [`projection`] — typed `ProjectionStreamItem` plus adapters to SSE
//!   (`projection::sse`) and WebSocket (`projection::websocket`). The cursor
//!   authority is always [`ironclaw_event_projections::ProjectionCursor`];
//!   transport-local `id` / sequence numbers are never accepted as resume
//!   authority.
//! - [`envelope`] — common response envelopes (errors, paginated lists,
//!   stream control frames).
//! - [`state`] — `ApiServices` struct + service traits that consumer crates
//!   plug their concrete implementations into.
//! - [`openapi`] — `utoipa` schema component declarations for the shared
//!   wire-stable types.
//!
//! ## Boundary
//!
//! `ironclaw_reborn_api` may depend on:
//! - `ironclaw_product_adapters` — DTO contract types exposed over HTTP
//! - `ironclaw_product_workflow` — `ProductWorkflow`, `IdempotencyLedger`,
//!   `IdempotencyDecision` ports
//! - `ironclaw_event_projections` — `ProjectionCursor`, `ProjectionScope`,
//!   `EventStreamManager` facade
//! - `ironclaw_turns` — `TurnActor`, `TurnScope`
//! - `ironclaw_host_api` — canonical identifiers
//!
//! Architecture boundary tests in `crates/ironclaw_architecture/tests/`
//! enforce that the crate has **no normal-build dependency** on the host
//! runtime (`ironclaw_dispatcher`, `ironclaw_capabilities`,
//! `ironclaw_host_runtime`, `ironclaw_authorization`, `ironclaw_approvals`,
//! `ironclaw_network`, `ironclaw_secrets`, `ironclaw_filesystem`,
//! `ironclaw_wasm`, `ironclaw_processes`, `ironclaw_extensions`,
//! `ironclaw_skills`, `ironclaw_mcp`, `ironclaw_scripts`), the v1 root
//! (`ironclaw_engine`, `ironclaw_gateway`, `ironclaw_tui`), or the Reborn
//! kernel (`ironclaw_reborn`).

#![forbid(unsafe_code)]

pub mod auth;
pub mod envelope;
pub mod error;
pub mod idempotency;
pub mod openapi;
pub mod projection;
pub mod state;

pub use auth::{AuthenticatedCaller, CallerAuthenticator};
pub use envelope::{ApiErrorEnvelope, ApiErrorEnvelopeBody, PaginatedListEnvelope};
pub use error::{ApiError, ApiErrorKind};
pub use idempotency::{
    HttpIdempotencyCache, HttpIdempotencyDecision, HttpIdempotencyError, HttpIdempotencyScope,
    HttpStoredResponse, IdempotencyKey, IdempotencyKeyExtractor, IdempotencyMiddlewareConfig,
    InMemoryHttpIdempotencyCache, idempotency_layer, idempotency_middleware,
};
pub use openapi::{SharedApiDoc, shared_schema_fragment};
pub use projection::sse::{CursorTrackedStream, into_sse};
pub use projection::websocket::{
    WebChatStreamClientFrame, WebChatStreamServerFrame, WebChatSubscribeFrame,
    WebChatUnsubscribeFrame, check_origin, drive_websocket, projection_item_to_server_frame,
};
pub use projection::{
    ProjectionStreamItem, ProjectionStreamItemKind, ProjectionStreamLagReason,
    ProjectionStreamRebaseReason,
};
pub use state::{ApiServices, ApiState};
