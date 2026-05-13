//! Server-Sent Events rendering of [`super::ProjectionStreamItem`].
//!
//! ## Cursor authority
//!
//! Reborn SSE deliberately does **not** emit an `id:` field on its frames.
//! Cursor authority is the [`ProjectionCursor`] carried inside the data
//! payload of `Snapshot` / `Update` / `RebaseRequired` / `Lagged` frames.
//! Clients must resume from that cursor, never from `Last-Event-ID` /
//! `last_event_id`. See issues #3266 and #3281 — accepting the SSE `id:`
//! field as a resume token would let a network-local identifier override
//! the scope-bound projection cursor and silently skip records when scopes
//! don't match.
//!
//! ## Heartbeat
//!
//! The adapter installs an axum `KeepAlive` with a 30-second interval to
//! match v1 SSE behaviour (`src/channels/web/platform/sse.rs`) and the
//! conservative end of common proxy idle timeouts. The keep-alive frame
//! carries the literal text `"keep-alive"` so it is distinguishable in
//! transcripts from genuine [`ProjectionStreamItem::KeepAlive`] frames
//! (which travel as a `keep_alive`-tagged event with a JSON body).

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::response::Sse;
use axum::response::sse::{Event, KeepAlive};
use futures_util::{Stream, StreamExt};
use ironclaw_event_projections::ProjectionCursor;
use tokio::sync::Mutex;

use super::ProjectionStreamItem;

/// SSE keep-alive interval. Matches the v1 gateway SSE cadence
/// (`src/channels/web/platform/sse.rs`) so any operator tuning aimed at
/// proxy idle timeouts applies uniformly across v1 and Reborn surfaces.
pub const KEEPALIVE_INTERVAL_SECS: u64 = 30;

/// Adapt an arbitrary [`ProjectionStreamItem`] stream into an axum
/// [`Sse`] response.
///
/// The error parameter `E` lets handlers thread their own transport-side
/// error type through to axum's `Sse` without forcing a single concrete
/// error here. The mapping function inside this adapter never produces
/// errors — every item is rendered to an [`Event`] — but the outer stream
/// signature is `Result<Event, E>` because that is what axum's `Sse`
/// accepts.
///
/// The returned response carries a `KeepAlive` set to
/// [`KEEPALIVE_INTERVAL_SECS`] seconds with the literal text
/// `"keep-alive"`. The body of every emitted [`Event`] is the JSON
/// representation of the [`ProjectionStreamItem`] (so `Snapshot`,
/// `Update`, etc. include their [`ProjectionCursor`] payload), and the
/// `event:` line carries the snake_case wire tag from
/// [`super::ProjectionStreamItemKind::as_wire_str`].
pub fn into_sse<S, E>(stream: S) -> Sse<impl Stream<Item = Result<Event, E>> + Send + 'static>
where
    S: Stream<Item = ProjectionStreamItem> + Send + 'static,
    E: std::error::Error + Send + Sync + 'static,
{
    let mapped = stream.map(|item| Ok::<_, E>(projection_item_to_sse_event(item)));

    Sse::new(mapped).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS))
            .text("keep-alive"),
    )
}

/// Render a single [`ProjectionStreamItem`] to an SSE [`Event`].
///
/// Deliberately omits `.id(...)` — see the module docs. Clients resume via
/// the [`ProjectionCursor`] carried in the JSON payload of the data field,
/// not via `Last-Event-ID`.
fn projection_item_to_sse_event(item: ProjectionStreamItem) -> Event {
    let kind = item.kind();
    // `ProjectionStreamItem` is a plain enum with `serde::Serialize` —
    // serialisation cannot fail for any in-tree variant. The fallback
    // keeps the SSE stream alive on the impossible failure path instead
    // of breaking the connection; per `error-handling.md`, this is a
    // documented silent-ok (transport-only, projection rendering must
    // not crash the subscription).
    let data = serde_json::to_string(&item).unwrap_or_else(|_| "{}".to_string()); // silent-ok: SSE render must not break the stream
    Event::default().event(kind.as_wire_str()).data(data)
    // Deliberately NO `.id(...)` — cursor authority is the
    // `ProjectionCursor` in the data payload, NOT the SSE id field
    // (per #3266 / #3281). Adding an SSE id here would invite clients
    // to resume via `Last-Event-ID` and bypass scope validation.
}

/// Stream wrapper that records the most recent [`ProjectionCursor`] seen
/// on a [`ProjectionStreamItem`] stream.
///
/// Useful for handlers that want to log / observe cursor advancement
/// without splitting or buffering the underlying stream. The cursor
/// handle is shared via [`Arc<Mutex<Option<ProjectionCursor>>>`] so the
/// handler can keep reading the latest cursor while the wrapped stream
/// is being polled by the SSE/WS adapter.
///
/// Semantics by variant:
///
/// - [`ProjectionStreamItem::Snapshot`] and
///   [`ProjectionStreamItem::Update`] both advance the recorded cursor to
///   the variant's `cursor` field.
/// - [`ProjectionStreamItem::RebaseRequired`] and
///   [`ProjectionStreamItem::Lagged`] both advance the recorded cursor to
///   their `snapshot_cursor` field (the resume base after rebase).
/// - [`ProjectionStreamItem::KeepAlive`] does **not** modify the recorded
///   cursor — keep-alive carries no cursor authority.
pub struct CursorTrackedStream<S> {
    inner: S,
    last_cursor: Arc<Mutex<Option<ProjectionCursor>>>,
}

impl<S> CursorTrackedStream<S>
where
    S: Stream<Item = ProjectionStreamItem>,
{
    /// Wrap `inner`, returning the wrapped stream and a shared handle to
    /// the latest-seen cursor. The handle is initialised to `None`; it
    /// transitions to `Some(..)` on the first cursor-bearing item.
    pub fn new(inner: S) -> (Self, Arc<Mutex<Option<ProjectionCursor>>>) {
        let last_cursor = Arc::new(Mutex::new(None));
        let stream = Self {
            inner,
            last_cursor: Arc::clone(&last_cursor),
        };
        (stream, last_cursor)
    }
}

impl<S> Stream for CursorTrackedStream<S>
where
    S: Stream<Item = ProjectionStreamItem> + Unpin,
{
    type Item = ProjectionStreamItem;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_next(cx) {
            Poll::Ready(Some(item)) => {
                // Snapshot the cursor we'll record (cloned at most once
                // per item) before yielding so a downstream consumer
                // never sees a frame before its cursor is reflected in
                // the tracker.
                let next_cursor: Option<ProjectionCursor> = match &item {
                    ProjectionStreamItem::Snapshot { cursor, .. }
                    | ProjectionStreamItem::Update { cursor, .. } => Some(cursor.clone()),
                    ProjectionStreamItem::RebaseRequired {
                        snapshot_cursor, ..
                    }
                    | ProjectionStreamItem::Lagged {
                        snapshot_cursor, ..
                    } => Some(snapshot_cursor.clone()),
                    ProjectionStreamItem::KeepAlive => None,
                };
                if let Some(c) = next_cursor {
                    // `try_lock` is sound here because the tokio Mutex
                    // is uncontended in the steady state (only the
                    // poll loop writes). If a reader happens to hold
                    // it, we defer updating the cursor until the next
                    // item rather than blocking the poll. The handle
                    // remains observable; the writer side is
                    // best-effort by design.
                    if let Ok(mut guard) = this.last_cursor.try_lock() {
                        *guard = Some(c);
                    }
                }
                Poll::Ready(Some(item))
            }
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use futures_util::stream;
    use ironclaw_event_projections::{ProjectionCursor, ProjectionScope};
    use ironclaw_events::{EventCursor, EventStreamKey, ReadScope};
    use ironclaw_host_api::{AgentId, TenantId, UserId};

    use crate::projection::{ProjectionStreamLagReason, ProjectionStreamRebaseReason};

    fn test_scope() -> ProjectionScope {
        ProjectionScope {
            stream: EventStreamKey::new(
                TenantId::new("tenant").expect("valid tenant id"),
                UserId::new("user").expect("valid user id"),
                Some(AgentId::new("agent").expect("valid agent id")),
            ),
            read_scope: ReadScope::any(),
        }
    }

    fn cursor_at(n: u64) -> ProjectionCursor {
        ProjectionCursor::for_scope(test_scope(), EventCursor::new(n))
    }

    // ---- Event rendering ------------------------------------------------

    /// Helper: render an event to its on-the-wire SSE frame bytes via the
    /// public `IntoResponse` path. Returns the rendered body so tests can
    /// assert against the `event:` / `data:` / `id:` lines directly.
    async fn render_event_to_wire(event: Event) -> String {
        use axum::body::to_bytes;
        use axum::response::IntoResponse;

        let response =
            Sse::new(stream::iter(vec![Ok::<_, std::convert::Infallible>(event)])).into_response();
        let body = response.into_body();
        let bytes = to_bytes(body, usize::MAX)
            .await
            .expect("collect sse body bytes");
        String::from_utf8(bytes.to_vec()).expect("sse body is utf-8")
    }

    #[tokio::test]
    async fn snapshot_event_carries_snake_case_kind_and_full_payload() {
        let item = ProjectionStreamItem::Snapshot {
            cursor: cursor_at(7),
            payload: serde_json::json!({ "rows": [1, 2, 3] }),
        };
        let event = projection_item_to_sse_event(item.clone());
        let wire = render_event_to_wire(event).await;

        assert!(
            wire.contains("event: snapshot"),
            "missing event:snapshot in {wire:?}"
        );
        // Data must contain the serialised item including the cursor and payload.
        let serialised = serde_json::to_string(&item).expect("serialise snapshot");
        assert!(
            wire.contains(&format!("data: {serialised}")),
            "missing data line carrying snapshot payload in {wire:?}"
        );
    }

    #[tokio::test]
    async fn update_event_carries_snake_case_kind_and_payload() {
        let item = ProjectionStreamItem::Update {
            cursor: cursor_at(11),
            payload: serde_json::json!({ "delta": "value" }),
        };
        let event = projection_item_to_sse_event(item.clone());
        let wire = render_event_to_wire(event).await;

        assert!(
            wire.contains("event: update"),
            "missing event:update in {wire:?}"
        );
        let serialised = serde_json::to_string(&item).expect("serialise update");
        assert!(
            wire.contains(&format!("data: {serialised}")),
            "missing data line carrying update payload in {wire:?}"
        );
    }

    #[tokio::test]
    async fn rebase_required_event_carries_reason_and_snapshot_cursor() {
        let item = ProjectionStreamItem::RebaseRequired {
            reason: ProjectionStreamRebaseReason::CursorAhead,
            snapshot_cursor: cursor_at(42),
        };
        let event = projection_item_to_sse_event(item.clone());
        let wire = render_event_to_wire(event).await;

        assert!(
            wire.contains("event: rebase_required"),
            "missing event:rebase_required in {wire:?}"
        );
        let serialised = serde_json::to_string(&item).expect("serialise rebase_required");
        assert!(
            wire.contains(&format!("data: {serialised}")),
            "missing rebase_required payload in {wire:?}"
        );
        // The reason and snapshot cursor must show up in the payload.
        assert!(
            wire.contains("cursor_ahead"),
            "missing rebase reason in {wire:?}"
        );
    }

    #[tokio::test]
    async fn lagged_event_carries_reason_and_snapshot_cursor() {
        let item = ProjectionStreamItem::Lagged {
            reason: ProjectionStreamLagReason::BufferOverflow,
            snapshot_cursor: cursor_at(99),
        };
        let event = projection_item_to_sse_event(item.clone());
        let wire = render_event_to_wire(event).await;

        assert!(
            wire.contains("event: lagged"),
            "missing event:lagged in {wire:?}"
        );
        let serialised = serde_json::to_string(&item).expect("serialise lagged");
        assert!(
            wire.contains(&format!("data: {serialised}")),
            "missing lagged payload in {wire:?}"
        );
        assert!(
            wire.contains("buffer_overflow"),
            "missing lag reason in {wire:?}"
        );
    }

    #[tokio::test]
    async fn keep_alive_event_has_no_payload_but_correct_kind() {
        let item = ProjectionStreamItem::KeepAlive;
        let event = projection_item_to_sse_event(item.clone());
        let wire = render_event_to_wire(event).await;

        assert!(
            wire.contains("event: keep_alive"),
            "missing event:keep_alive in {wire:?}"
        );
        // KeepAlive serialises to `{"kind":"keep_alive"}`.
        let serialised = serde_json::to_string(&item).expect("serialise keep_alive");
        assert_eq!(serialised, r#"{"kind":"keep_alive"}"#);
        assert!(
            wire.contains(&format!("data: {serialised}")),
            "missing keep_alive payload in {wire:?}"
        );
    }

    #[tokio::test]
    async fn sse_response_omits_id_field_to_enforce_cursor_only_resume() {
        // Render one of every cursor-bearing variant plus keep_alive and
        // assert none of the rendered events include an `id:` line. The
        // Reborn SSE contract is cursor-only resume (#3266 / #3281); an
        // `id:` line here would invite clients to resume via
        // `Last-Event-ID` and bypass scope validation.
        let items = vec![
            ProjectionStreamItem::Snapshot {
                cursor: cursor_at(1),
                payload: serde_json::json!({}),
            },
            ProjectionStreamItem::Update {
                cursor: cursor_at(2),
                payload: serde_json::json!({}),
            },
            ProjectionStreamItem::RebaseRequired {
                reason: ProjectionStreamRebaseReason::CursorMalformed,
                snapshot_cursor: cursor_at(3),
            },
            ProjectionStreamItem::Lagged {
                reason: ProjectionStreamLagReason::SlowConsumer,
                snapshot_cursor: cursor_at(4),
            },
            ProjectionStreamItem::KeepAlive,
        ];
        for item in items {
            let event = projection_item_to_sse_event(item.clone());
            let wire = render_event_to_wire(event).await;

            // SSE frames separate fields with newlines; check that no
            // line starts with `id:` (the SSE `id` field on the wire).
            for line in wire.lines() {
                assert!(
                    !line.starts_with("id:") && !line.starts_with("id "),
                    "projection SSE frame must not carry id field: {wire:?} (item {item:?})"
                );
            }
        }
    }

    // ---- Cursor tracking -----------------------------------------------

    #[tokio::test]
    async fn cursor_tracked_stream_records_latest_cursor_from_snapshot_and_update() {
        let items = vec![
            ProjectionStreamItem::Snapshot {
                cursor: cursor_at(1),
                payload: serde_json::json!({}),
            },
            ProjectionStreamItem::Update {
                cursor: cursor_at(2),
                payload: serde_json::json!({}),
            },
            ProjectionStreamItem::Update {
                cursor: cursor_at(3),
                payload: serde_json::json!({}),
            },
        ];
        let (tracked, handle) = CursorTrackedStream::new(stream::iter(items));

        // Drain the stream — consume every item.
        let collected: Vec<ProjectionStreamItem> = tracked.collect().await;
        assert_eq!(collected.len(), 3);

        let observed = handle.lock().await.clone();
        assert_eq!(
            observed,
            Some(cursor_at(3)),
            "tracker must reflect last Update cursor"
        );
    }

    #[tokio::test]
    async fn cursor_tracked_stream_records_cursor_from_rebase_and_lagged() {
        let items = vec![
            ProjectionStreamItem::RebaseRequired {
                reason: ProjectionStreamRebaseReason::SubscriptionExpired,
                snapshot_cursor: cursor_at(10),
            },
            ProjectionStreamItem::Lagged {
                reason: ProjectionStreamLagReason::BufferOverflow,
                snapshot_cursor: cursor_at(20),
            },
        ];
        let (tracked, handle) = CursorTrackedStream::new(stream::iter(items));
        let _: Vec<_> = tracked.collect().await;

        let observed = handle.lock().await.clone();
        assert_eq!(
            observed,
            Some(cursor_at(20)),
            "tracker must reflect Lagged snapshot_cursor"
        );
    }

    #[tokio::test]
    async fn cursor_tracked_stream_keeps_prior_cursor_after_keep_alive() {
        let items = vec![
            ProjectionStreamItem::Snapshot {
                cursor: cursor_at(5),
                payload: serde_json::json!({}),
            },
            ProjectionStreamItem::KeepAlive,
            ProjectionStreamItem::KeepAlive,
        ];
        let (tracked, handle) = CursorTrackedStream::new(stream::iter(items));
        let _: Vec<_> = tracked.collect().await;

        let observed = handle.lock().await.clone();
        assert_eq!(
            observed,
            Some(cursor_at(5)),
            "KeepAlive must not modify the tracked cursor"
        );
    }
}
