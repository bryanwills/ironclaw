//! Planner facade — composition layer that ties the nine strategies into a
//! single thing the executor calls.
//!
//! See `docs/reborn/agent-loop-skeleton.md` §3 ("Planner facade") and §6
//! ("Strategy decomposition"), and the workstream brief
//! `docs/reborn/agent-loop-briefs/planner-facade.md` for the rationale.

use std::fmt;

use crate::strategies::{
    BatchPolicyStrategy, BudgetStrategy, CapabilityStrategy, ContextStrategy, GateHandlingStrategy,
    InputDrainStrategy, ModelStrategy, RecoveryStrategy, StopConditionStrategy,
};

/// Stable identifier for a planner composition.
///
/// Carried in checkpoint payload metadata so that resume can validate the
/// planner being used hasn't drifted from the planner that produced the
/// checkpoint. See `docs/reborn/agent-loop-skeleton.md` §3 + §10
/// ("Checkpoint payload schema").
///
/// Validation: ASCII printable, no whitespace, 1..=96 bytes. Construction
/// goes through [`PlannerId::new`] / `TryFrom<String>` so wire-side and
/// in-process construction share the same validator. See
/// `.claude/rules/types.md` for the canonical newtype template.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "String")]
pub struct PlannerId(String);

/// Errors produced when constructing a [`PlannerId`].
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PlannerIdError {
    /// Empty or longer than 96 bytes.
    #[error("planner id must be 1..=96 bytes, got {0}")]
    InvalidLength(usize),
    /// Contains a whitespace or non-printable ASCII byte.
    #[error("planner id contains forbidden character at byte {0}")]
    ForbiddenChar(usize),
}

impl PlannerId {
    /// Maximum byte length. Mirrors the validator's upper bound.
    pub const MAX_BYTES: usize = 96;

    fn validate(s: &str) -> Result<(), PlannerIdError> {
        let len = s.len();
        if len == 0 || len > Self::MAX_BYTES {
            return Err(PlannerIdError::InvalidLength(len));
        }
        for (idx, byte) in s.as_bytes().iter().enumerate() {
            // ASCII printable per RFC 20: 0x21..=0x7E. Whitespace (including
            // 0x20 SPACE) is rejected so ids stay safe to log inline.
            if !(0x21..=0x7E).contains(byte) {
                return Err(PlannerIdError::ForbiddenChar(idx));
            }
        }
        Ok(())
    }

    /// Construct a planner id, validating the input.
    pub fn new(raw: impl Into<String>) -> Result<Self, PlannerIdError> {
        let s = raw.into();
        Self::validate(&s)?;
        Ok(Self(s))
    }

    /// Borrow the underlying ASCII string.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Consume the wrapper and return the underlying `String`.
    pub fn into_inner(self) -> String {
        self.0
    }
}

impl TryFrom<String> for PlannerId {
    type Error = PlannerIdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::validate(&value)?;
        Ok(Self(value))
    }
}

impl AsRef<str> for PlannerId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PlannerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<PlannerId> for String {
    fn from(id: PlannerId) -> Self {
        id.0
    }
}

/// A planner is a composition of nine strategies.
///
/// Each strategy is one swappable decision-procedure consulted by the
/// executor at a specific point in the canonical tick (see master doc §6
/// and §8). Implementations should be cheap to clone (typically wrap each
/// strategy in `Arc<dyn …Strategy>`) so the executor can borrow strategies
/// without constraining planner lifetimes.
///
/// The planner has NO `run()` or `tick()` method; loop mechanics live in
/// the `AgentLoopExecutor` (WS-6). The planner is data — strategies + an
/// id.
pub trait AgentLoopPlanner: Send + Sync {
    /// Stable id carried into checkpoint payloads for resume validation.
    fn id(&self) -> &PlannerId;

    fn context(&self) -> &dyn ContextStrategy;
    fn capability(&self) -> &dyn CapabilityStrategy;
    fn model(&self) -> &dyn ModelStrategy;
    fn batch(&self) -> &dyn BatchPolicyStrategy;
    fn gate(&self) -> &dyn GateHandlingStrategy;
    fn recovery(&self) -> &dyn RecoveryStrategy;
    fn stop(&self) -> &dyn StopConditionStrategy;
    fn drain(&self) -> &dyn InputDrainStrategy;
    fn budget(&self) -> &dyn BudgetStrategy;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Compile-time object-safety check — `AgentLoopPlanner` MUST be
    /// usable behind `&dyn …` so the executor can hold a heterogeneous
    /// planner stack without a generic parameter.
    #[allow(dead_code)]
    fn _check(_: &dyn AgentLoopPlanner) {}

    #[test]
    fn new_accepts_canonical_default_id() {
        let id = PlannerId::new("reborn:default-loop").expect("valid id");
        assert_eq!(id.as_str(), "reborn:default-loop");
        assert_eq!(id.to_string(), "reborn:default-loop");
    }

    #[test]
    fn new_rejects_empty_with_invalid_length() {
        assert_eq!(PlannerId::new(""), Err(PlannerIdError::InvalidLength(0)));
    }

    #[test]
    fn new_rejects_oversize_with_invalid_length() {
        let too_long = "a".repeat(PlannerId::MAX_BYTES + 1);
        assert_eq!(
            PlannerId::new(too_long.clone()),
            Err(PlannerIdError::InvalidLength(too_long.len()))
        );
    }

    #[test]
    fn new_rejects_whitespace_with_forbidden_char() {
        assert_eq!(
            PlannerId::new("has space"),
            Err(PlannerIdError::ForbiddenChar(3))
        );
        assert_eq!(
            PlannerId::new("tab\there"),
            Err(PlannerIdError::ForbiddenChar(3))
        );
        assert_eq!(
            PlannerId::new("nl\nhere"),
            Err(PlannerIdError::ForbiddenChar(2))
        );
    }

    #[test]
    fn new_rejects_non_ascii_with_forbidden_char() {
        // The first byte of the multi-byte UTF-8 sequence is non-ASCII.
        assert!(matches!(
            PlannerId::new("smiley🙂"),
            Err(PlannerIdError::ForbiddenChar(_))
        ));
    }

    #[test]
    fn json_round_trip_preserves_value() {
        let id = PlannerId::new("reborn:default-loop").expect("valid");
        let serialized = serde_json::to_string(&id).expect("serialize");
        assert_eq!(serialized, "\"reborn:default-loop\"");
        let restored: PlannerId = serde_json::from_str(&serialized).expect("deserialize");
        assert_eq!(restored, id);
    }

    #[test]
    fn deserialize_rejects_empty_string() {
        let err = serde_json::from_str::<PlannerId>("\"\"").expect_err("must reject empty");
        assert!(
            err.to_string().contains("1..=96"),
            "expected length-error message, got: {err}"
        );
    }

    #[test]
    fn deserialize_rejects_whitespace() {
        let err =
            serde_json::from_str::<PlannerId>("\"has space\"").expect_err("must reject whitespace");
        assert!(
            err.to_string().contains("forbidden character"),
            "expected forbidden-char message, got: {err}"
        );
    }

    #[test]
    fn try_from_string_revalidates() {
        assert_eq!(
            PlannerId::try_from(String::new()),
            Err(PlannerIdError::InvalidLength(0))
        );
        assert_eq!(
            PlannerId::try_from(String::from("ok-id")),
            Ok(PlannerId::new("ok-id").expect("valid"))
        );
    }

    #[test]
    fn into_inner_returns_underlying_string() {
        let id = PlannerId::new("reborn:default-loop").expect("valid");
        assert_eq!(id.into_inner(), "reborn:default-loop");
    }
}
