//! Consumer hook to observe an agent run's trajectory as it happens.
//!
//! The reborn runtime is intentionally sealed — the high-level
//! [`crate::RebornRuntime`] hands back only the final assistant reply, and the
//! per-step capability (tool) calls + their results live in internal stores not
//! otherwise exposed. A downstream caller (e.g. a benchmark harness that wants
//! to render a full step-by-step trajectory, or a UI/debugger) can install a
//! [`RebornTrajectoryObserver`] via
//! [`RebornRuntimeInput::with_trajectory_observer`](crate::RebornRuntimeInput::with_trajectory_observer)
//! to receive those events live.
//!
//! The observer trait itself lives in `ironclaw_loop_support` (next to the
//! capability port that drives it, so both the input hook on the host port and
//! the result hook on the local-dev capability IO can reference one type). It is
//! re-exported here under the reborn-facing name for the composition's API.

pub use ironclaw_loop_support::CapabilityTrajectoryObserver as RebornTrajectoryObserver;
