//! `ApiError` — the unified HTTP error type for Reborn product surfaces.
//!
//! Maps from [`ironclaw_product_adapters::ProductAdapterError`] and other
//! Reborn-side errors to HTTP status codes plus a wire-stable error envelope
//! (see [`crate::envelope::ApiErrorEnvelope`]).
//!
//! The envelope shape mirrors the OpenAI-compatible error format
//! (`{ "error": { "type", "message", "param", "code" } }`) so the same mapper
//! serves both WebChat v2 (#3282) and OpenAI-compatible (#3283) surfaces.
//!
//! ## Invariants
//!
//! - The wire `type` and `message` fields are **deterministic per
//!   [`ApiErrorKind`]**. Source-string detail is never copied into the wire
//!   body — the internal reason is captured in `internal_reason` purely for
//!   server-side log redaction. [`RedactedString::Display`] always emits
//!   `"<redacted>"`, so even if the internal reason were leaked accidentally
//!   into the wire body, the inner secret would not escape; the per-kind
//!   stable message is the contractual user-visible string regardless.
//! - HTTP status codes flow from [`ApiErrorKind::status_code`].
//! - `From<ProductAdapterError>` collapses the adapter error vocabulary onto
//!   the same wire taxonomy, mirroring OpenAI's stable type set. See the
//!   table inline below.

use http::StatusCode;

use ironclaw_product_adapters::{
    ProductAdapterError, ProductWorkflowRejectionKind, ProtocolAuthFailure, RedactedString,
};

use crate::envelope::{ApiErrorEnvelope, ApiErrorEnvelopeBody};

/// Wire-stable kind of API error. Distinct from HTTP status codes so consumers
/// can branch on semantics rather than transport details.
///
/// Each variant has a fixed `(wire_type, wire_message, status_code)` tuple
/// defined by the methods below. Adding a new variant requires picking a
/// wire-stable snake_case type string and a user-safe message — neither must
/// leak source-level diagnostic detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiErrorKind {
    Unauthorized,
    InvalidRequest,
    PolicyDenied,
    NotFound,
    Conflict,
    RateLimited,
    Unavailable,
    Internal,
}

impl ApiErrorKind {
    pub fn status_code(self) -> StatusCode {
        match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::InvalidRequest => StatusCode::BAD_REQUEST,
            Self::PolicyDenied => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Conflict => StatusCode::CONFLICT,
            Self::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// Default snake_case wire `type` string for this kind. Stable; consumers
    /// branch on this value. Special-cased mappings (e.g. workflow rejections
    /// flagged retryable with HTTP 429) override via
    /// [`ApiError::with_wire_type`].
    pub fn wire_type(self) -> &'static str {
        match self {
            Self::Unauthorized => "authentication_error",
            Self::InvalidRequest => "invalid_request_error",
            Self::PolicyDenied => "policy_denied_error",
            Self::NotFound => "not_found_error",
            Self::Conflict => "conflict_error",
            Self::RateLimited => "rate_limit_error",
            Self::Unavailable => "server_unavailable_error",
            Self::Internal => "server_error",
        }
    }

    /// Stable user-safe wire `message` string for this kind. Deliberately
    /// short and non-leaky — internal source detail never appears here.
    pub fn wire_message(self) -> &'static str {
        match self {
            Self::Unauthorized => "Authentication required.",
            Self::InvalidRequest => "The request was invalid.",
            Self::PolicyDenied => "The request was denied by policy.",
            Self::NotFound => "The requested resource was not found.",
            Self::Conflict => "The request conflicts with the current state.",
            Self::RateLimited => "Too many requests. Please retry later.",
            Self::Unavailable => "The service is temporarily unavailable.",
            Self::Internal => "An internal error occurred.",
        }
    }
}

/// The unified HTTP error type. The wire response is fully determined by
/// `kind` + optional `param`/`code`; `internal_reason` is **never** emitted
/// to clients and exists only for server-side logging.
#[derive(Debug, Clone, thiserror::Error)]
#[error("api error: {kind:?} ({wire_type})")]
pub struct ApiError {
    pub kind: ApiErrorKind,
    /// Wire `type` string emitted to clients. Defaults to
    /// [`ApiErrorKind::wire_type`] unless overridden via
    /// [`ApiError::with_wire_type`].
    pub wire_type: &'static str,
    /// Redacted reason text captured for server-side logging. Display always
    /// emits `<redacted>` via [`RedactedString`]; safe to log.
    pub internal_reason: RedactedString,
    pub param: Option<String>,
    pub code: Option<String>,
}

impl ApiError {
    pub fn new(kind: ApiErrorKind, internal_reason: impl Into<String>) -> Self {
        Self {
            kind,
            wire_type: kind.wire_type(),
            internal_reason: RedactedString::new(internal_reason.into()),
            param: None,
            code: None,
        }
    }

    /// Construct an [`ApiError`] with an explicit wire `type` override. Used
    /// for the special-cased workflow-rejection-with-retryable-429 case which
    /// maps to `rate_limit_error` rather than the kind's default type.
    pub fn with_wire_type(
        kind: ApiErrorKind,
        wire_type: &'static str,
        internal_reason: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            wire_type,
            internal_reason: RedactedString::new(internal_reason.into()),
            param: None,
            code: None,
        }
    }

    pub fn with_param(mut self, param: impl Into<String>) -> Self {
        self.param = Some(param.into());
        self
    }

    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    /// Build the wire envelope for this error. Exposed `pub(crate)` so tests
    /// can inspect the wire shape without spinning a full HTTP response.
    pub(crate) fn to_envelope(&self) -> ApiErrorEnvelope {
        ApiErrorEnvelope {
            error: ApiErrorEnvelopeBody {
                kind: self.wire_type.to_string(),
                message: self.kind.wire_message().to_string(),
                param: self.param.clone(),
                code: self.code.clone(),
            },
        }
    }

    /// Construct from a [`ProductAdapterError`]. Each variant maps to a
    /// stable `(ApiErrorKind, wire_type)` pair:
    ///
    /// | Source variant | kind | wire type |
    /// |---|---|---|
    /// | `Authentication(_)` | `Unauthorized` | `authentication_error` |
    /// | `MalformedInboundPayload` | `InvalidRequest` | `invalid_request_error` |
    /// | `WorkflowRejected { ThreadBusy }` | `Conflict` | `conflict_error` |
    /// | `WorkflowRejected { Unauthorized }` | `PolicyDenied` | `policy_denied_error` |
    /// | `WorkflowRejected { ScopeNotFound }` | `NotFound` | `not_found_error` |
    /// | `WorkflowRejected { AdmissionRejected }` | `PolicyDenied` | `policy_denied_error` |
    /// | `WorkflowRejected { InvalidRequest }` | `InvalidRequest` | `invalid_request_error` |
    /// | `WorkflowRejected { Unavailable }` | `Unavailable` | `server_unavailable_error` |
    /// | `WorkflowRejected { Conflict }` | `Conflict` | `conflict_error` |
    /// | `WorkflowRejected { retryable: true, status_code: 429 }` | `RateLimited` | `rate_limit_error` |
    /// | `WorkflowRejected { retryable: true, status_code: 503 }` | `Unavailable` | `server_unavailable_error` |
    /// | `WorkflowTransient` | `Unavailable` | `server_unavailable_error` |
    /// | `EgressTransient` | `Unavailable` | `server_unavailable_error` |
    /// | `EgressDenied` | `PolicyDenied` | `policy_denied_error` |
    /// | `EgressUndeclaredHost` | `PolicyDenied` | `policy_denied_error` |
    /// | `InvalidIdentifier` | `InvalidRequest` | `invalid_request_error` |
    /// | `Internal` | `Internal` | `server_error` |
    fn from_product_adapter_error(value: ProductAdapterError) -> Self {
        match value {
            ProductAdapterError::Authentication(failure) => {
                Self::new(ApiErrorKind::Unauthorized, auth_failure_reason(&failure))
            }
            ProductAdapterError::MalformedInboundPayload { reason } => {
                // RedactedString::to_string() emits "<redacted>"; we preserve
                // that on the internal_reason side. The wire body uses the
                // stable per-kind message regardless.
                Self::new(ApiErrorKind::InvalidRequest, reason.to_string())
            }
            ProductAdapterError::InvalidIdentifier { kind, reason } => Self::new(
                ApiErrorKind::InvalidRequest,
                format!("invalid {kind} identifier: {reason}"),
            ),
            ProductAdapterError::WorkflowRejected {
                retryable: true,
                status_code: 429,
                reason,
                ..
            } => Self::with_wire_type(
                ApiErrorKind::RateLimited,
                ApiErrorKind::RateLimited.wire_type(),
                reason.to_string(),
            ),
            ProductAdapterError::WorkflowRejected {
                retryable: true,
                status_code: 503,
                reason,
                ..
            } => Self::with_wire_type(
                ApiErrorKind::Unavailable,
                ApiErrorKind::Unavailable.wire_type(),
                reason.to_string(),
            ),
            ProductAdapterError::WorkflowRejected { kind, reason, .. } => {
                let api_kind = match kind {
                    ProductWorkflowRejectionKind::ThreadBusy => ApiErrorKind::Conflict,
                    ProductWorkflowRejectionKind::Unauthorized => ApiErrorKind::PolicyDenied,
                    ProductWorkflowRejectionKind::ScopeNotFound => ApiErrorKind::NotFound,
                    ProductWorkflowRejectionKind::AdmissionRejected => ApiErrorKind::PolicyDenied,
                    ProductWorkflowRejectionKind::InvalidRequest => ApiErrorKind::InvalidRequest,
                    ProductWorkflowRejectionKind::Unavailable => ApiErrorKind::Unavailable,
                    ProductWorkflowRejectionKind::Conflict => ApiErrorKind::Conflict,
                };
                Self::new(api_kind, workflow_rejection_reason(kind, &reason))
            }
            ProductAdapterError::WorkflowTransient { reason } => {
                Self::new(ApiErrorKind::Unavailable, reason.to_string())
            }
            ProductAdapterError::EgressTransient { reason } => {
                Self::new(ApiErrorKind::Unavailable, reason.to_string())
            }
            ProductAdapterError::EgressDenied { reason } => {
                Self::new(ApiErrorKind::PolicyDenied, reason.to_string())
            }
            ProductAdapterError::EgressUndeclaredHost { host } => Self::new(
                ApiErrorKind::PolicyDenied,
                format!("egress to undeclared host {host}"),
            ),
            ProductAdapterError::Internal { detail } => {
                Self::new(ApiErrorKind::Internal, detail.to_string())
            }
        }
    }
}

fn auth_failure_reason(failure: &ProtocolAuthFailure) -> String {
    // ProtocolAuthFailure::Display is already redaction-safe (the `Other`
    // variant carries a RedactedString); reusing it keeps the diagnostic
    // categorisation in the server log without leaking secrets.
    failure.to_string()
}

fn workflow_rejection_reason(
    kind: ProductWorkflowRejectionKind,
    reason: &RedactedString,
) -> String {
    let kind_phrase = match kind {
        ProductWorkflowRejectionKind::ThreadBusy => "thread busy",
        ProductWorkflowRejectionKind::AdmissionRejected => "admission rejected",
        ProductWorkflowRejectionKind::ScopeNotFound => "scope not found",
        ProductWorkflowRejectionKind::Unauthorized => "unauthorized",
        ProductWorkflowRejectionKind::InvalidRequest => "invalid request",
        ProductWorkflowRejectionKind::Unavailable => "unavailable",
        ProductWorkflowRejectionKind::Conflict => "conflict",
    };
    format!("workflow rejected: {kind_phrase} ({reason})")
}

impl From<ProductAdapterError> for ApiError {
    fn from(value: ProductAdapterError) -> Self {
        Self::from_product_adapter_error(value)
    }
}

impl axum::response::IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let status = self.kind.status_code();

        // Server-side log only — internal_reason renders as `<redacted>` via
        // RedactedString's Display impl, so even a misconfigured tracing
        // subscriber cannot leak the inner secret.
        if status.is_server_error() {
            tracing::error!(
                kind = ?self.kind,
                wire_type = self.wire_type,
                param = ?self.param,
                code = ?self.code,
                reason = %self.internal_reason,
                "api error (5xx)"
            );
        } else {
            tracing::warn!(
                kind = ?self.kind,
                wire_type = self.wire_type,
                param = ?self.param,
                code = ?self.code,
                reason = %self.internal_reason,
                "api error (4xx)"
            );
        }

        let envelope = self.to_envelope();
        (status, axum::Json(envelope)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rejection(
        kind: ProductWorkflowRejectionKind,
        status_code: u16,
        retryable: bool,
    ) -> ProductAdapterError {
        ProductAdapterError::WorkflowRejected {
            kind,
            status_code,
            retryable,
            reason: RedactedString::new("rejection-detail"),
        }
    }

    #[test]
    fn unauthorized_maps_to_401_authentication_error() {
        let err: ApiError =
            ProductAdapterError::Authentication(ProtocolAuthFailure::Missing).into();
        assert_eq!(err.kind, ApiErrorKind::Unauthorized);
        assert_eq!(err.kind.status_code(), StatusCode::UNAUTHORIZED);
        let env = err.to_envelope();
        assert_eq!(env.error.kind, "authentication_error");
        assert_eq!(env.error.message, "Authentication required.");
    }

    #[test]
    fn invalid_request_maps_to_400_invalid_request_error() {
        let err: ApiError = ProductAdapterError::MalformedInboundPayload {
            reason: RedactedString::new("missing field"),
        }
        .into();
        assert_eq!(err.kind, ApiErrorKind::InvalidRequest);
        assert_eq!(err.kind.status_code(), StatusCode::BAD_REQUEST);
        let env = err.to_envelope();
        assert_eq!(env.error.kind, "invalid_request_error");
        assert_eq!(env.error.message, "The request was invalid.");
    }

    #[test]
    fn policy_denied_maps_to_403() {
        let err: ApiError =
            rejection(ProductWorkflowRejectionKind::AdmissionRejected, 403, false).into();
        assert_eq!(err.kind, ApiErrorKind::PolicyDenied);
        assert_eq!(err.kind.status_code(), StatusCode::FORBIDDEN);
        let env = err.to_envelope();
        assert_eq!(env.error.kind, "policy_denied_error");
    }

    #[test]
    fn rate_limited_maps_to_429() {
        // Special-cased: retryable + status 429 → RateLimited regardless of
        // the rejection's `kind`.
        let err: ApiError = rejection(ProductWorkflowRejectionKind::ThreadBusy, 429, true).into();
        assert_eq!(err.kind, ApiErrorKind::RateLimited);
        assert_eq!(err.kind.status_code(), StatusCode::TOO_MANY_REQUESTS);
        let env = err.to_envelope();
        assert_eq!(env.error.kind, "rate_limit_error");
        assert_eq!(env.error.message, "Too many requests. Please retry later.");
    }

    #[test]
    fn unavailable_maps_to_503_server_unavailable() {
        let err: ApiError = ProductAdapterError::WorkflowTransient {
            reason: RedactedString::new("downstream-unavailable"),
        }
        .into();
        assert_eq!(err.kind, ApiErrorKind::Unavailable);
        assert_eq!(err.kind.status_code(), StatusCode::SERVICE_UNAVAILABLE);
        let env = err.to_envelope();
        assert_eq!(env.error.kind, "server_unavailable_error");
    }

    #[test]
    fn internal_maps_to_500_server_error() {
        let err: ApiError = ProductAdapterError::Internal {
            detail: RedactedString::new("oops"),
        }
        .into();
        assert_eq!(err.kind, ApiErrorKind::Internal);
        assert_eq!(err.kind.status_code(), StatusCode::INTERNAL_SERVER_ERROR);
        let env = err.to_envelope();
        assert_eq!(env.error.kind, "server_error");
        assert_eq!(env.error.message, "An internal error occurred.");
    }

    #[test]
    fn wire_message_never_leaks_internal_reason() {
        // Even when constructed with an internal reason string containing
        // diagnostic detail, the wire body's `message` must be the stable
        // per-kind phrase. The internal reason text is captured in
        // `internal_reason` for server-side logging, where
        // RedactedString::Display further coerces it to "<redacted>".
        let err = ApiError::new(ApiErrorKind::Internal, "super-secret-debug-detail");
        let env = err.to_envelope();
        assert_eq!(env.error.message, "An internal error occurred.");
        assert!(!env.error.message.contains("super-secret-debug-detail"));

        // RedactedString::Display ensures the internal reason itself never
        // leaks even via accidental log misrouting.
        assert_eq!(err.internal_reason.to_string(), "<redacted>");
    }

    #[test]
    fn product_adapter_error_maps_match_documented_table() {
        let cases: Vec<(ProductAdapterError, ApiErrorKind, &'static str)> = vec![
            (
                ProductAdapterError::Authentication(ProtocolAuthFailure::SignatureMismatch),
                ApiErrorKind::Unauthorized,
                "authentication_error",
            ),
            (
                ProductAdapterError::MalformedInboundPayload {
                    reason: RedactedString::new("bad"),
                },
                ApiErrorKind::InvalidRequest,
                "invalid_request_error",
            ),
            (
                ProductAdapterError::InvalidIdentifier {
                    kind: "adapter id",
                    reason: "empty".into(),
                },
                ApiErrorKind::InvalidRequest,
                "invalid_request_error",
            ),
            (
                rejection(ProductWorkflowRejectionKind::ThreadBusy, 409, false),
                ApiErrorKind::Conflict,
                "conflict_error",
            ),
            (
                rejection(ProductWorkflowRejectionKind::Unauthorized, 403, false),
                ApiErrorKind::PolicyDenied,
                "policy_denied_error",
            ),
            (
                rejection(ProductWorkflowRejectionKind::ScopeNotFound, 404, false),
                ApiErrorKind::NotFound,
                "not_found_error",
            ),
            (
                rejection(ProductWorkflowRejectionKind::AdmissionRejected, 403, false),
                ApiErrorKind::PolicyDenied,
                "policy_denied_error",
            ),
            (
                rejection(ProductWorkflowRejectionKind::InvalidRequest, 400, false),
                ApiErrorKind::InvalidRequest,
                "invalid_request_error",
            ),
            (
                rejection(ProductWorkflowRejectionKind::Unavailable, 503, false),
                ApiErrorKind::Unavailable,
                "server_unavailable_error",
            ),
            (
                rejection(ProductWorkflowRejectionKind::Conflict, 409, false),
                ApiErrorKind::Conflict,
                "conflict_error",
            ),
            // Special case: retryable + 429 wins over the `kind`'s default.
            (
                rejection(ProductWorkflowRejectionKind::ThreadBusy, 429, true),
                ApiErrorKind::RateLimited,
                "rate_limit_error",
            ),
            // Special case: retryable + 503 wins over the `kind`'s default.
            (
                rejection(ProductWorkflowRejectionKind::ScopeNotFound, 503, true),
                ApiErrorKind::Unavailable,
                "server_unavailable_error",
            ),
            (
                ProductAdapterError::WorkflowTransient {
                    reason: RedactedString::new("x"),
                },
                ApiErrorKind::Unavailable,
                "server_unavailable_error",
            ),
            (
                ProductAdapterError::Internal {
                    detail: RedactedString::new("x"),
                },
                ApiErrorKind::Internal,
                "server_error",
            ),
        ];

        for (input, want_kind, want_wire_type) in cases {
            let debug = format!("{input:?}");
            let api: ApiError = input.into();
            assert_eq!(api.kind, want_kind, "kind mismatch for {debug}");
            assert_eq!(
                api.wire_type, want_wire_type,
                "wire_type mismatch for {debug}"
            );
        }
    }

    #[test]
    fn with_param_and_code_round_trip_through_envelope() {
        let err = ApiError::new(ApiErrorKind::InvalidRequest, "missing required field")
            .with_param("model")
            .with_code("missing_required_field");
        let env = err.to_envelope();
        assert_eq!(env.error.param.as_deref(), Some("model"));
        assert_eq!(env.error.code.as_deref(), Some("missing_required_field"));
    }

    #[test]
    fn into_response_carries_status_and_json_body() {
        use axum::response::IntoResponse;
        let err = ApiError::new(ApiErrorKind::NotFound, "missing thread");
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let ct = resp
            .headers()
            .get(http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(
            ct.starts_with("application/json"),
            "expected JSON content type, got {ct:?}"
        );
    }
}
