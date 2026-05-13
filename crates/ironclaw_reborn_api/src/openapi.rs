//! `utoipa` schema component declarations for shared wire-stable types.
//!
//! Consumer surfaces (WebChat v2 per #3282, OpenAI-compatible per #3283) build
//! their own [`utoipa::OpenApi`] document and merge [`SharedApiDoc`] into it so
//! the shared envelopes (`ApiErrorEnvelope`, `ProjectionStreamItem`, …) end up
//! in `components.schemas` under deterministic names.
//!
//! ## What's included
//!
//! - [`ApiErrorEnvelope`] / [`ApiErrorEnvelopeBody`] — OpenAI-compatible error
//!   wire shape, identical across both consumer surfaces.
//! - [`ProjectionStreamItem`] and its three sub-enums
//!   ([`ProjectionStreamItemKind`], [`ProjectionStreamLagReason`],
//!   [`ProjectionStreamRebaseReason`]) — projection-stream control + payload
//!   frames, used by SSE and WebSocket adapters.
//! - [`AuthenticatedCaller`] — the shape exposed by the auth extractor.
//!
//! ## What's NOT included, and why
//!
//! - [`PaginatedListEnvelope`] is generic over the item type. utoipa's
//!   `components.schemas` namespace is not generic — every concrete
//!   instantiation must be registered separately via an `#[aliases(...)]`
//!   attribute on the consumer crate's `OpenApi` macro:
//!
//!   ```ignore
//!   #[derive(utoipa::OpenApi)]
//!   #[openapi(components(schemas(
//!       PaginatedListEnvelopeMessage,
//!   )))]
//!   pub struct ConsumerSurfaceDoc;
//!
//!   #[derive(serde::Serialize, utoipa::ToSchema)]
//!   #[aliases(PaginatedListEnvelopeMessage = PaginatedListEnvelope<Message>)]
//!   pub struct PaginatedListEnvelope<T> { /* ... */ }
//!   ```
//!
//!   The shared crate has no concrete `T` to register, so it omits the
//!   alias. Documenting the pattern in the type's rustdoc (see
//!   `envelope::PaginatedListEnvelope`) is the deliberate substitute.

use crate::auth::AuthenticatedCaller;
use crate::envelope::{ApiErrorEnvelope, ApiErrorEnvelopeBody};
use crate::projection::{
    ProjectionStreamItem, ProjectionStreamItemKind, ProjectionStreamLagReason,
    ProjectionStreamRebaseReason,
};

/// Aggregated `utoipa::OpenApi` document carrying every shared wire-stable
/// schema component. Consumer surfaces compose this with their per-route
/// schemas via [`utoipa::openapi::OpenApi::merge`] or by listing
/// [`SharedApiDoc::openapi()`] in their own `#[openapi(nested(...))]`.
#[derive(utoipa::OpenApi)]
#[openapi(
    components(schemas(
        ApiErrorEnvelope,
        ApiErrorEnvelopeBody,
        ProjectionStreamItem,
        ProjectionStreamItemKind,
        ProjectionStreamLagReason,
        ProjectionStreamRebaseReason,
        AuthenticatedCaller,
    )),
    tags(
        (name = "ironclaw_reborn_api", description = "Shared infrastructure for IronClaw Reborn product surfaces"),
    ),
)]
pub struct SharedApiDoc;

/// Returns an `OpenApi` schema fragment containing every shared response
/// envelope and projection-stream item type the crate defines. Consumer
/// surfaces compose this with their own per-route schemas.
pub fn shared_schema_fragment() -> utoipa::openapi::OpenApi {
    use utoipa::OpenApi;
    SharedApiDoc::openapi()
}
