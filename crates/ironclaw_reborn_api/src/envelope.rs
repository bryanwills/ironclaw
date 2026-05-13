//! Wire-stable response envelopes shared across product surfaces.
//
// TODO(reborn-api): full envelope set (error, paginated list, projection
// stream control frames) lands in a follow-up commit by a dedicated agent.

use serde::{Deserialize, Serialize};

/// Wire shape of an API error response. Matches OpenAI-compatible format
/// (`{ "error": { "type", "message", "param", "code" } }`).
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ApiErrorEnvelope {
    pub error: ApiErrorEnvelopeBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ApiErrorEnvelopeBody {
    /// Stable error kind identifier (e.g. `"invalid_request_error"`,
    /// `"rate_limit_error"`, `"authentication_error"`, `"server_error"`).
    #[serde(rename = "type")]
    pub kind: String,
    /// Redacted human-readable message.
    pub message: String,
    /// Optional request parameter name when the error is parameter-specific.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub param: Option<String>,
    /// Optional stable machine-readable code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// Wire shape of a paginated list endpoint. Pagination cursor is always
/// opaque; transport-local offsets / page numbers are never accepted.
///
/// This type is generic over the item type and deliberately does **not**
/// carry a `utoipa::ToSchema` derive. Adding `#[derive(ToSchema)]` here
/// would require every `T` used anywhere in the codebase to implement
/// `ToSchema` (a viral bound across non-API consumers), and OpenAPI's
/// `components.schemas` namespace is non-generic anyway. Consumer crates
/// that surface a paginated list over a concrete item type must add
/// `#[aliases(PaginatedListEnvelopeFooBar = PaginatedListEnvelope<FooBar>)]`
/// in their own `OpenApi` macro and register the alias under
/// `components(schemas(...))`. See `crate::openapi::SharedApiDoc` — this
/// generic is intentionally omitted from the shared fragment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaginatedListEnvelope<T> {
    pub items: Vec<T>,
    /// Opaque cursor for the next page, if any. Caller passes it back as
    /// `?after=<cursor>` on the next request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}
