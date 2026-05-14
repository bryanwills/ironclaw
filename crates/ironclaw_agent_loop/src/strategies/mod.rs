//! Crate-internal strategy trait contracts for the Reborn agent-loop framework.
//!
//! Wire enums remain non-exhaustive so checkpoints and observability payloads
//! can add compatible states without forcing old consumers to assume closure.

// WS-1/2/3 land crate-private strategy contracts before WS-4/5/6 compose and
// execute them. Keep the unused lint local to these forward-declared contracts.
#![allow(dead_code, unused_imports)]

pub(crate) mod batch;
pub(crate) mod budget;
pub(crate) mod capability;
pub(crate) mod context;
pub(crate) mod drain;
pub(crate) mod gate;
pub(crate) mod model;
pub(crate) mod recovery;
pub(crate) mod stop;

pub(crate) use batch::{BatchPolicy, BatchPolicyStrategy, CapabilityCallSummary};
pub(crate) use budget::BudgetStrategy;
pub(crate) use capability::{CapabilityFilter, CapabilityStrategy};
pub(crate) use context::ContextStrategy;
pub(crate) use drain::InputDrainStrategy;
pub(crate) use gate::{GateHandlingStrategy, GateKind, GateOutcome, GateSummary};
pub(crate) use ironclaw_turns::run_profile::ConcurrencyHint;
pub(crate) use model::{ModelPreference, ModelStrategy};
pub(crate) use recovery::{
    BackoffDelayMs, CapabilityErrorClass, CapabilityErrorSummary, ModelErrorClass,
    ModelErrorSummary, RecoveryOutcome, RecoveryStrategy, RetryAlteration, RetryScope,
    SanitizedStrategySummary,
};
pub(crate) use stop::{StopConditionStrategy, StopKind, StopOutcome, TurnEndKind, TurnSummary};
