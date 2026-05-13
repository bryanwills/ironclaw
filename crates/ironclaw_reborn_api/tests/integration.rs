//! End-to-end integration tests for `ironclaw_reborn_api` shared
//! infrastructure: the `utoipa` schema fragment, the `ApiError` response
//! shape, and the `PaginatedListEnvelope` wire serialisation.
//!
//! These live under `tests/` (rather than as `#[cfg(test)] mod tests` inside
//! `src/`) because they exercise the crate's public re-exports — the same
//! surface area downstream consumer crates (WebChat v2 per #3282,
//! OpenAI-compatible per #3283) use. Crate-internal modules are deliberately
//! NOT imported.

use axum::response::IntoResponse;
use http_body_util::BodyExt;
use ironclaw_reborn_api::{
    ApiError, ApiErrorEnvelope, ApiErrorKind, PaginatedListEnvelope, shared_schema_fragment,
};

/// Drain an `axum::response::Response` body to a `Vec<u8>` for assertions.
async fn body_bytes(resp: axum::response::Response) -> Vec<u8> {
    resp.into_body()
        .collect()
        .await
        .expect("collect response body")
        .to_bytes()
        .to_vec()
}

#[test]
fn shared_schema_fragment_includes_api_error_envelope() {
    let doc = shared_schema_fragment();
    let json = serde_json::to_value(&doc).expect("serialise OpenApi doc");
    let schemas = json
        .pointer("/components/schemas")
        .and_then(|v| v.as_object())
        .expect("components.schemas object present");
    assert!(
        schemas.contains_key("ApiErrorEnvelope"),
        "expected ApiErrorEnvelope under components.schemas, got keys: {:?}",
        schemas.keys().collect::<Vec<_>>()
    );
    assert!(
        schemas.contains_key("ApiErrorEnvelopeBody"),
        "expected ApiErrorEnvelopeBody under components.schemas"
    );
}

#[test]
fn shared_schema_fragment_includes_projection_stream_item() {
    let doc = shared_schema_fragment();
    let json = serde_json::to_value(&doc).expect("serialise OpenApi doc");
    let schemas = json
        .pointer("/components/schemas")
        .and_then(|v| v.as_object())
        .expect("components.schemas object present");
    assert!(
        schemas.contains_key("ProjectionStreamItem"),
        "expected ProjectionStreamItem under components.schemas, got keys: {:?}",
        schemas.keys().collect::<Vec<_>>()
    );
    assert!(
        schemas.contains_key("ProjectionStreamItemKind"),
        "expected ProjectionStreamItemKind under components.schemas"
    );
    assert!(
        schemas.contains_key("ProjectionStreamLagReason"),
        "expected ProjectionStreamLagReason under components.schemas"
    );
    assert!(
        schemas.contains_key("ProjectionStreamRebaseReason"),
        "expected ProjectionStreamRebaseReason under components.schemas"
    );
}

#[test]
fn shared_schema_fragment_includes_authenticated_caller() {
    let doc = shared_schema_fragment();
    let json = serde_json::to_value(&doc).expect("serialise OpenApi doc");
    let schemas = json
        .pointer("/components/schemas")
        .and_then(|v| v.as_object())
        .expect("components.schemas object present");
    assert!(
        schemas.contains_key("AuthenticatedCaller"),
        "expected AuthenticatedCaller under components.schemas, got keys: {:?}",
        schemas.keys().collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn error_response_serializes_with_openai_compat_shape() {
    let err = ApiError::new(ApiErrorKind::InvalidRequest, "missing required field")
        .with_param("model")
        .with_code("missing_required_field");
    let resp = err.into_response();
    assert_eq!(resp.status(), http::StatusCode::BAD_REQUEST);

    let bytes = body_bytes(resp).await;
    let envelope: ApiErrorEnvelope =
        serde_json::from_slice(&bytes).expect("body deserialises into ApiErrorEnvelope");
    assert_eq!(envelope.error.kind, "invalid_request_error");
    // The wire `message` is the stable per-kind phrase; the internal_reason
    // ("missing required field") deliberately never appears here — see
    // `ApiError::to_envelope`.
    assert_eq!(envelope.error.message, "The request was invalid.");
    assert_eq!(envelope.error.param.as_deref(), Some("model"));
    assert_eq!(
        envelope.error.code.as_deref(),
        Some("missing_required_field")
    );
}

#[tokio::test]
async fn api_error_into_response_emits_application_json_content_type() {
    let err = ApiError::new(ApiErrorKind::Internal, "synthetic");
    let resp = err.into_response();
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

#[test]
fn paginated_list_envelope_serializes_with_optional_next_cursor() {
    // With cursor.
    let with_cursor = PaginatedListEnvelope {
        items: vec!["alpha".to_string(), "beta".to_string()],
        next_cursor: Some("opaque-cursor-token".to_string()),
    };
    let json = serde_json::to_value(&with_cursor).expect("serialise with cursor");
    assert_eq!(json["items"], serde_json::json!(["alpha", "beta"]));
    assert_eq!(
        json["next_cursor"],
        serde_json::json!("opaque-cursor-token")
    );

    // Without cursor — the field must be omitted entirely (skip_serializing_if).
    let without_cursor: PaginatedListEnvelope<String> = PaginatedListEnvelope {
        items: vec!["only".to_string()],
        next_cursor: None,
    };
    let json = serde_json::to_value(&without_cursor).expect("serialise without cursor");
    assert_eq!(json["items"], serde_json::json!(["only"]));
    assert!(
        json.as_object()
            .map(|o| !o.contains_key("next_cursor"))
            .unwrap_or(false),
        "next_cursor should be omitted when None, got {json}"
    );

    // Round-trip.
    let reparsed: PaginatedListEnvelope<String> =
        serde_json::from_value(json).expect("deserialise");
    assert!(reparsed.next_cursor.is_none());
    assert_eq!(reparsed.items, vec!["only".to_string()]);
}

#[test]
fn api_error_kind_status_codes_match_table() {
    use http::StatusCode;
    let table = [
        (ApiErrorKind::Unauthorized, StatusCode::UNAUTHORIZED),
        (ApiErrorKind::InvalidRequest, StatusCode::BAD_REQUEST),
        (ApiErrorKind::PolicyDenied, StatusCode::FORBIDDEN),
        (ApiErrorKind::NotFound, StatusCode::NOT_FOUND),
        (ApiErrorKind::Conflict, StatusCode::CONFLICT),
        (ApiErrorKind::RateLimited, StatusCode::TOO_MANY_REQUESTS),
        (ApiErrorKind::Unavailable, StatusCode::SERVICE_UNAVAILABLE),
        (ApiErrorKind::Internal, StatusCode::INTERNAL_SERVER_ERROR),
    ];
    for (kind, expected) in table {
        assert_eq!(
            kind.status_code(),
            expected,
            "status code mismatch for {kind:?}"
        );
    }
}

#[test]
fn api_error_kind_wire_types_match_documented_set() {
    // These wire-type strings are part of the public contract — consumer
    // surfaces branch on them. If anyone renames one of these, the test
    // must be updated explicitly (it's not auto-generated).
    let table = [
        (ApiErrorKind::Unauthorized, "authentication_error"),
        (ApiErrorKind::InvalidRequest, "invalid_request_error"),
        (ApiErrorKind::PolicyDenied, "policy_denied_error"),
        (ApiErrorKind::NotFound, "not_found_error"),
        (ApiErrorKind::Conflict, "conflict_error"),
        (ApiErrorKind::RateLimited, "rate_limit_error"),
        (ApiErrorKind::Unavailable, "server_unavailable_error"),
        (ApiErrorKind::Internal, "server_error"),
    ];
    for (kind, expected) in table {
        assert_eq!(
            kind.wire_type(),
            expected,
            "wire_type mismatch for {kind:?}"
        );
    }
}
