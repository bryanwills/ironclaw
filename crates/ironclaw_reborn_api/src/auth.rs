//! `CallerAuthenticator` trait + `AuthenticatedCaller` extractor.
//!
//! Reborn API caller authentication is delegated to a trait that consumer
//! crates implement — typically wrapping the v1 gateway's existing bearer /
//! OIDC stack from `src/channels/web/platform/auth.rs`. This crate defines
//! the contract; it does not import v1 auth code (would be a forbidden
//! cross-layer dep).
//
// TODO(reborn-api): full extractor + middleware lands in a follow-up commit
// by a dedicated agent. This is a placeholder so the crate compiles.

use async_trait::async_trait;
use http::HeaderMap;
use ironclaw_host_api::{TenantId, UserId};

use crate::error::ApiError;

/// A successfully authenticated API caller. Production implementations may
/// extend the wire fields (role, scopes, OIDC claims) via per-surface state
/// stored alongside.
//
// `TenantId` and `UserId` live in `ironclaw_host_api` (no `utoipa`
// dependency by design — that crate is a foundational vocabulary), but
// both serialize transparently as strings via `Serialize`. The OpenAPI
// schema models them as bare `String`.
#[derive(Debug, Clone, PartialEq, Eq, utoipa::ToSchema)]
pub struct AuthenticatedCaller {
    #[schema(value_type = String)]
    pub user_id: UserId,
    #[schema(value_type = String)]
    pub tenant_id: TenantId,
}

#[async_trait]
pub trait CallerAuthenticator: Send + Sync {
    /// Authenticate an incoming request given its HTTP headers. Implementations
    /// must NOT inspect the body (idempotency middleware runs first and the
    /// body has already been consumed in some flows).
    async fn authenticate(&self, headers: &HeaderMap) -> Result<AuthenticatedCaller, ApiError>;
}
