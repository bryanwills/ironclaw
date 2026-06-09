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

use serde_json::Value;

/// Receives capability/tool invocations and their results during a run.
///
/// `call_id` correlates an `on_capability_input` with its matching
/// `on_capability_result` (it is the capability input ref). Implementations must
/// be cheap and non-blocking; this is best-effort observation and must not affect
/// the run outcome.
pub trait RebornTrajectoryObserver: std::fmt::Debug + Send + Sync {
    /// A capability/tool was invoked with `tool_name` and `arguments`. Not every
    /// runtime staging path surfaces inputs here (provider tool calls are staged
    /// by a lower decorator), so consumers must also handle a result arriving for
    /// a `call_id` they never saw an input for — see [`Self::on_capability_result`].
    fn on_capability_input(&self, call_id: &str, tool_name: &str, arguments: &Value);

    /// The capability keyed by `call_id` (capability id `capability_id`, e.g.
    /// `builtin.shell`) produced `output`. This fires for every completed
    /// capability, so it is the reliable spine of the trajectory.
    fn on_capability_result(&self, call_id: &str, capability_id: &str, output: &Value);
}
