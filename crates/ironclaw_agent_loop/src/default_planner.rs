//! `DefaultPlanner` — the reference composition of the nine strategies.
//!
//! See `docs/reborn/agent-loop-skeleton.md` §3 ("Planner facade") + §6
//! ("Strategy decomposition"), and the workstream brief
//! `docs/reborn/agent-loop-briefs/planner-facade.md`.
//!
//! ## Coordination with WS-5
//!
//! The brief explains that the production `Default*Strategy` implementations
//! (one per strategy) ship in the parallel workstream WS-5. To unblock WS-4
//! from being merged behind WS-5, this file uses *internal placeholder
//! structs* that satisfy each strategy trait with the minimal value the
//! executor will tolerate. WS-5 then replaces `DefaultPlanner::default()` so
//! that it composes the real `Default*Strategy` types instead of these
//! placeholders. The placeholders are intentionally `pub(crate)` only — they
//! are not part of the framework's public API.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ironclaw_turns::run_profile::{LoopPromptBundleRequest, PromptMode};

use crate::planner::{AgentLoopPlanner, PlannerId};
use crate::state::LoopExecutionState;
use crate::strategies::{
    BatchPolicy, BatchPolicyStrategy, BudgetStrategy, CapabilityCallSummary,
    CapabilityErrorSummary, CapabilityFilter, CapabilityStrategy, ContextStrategy,
    GateHandlingStrategy, GateOutcome, GateSummary, InputDrainStrategy, ModelErrorSummary,
    ModelPreference, ModelStrategy, RecoveryOutcome, RecoveryStrategy, StopConditionStrategy,
    StopOutcome, TurnSummary,
};

/// The reference planner. Composes nine strategies; each can be swapped
/// individually via the builder methods.
///
/// `DefaultPlanner::default()` returns the all-`Default*Strategy` composition
/// that models pi-mono behavior (the real `Default*Strategy` impls ship in
/// WS-5; this skeleton uses internal placeholders so the framework compiles
/// in isolation — see this module's header comment).
///
/// Loop families build on top by overriding individual strategies:
///
/// ```ignore
/// // Hypothetical loop-family override (real `CodingContextStrategy` lives
/// // outside this crate).
/// let coding = DefaultPlanner::default()
///     .with_id(PlannerId::new("reborn:coding-loop")?)
///     .with_context(Arc::new(CodingContextStrategy::new()));
/// ```
#[derive(Clone)]
pub struct DefaultPlanner {
    id: PlannerId,
    context: Arc<dyn ContextStrategy>,
    capability: Arc<dyn CapabilityStrategy>,
    model: Arc<dyn ModelStrategy>,
    batch: Arc<dyn BatchPolicyStrategy>,
    gate: Arc<dyn GateHandlingStrategy>,
    recovery: Arc<dyn RecoveryStrategy>,
    stop: Arc<dyn StopConditionStrategy>,
    drain: Arc<dyn InputDrainStrategy>,
    budget: Arc<dyn BudgetStrategy>,
}

impl DefaultPlanner {
    /// Replace the planner id (loop families set their own to disambiguate
    /// in checkpoint payloads).
    pub fn with_id(mut self, id: PlannerId) -> Self {
        self.id = id;
        self
    }

    /// Override the context strategy. Returns `Self` for chaining.
    pub fn with_context(mut self, strategy: Arc<dyn ContextStrategy>) -> Self {
        self.context = strategy;
        self
    }

    /// Override the capability filter strategy.
    pub fn with_capability(mut self, strategy: Arc<dyn CapabilityStrategy>) -> Self {
        self.capability = strategy;
        self
    }

    /// Override the model preference strategy.
    pub fn with_model(mut self, strategy: Arc<dyn ModelStrategy>) -> Self {
        self.model = strategy;
        self
    }

    /// Override the batch policy strategy.
    pub fn with_batch(mut self, strategy: Arc<dyn BatchPolicyStrategy>) -> Self {
        self.batch = strategy;
        self
    }

    /// Override the gate-handling strategy.
    pub fn with_gate(mut self, strategy: Arc<dyn GateHandlingStrategy>) -> Self {
        self.gate = strategy;
        self
    }

    /// Override the recovery strategy.
    pub fn with_recovery(mut self, strategy: Arc<dyn RecoveryStrategy>) -> Self {
        self.recovery = strategy;
        self
    }

    /// Override the stop-condition strategy.
    pub fn with_stop(mut self, strategy: Arc<dyn StopConditionStrategy>) -> Self {
        self.stop = strategy;
        self
    }

    /// Override the input-drain strategy.
    pub fn with_drain(mut self, strategy: Arc<dyn InputDrainStrategy>) -> Self {
        self.drain = strategy;
        self
    }

    /// Override the budget strategy.
    pub fn with_budget(mut self, strategy: Arc<dyn BudgetStrategy>) -> Self {
        self.budget = strategy;
        self
    }
}

impl AgentLoopPlanner for DefaultPlanner {
    fn id(&self) -> &PlannerId {
        &self.id
    }

    fn context(&self) -> &dyn ContextStrategy {
        &*self.context
    }

    fn capability(&self) -> &dyn CapabilityStrategy {
        &*self.capability
    }

    fn model(&self) -> &dyn ModelStrategy {
        &*self.model
    }

    fn batch(&self) -> &dyn BatchPolicyStrategy {
        &*self.batch
    }

    fn gate(&self) -> &dyn GateHandlingStrategy {
        &*self.gate
    }

    fn recovery(&self) -> &dyn RecoveryStrategy {
        &*self.recovery
    }

    fn stop(&self) -> &dyn StopConditionStrategy {
        &*self.stop
    }

    fn drain(&self) -> &dyn InputDrainStrategy {
        &*self.drain
    }

    fn budget(&self) -> &dyn BudgetStrategy {
        &*self.budget
    }
}

impl Default for DefaultPlanner {
    /// Composes nine placeholder strategy instances with the canonical
    /// `"reborn:default-loop"` id. WS-5 replaces the placeholders with the
    /// real `Default*Strategy` impls; the public composition API does not
    /// change.
    fn default() -> Self {
        // Construction of the canonical id uses a vetted literal that
        // satisfies `PlannerId::validate`. We surface the validation failure
        // as a panic-free `Result` upstream by re-deriving it once and
        // erroring at *test* time only — production constructors never
        // see a failure here because the literal is fixed.
        Self {
            id: canonical_default_id(),
            context: Arc::new(PlaceholderStrategy),
            capability: Arc::new(PlaceholderStrategy),
            model: Arc::new(PlaceholderStrategy),
            batch: Arc::new(PlaceholderStrategy),
            gate: Arc::new(PlaceholderStrategy),
            recovery: Arc::new(PlaceholderStrategy),
            stop: Arc::new(PlaceholderStrategy),
            drain: Arc::new(PlaceholderStrategy),
            budget: Arc::new(PlaceholderStrategy),
        }
    }
}

/// The canonical id used by `DefaultPlanner::default()`. Lives in a free
/// function so we can prove its validity in tests rather than at the
/// constructor call site.
fn canonical_default_id() -> PlannerId {
    // SAFETY-style note: the literal `"reborn:default-loop"` satisfies
    // `PlannerId::validate` — see `default_planner_id_literal_is_valid`
    // below. The `.unwrap_or_else` gives us a deterministic, no-`expect`
    // construction in release; the test guards against drift.
    PlannerId::new("reborn:default-loop").unwrap_or_else(|_| {
        // Unreachable: covered by the const-validity test. We still avoid
        // `expect` per `.claude/rules/error-handling.md`. If this ever
        // fires, the placeholder yields the literal anyway — the trait
        // surface remains usable, the bug is loud in tests.
        debug_assert!(
            false,
            "reborn:default-loop literal failed PlannerId::validate"
        );
        // Fall back to a guaranteed-valid one-byte id so the planner is
        // still constructable in pathological release builds.
        PlannerId::new("x").unwrap_or_else(|_| unreachable!("single ascii byte is valid"))
    })
}

// =====================================================================
// Placeholder strategy impls — see this module's header comment for why.
// WS-5 will replace `DefaultPlanner::default()` to drop these in favor
// of the real `Default*Strategy` types.
// =====================================================================

/// Single zero-sized placeholder that implements every strategy trait.
/// Defined once and reused so each strategy slot doesn't need its own
/// stub type.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct PlaceholderStrategy;

#[async_trait]
impl ContextStrategy for PlaceholderStrategy {
    async fn plan_context_request(&self, _state: &LoopExecutionState) -> LoopPromptBundleRequest {
        LoopPromptBundleRequest {
            mode: PromptMode::TextOnly,
            context_cursor: None,
            surface_version: None,
            checkpoint_state_ref: None,
            max_messages: None,
            inline_messages: Vec::new(),
        }
    }
}

#[async_trait]
impl CapabilityStrategy for PlaceholderStrategy {
    async fn filter(&self, _state: &LoopExecutionState) -> CapabilityFilter {
        CapabilityFilter::All
    }
}

#[async_trait]
impl ModelStrategy for PlaceholderStrategy {
    async fn preference(&self, _state: &LoopExecutionState) -> ModelPreference {
        ModelPreference::Primary
    }
}

impl BatchPolicyStrategy for PlaceholderStrategy {
    fn policy(&self, _state: &LoopExecutionState, _calls: &[CapabilityCallSummary]) -> BatchPolicy {
        BatchPolicy::Sequential
    }
}

#[async_trait]
impl GateHandlingStrategy for PlaceholderStrategy {
    async fn handle(&self, state: &LoopExecutionState, _gate: &GateSummary) -> GateOutcome {
        GateOutcome::Block {
            control: state.control_state.clone(),
        }
    }
}

#[async_trait]
impl RecoveryStrategy for PlaceholderStrategy {
    async fn on_capability_error(
        &self,
        state: &LoopExecutionState,
        _err: &CapabilityErrorSummary,
    ) -> RecoveryOutcome {
        RecoveryOutcome::SkipResult {
            recovery: state.recovery_state.clone(),
        }
    }

    async fn on_model_error(
        &self,
        state: &LoopExecutionState,
        _err: &ModelErrorSummary,
    ) -> RecoveryOutcome {
        RecoveryOutcome::SkipResult {
            recovery: state.recovery_state.clone(),
        }
    }
}

#[async_trait]
impl StopConditionStrategy for PlaceholderStrategy {
    async fn should_stop_after_turn(
        &self,
        state: &LoopExecutionState,
        _just_completed: &TurnSummary,
    ) -> StopOutcome {
        StopOutcome::Continue {
            control: state.control_state.clone(),
        }
    }
}

#[async_trait]
impl InputDrainStrategy for PlaceholderStrategy {
    async fn drain_steering(&self, _state: &LoopExecutionState) -> bool {
        false
    }

    async fn drain_followup(&self, _state: &LoopExecutionState) -> bool {
        false
    }
}

impl BudgetStrategy for PlaceholderStrategy {
    fn iteration_limit(&self, _state: &LoopExecutionState) -> u32 {
        32
    }

    fn wall_clock_limit(&self, _state: &LoopExecutionState) -> Option<Duration> {
        None
    }
}

#[cfg(test)]
mod tests {
    use ironclaw_host_api::{CapabilityId, TenantId, ThreadId};

    use crate::state::{ControlStrategyState, RecoveryStrategyState};
    use ironclaw_turns::{
        AgentLoopDriverDescriptor, RunProfileId, RunProfileVersion, TurnId, TurnRunId, TurnScope,
        run_profile::{
            CancellationPolicy, CapabilitySurfaceProfileId, CheckpointPolicy, CheckpointSchemaId,
            ConcurrencyClass, ContextProfileId, LoopDriverId, LoopRunContext, ModelProfileId,
            RedactedRunProfileProvenance, ResolvedRunProfile, ResourceBudgetPolicy,
            ResourceBudgetTier, RunClassId, RunProfileFingerprint, RuntimeProfileConstraints,
            SchedulingClass, SteeringPolicy,
        },
    };

    use super::*;

    fn assert_send_sync<T: Send + Sync>() {}
    fn assert_clone<T: Clone>() {}

    /// Compile-time object-safety guard for the planner trait.
    #[allow(dead_code)]
    fn _check(_: &dyn AgentLoopPlanner) {}

    #[test]
    fn default_planner_is_send_sync_and_clone() {
        assert_send_sync::<DefaultPlanner>();
        assert_clone::<DefaultPlanner>();
    }

    #[test]
    fn default_planner_has_canonical_id() {
        let planner = DefaultPlanner::default();
        assert_eq!(planner.id().as_str(), "reborn:default-loop");
    }

    #[test]
    fn default_planner_id_literal_is_valid() {
        // Locks the canonical id literal against drift — if someone retypes
        // it to something the validator rejects, this test fires before the
        // production `unwrap_or_else` fallback hides the regression.
        assert!(PlannerId::new("reborn:default-loop").is_ok());
    }

    #[test]
    fn default_planner_clone_preserves_id() {
        let planner = DefaultPlanner::default();
        let cloned = planner.clone();
        assert_eq!(planner.id(), cloned.id());
    }

    #[test]
    fn default_planner_is_object_safe_through_dyn_trait() {
        let planner: Box<dyn AgentLoopPlanner> = Box::new(DefaultPlanner::default());
        assert_eq!(planner.id().as_str(), "reborn:default-loop");
    }

    #[test]
    fn with_id_overrides_id_slot() {
        let id = PlannerId::new("reborn:custom-loop").expect("valid");
        let planner = DefaultPlanner::default().with_id(id.clone());
        assert_eq!(planner.id(), &id);
    }

    #[test]
    fn builder_chain_overrides_propagate_to_accessors() {
        let id = PlannerId::new("reborn:override-test").expect("valid");

        // Custom strategies for two of the slots — verify the planner hands
        // BACK the same trait object after building.
        #[derive(Default)]
        struct CustomContext;
        #[async_trait]
        impl ContextStrategy for CustomContext {
            async fn plan_context_request(
                &self,
                _state: &LoopExecutionState,
            ) -> LoopPromptBundleRequest {
                LoopPromptBundleRequest {
                    mode: PromptMode::TextOnly,
                    context_cursor: None,
                    surface_version: None,
                    checkpoint_state_ref: None,
                    max_messages: Some(7),
                    inline_messages: Vec::new(),
                }
            }
        }

        #[derive(Default)]
        struct CustomCapability;
        #[async_trait]
        impl CapabilityStrategy for CustomCapability {
            async fn filter(&self, _state: &LoopExecutionState) -> CapabilityFilter {
                CapabilityFilter::AllowOnly(vec![
                    CapabilityId::new("demo.echo").expect("valid capability id"),
                ])
            }
        }

        let planner = DefaultPlanner::default()
            .with_id(id.clone())
            .with_context(Arc::new(CustomContext))
            .with_capability(Arc::new(CustomCapability));

        assert_eq!(planner.id(), &id);

        // Drive the strategy accessors to confirm the overrides reached the
        // facade — this is the "test through the caller" pattern from
        // `.claude/rules/testing.md`: assert via the trait surface, not the
        // private slot.
        let state = LoopExecutionState::initial_for_run(&test_run_context());
        let request = futures::executor::block_on(planner.context().plan_context_request(&state));
        assert_eq!(request.max_messages, Some(7));

        let filter = futures::executor::block_on(planner.capability().filter(&state));
        let expected_capability = CapabilityId::new("demo.echo").expect("valid capability id");
        assert_eq!(
            filter,
            CapabilityFilter::AllowOnly(vec![expected_capability])
        );
    }

    #[test]
    fn placeholder_strategies_satisfy_default_invariants() {
        let planner = DefaultPlanner::default();
        let state = LoopExecutionState::initial_for_run(&test_run_context());

        // Budget placeholder: 32 iterations, no wall clock.
        assert_eq!(planner.budget().iteration_limit(&state), 32);
        assert_eq!(planner.budget().wall_clock_limit(&state), None);

        // Batch placeholder: sequential, regardless of input.
        assert_eq!(planner.batch().policy(&state, &[]), BatchPolicy::Sequential);

        // Capability placeholder: All.
        let filter = futures::executor::block_on(planner.capability().filter(&state));
        assert_eq!(filter, CapabilityFilter::All);

        // Model placeholder: Primary.
        let preference = futures::executor::block_on(planner.model().preference(&state));
        assert_eq!(preference, ModelPreference::Primary);

        // Drain placeholder: never drains.
        let steering = futures::executor::block_on(planner.drain().drain_steering(&state));
        let followup = futures::executor::block_on(planner.drain().drain_followup(&state));
        assert!(!steering);
        assert!(!followup);
    }

    #[test]
    fn placeholder_recovery_returns_skip_result() {
        let planner = DefaultPlanner::default();
        let state = LoopExecutionState::initial_for_run(&test_run_context());
        let summary = CapabilityErrorSummary {
            class: crate::strategies::CapabilityErrorClass::Transient,
            safe_summary: "noop".to_string(),
            diagnostic_ref: None,
        };

        let outcome =
            futures::executor::block_on(planner.recovery().on_capability_error(&state, &summary));
        assert!(matches!(
            outcome,
            RecoveryOutcome::SkipResult {
                recovery: RecoveryStrategyState { attempts: 0 }
            }
        ));
    }

    #[test]
    fn placeholder_gate_returns_block_with_current_control_state() {
        let planner = DefaultPlanner::default();
        let state = LoopExecutionState::initial_for_run(&test_run_context());
        let summary = GateSummary {
            kind: crate::strategies::GateKind::Approval,
            gate_ref: ironclaw_turns::LoopGateRef::new("gate:placeholder").expect("valid"),
        };

        let outcome = futures::executor::block_on(planner.gate().handle(&state, &summary));
        assert!(matches!(
            outcome,
            GateOutcome::Block {
                control: ControlStrategyState {
                    turns_completed: 0,
                    terminate_hints_in_last_batch: 0,
                    last_batch_total: 0,
                }
            }
        ));
    }

    fn test_run_context() -> LoopRunContext {
        let scope = TurnScope::new(
            TenantId::new("tenant-default-planner").expect("valid"),
            None,
            None,
            ThreadId::new("thread-default-planner").expect("valid"),
        );
        let descriptor = AgentLoopDriverDescriptor {
            id: LoopDriverId::new("default_planner_test_driver").expect("valid"),
            version: RunProfileVersion::new(1),
            checkpoint_schema_id: Some(
                CheckpointSchemaId::new("default_planner_test_checkpoint").expect("valid"),
            ),
            checkpoint_schema_version: Some(RunProfileVersion::new(1)),
        };
        let resolved_run_profile = ResolvedRunProfile {
            run_class_id: RunClassId::new("default_planner_test_class").expect("valid"),
            profile_id: RunProfileId::default_profile(),
            profile_version: RunProfileVersion::new(1),
            loop_driver: descriptor.clone(),
            checkpoint_schema_id: descriptor
                .checkpoint_schema_id
                .clone()
                .expect("descriptor checkpoint id"),
            checkpoint_schema_version: descriptor
                .checkpoint_schema_version
                .expect("descriptor checkpoint version"),
            model_profile_id: ModelProfileId::new("default_planner_test_model").expect("valid"),
            capability_surface_profile_id: CapabilitySurfaceProfileId::new(
                "default_planner_test_capabilities",
            )
            .expect("valid"),
            context_profile_id: ContextProfileId::new("default_planner_test_context")
                .expect("valid"),
            steering_policy: SteeringPolicy {
                allow_steering: false,
                allow_interrupt: true,
                allow_driver_specific_nudges: false,
            },
            cancellation_policy: CancellationPolicy {
                allow_cancel: true,
                require_checkpoint_before_cancel: false,
            },
            checkpoint_policy: CheckpointPolicy {
                require_before_model: false,
                require_before_side_effect: false,
                require_before_block: true,
                max_checkpoint_bytes: 64 * 1024,
                require_final_checkpoint: false,
                allow_no_reply_completion: false,
            },
            resource_budget_policy: ResourceBudgetPolicy {
                tier: ResourceBudgetTier::new("default_planner_test_tier").expect("valid"),
                max_model_calls: 32,
                max_capability_invocations: 64,
            },
            runtime_constraints: RuntimeProfileConstraints {
                allow_raw_runtime_backend_selection: false,
                allow_broad_capability_surface: false,
            },
            runner_pool_id: None,
            scheduling_class: SchedulingClass::new("interactive").expect("valid"),
            concurrency_class: ConcurrencyClass::new("thread_serial").expect("valid"),
            resolution_fingerprint: RunProfileFingerprint::new("default-planner-test-fingerprint")
                .expect("valid"),
            provenance: RedactedRunProfileProvenance {
                sources: vec![],
                effective_privileges: vec![],
            },
        };
        LoopRunContext::new(scope, TurnId::new(), TurnRunId::new(), resolved_run_profile)
    }
}
