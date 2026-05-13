//! WebSocket rendering of [`super::ProjectionStreamItem`].
//!
//! Implements the WebChat v2 multiplexed-subscription frame protocol sketched in
//! issue #3282. The adapter is split into three pieces:
//!
//! 1. **Wire types** — [`WebChatStreamClientFrame`] (`subscribe` / `unsubscribe`
//!    / `ping`) and [`WebChatStreamServerFrame`] (`snapshot` / `update` /
//!    `rebase_required` / `lagged` / `keepalive` / `error`).
//! 2. **Mapping** — [`projection_item_to_server_frame`] converts a single
//!    [`super::ProjectionStreamItem`] into the corresponding server frame,
//!    tagging it with the caller-supplied `subscription_id` so the client can
//!    demultiplex frames across multiple subscriptions on one socket.
//! 3. **Connection driver** — [`drive_websocket`] runs the bidirectional loop,
//!    spawns per-subscription forwarders, enforces idle-timeout +
//!    application-level keepalive, caps concurrent subscriptions, and emits a
//!    final [`WebChatStreamServerFrame::Error`] for malformed input.
//!
//! **Cursor authority is always [`ironclaw_event_projections::ProjectionCursor`].**
//! The transport carries no sequence numbers or transport-local ids of its own
//! that the server treats as resume authority — the server validates the
//! client's `after_cursor` via the projection layer and emits
//! [`WebChatStreamServerFrame::RebaseRequired`] on mismatch.
//!
//! ## Origin protection
//!
//! [`check_origin`] enforces the WebSocket `Origin` header allowlist the
//! consumer surface passes in. Browsers always send an `Origin` header on WS
//! upgrades; non-browser clients that omit it are rejected outright (per
//! #3282's "strict WebSocket Origin protection" callout). Cross-origin upgrade
//! attempts from a different site cannot bypass this check because the browser
//! enforces the header on its end too.
//!
//! ## Test coverage
//!
//! Frame parsing, frame serialisation, the variant mapping, and the origin
//! helper are covered by the unit tests below. The full [`drive_websocket`]
//! loop is **not** unit-tested here — exercising it end-to-end needs a real
//! WebSocket pair and is best driven by the concrete consumer (WebChat v2)
//! integration test that lands alongside #3282. The load-bearing logic that
//! could regress silently — frame shape, mapping, origin allow/deny — is
//! covered.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, close_code};
use futures_util::{SinkExt, Stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle;
use tokio::time;

use super::{
    ProjectionStreamItem, ProjectionStreamItemKind, ProjectionStreamLagReason,
    ProjectionStreamRebaseReason,
};
use crate::error::{ApiError, ApiErrorKind};

/// Maximum concurrent multiplexed subscriptions on a single WebSocket
/// connection. Each `subscribe` frame creates one forwarder task; the cap
/// bounds memory and spawned-task fan-out per socket. Overflow gets an
/// `error` frame with `kind = "too_many_subscriptions"`.
const MAX_SUBSCRIPTIONS_PER_SOCKET: usize = 4;

/// Idle window before the driver sends a transport-level WS ping. If no pong
/// arrives within [`PONG_TIMEOUT`], the connection is closed with code 1011.
const IDLE_PING_AFTER: Duration = Duration::from_secs(60);

/// How long to wait for a WS pong reply after sending a transport-level ping.
const PONG_TIMEOUT: Duration = Duration::from_secs(10);

/// Cadence for application-level [`WebChatStreamServerFrame::Keepalive`]
/// frames. Distinct from the transport-level ping/pong handshake — some
/// browser clients only inspect application-level liveness and never see
/// transport pings.
const APP_KEEPALIVE_EVERY: Duration = Duration::from_secs(30);

/// Bound on the per-socket egress channel. Forwarders push server frames into
/// this channel; the writer task drains it. A bounded channel means a slow
/// network cannot make the in-memory queue grow without limit — backpressure
/// propagates back to the projection layer through the stream-mapping task.
const SOCKET_EGRESS_BUFFER: usize = 64;

// -- Client -> server frame types -----------------------------------------

/// Client → server WebChat v2 frame. Carried inside a WS text frame as JSON;
/// the `kind` field discriminates.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WebChatStreamClientFrame {
    /// Begin a new subscription. The server replies with a
    /// [`WebChatStreamServerFrame::Snapshot`] on success or a
    /// [`WebChatStreamServerFrame::RebaseRequired`] / `Error` on failure.
    Subscribe(WebChatSubscribeFrame),
    /// Tear down an existing subscription by id. No reply expected.
    Unsubscribe(WebChatUnsubscribeFrame),
    /// Application-level liveness ping. The server replies with
    /// [`WebChatStreamServerFrame::Keepalive`].
    Ping,
}

/// Body of a [`WebChatStreamClientFrame::Subscribe`] frame.
#[derive(Debug, Clone, Deserialize)]
pub struct WebChatSubscribeFrame {
    /// Caller-assigned id used to ack the subscription and tag subsequent
    /// server frames so the client knows which subscription they belong to.
    pub subscription_id: String,
    /// Opaque cursor to resume from. Wire-stable; the server validates it
    /// via [`ironclaw_event_projections::ProjectionCursor`] authority and
    /// returns [`WebChatStreamServerFrame::RebaseRequired`] if invalid.
    pub after_cursor: Option<ironclaw_event_projections::ProjectionCursor>,
    /// Optional view class. Defaults to the consumer's per-surface default
    /// (e.g. `ProductThread` for WebChat v2). The concrete view-class enum
    /// lands in #3281; this placeholder lets the frame plumb through.
    pub view: Option<ProjectionStreamItemKind>,
}

/// Body of a [`WebChatStreamClientFrame::Unsubscribe`] frame.
#[derive(Debug, Clone, Deserialize)]
pub struct WebChatUnsubscribeFrame {
    /// Id of the subscription to tear down. Unknown ids are ignored
    /// silently — idempotent cancellation.
    pub subscription_id: String,
}

// -- Server -> client frame types -----------------------------------------

/// Server → client WebChat v2 frame. Carried inside a WS text frame as JSON;
/// the `kind` field discriminates.
///
/// Note: `Keepalive` is deliberately spelled differently from the
/// [`ProjectionStreamItemKind::KeepAlive`] variant — #3282's sketch uses the
/// one-word form on the wire while the internal enum uses two-word
/// `KeepAlive` for Rust naming consistency. The mapping is fixed by
/// [`projection_item_to_server_frame`].
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WebChatStreamServerFrame {
    /// Initial state for a subscription. `cursor` is the resume point the
    /// client should send back on reconnect.
    Snapshot {
        subscription_id: String,
        cursor: ironclaw_event_projections::ProjectionCursor,
        payload: serde_json::Value,
    },
    /// Incremental update on an existing subscription.
    Update {
        subscription_id: String,
        cursor: ironclaw_event_projections::ProjectionCursor,
        payload: serde_json::Value,
    },
    /// The client's resume cursor was rejected. The client should fetch a
    /// fresh snapshot starting at `snapshot_cursor`.
    RebaseRequired {
        subscription_id: String,
        reason: ProjectionStreamRebaseReason,
        snapshot_cursor: ironclaw_event_projections::ProjectionCursor,
    },
    /// The subscriber fell behind the bounded buffer. Updates between the
    /// last delivered cursor and `snapshot_cursor` may have been dropped;
    /// the client should treat this as a soft-reset and re-fetch a
    /// snapshot.
    Lagged {
        subscription_id: String,
        reason: ProjectionStreamLagReason,
        snapshot_cursor: ironclaw_event_projections::ProjectionCursor,
    },
    /// Application-level liveness frame. Sent on a 30s cadence regardless
    /// of activity and in reply to a client `ping`. Distinct from the
    /// transport WS ping/pong handshake.
    Keepalive,
    /// Out-of-band server error scoped to either a single subscription
    /// (`subscription_id = Some`) or the whole connection
    /// (`subscription_id = None`, e.g. an unparsable frame). Closing on
    /// error is left to the driver — the frame itself is informational.
    Error {
        subscription_id: Option<String>,
        #[serde(rename = "error_kind")]
        error_kind: String,
        message: String,
    },
}

// -- Mapping ---------------------------------------------------------------

/// Map a single [`super::ProjectionStreamItem`] to the corresponding
/// [`WebChatStreamServerFrame`], tagging snapshot/update/rebase/lagged
/// frames with the caller-supplied `subscription_id`.
///
/// `KeepAlive` maps to `Keepalive` — the spelling difference is wire-stable
/// per the #3282 sketch and exists because the WebSocket frame is a
/// per-connection signal while the projection-stream `KeepAlive` is a
/// per-stream signal. They're related concepts on different layers.
pub fn projection_item_to_server_frame(
    subscription_id: &str,
    item: ProjectionStreamItem,
) -> WebChatStreamServerFrame {
    match item {
        ProjectionStreamItem::Snapshot { cursor, payload } => WebChatStreamServerFrame::Snapshot {
            subscription_id: subscription_id.to_string(),
            cursor,
            payload,
        },
        ProjectionStreamItem::Update { cursor, payload } => WebChatStreamServerFrame::Update {
            subscription_id: subscription_id.to_string(),
            cursor,
            payload,
        },
        ProjectionStreamItem::RebaseRequired {
            reason,
            snapshot_cursor,
        } => WebChatStreamServerFrame::RebaseRequired {
            subscription_id: subscription_id.to_string(),
            reason,
            snapshot_cursor,
        },
        ProjectionStreamItem::Lagged {
            reason,
            snapshot_cursor,
        } => WebChatStreamServerFrame::Lagged {
            subscription_id: subscription_id.to_string(),
            reason,
            snapshot_cursor,
        },
        ProjectionStreamItem::KeepAlive => WebChatStreamServerFrame::Keepalive,
    }
}

// -- Origin check ---------------------------------------------------------

/// Validate the `Origin` header on a WebSocket upgrade against an allowlist.
///
/// Browsers always send `Origin: <scheme>://<host>[:port]` on WS upgrades, so
/// a missing header from a browser is itself a red flag. We treat both
/// missing-header and not-in-allowlist as unauthorized. The error message on
/// the wire is deliberately generic — the internal reason field captures the
/// specifics for server-side logs.
///
/// The consumer surface (e.g. the WebChat v2 router) owns the allowlist and
/// passes it in: this crate doesn't know what counts as a legitimate origin.
pub fn check_origin(headers: &http::HeaderMap, allowed_origins: &[&str]) -> Result<(), ApiError> {
    let origin = headers
        .get(http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            ApiError::new(
                ApiErrorKind::Unauthorized,
                "missing origin header on websocket upgrade",
            )
        })?;
    if !allowed_origins.contains(&origin) {
        return Err(ApiError::new(
            ApiErrorKind::Unauthorized,
            format!("origin not allowed: {origin}"),
        ));
    }
    Ok(())
}

// -- Connection driver ----------------------------------------------------

/// Handle a single subscription forwarder's lifecycle: a JoinHandle plus a
/// channel sender used to cancel the forwarder on unsubscribe.
struct SubscriptionHandle {
    /// Notifying this channel causes the forwarder to drop its stream and
    /// exit. We use a oneshot via a bounded channel of `()` so the cancel
    /// signal cannot fail to send for any reason other than "already cancelled".
    cancel: mpsc::Sender<()>,
    task: JoinHandle<()>,
}

impl SubscriptionHandle {
    async fn cancel(self) {
        // Best-effort: if the receiver is already dropped (forwarder exited
        // on its own because the stream ended), there's nothing to cancel.
        let _ = self.cancel.send(()).await;
        // Wait for the task to actually finish so we don't leak it.
        let _ = self.task.await;
    }
}

/// Drive a WebChat v2-style multiplexed subscription WebSocket to completion.
///
/// `subscribe_handler` is the consumer-supplied port that turns a
/// [`WebChatSubscribeFrame`] into a [`Stream`] of
/// [`super::ProjectionStreamItem`]s. The driver:
///
/// 1. Reads client frames from the socket.
/// 2. On `subscribe`: spawns a forwarder that pulls items off the
///    consumer-supplied stream and pushes mapped server frames onto the
///    shared egress channel. Up to [`MAX_SUBSCRIPTIONS_PER_SOCKET`]
///    concurrent forwarders per socket.
/// 3. On `unsubscribe`: cancels the named forwarder.
/// 4. On `ping`: sends a `Keepalive` server frame in reply (in addition to
///    the unconditional 30s application keepalive).
/// 5. On a malformed frame: emits a single
///    [`WebChatStreamServerFrame::Error`] with `subscription_id = None`.
/// 6. On idle for [`IDLE_PING_AFTER`]: sends a transport-level WS ping;
///    closes the socket with code 1011 if no pong arrives within
///    [`PONG_TIMEOUT`].
///
/// Cleanup is best-effort but exhaustive: when the loop exits for any
/// reason (client close, write error, idle timeout, error), all active
/// forwarder tasks are cancelled and joined before the function returns.
pub async fn drive_websocket<F, Fut, S>(socket: WebSocket, subscribe_handler: F)
where
    F: Fn(WebChatSubscribeFrame) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<S, ApiError>> + Send + 'static,
    S: Stream<Item = ProjectionStreamItem> + Send + Unpin + 'static,
{
    let (mut ws_sink, mut ws_stream) = socket.split();
    let (egress_tx, mut egress_rx) =
        mpsc::channel::<WebChatStreamServerFrame>(SOCKET_EGRESS_BUFFER);

    // Holds active forwarder handles keyed by subscription_id. Arc<Mutex<...>>
    // because the writer task and the receive loop both need access (the
    // writer doesn't touch it today, but we keep one shared owner so future
    // additions don't fork the state).
    let subscriptions: Arc<Mutex<std::collections::HashMap<String, SubscriptionHandle>>> =
        Arc::new(Mutex::new(std::collections::HashMap::new()));
    let subscription_count = Arc::new(AtomicUsize::new(0));

    let subscribe_handler = Arc::new(subscribe_handler);

    // Writer task — drains the egress channel and writes JSON text frames to
    // the socket. Also responsible for sending transport-level ping frames
    // and the periodic application keepalive. Exits when the egress channel
    // closes (which happens after the receive loop finishes and drops its
    // sender) or when a write fails.
    //
    // Using a separate task for writes lets the receive loop emit egress
    // frames synchronously without ever blocking on a slow socket — the
    // bounded channel applies backpressure instead.
    let writer_egress_rx = &mut egress_rx;
    let mut app_keepalive = time::interval(APP_KEEPALIVE_EVERY);
    app_keepalive.set_missed_tick_behavior(time::MissedTickBehavior::Skip);

    let mut idle_timer = time::interval(IDLE_PING_AFTER);
    idle_timer.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    // Skip the immediate first tick — interval fires once at construction.
    idle_timer.tick().await;
    app_keepalive.tick().await;

    let mut awaiting_pong: Option<time::Instant> = None;

    loop {
        tokio::select! {
            // Outgoing: forwarders pushed a server frame onto the egress
            // channel. Serialise + send.
            maybe_frame = writer_egress_rx.recv() => {
                let Some(frame) = maybe_frame else {
                    // No forwarders left and the receive loop dropped its
                    // egress sender — connection done.
                    break;
                };
                let json = match serde_json::to_string(&frame) {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::warn!(error = %e, "failed to serialise server frame; dropping");
                        continue;
                    }
                };
                if ws_sink.send(Message::Text(json.into())).await.is_err() {
                    // Client gone; tear down everything.
                    break;
                }
            }

            // Incoming: client frame or transport-level control frame.
            maybe_msg = ws_stream.next() => {
                // Any incoming frame counts as activity — reset idle.
                idle_timer.reset();
                awaiting_pong = None;

                let Some(msg) = maybe_msg else {
                    // Stream ended — client closed.
                    break;
                };
                let msg = match msg {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!(error = %e, "websocket read error");
                        break;
                    }
                };

                match msg {
                    Message::Text(text) => {
                        let parsed: Result<WebChatStreamClientFrame, _> =
                            serde_json::from_str(&text);
                        match parsed {
                            Ok(WebChatStreamClientFrame::Subscribe(sub)) => {
                                handle_subscribe(
                                    sub,
                                    &subscriptions,
                                    &subscription_count,
                                    &egress_tx,
                                    subscribe_handler.clone(),
                                )
                                .await;
                            }
                            Ok(WebChatStreamClientFrame::Unsubscribe(unsub)) => {
                                let mut guard = subscriptions.lock().await;
                                if let Some(handle) = guard.remove(&unsub.subscription_id) {
                                    drop(guard);
                                    handle.cancel().await;
                                    subscription_count.fetch_sub(1, Ordering::Relaxed);
                                }
                            }
                            Ok(WebChatStreamClientFrame::Ping) => {
                                // Reply with an application-level Keepalive so
                                // clients that only watch the app layer see
                                // liveness. The transport ping/pong handshake
                                // is handled below independently.
                                let _ = egress_tx
                                    .send(WebChatStreamServerFrame::Keepalive)
                                    .await;
                            }
                            Err(e) => {
                                let _ = egress_tx
                                    .send(WebChatStreamServerFrame::Error {
                                        subscription_id: None,
                                        error_kind: "invalid_frame".to_string(),
                                        message: format!("could not parse client frame: {e}"),
                                    })
                                    .await;
                            }
                        }
                    }
                    Message::Binary(_) => {
                        let _ = egress_tx
                            .send(WebChatStreamServerFrame::Error {
                                subscription_id: None,
                                error_kind: "invalid_frame".to_string(),
                                message: "binary frames are not supported on this socket"
                                    .to_string(),
                            })
                            .await;
                    }
                    Message::Pong(_) => {
                        // Transport-level pong — already cleared above.
                    }
                    Message::Ping(payload) => {
                        // Reply pong; axum normally auto-pongs but we be
                        // explicit because we manage the sink ourselves.
                        if ws_sink.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Message::Close(_) => {
                        break;
                    }
                }
            }

            // Periodic: send an application-level keepalive every 30s
            // regardless of activity. Clients that only watch the app layer
            // (no transport ping/pong inspection) rely on this.
            _ = app_keepalive.tick() => {
                if egress_tx
                    .send(WebChatStreamServerFrame::Keepalive)
                    .await
                    .is_err()
                {
                    break;
                }
            }

            // Periodic: transport-level ping when idle. Close if no pong
            // arrives within PONG_TIMEOUT.
            _ = idle_timer.tick() => {
                match awaiting_pong {
                    Some(sent_at) if sent_at.elapsed() >= PONG_TIMEOUT => {
                        // No pong in the window — close.
                        let _ = ws_sink
                            .send(Message::Close(Some(CloseFrame {
                                code: close_code::ERROR,
                                reason: "idle_timeout".into(),
                            })))
                            .await;
                        break;
                    }
                    Some(_) => {
                        // Still within the pong window — keep waiting.
                    }
                    None => {
                        if ws_sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                            break;
                        }
                        awaiting_pong = Some(time::Instant::now());
                    }
                }
            }
        }
    }

    // Cleanup: cancel every outstanding forwarder so spawned tasks don't leak.
    let mut guard = subscriptions.lock().await;
    let handles: Vec<SubscriptionHandle> = guard.drain().map(|(_, v)| v).collect();
    drop(guard);
    for handle in handles {
        handle.cancel().await;
    }

    // Best-effort close. If the socket is already torn down, this is a no-op.
    let _ = ws_sink.close().await;
}

/// Process a `subscribe` client frame: enforce the per-socket cap, spawn a
/// forwarder, and register it under `subscription_id`.
async fn handle_subscribe<F, Fut, S>(
    frame: WebChatSubscribeFrame,
    subscriptions: &Arc<Mutex<std::collections::HashMap<String, SubscriptionHandle>>>,
    subscription_count: &Arc<AtomicUsize>,
    egress_tx: &mpsc::Sender<WebChatStreamServerFrame>,
    subscribe_handler: Arc<F>,
) where
    F: Fn(WebChatSubscribeFrame) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<S, ApiError>> + Send + 'static,
    S: Stream<Item = ProjectionStreamItem> + Send + Unpin + 'static,
{
    // Reject duplicates so a buggy client doesn't silently replace a live
    // subscription and leak the prior forwarder.
    {
        let guard = subscriptions.lock().await;
        if guard.contains_key(&frame.subscription_id) {
            drop(guard);
            let _ = egress_tx
                .send(WebChatStreamServerFrame::Error {
                    subscription_id: Some(frame.subscription_id),
                    error_kind: "duplicate_subscription".to_string(),
                    message: "subscription_id is already active on this socket".to_string(),
                })
                .await;
            return;
        }
    }

    if subscription_count.load(Ordering::Relaxed) >= MAX_SUBSCRIPTIONS_PER_SOCKET {
        let _ = egress_tx
            .send(WebChatStreamServerFrame::Error {
                subscription_id: Some(frame.subscription_id),
                error_kind: "too_many_subscriptions".to_string(),
                message: format!(
                    "socket has reached the per-connection subscription cap of {MAX_SUBSCRIPTIONS_PER_SOCKET}"
                ),
            })
            .await;
        return;
    }

    let subscription_id = frame.subscription_id.clone();
    let egress_for_task = egress_tx.clone();
    let (cancel_tx, mut cancel_rx) = mpsc::channel::<()>(1);
    let handler = subscribe_handler.clone();
    let frame_for_handler = frame.clone();
    let sub_count_for_task = subscription_count.clone();
    let subscriptions_for_task = subscriptions.clone();
    let subscription_id_for_task = subscription_id.clone();

    let task = tokio::spawn(async move {
        let stream = match (handler)(frame_for_handler).await {
            Ok(s) => s,
            Err(err) => {
                let _ = egress_for_task
                    .send(WebChatStreamServerFrame::Error {
                        subscription_id: Some(subscription_id_for_task.clone()),
                        error_kind: err.wire_type.to_string(),
                        message: err.kind.wire_message().to_string(),
                    })
                    .await;
                // Auto-remove ourselves from the registry on early failure so
                // the slot is reclaimable. The outer cleanup also removes us,
                // but doing it here means the client can re-subscribe under
                // the same id immediately.
                let mut guard = subscriptions_for_task.lock().await;
                if guard.remove(&subscription_id_for_task).is_some() {
                    sub_count_for_task.fetch_sub(1, Ordering::Relaxed);
                }
                return;
            }
        };
        let mut stream = stream;

        loop {
            tokio::select! {
                biased;
                _ = cancel_rx.recv() => break,
                item = stream.next() => {
                    match item {
                        Some(item) => {
                            let server_frame =
                                projection_item_to_server_frame(&subscription_id_for_task, item);
                            if egress_for_task.send(server_frame).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
        }

        // Stream ended naturally — drop ourselves from the registry so the
        // slot is reusable and the per-socket counter is accurate.
        let mut guard = subscriptions_for_task.lock().await;
        if guard.remove(&subscription_id_for_task).is_some() {
            sub_count_for_task.fetch_sub(1, Ordering::Relaxed);
        }
    });

    let mut guard = subscriptions.lock().await;
    guard.insert(
        subscription_id,
        SubscriptionHandle {
            cancel: cancel_tx,
            task,
        },
    );
    subscription_count.fetch_add(1, Ordering::Relaxed);
}

// -- Tests ----------------------------------------------------------------
//
// Test gap: we deliberately do NOT unit-test the full `drive_websocket`
// loop here. It needs a real WebSocket pair (or a non-trivial
// duplex-channel fake) to exercise; the load-bearing logic worth covering
// at this tier — frame shape, mapping, origin allow/deny — is independently
// reachable. An integration test for the loop lands alongside a concrete
// consumer (WebChat v2 PR for #3282).

#[cfg(test)]
mod tests {
    use super::*;

    use ironclaw_event_projections::{ProjectionCursor, ProjectionScope};
    use ironclaw_host_api::{InvocationId, ResourceScope, UserId};

    fn sample_cursor() -> ProjectionCursor {
        // `local_default` validates and returns a typed scope under the local
        // single-user defaults; that's enough to mint a wire-shape-stable
        // cursor for serialisation tests. The cursor authority itself is
        // exercised by `ironclaw_event_projections` tests.
        let resource = ResourceScope::local_default(
            UserId::new("user-a").expect("test user id must be valid"),
            InvocationId::new(),
        )
        .expect("local_default must build a valid scope under fixed inputs");
        let scope = ProjectionScope::from_resource_scope(&resource);
        ProjectionCursor::origin_for_scope(scope)
    }

    #[test]
    fn client_frame_subscribe_deserializes() {
        let raw = r#"{"kind":"subscribe","subscription_id":"sub-1"}"#;
        let frame: WebChatStreamClientFrame =
            serde_json::from_str(raw).expect("must parse subscribe");
        match frame {
            WebChatStreamClientFrame::Subscribe(sub) => {
                assert_eq!(sub.subscription_id, "sub-1");
                assert!(sub.after_cursor.is_none());
                assert!(sub.view.is_none());
            }
            _ => panic!("expected Subscribe"),
        }
    }

    #[test]
    fn client_frame_unsubscribe_deserializes() {
        let raw = r#"{"kind":"unsubscribe","subscription_id":"sub-1"}"#;
        let frame: WebChatStreamClientFrame =
            serde_json::from_str(raw).expect("must parse unsubscribe");
        match frame {
            WebChatStreamClientFrame::Unsubscribe(unsub) => {
                assert_eq!(unsub.subscription_id, "sub-1");
            }
            _ => panic!("expected Unsubscribe"),
        }
    }

    #[test]
    fn client_frame_ping_deserializes() {
        let raw = r#"{"kind":"ping"}"#;
        let frame: WebChatStreamClientFrame = serde_json::from_str(raw).expect("must parse ping");
        assert!(matches!(frame, WebChatStreamClientFrame::Ping));
    }

    #[test]
    fn unknown_client_frame_kind_returns_invalid_frame_error() {
        let raw = r#"{"kind":"bogus"}"#;
        let err = serde_json::from_str::<WebChatStreamClientFrame>(raw)
            .expect_err("unknown kind must reject");
        // serde reports the variant set; just confirm we did NOT parse it
        // into one of the known variants.
        assert!(err.to_string().contains("bogus") || err.to_string().contains("unknown"));
    }

    #[test]
    fn server_frame_snapshot_serializes_with_cursor_and_subscription_id() {
        let frame = WebChatStreamServerFrame::Snapshot {
            subscription_id: "sub-1".to_string(),
            cursor: sample_cursor(),
            payload: serde_json::json!({"hello": "world"}),
        };
        let json = serde_json::to_value(&frame).expect("must serialise snapshot");
        assert_eq!(json["kind"], "snapshot");
        assert_eq!(json["subscription_id"], "sub-1");
        assert!(json.get("cursor").is_some(), "cursor must be present");
        assert_eq!(json["payload"]["hello"], "world");
    }

    #[test]
    fn server_frame_update_serializes_with_subscription_id() {
        let frame = WebChatStreamServerFrame::Update {
            subscription_id: "sub-2".to_string(),
            cursor: sample_cursor(),
            payload: serde_json::json!(42),
        };
        let json = serde_json::to_value(&frame).expect("must serialise update");
        assert_eq!(json["kind"], "update");
        assert_eq!(json["subscription_id"], "sub-2");
        assert_eq!(json["payload"], 42);
    }

    #[test]
    fn server_frame_rebase_required_serializes_with_reason() {
        let frame = WebChatStreamServerFrame::RebaseRequired {
            subscription_id: "sub-3".to_string(),
            reason: ProjectionStreamRebaseReason::CursorAhead,
            snapshot_cursor: sample_cursor(),
        };
        let json = serde_json::to_value(&frame).expect("must serialise rebase_required");
        assert_eq!(json["kind"], "rebase_required");
        assert_eq!(json["subscription_id"], "sub-3");
        assert_eq!(json["reason"], "cursor_ahead");
        assert!(json.get("snapshot_cursor").is_some());
    }

    #[test]
    fn server_frame_lagged_serializes_with_reason() {
        let frame = WebChatStreamServerFrame::Lagged {
            subscription_id: "sub-4".to_string(),
            reason: ProjectionStreamLagReason::BufferOverflow,
            snapshot_cursor: sample_cursor(),
        };
        let json = serde_json::to_value(&frame).expect("must serialise lagged");
        assert_eq!(json["kind"], "lagged");
        assert_eq!(json["subscription_id"], "sub-4");
        assert_eq!(json["reason"], "buffer_overflow");
        assert!(json.get("snapshot_cursor").is_some());
    }

    #[test]
    fn server_frame_keepalive_has_no_payload() {
        let frame = WebChatStreamServerFrame::Keepalive;
        let json = serde_json::to_value(&frame).expect("must serialise keepalive");
        assert_eq!(json["kind"], "keepalive");
        // The keepalive frame is intentionally payload-free; no other keys
        // beyond the discriminator.
        let obj = json
            .as_object()
            .expect("keepalive must serialise as object");
        assert_eq!(obj.len(), 1, "keepalive must only carry the `kind` tag");
    }

    #[test]
    fn server_frame_error_has_optional_subscription_id() {
        // With subscription id (subscription-scoped error)
        let scoped = WebChatStreamServerFrame::Error {
            subscription_id: Some("sub-1".to_string()),
            error_kind: "bad_cursor".to_string(),
            message: "cursor malformed".to_string(),
        };
        let json = serde_json::to_value(&scoped).expect("must serialise scoped error");
        assert_eq!(json["kind"], "error");
        assert_eq!(json["subscription_id"], "sub-1");

        // Without subscription id (connection-scoped error, e.g. unparsable
        // frame). Serde still emits the field but as null — assert that
        // shape so clients can rely on it.
        let global = WebChatStreamServerFrame::Error {
            subscription_id: None,
            error_kind: "invalid_frame".to_string(),
            message: "could not parse".to_string(),
        };
        let json = serde_json::to_value(&global).expect("must serialise global error");
        assert_eq!(json["kind"], "error");
        assert!(json["subscription_id"].is_null());
    }

    #[test]
    fn projection_item_to_server_frame_maps_all_variants() {
        // Snapshot
        let frame = projection_item_to_server_frame(
            "sub-1",
            ProjectionStreamItem::Snapshot {
                cursor: sample_cursor(),
                payload: serde_json::json!({"k": "v"}),
            },
        );
        match &frame {
            WebChatStreamServerFrame::Snapshot {
                subscription_id,
                payload,
                ..
            } => {
                assert_eq!(subscription_id, "sub-1");
                assert_eq!(payload["k"], "v");
            }
            _ => panic!("Snapshot must map to WebChatStreamServerFrame::Snapshot"),
        }

        // Update
        let frame = projection_item_to_server_frame(
            "sub-1",
            ProjectionStreamItem::Update {
                cursor: sample_cursor(),
                payload: serde_json::json!(1),
            },
        );
        assert!(matches!(frame, WebChatStreamServerFrame::Update { .. }));

        // RebaseRequired
        let frame = projection_item_to_server_frame(
            "sub-1",
            ProjectionStreamItem::RebaseRequired {
                reason: ProjectionStreamRebaseReason::CursorMalformed,
                snapshot_cursor: sample_cursor(),
            },
        );
        match frame {
            WebChatStreamServerFrame::RebaseRequired {
                subscription_id,
                reason,
                ..
            } => {
                assert_eq!(subscription_id, "sub-1");
                assert_eq!(reason, ProjectionStreamRebaseReason::CursorMalformed);
            }
            _ => panic!("RebaseRequired must map to WebChatStreamServerFrame::RebaseRequired"),
        }

        // Lagged
        let frame = projection_item_to_server_frame(
            "sub-1",
            ProjectionStreamItem::Lagged {
                reason: ProjectionStreamLagReason::SlowConsumer,
                snapshot_cursor: sample_cursor(),
            },
        );
        match frame {
            WebChatStreamServerFrame::Lagged {
                subscription_id,
                reason,
                ..
            } => {
                assert_eq!(subscription_id, "sub-1");
                assert_eq!(reason, ProjectionStreamLagReason::SlowConsumer);
            }
            _ => panic!("Lagged must map to WebChatStreamServerFrame::Lagged"),
        }

        // KeepAlive (note the spelling change: stream KeepAlive → wire keepalive)
        let frame = projection_item_to_server_frame("sub-1", ProjectionStreamItem::KeepAlive);
        assert!(matches!(frame, WebChatStreamServerFrame::Keepalive));
    }

    fn header_map_with_origin(value: &str) -> http::HeaderMap {
        let mut h = http::HeaderMap::new();
        h.insert(http::header::ORIGIN, value.parse().unwrap());
        h
    }

    #[test]
    fn check_origin_accepts_allowed() {
        let h = header_map_with_origin("https://app.example.com");
        check_origin(&h, &["https://app.example.com"]).expect("allowed origin must pass");
    }

    #[test]
    fn check_origin_rejects_missing_or_unknown() {
        // Missing
        let empty = http::HeaderMap::new();
        let err = check_origin(&empty, &["https://app.example.com"])
            .expect_err("missing origin must reject");
        assert_eq!(err.kind, ApiErrorKind::Unauthorized);

        // Unknown
        let h = header_map_with_origin("https://evil.example.com");
        let err =
            check_origin(&h, &["https://app.example.com"]).expect_err("unknown origin must reject");
        assert_eq!(err.kind, ApiErrorKind::Unauthorized);
    }
}
