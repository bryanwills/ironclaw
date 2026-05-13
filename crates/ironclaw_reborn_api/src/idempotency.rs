//! Idempotency middleware supporting both surfaces' conventions.
//!
//! WebChat v2 (#3282) carries `client_action_id` as a body field.
//! OpenAI-compat (#3283) carries `Idempotency-Key` as an HTTP header.
//!
//! # HTTP-layer cache vs. product-workflow ledger
//!
//! This middleware is the **HTTP-layer** idempotency cache. It deduplicates
//! caller-supplied tokens (`Idempotency-Key` header / `client_action_id`
//! body field) so a retried HTTP request returns the same response body
//! without re-running the handler.
//!
//! This is **distinct** from the product-workflow
//! [`ironclaw_product_workflow::IdempotencyLedger`], which deduplicates
//! product-layer inbound actions by `ActionFingerprintKey { adapter_id,
//! installation_id, source_binding_key, external_event_id }` — fingerprints
//! minted from a `ProductInboundEnvelope`, not caller tokens. The two
//! layers serve different purposes and operate on different keys; this
//! middleware does NOT call the product-workflow ledger.
//!
//! # Dependency order
//!
//! The middleware reads [`HttpIdempotencyScope`] from request extensions,
//! which must be inserted by an upstream authentication middleware. Wire
//! this middleware AFTER `CallerAuthenticator` so the scope is populated.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    extract::{Request, State},
    middleware::{Next, from_fn_with_state},
    response::{IntoResponse, Response},
};
use ironclaw_host_api::{TenantId, UserId};
use serde_json::Value as JsonValue;
use tokio::sync::Mutex;
use tower::Layer;

use crate::error::{ApiError, ApiErrorKind};

const DEFAULT_MAX_BODY_BYTES: usize = 1024 * 1024; // 1 MiB

/// A typed idempotency key. Construct via [`IdempotencyKey::new`] which
/// validates length and character set.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct IdempotencyKey(String);

impl IdempotencyKey {
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        let value = value.into();
        if value.is_empty() {
            return Err("idempotency key must not be empty".into());
        }
        if value.len() > 256 {
            return Err("idempotency key exceeds 256-byte limit".into());
        }
        if value
            .chars()
            .any(|c| c == '\0' || c.is_control() || c.is_whitespace())
        {
            return Err("idempotency key contains forbidden characters".into());
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// How the middleware should extract the idempotency key from a request.
#[derive(Debug, Clone)]
pub enum IdempotencyKeyExtractor {
    /// Read the value of a specific HTTP header (e.g. `Idempotency-Key`).
    Header { header_name: http::HeaderName },
    /// Read a top-level JSON field from the request body
    /// (e.g. `client_action_id`). The middleware buffers + clones the body
    /// to make this safe; expensive for large requests.
    BodyField { field_name: String },
}

#[derive(Debug, Clone)]
pub struct IdempotencyMiddlewareConfig {
    pub extractor: IdempotencyKeyExtractor,
    /// If true, missing key returns `400 Bad Request`. If false, missing key
    /// is allowed and the request proceeds without idempotency protection.
    pub required: bool,
    /// Maximum bytes the middleware will buffer when extracting a key from
    /// the request body. Requests with bodies larger than this return
    /// `400 Bad Request`. Defaults to 1 MiB.
    ///
    /// This is *separate* from any upstream `RequestBodyLimitLayer` — that
    /// layer should still be applied at the router boundary to bound the
    /// total bytes any handler can receive. This cap exists to keep the
    /// middleware itself from materialising oversized payloads in memory
    /// when the key sits in the body.
    pub max_body_bytes: usize,
}

impl IdempotencyMiddlewareConfig {
    pub fn header(header_name: http::HeaderName, required: bool) -> Self {
        Self {
            extractor: IdempotencyKeyExtractor::Header { header_name },
            required,
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
        }
    }

    pub fn body_field(field_name: impl Into<String>, required: bool) -> Self {
        Self {
            extractor: IdempotencyKeyExtractor::BodyField {
                field_name: field_name.into(),
            },
            required,
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
        }
    }
}

/// Per-caller scoping for the HTTP idempotency cache. Inserted into the
/// request extensions by an upstream auth middleware so this middleware
/// can scope cached responses to a single (tenant, user) pair and prevent
/// cross-caller key collisions.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HttpIdempotencyScope {
    pub tenant_id: TenantId,
    pub user_id: UserId,
}

/// Outcome of [`HttpIdempotencyCache::record_or_replay`].
#[derive(Debug, Clone)]
pub enum HttpIdempotencyDecision {
    /// First time the (scope, key) pair was seen. Run the handler.
    New,
    /// A response was previously stored for this (scope, key). Replay it.
    Replay { response: HttpStoredResponse },
}

/// Buffered representation of a handler response suitable for replay.
#[derive(Debug, Clone)]
pub struct HttpStoredResponse {
    pub status: http::StatusCode,
    pub headers: http::HeaderMap,
    pub body: Vec<u8>,
}

/// Errors raised by [`HttpIdempotencyCache`] implementations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpIdempotencyError {
    /// Backend failure (storage unavailable, serialization, …).
    Backend,
    /// The same key has been used with a different in-flight request and
    /// the cache cannot serve a response yet. Surfaced as HTTP 409.
    Conflict,
}

/// Caller-token cache for HTTP idempotency. Implementations dedupe by
/// `(scope, key)` and serve a previously stored response on replay.
#[async_trait]
pub trait HttpIdempotencyCache: Send + Sync {
    /// Insert a (key, scope) reservation. Returns the previously stored
    /// response if the key is already present.
    async fn record_or_replay(
        &self,
        key: IdempotencyKey,
        scope: HttpIdempotencyScope,
    ) -> Result<HttpIdempotencyDecision, HttpIdempotencyError>;

    /// After the handler completes successfully, store the response so a
    /// retry with the same key returns the same body.
    async fn store_response(
        &self,
        key: IdempotencyKey,
        scope: HttpIdempotencyScope,
        response: HttpStoredResponse,
    ) -> Result<(), HttpIdempotencyError>;
}

/// In-memory [`HttpIdempotencyCache`] for tests and downstream prototyping.
///
/// Not durable, not bounded — production deployments must wire a
/// persistent implementation. This exists so the middleware is testable
/// without a database.
#[derive(Default, Clone)]
pub struct InMemoryHttpIdempotencyCache {
    inner: Arc<Mutex<HashMap<(HttpIdempotencyScope, IdempotencyKey), HttpStoredResponse>>>,
}

impl InMemoryHttpIdempotencyCache {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl HttpIdempotencyCache for InMemoryHttpIdempotencyCache {
    async fn record_or_replay(
        &self,
        key: IdempotencyKey,
        scope: HttpIdempotencyScope,
    ) -> Result<HttpIdempotencyDecision, HttpIdempotencyError> {
        let guard = self.inner.lock().await;
        match guard.get(&(scope, key)) {
            Some(stored) => Ok(HttpIdempotencyDecision::Replay {
                response: stored.clone(),
            }),
            None => Ok(HttpIdempotencyDecision::New),
        }
    }

    async fn store_response(
        &self,
        key: IdempotencyKey,
        scope: HttpIdempotencyScope,
        response: HttpStoredResponse,
    ) -> Result<(), HttpIdempotencyError> {
        let mut guard = self.inner.lock().await;
        guard.insert((scope, key), response);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/// Shared state passed into the middleware closure.
type MiddlewareState = (Arc<dyn HttpIdempotencyCache>, IdempotencyMiddlewareConfig);

/// Axum middleware that extracts an idempotency key per the configured
/// strategy, short-circuits duplicate requests with the stored response,
/// and caches successful (2xx) responses for replay.
///
/// Depends on an upstream auth middleware inserting [`HttpIdempotencyScope`]
/// into request extensions. If the scope extension is missing the request
/// is rejected with `500 Internal Server Error` — wiring this middleware
/// without the auth layer in front is a programmer error.
pub async fn idempotency_middleware(
    State((cache, config)): State<MiddlewareState>,
    request: Request,
    next: Next,
) -> Response {
    // Auth middleware MUST run first and stash the scope. Without it we
    // cannot safely cache responses (cross-caller collision risk), so we
    // refuse to proceed rather than fall back to a global cache.
    let scope = match request.extensions().get::<HttpIdempotencyScope>().cloned() {
        Some(scope) => scope,
        None => {
            return api_error_response(ApiError::new(
                ApiErrorKind::Internal,
                "idempotency middleware requires HttpIdempotencyScope; wire auth middleware first",
            ));
        }
    };

    // Extract the key, possibly buffering and rebuilding the request body.
    let (key, request) = match extract_key(request, &config).await {
        Ok(extracted) => extracted,
        Err(err) => return api_error_response(err),
    };

    let Some(key) = key else {
        // No key found and not required — pass through without caching.
        return next.run(request).await;
    };

    match cache.record_or_replay(key.clone(), scope.clone()).await {
        Ok(HttpIdempotencyDecision::Replay { response }) => {
            return stored_to_response(response);
        }
        Ok(HttpIdempotencyDecision::New) => {}
        Err(HttpIdempotencyError::Conflict) => {
            return api_error_response(ApiError::new(
                ApiErrorKind::Conflict,
                "idempotency key reused while a prior request is still in flight",
            ));
        }
        Err(HttpIdempotencyError::Backend) => {
            return api_error_response(ApiError::new(
                ApiErrorKind::Unavailable,
                "idempotency cache backend unavailable",
            ));
        }
    }

    // Run the inner handler.
    let response = next.run(request).await;
    let status = response.status();

    // Only cache successful responses. 4xx/5xx may legitimately resolve
    // differently on retry (e.g. transient backend error).
    if !status.is_success() {
        return response;
    }

    // Buffer the response body so we can both replay it and return it now.
    let (parts, body) = response.into_parts();
    let body_bytes = match to_bytes(body, config.max_body_bytes).await {
        Ok(bytes) => bytes.to_vec(),
        Err(_) => {
            return api_error_response(ApiError::new(
                ApiErrorKind::Internal,
                "handler response body exceeded idempotency buffer cap",
            ));
        }
    };

    let stored = HttpStoredResponse {
        status: parts.status,
        headers: parts.headers.clone(),
        body: body_bytes.clone(),
    };

    if let Err(err) = cache.store_response(key, scope, stored).await {
        // Don't fail the request when caching fails — the handler already
        // ran. Log via tracing and continue with the live response.
        tracing::warn!(?err, "failed to store idempotency cache entry");
    }

    Response::from_parts(parts, Body::from(body_bytes))
}

/// Build an axum middleware layer that extracts an idempotency key and
/// short-circuits duplicates through the provided cache.
///
/// The return type is an opaque `impl Layer<...>` because the concrete
/// `FromFn` type axum constructs is parameterised by a closure type that
/// cannot be named. Consumers should treat the return value as a
/// `tower::Layer` and pass it to `Router::layer` / `.layer(...)` etc.
pub fn idempotency_layer(
    cache: Arc<dyn HttpIdempotencyCache>,
    config: IdempotencyMiddlewareConfig,
) -> impl Layer<
    axum::routing::Route,
    Service = impl tower::Service<
        Request,
        Response = Response,
        Error = std::convert::Infallible,
        Future = impl Send + 'static,
    > + Clone
              + Send
              + Sync
              + 'static,
> + Clone {
    from_fn_with_state((cache, config), idempotency_middleware)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn extract_key(
    request: Request,
    config: &IdempotencyMiddlewareConfig,
) -> Result<(Option<IdempotencyKey>, Request), ApiError> {
    match &config.extractor {
        IdempotencyKeyExtractor::Header { header_name } => {
            let raw = request
                .headers()
                .get(header_name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            match raw {
                Some(value) => {
                    let key = IdempotencyKey::new(value).map_err(|e| {
                        ApiError::new(
                            ApiErrorKind::InvalidRequest,
                            format!("invalid idempotency header: {e}"),
                        )
                    })?;
                    Ok((Some(key), request))
                }
                None => {
                    if config.required {
                        Err(ApiError::new(
                            ApiErrorKind::InvalidRequest,
                            format!("missing idempotency header: {}", header_name.as_str()),
                        ))
                    } else {
                        Ok((None, request))
                    }
                }
            }
        }
        IdempotencyKeyExtractor::BodyField { field_name } => {
            let (parts, body) = request.into_parts();
            let bytes = match to_bytes(body, config.max_body_bytes).await {
                Ok(b) => b,
                Err(_) => {
                    return Err(ApiError::new(
                        ApiErrorKind::InvalidRequest,
                        format!(
                            "request body exceeds idempotency cap of {} bytes",
                            config.max_body_bytes
                        ),
                    ));
                }
            };

            let key_opt = if bytes.is_empty() {
                None
            } else {
                let parsed: JsonValue = match serde_json::from_slice(&bytes) {
                    Ok(v) => v,
                    Err(_) => {
                        // Body is not JSON — rebuild and let the handler decide.
                        let rebuilt = Request::from_parts(parts, Body::from(bytes.to_vec()));
                        return if config.required {
                            Err(ApiError::new(
                                ApiErrorKind::InvalidRequest,
                                format!(
                                    "request body must be JSON containing '{}' field",
                                    field_name
                                ),
                            ))
                        } else {
                            Ok((None, rebuilt))
                        };
                    }
                };
                parsed
                    .get(field_name.as_str())
                    .and_then(JsonValue::as_str)
                    .map(str::to_owned)
            };

            // Rebuild the request with the buffered body so the inner
            // handler still sees it.
            let request = Request::from_parts(parts, Body::from(bytes.to_vec()));

            match key_opt {
                Some(value) => {
                    let key = IdempotencyKey::new(value).map_err(|e| {
                        ApiError::new(
                            ApiErrorKind::InvalidRequest,
                            format!("invalid '{}' field: {e}", field_name),
                        )
                    })?;
                    Ok((Some(key), request))
                }
                None => {
                    if config.required {
                        Err(ApiError::new(
                            ApiErrorKind::InvalidRequest,
                            format!("missing '{}' field in request body", field_name),
                        ))
                    } else {
                        Ok((None, request))
                    }
                }
            }
        }
    }
}

fn stored_to_response(stored: HttpStoredResponse) -> Response {
    let mut builder = Response::builder().status(stored.status);
    if let Some(headers) = builder.headers_mut() {
        *headers = stored.headers;
    }
    match builder.body(Body::from(stored.body)) {
        Ok(resp) => resp,
        Err(_) => api_error_response(ApiError::new(
            ApiErrorKind::Internal,
            "failed to rebuild cached response",
        )),
    }
}

/// Render an [`ApiError`] as an axum [`Response`]. Delegates to the
/// `IntoResponse` impl in `error.rs` which is the single source of truth
/// for the wire shape and tracing emission.
fn api_error_response(err: ApiError) -> Response {
    err.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::{
        Router,
        body::Body,
        http::{Request, StatusCode},
        middleware::from_fn,
        routing::post,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt; // for `oneshot`

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    fn test_scope() -> HttpIdempotencyScope {
        HttpIdempotencyScope {
            tenant_id: TenantId::new("tenant-a").expect("tenant id"),
            user_id: UserId::new("user-a").expect("user id"),
        }
    }

    fn other_scope() -> HttpIdempotencyScope {
        HttpIdempotencyScope {
            tenant_id: TenantId::new("tenant-b").expect("tenant id"),
            user_id: UserId::new("user-b").expect("user id"),
        }
    }

    async fn inject_scope_layer(
        scope: HttpIdempotencyScope,
        mut request: Request<Body>,
        next: Next,
    ) -> Response {
        request.extensions_mut().insert(scope);
        next.run(request).await
    }

    fn router_with_middleware(
        cache: Arc<dyn HttpIdempotencyCache>,
        config: IdempotencyMiddlewareConfig,
        scope: HttpIdempotencyScope,
        handler_calls: Arc<AtomicUsize>,
    ) -> Router {
        let counter = handler_calls.clone();
        let handler = move |body: String| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                (StatusCode::OK, format!("handled:{body}"))
            }
        };

        // Outer layer (runs first) injects the scope; then idempotency;
        // then the route. Note that axum layer order is "outer wraps
        // inner", so the layer added LAST runs FIRST on the request.
        Router::new()
            .route("/test", post(handler))
            .layer(idempotency_layer(cache, config))
            .layer(from_fn(move |req, next| {
                let scope = scope.clone();
                async move { inject_scope_layer(scope, req, next).await }
            }))
    }

    fn failing_router(
        cache: Arc<dyn HttpIdempotencyCache>,
        config: IdempotencyMiddlewareConfig,
        scope: HttpIdempotencyScope,
        handler_calls: Arc<AtomicUsize>,
    ) -> Router {
        let counter = handler_calls.clone();
        let handler = move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                (StatusCode::INTERNAL_SERVER_ERROR, "boom")
            }
        };

        Router::new()
            .route("/test", post(handler))
            .layer(idempotency_layer(cache, config))
            .layer(from_fn(move |req, next| {
                let scope = scope.clone();
                async move { inject_scope_layer(scope, req, next).await }
            }))
    }

    async fn body_string(resp: Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .expect("collect body");
        String::from_utf8(bytes.to_vec()).expect("utf-8 body")
    }

    // -----------------------------------------------------------------
    // 1. IdempotencyKey constructor validates
    // -----------------------------------------------------------------

    #[test]
    fn idempotency_key_constructor_validates() {
        assert!(IdempotencyKey::new("").is_err());
        assert!(IdempotencyKey::new("ok-key-123").is_ok());
        assert!(IdempotencyKey::new("a".repeat(257)).is_err());
        assert!(IdempotencyKey::new("a\0b").is_err());
        assert!(IdempotencyKey::new("a b").is_err());
        assert!(IdempotencyKey::new("a\nb").is_err());
    }

    // -----------------------------------------------------------------
    // 2. Header extractor: missing key returns 400 when required
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn header_extractor_missing_key_returns_400_when_required() {
        let cache: Arc<dyn HttpIdempotencyCache> = Arc::new(InMemoryHttpIdempotencyCache::new());
        let config = IdempotencyMiddlewareConfig::header(
            http::HeaderName::from_static("idempotency-key"),
            true,
        );
        let handler_calls = Arc::new(AtomicUsize::new(0));
        let app = router_with_middleware(cache, config, test_scope(), handler_calls.clone());

        let req = Request::builder()
            .method("POST")
            .uri("/test")
            .body(Body::from("hello"))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(handler_calls.load(Ordering::SeqCst), 0);
        let body = body_string(resp).await;
        assert!(body.contains("invalid_request_error"), "body: {body}");
    }

    // -----------------------------------------------------------------
    // 3. Header extractor: missing key passes through when not required
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn header_extractor_missing_key_passes_through_when_not_required() {
        let cache: Arc<dyn HttpIdempotencyCache> = Arc::new(InMemoryHttpIdempotencyCache::new());
        let config = IdempotencyMiddlewareConfig::header(
            http::HeaderName::from_static("idempotency-key"),
            false,
        );
        let handler_calls = Arc::new(AtomicUsize::new(0));
        let app = router_with_middleware(cache, config, test_scope(), handler_calls.clone());

        let req = Request::builder()
            .method("POST")
            .uri("/test")
            .body(Body::from("hello"))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(handler_calls.load(Ordering::SeqCst), 1);
    }

    // -----------------------------------------------------------------
    // 4. Body-field extractor extracts client_action_id from JSON body
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn body_field_extractor_extracts_client_action_id_from_body() {
        let cache: Arc<dyn HttpIdempotencyCache> = Arc::new(InMemoryHttpIdempotencyCache::new());
        let config = IdempotencyMiddlewareConfig::body_field("client_action_id", true);
        let handler_calls = Arc::new(AtomicUsize::new(0));
        let app = router_with_middleware(cache, config, test_scope(), handler_calls.clone());

        let body = serde_json::json!({
            "client_action_id": "abc",
            "other": "data",
        });
        let req = Request::builder()
            .method("POST")
            .uri("/test")
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(handler_calls.load(Ordering::SeqCst), 1);

        // Handler received the original body (echoed) — so body buffering
        // and rebuild round-tripped the bytes correctly.
        let received = body_string(resp).await;
        assert!(received.starts_with("handled:"), "got: {received}");
        assert!(received.contains("client_action_id"), "got: {received}");
    }

    // -----------------------------------------------------------------
    // 5. Replay returns stored response without running handler twice
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn replay_returns_stored_response_without_running_handler() {
        let cache: Arc<dyn HttpIdempotencyCache> = Arc::new(InMemoryHttpIdempotencyCache::new());
        let config = IdempotencyMiddlewareConfig::header(
            http::HeaderName::from_static("idempotency-key"),
            true,
        );
        let handler_calls = Arc::new(AtomicUsize::new(0));

        let app = || {
            router_with_middleware(
                cache.clone(),
                config.clone(),
                test_scope(),
                handler_calls.clone(),
            )
        };

        // First request — runs the handler, caches the response.
        let req = Request::builder()
            .method("POST")
            .uri("/test")
            .header("idempotency-key", "key-1")
            .body(Body::from("payload"))
            .unwrap();
        let resp = app().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let first_body = body_string(resp).await;

        // Second request with the same key — replays the cached response.
        let req = Request::builder()
            .method("POST")
            .uri("/test")
            .header("idempotency-key", "key-1")
            .body(Body::from("DIFFERENT"))
            .unwrap();
        let resp = app().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let second_body = body_string(resp).await;

        assert_eq!(handler_calls.load(Ordering::SeqCst), 1);
        assert_eq!(first_body, second_body);
    }

    // -----------------------------------------------------------------
    // 6. Non-2xx response is not cached
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn non_2xx_response_is_not_cached() {
        let cache: Arc<dyn HttpIdempotencyCache> = Arc::new(InMemoryHttpIdempotencyCache::new());
        let config = IdempotencyMiddlewareConfig::header(
            http::HeaderName::from_static("idempotency-key"),
            true,
        );
        let handler_calls = Arc::new(AtomicUsize::new(0));

        let app = || {
            failing_router(
                cache.clone(),
                config.clone(),
                test_scope(),
                handler_calls.clone(),
            )
        };

        let req = Request::builder()
            .method("POST")
            .uri("/test")
            .header("idempotency-key", "key-fail")
            .body(Body::empty())
            .unwrap();
        let resp = app().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);

        // Retry — handler should run again.
        let req = Request::builder()
            .method("POST")
            .uri("/test")
            .header("idempotency-key", "key-fail")
            .body(Body::empty())
            .unwrap();
        let resp = app().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);

        assert_eq!(handler_calls.load(Ordering::SeqCst), 2);
    }

    // -----------------------------------------------------------------
    // 7. Different scopes don't collide
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn different_scopes_dont_collide() {
        let cache: Arc<dyn HttpIdempotencyCache> = Arc::new(InMemoryHttpIdempotencyCache::new());
        let config = IdempotencyMiddlewareConfig::header(
            http::HeaderName::from_static("idempotency-key"),
            true,
        );

        let handler_calls_a = Arc::new(AtomicUsize::new(0));
        let app_a = router_with_middleware(
            cache.clone(),
            config.clone(),
            test_scope(),
            handler_calls_a.clone(),
        );

        let req = Request::builder()
            .method("POST")
            .uri("/test")
            .header("idempotency-key", "shared-key")
            .body(Body::from("scope-a"))
            .unwrap();
        let resp_a = app_a.oneshot(req).await.unwrap();
        assert_eq!(resp_a.status(), StatusCode::OK);

        // Same key under a different scope must NOT replay.
        let handler_calls_b = Arc::new(AtomicUsize::new(0));
        let app_b = router_with_middleware(
            cache.clone(),
            config.clone(),
            other_scope(),
            handler_calls_b.clone(),
        );
        let req = Request::builder()
            .method("POST")
            .uri("/test")
            .header("idempotency-key", "shared-key")
            .body(Body::from("scope-b"))
            .unwrap();
        let resp_b = app_b.oneshot(req).await.unwrap();
        assert_eq!(resp_b.status(), StatusCode::OK);

        // Each scope ran its own handler exactly once.
        assert_eq!(handler_calls_a.load(Ordering::SeqCst), 1);
        assert_eq!(handler_calls_b.load(Ordering::SeqCst), 1);

        let body_a = body_string(resp_a).await;
        let body_b = body_string(resp_b).await;
        assert_ne!(body_a, body_b);
    }

    // -----------------------------------------------------------------
    // 8. InMemoryHttpIdempotencyCache round-trips stored response
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn in_memory_cache_round_trips_stored_response() {
        let cache = InMemoryHttpIdempotencyCache::new();
        let key = IdempotencyKey::new("rt-key").unwrap();
        let scope = test_scope();

        // First lookup — new.
        let decision = cache
            .record_or_replay(key.clone(), scope.clone())
            .await
            .unwrap();
        assert!(matches!(decision, HttpIdempotencyDecision::New));

        let mut headers = http::HeaderMap::new();
        headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("text/plain"),
        );
        let stored = HttpStoredResponse {
            status: StatusCode::OK,
            headers: headers.clone(),
            body: b"hello".to_vec(),
        };
        cache
            .store_response(key.clone(), scope.clone(), stored.clone())
            .await
            .unwrap();

        // Second lookup — replay.
        let decision = cache.record_or_replay(key, scope).await.unwrap();
        match decision {
            HttpIdempotencyDecision::Replay { response } => {
                assert_eq!(response.status, StatusCode::OK);
                assert_eq!(response.body, b"hello".to_vec());
                assert_eq!(
                    response
                        .headers
                        .get(http::header::CONTENT_TYPE)
                        .map(|v| v.to_str().unwrap_or("")),
                    Some("text/plain")
                );
            }
            _ => panic!("expected replay"),
        }
    }

    // -----------------------------------------------------------------
    // 9. Oversized body for body-field extractor returns 400
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn oversized_body_for_body_field_extractor_returns_400() {
        let cache: Arc<dyn HttpIdempotencyCache> = Arc::new(InMemoryHttpIdempotencyCache::new());
        let mut config = IdempotencyMiddlewareConfig::body_field("client_action_id", true);
        config.max_body_bytes = 32; // tiny cap to force overflow
        let handler_calls = Arc::new(AtomicUsize::new(0));
        let app = router_with_middleware(cache, config, test_scope(), handler_calls.clone());

        let body = serde_json::json!({
            "client_action_id": "abc",
            "filler": "x".repeat(1024),
        });
        let req = Request::builder()
            .method("POST")
            .uri("/test")
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(handler_calls.load(Ordering::SeqCst), 0);
    }
}
