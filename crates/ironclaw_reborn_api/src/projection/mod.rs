//! Projection-stream transport adapters.
//!
//! Defines a local [`ProjectionStreamItem`] modelled on issue #3281's sketch
//! (`Snapshot` / `Update` / `RebaseRequired` / `Lagged` / `KeepAlive`) and
//! provides transport-specific renderings:
//! - [`sse`] — Server-Sent Events (used by OpenAI-compatible streaming and
//!   any HTTP/1.1 SSE consumer)
//! - [`websocket`] — multiplexed WebSocket frames (used by WebChat v2 per
//!   #3282)
//!
//! Cursor authority is **only** [`ironclaw_event_projections::ProjectionCursor`].
//! Transport-local `id` fields / WebSocket seq numbers are NEVER accepted as
//! resume authority.

pub mod sse;
pub mod websocket;

use ironclaw_event_projections::ProjectionCursor;
use ironclaw_product_adapters::ProductInboundEnvelope;
use serde::{Deserialize, Serialize};

/// Wire-stable kind tag for a projection stream item. Carried as the SSE
/// `event:` name and as the WebSocket frame `kind` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionStreamItemKind {
    Snapshot,
    Update,
    RebaseRequired,
    Lagged,
    KeepAlive,
}

impl ProjectionStreamItemKind {
    /// Wire-stable snake_case tag used as the SSE `event:` name and the
    /// WebSocket frame `kind` field. Always matches the serde rename above
    /// (`#[serde(rename_all = "snake_case")]`); locking the mapping into a
    /// `&'static str` here means the SSE/WS adapters never re-serialise the
    /// enum just to get the tag.
    pub fn as_wire_str(&self) -> &'static str {
        match self {
            Self::Snapshot => "snapshot",
            Self::Update => "update",
            Self::RebaseRequired => "rebase_required",
            Self::Lagged => "lagged",
            Self::KeepAlive => "keep_alive",
        }
    }
}

/// Reason a `RebaseRequired` frame was emitted. Adapters use this to decide
/// whether to re-fetch a full snapshot or just realign cursors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionStreamRebaseReason {
    CursorAhead,
    CursorMalformed,
    SubscriptionExpired,
}

/// Reason a `Lagged` frame was emitted. Indicates the subscriber fell behind
/// the bounded buffer and may have missed updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionStreamLagReason {
    BufferOverflow,
    SlowConsumer,
}

/// A single item emitted on a projection subscription stream. Local to
/// `ironclaw_reborn_api` until issue #3281 lands the canonical version in
/// `ironclaw_event_projections`; consumers should treat this type as the
/// wire-stable shape for now.
//
// TODO(reborn-api): full payload typing lands in a follow-up commit by a
// dedicated agent. This is a placeholder so the crate compiles.
//
// `ProjectionCursor` lives in `ironclaw_event_projections` and does not
// implement `utoipa::ToSchema` (that crate has no `utoipa` dependency by
// design). Cursors are opaque on the wire anyway — clients echo them back
// unmodified — so the OpenAPI schema models them as `Object`. Likewise
// `serde_json::Value` is `Object` since the payload is per-ProjectionViewClass.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectionStreamItem {
    Snapshot {
        #[schema(value_type = Object)]
        cursor: ProjectionCursor,
        /// Opaque payload — concrete shape is per ProjectionViewClass and
        /// will be typed when #3281 lands.
        #[schema(value_type = Object)]
        payload: serde_json::Value,
    },
    Update {
        #[schema(value_type = Object)]
        cursor: ProjectionCursor,
        #[schema(value_type = Object)]
        payload: serde_json::Value,
    },
    RebaseRequired {
        reason: ProjectionStreamRebaseReason,
        #[schema(value_type = Object)]
        snapshot_cursor: ProjectionCursor,
    },
    Lagged {
        reason: ProjectionStreamLagReason,
        #[schema(value_type = Object)]
        snapshot_cursor: ProjectionCursor,
    },
    KeepAlive,
}

impl ProjectionStreamItem {
    /// Wire-stable [`ProjectionStreamItemKind`] for this item. Used by the
    /// SSE and WebSocket adapters to tag a frame without re-serialising the
    /// whole item just to read its `kind` discriminator.
    pub fn kind(&self) -> ProjectionStreamItemKind {
        match self {
            Self::Snapshot { .. } => ProjectionStreamItemKind::Snapshot,
            Self::Update { .. } => ProjectionStreamItemKind::Update,
            Self::RebaseRequired { .. } => ProjectionStreamItemKind::RebaseRequired,
            Self::Lagged { .. } => ProjectionStreamItemKind::Lagged,
            Self::KeepAlive => ProjectionStreamItemKind::KeepAlive,
        }
    }
}

/// Helper to mark a projection-related envelope as not a subscription
/// request. Used by handlers that want to reject non-subscription envelopes
/// before reaching the workflow. Kept here so consumers can share the check.
pub fn is_subscription_envelope(envelope: &ProductInboundEnvelope) -> bool {
    matches!(
        envelope.payload(),
        ironclaw_product_adapters::ProductInboundPayload::SubscriptionRequest(_)
    )
}
