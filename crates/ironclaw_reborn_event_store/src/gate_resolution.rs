//! Durable gate-resolution store trait + error type.
//!
//! Spec: `docs/reborn/2026-06-08-subagent-durability-spec.md` §1.
//!
//! The trait is implemented by:
//! - [`crate::libsql::LibSqlGateResolutionStore`] (libSQL backend, feature `libsql`)
//! - [`crate::postgres::PostgresGateResolutionStore`] (PostgreSQL backend, feature `postgres`)
//!
//! All scoped queries MUST use the conditional `<agent_predicate>` convention
//! from spec §1.6: `agent_id = ?` when the caller's `TurnScope.agent_id` is
//! `Some`, and `agent_id IS NULL` when `None`. Using
//! `(agent_id = ? OR agent_id IS NULL)` is forbidden — it allows agent-scoped
//! callers to reach system-level (NULL `agent_id`) rows.

use std::collections::HashSet;

use async_trait::async_trait;
use ironclaw_host_api::UserId;
use ironclaw_turns::{GateRef, LoopResultRef, TurnRunId, TurnScope, TurnStatus};
use thiserror::Error;

/// Errors returned by the durable gate-resolution store.
#[derive(Debug, Error)]
pub enum GateResolutionStoreError {
    #[error("gate resolution store backend unavailable: {reason}")]
    Unavailable { reason: String },
    #[error("gate resolution store I/O error during {operation}: {reason}")]
    Io {
        operation: &'static str,
        reason: String,
    },
    #[error("gate resolution store serialization failed: {reason}")]
    Serialization { reason: String },
    #[error("gate resolution capacity exceeded for scope")]
    CapacityExceeded,
    #[error("gate resolution store: non-terminal status rejected")]
    NonTerminalStatus,
}

impl GateResolutionStoreError {
    pub(crate) fn unavailable(reason: impl Into<String>) -> Self {
        Self::Unavailable {
            reason: reason.into(),
        }
    }
    pub(crate) fn io(operation: &'static str, reason: impl Into<String>) -> Self {
        Self::Io {
            operation,
            reason: reason.into(),
        }
    }
    #[allow(dead_code)]
    pub(crate) fn serialization(reason: impl Into<String>) -> Self {
        Self::Serialization {
            reason: reason.into(),
        }
    }
}

/// Terminal event for a settled awaited child.
///
/// Mirrors `AwaitedChildTerminalEvent` in the in-memory store but is defined
/// here for the durable trait boundary — no dependency on
/// `ironclaw_reborn` private types.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableTerminalEvent {
    pub status: TurnStatus,
    pub kind: String,
    pub cursor: u64,
    pub sanitized_reason: Option<String>,
    pub owner_user_id: Option<UserId>,
}

/// The number of capacity-counter buckets per scope (K=16, operator-tunable).
///
/// Spec §1 decision 21: spawn writes to `bucket = hash(child_run_id) % K`.
/// Cap check reads `SUM(undelivered) FROM counter WHERE scope`.
pub const CAPACITY_COUNTER_BUCKETS: u32 = 16;

/// Environment variable for overriding the number of capacity-counter buckets.
pub const CAPACITY_COUNTER_BUCKETS_ENV: &str = "CAPACITY_COUNTER_BUCKETS";

/// Read the effective bucket count from the environment.
/// Falls back to [`CAPACITY_COUNTER_BUCKETS`] if the env var is unset or
/// unparseable.
pub fn effective_capacity_counter_buckets() -> u32 {
    std::env::var(CAPACITY_COUNTER_BUCKETS_ENV)
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|&k| k > 0)
        .unwrap_or(CAPACITY_COUNTER_BUCKETS)
}

/// Deterministic bucket index for a given `child_run_id` string and K.
///
/// Uses FNV-1a (a simple, non-cryptographic hash adequate for bucket
/// distribution). Returns `hash(child_run_id_bytes) % k`.
pub fn child_bucket(child_run_id_str: &str, k: u32) -> u32 {
    // FNV-1a 32-bit
    const FNV_OFFSET: u32 = 2_166_136_261;
    const FNV_PRIME: u32 = 16_777_619;
    let hash = child_run_id_str.bytes().fold(FNV_OFFSET, |acc, b| {
        acc.wrapping_mul(FNV_PRIME) ^ (b as u32)
    });
    hash % k
}

/// Maximum number of awaited-child gate records per scope.
pub const MAX_GATE_RECORDS: u32 = 4096;

/// Durable gate-resolution store trait (spec §1).
///
/// All implementations must match the first-writer-wins semantics of
/// `BoundedSubagentGateResolutionStore`:
/// - `record_awaited_child`: `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`.
/// - `record_child_terminal`: UPDATE `terminal_status` only when
///   `terminal_status IS NULL` (first writer wins).
/// - Delivery claim: `delivered_to_parent = 0` guard.
///
/// Scope predicate convention (spec §1.6):
/// - `agent_id = ?` when `scope.agent_id` is `Some`.
/// - `agent_id IS NULL` when `scope.agent_id` is `None`.
/// - NEVER `(agent_id = ? OR agent_id IS NULL)`.
#[async_trait]
pub trait DurableSubagentGateResolutionStore: Send + Sync {
    // ── Core CRUD ──────────────────────────────────────────────────────────

    /// Insert a new awaited-child row under the given scope and gate.
    ///
    /// Idempotent: duplicate `(gate_ref, child_run_id)` is silently ignored
    /// (first-writer-wins per spec §1.6, decision 6).
    ///
    /// Returns `Err(GateResolutionStoreError::CapacityExceeded)` when
    /// `SUM(undelivered)` for the scope would exceed `MAX_GATE_RECORDS`.
    async fn record_awaited_child(
        &self,
        scope: &TurnScope,
        record: AwaitedChildRecord,
    ) -> Result<(), GateResolutionStoreError>;

    /// Record the terminal event for a child run (first-writer-wins).
    ///
    /// Updates `terminal_status` / `terminal_event_json` / `settled_at` only
    /// when `terminal_status IS NULL`. Adds an entry to the deliverable queue
    /// and appends a row to the settlement log.
    ///
    /// Rejects non-terminal statuses with
    /// `GateResolutionStoreError::NonTerminalStatus`.
    async fn record_child_terminal(
        &self,
        scope: &TurnScope,
        gate_ref: GateRef,
        child_run_id: TurnRunId,
        event: DurableTerminalEvent,
    ) -> Result<(), GateResolutionStoreError>;

    /// Flip `terminal_result_written = true` and record `terminal_byte_len`.
    ///
    /// No-op if the row does not exist or the flag is already set.
    async fn mark_terminal_result_written(
        &self,
        scope: &TurnScope,
        gate_ref: &GateRef,
        child_run_id: TurnRunId,
        byte_len: u64,
    ) -> Result<(), GateResolutionStoreError>;

    /// Claim delivery for a child: flip `delivery_claimed = 1`,
    /// `delivered_to_parent = 1`, decrement the capacity counter bucket,
    /// and delete the deliverable-queue entry — all in one transaction.
    ///
    /// Returns `true` if the gate is now fully delivered (all children
    /// under the gate have `delivered_to_parent = 1`), `false` otherwise.
    /// Returns `false` (not an error) if the row has already been delivered
    /// (idempotent guard via `delivered_to_parent = 0`).
    async fn mark_child_delivered(
        &self,
        scope: &TurnScope,
        gate_ref: &GateRef,
        child_run_id: TurnRunId,
    ) -> Result<bool, GateResolutionStoreError>;

    /// Claim the next deliverable terminal state for a child.
    ///
    /// Returns `Some(record)` if an undelivered-terminal row exists for the
    /// child in the deliverable queue; `None` if the queue is empty.
    async fn claim_next_terminal_state_for_child(
        &self,
        scope: &TurnScope,
        child_run_id: TurnRunId,
    ) -> Result<Option<AwaitedChildRow>, GateResolutionStoreError>;

    /// Drain ALL deliverable terminal states for a child in one call.
    async fn claim_all_terminal_states_for_child(
        &self,
        scope: &TurnScope,
        child_run_id: TurnRunId,
    ) -> Result<Vec<AwaitedChildRow>, GateResolutionStoreError>;

    /// Delete all rows for a gate (primary table + child index + deliverable
    /// queue), decrementing the capacity counter atomically.
    ///
    /// This is the gate-cleanup path. Rows deleted here are NOT recoverable
    /// by the reconciler — the settlement log retains the append-only record.
    async fn delete_awaited_child(
        &self,
        scope: &TurnScope,
        gate_ref: &GateRef,
    ) -> Result<(), GateResolutionStoreError>;

    // ── Reconciler-facing methods (spec §5.2.1) ────────────────────────────

    /// Batch existence check: returns the subset of `gate_refs` that still
    /// exist in `subagent_gate_awaited_children` for the given scope.
    ///
    /// One batched SELECT; no payload bytes cross this boundary.
    async fn gates_exist_batch(
        &self,
        scope: &TurnScope,
        gate_refs: Vec<GateRef>,
    ) -> Result<HashSet<GateRef>, GateResolutionStoreError>;

    /// Reconciler delivery (spec §5.2.1, decision 29).
    ///
    /// Idempotently ensures the gate row's terminal flags are set from the
    /// settlement-log row and an entry exists in the deliverable queue — the
    /// §1.6 settlement transaction, re-driven.
    ///
    /// Returns `false` if the gate row no longer exists (orphan race — caller
    /// counts it as `skipped_orphan`).
    async fn redeliver_settled_child(
        &self,
        scope: &TurnScope,
        gate_ref: GateRef,
        child_run_id: TurnRunId,
        terminal_status: TurnStatus,
        result_ref: LoopResultRef,
    ) -> Result<bool, GateResolutionStoreError>;

    /// Capacity resolution for rows that will never deliver (spec decision 31).
    ///
    /// For each `(gate_ref, child_run_id)`: flip `delivered_to_parent`,
    /// decrement the capacity bucket, delete the queue entry — the §1.6
    /// delivery-claim transaction, batched. Idempotent per row via the
    /// `delivered_to_parent = 0` guard.
    async fn resolve_undeliverable_batch(
        &self,
        scope: &TurnScope,
        rows: Vec<(GateRef, TurnRunId)>,
    ) -> Result<(), GateResolutionStoreError>;
}

/// A row in `subagent_gate_awaited_children` — returned by claim methods.
#[derive(Debug, Clone)]
pub struct AwaitedChildRow {
    pub gate_ref: GateRef,
    pub child_run_id: TurnRunId,
    pub parent_run_id: TurnRunId,
    pub tree_root_run_id: TurnRunId,
    /// JSON-encoded `TurnScope` (child scope)
    pub child_scope_json: String,
    /// JSON-encoded `LoopRunContext` (parent run context)
    pub parent_run_context_json: String,
    pub source_binding_ref: String,
    pub reply_target_binding_ref: String,
    pub subagent_kind: String,
    pub spawn_capability_id: String,
    pub result_ref: LoopResultRef,
    pub spawn_mode: String,
    pub terminal_status: Option<TurnStatus>,
    pub terminal_event_json: Option<String>,
    pub terminal_result_written: bool,
    pub terminal_byte_len: u64,
    pub delivery_claimed: bool,
    pub delivered_to_parent: bool,
}

/// The data needed to INSERT a new awaited-child row.
#[derive(Debug, Clone)]
pub struct AwaitedChildRecord {
    pub gate_ref: GateRef,
    pub parent_run_id: TurnRunId,
    pub tree_root_run_id: TurnRunId,
    pub child_run_id: TurnRunId,
    pub child_thread_id: String,
    /// JSON-encoded `TurnScope` (child scope)
    pub child_scope_json: String,
    /// JSON-encoded `LoopRunContext` — MUST be stripped of sensitive fields
    /// before reaching this struct (see credential audit).
    pub parent_run_context_json: String,
    pub source_binding_ref: String,
    pub reply_target_binding_ref: String,
    pub subagent_kind: String,
    pub spawn_capability_id: String,
    pub result_ref: LoopResultRef,
    pub spawn_mode: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_is_stable_and_bounded() {
        let child_id = "550e8400-e29b-41d4-a716-446655440000";
        let k = CAPACITY_COUNTER_BUCKETS;
        let bucket = child_bucket(child_id, k);
        assert!(bucket < k, "bucket {bucket} must be < {k}");
        // Deterministic: same input, same output.
        assert_eq!(child_bucket(child_id, k), bucket);
    }

    #[test]
    fn buckets_distribute_across_range() {
        let k = CAPACITY_COUNTER_BUCKETS;
        let mut seen = std::collections::HashSet::new();
        for i in 0..200u32 {
            let id = format!("child-run-{i:08x}-beef-dead-cafe-000000000000");
            seen.insert(child_bucket(&id, k));
        }
        // With 200 inputs and K=16, expect reasonable coverage (> 10 distinct buckets).
        assert!(
            seen.len() > 10,
            "expected spread across buckets, got {seen:?}"
        );
    }

    #[test]
    fn effective_capacity_counter_buckets_defaults_to_constant() {
        // Test without the env var set.
        if std::env::var(CAPACITY_COUNTER_BUCKETS_ENV).is_err() {
            assert_eq!(
                effective_capacity_counter_buckets(),
                CAPACITY_COUNTER_BUCKETS
            );
        }
    }
}
