//! Strategy contracts for the Reborn agent-loop framework.
//!
//! Wire enums remain non-exhaustive so checkpoints and observability payloads
//! can add compatible states without forcing old consumers to assume closure.

// WS-1/2/3 land crate-private strategy contracts before WS-4/5/6 compose and
// execute them. Keep the unused lint local to these forward-declared contracts.
#![allow(dead_code, unused_imports)]

mod budget;
mod drain;
mod stop;

pub(crate) use budget::BudgetStrategy;
pub(crate) use drain::InputDrainStrategy;
pub(crate) use stop::{StopConditionStrategy, StopKind, StopOutcome, TurnEndKind, TurnSummary};
