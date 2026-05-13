//! Declarative predicate evaluator for `Installed`-tier hooks.
//!
//! The evaluator consumes a [`HookPredicateSpec`] plus a per-invocation
//! context and produces an [`EvaluatorDecision`]. Sliding-window state
//! (invocation timestamps, accumulated values) lives in-process inside the
//! evaluator's own `Mutex`-protected maps.
//!
//! Foundation slice coverage:
//!
//! - `HookPredicateSpec::DenyCapability` — predicate-only, stateless.
//! - `HookPredicateSpec::PauseApproval` — predicate-only, stateless.
//! - `HookPredicateSpec::RateOrValueCap` with
//!   `ValueOrRateBound::InvocationCount` — sliding-window counter.
//! - `ValueOrRateBound::NumericSum` — types implemented but evaluation
//!   returns `EvaluatorDecision::Allow` and emits a warn-level audit so the
//!   gap is visible. The full numeric-extraction story belongs in the next
//!   slice where capability arguments become hook-visible.
//!
//! Counter state is in-memory only. Restarts reset the counters; cross-
//! process counters and durable persistence are a separate slice.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::identity::HookId;
use crate::points::BeforeCapabilityHookContext;
use crate::predicate::{
    CapabilityPredicate, HookPredicateSpec, OnExceededAction, ValueOrRateBound,
};

/// Decision returned by the predicate evaluator. The
/// [`crate::installed_hook::PredicateBackedBeforeCapabilityHook`] glue
/// translates these into sink calls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvaluatorDecision {
    /// Predicate did not fire; capability invocation proceeds.
    Allow,
    /// Predicate fired and requested a deny. Carries the reason string to
    /// propagate to the sink.
    Deny { reason: String },
    /// Predicate fired and requested an approval pause.
    PauseApproval { reason: String },
}

/// In-process evaluator. One evaluator per dispatcher / run; sliding-window
/// state is shared across all predicate-backed hooks the evaluator serves.
pub struct PredicateEvaluator {
    /// `(hook_id, capability_name)` → recent invocation timestamps.
    invocation_history: Mutex<HashMap<HistoryKey, VecDeque<Instant>>>,
}

impl PredicateEvaluator {
    pub fn new() -> Self {
        Self {
            invocation_history: Mutex::new(HashMap::new()),
        }
    }

    /// Evaluate `spec` against the given context. Mutates internal counters
    /// for stateful predicates.
    pub fn evaluate(
        &self,
        hook_id: HookId,
        spec: &HookPredicateSpec,
        ctx: &BeforeCapabilityHookContext,
    ) -> EvaluatorDecision {
        self.evaluate_at(hook_id, spec, ctx, Instant::now())
    }

    /// Test-only variant accepting an explicit `now` so sliding-window tests
    /// don't depend on real wall-clock progress.
    pub fn evaluate_at(
        &self,
        hook_id: HookId,
        spec: &HookPredicateSpec,
        ctx: &BeforeCapabilityHookContext,
        now: Instant,
    ) -> EvaluatorDecision {
        match spec {
            HookPredicateSpec::DenyCapability { when, reason } => {
                if predicate_matches(when, ctx) {
                    EvaluatorDecision::Deny {
                        reason: reason.clone(),
                    }
                } else {
                    EvaluatorDecision::Allow
                }
            }
            HookPredicateSpec::PauseApproval { when, reason } => {
                if predicate_matches(when, ctx) {
                    EvaluatorDecision::PauseApproval {
                        reason: reason.clone(),
                    }
                } else {
                    EvaluatorDecision::Allow
                }
            }
            HookPredicateSpec::RateOrValueCap {
                when,
                bound,
                on_exceeded,
            } => {
                if !predicate_matches(when, ctx) {
                    return EvaluatorDecision::Allow;
                }
                match bound {
                    ValueOrRateBound::InvocationCount { max, window } => {
                        let Some(window_dur) = parse_window(window) else {
                            tracing::warn!(
                                window,
                                "predicate evaluator could not parse window; failing closed"
                            );
                            return restrictive_action(on_exceeded);
                        };
                        let key = HistoryKey {
                            hook_id,
                            capability: ctx.capability_name.clone(),
                        };
                        let mut history = self
                            .invocation_history
                            .lock()
                            .expect("predicate history mutex poisoned");
                        let entries = history.entry(key).or_default();
                        // Trim entries outside the window.
                        let cutoff = now.checked_sub(window_dur).unwrap_or(now);
                        while let Some(front) = entries.front() {
                            if *front < cutoff {
                                entries.pop_front();
                            } else {
                                break;
                            }
                        }
                        entries.push_back(now);
                        let count = entries.len() as u32;
                        if count > *max {
                            restrictive_action(on_exceeded)
                        } else {
                            EvaluatorDecision::Allow
                        }
                    }
                    ValueOrRateBound::NumericSum { .. } => {
                        // NumericSum requires inspection of capability
                        // arguments, which the current hook context does not
                        // expose. Surfaced as a known gap; evaluator allows
                        // and emits a warn so misconfigurations are visible.
                        tracing::warn!(
                            "predicate evaluator received NumericSum bound; \
                             argument-extraction support is not yet implemented \
                             (allowing). Track via #3524 follow-up slices."
                        );
                        EvaluatorDecision::Allow
                    }
                }
            }
        }
    }
}

impl Default for PredicateEvaluator {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct HistoryKey {
    hook_id: HookId,
    capability: String,
}

fn predicate_matches(predicate: &CapabilityPredicate, ctx: &BeforeCapabilityHookContext) -> bool {
    match predicate {
        CapabilityPredicate::Always => true,
        CapabilityPredicate::NameEquals { name } => &ctx.capability_name == name,
        CapabilityPredicate::NameStartsWith { prefix } => ctx.capability_name.starts_with(prefix),
        CapabilityPredicate::All { predicates } => {
            predicates.iter().all(|p| predicate_matches(p, ctx))
        }
        CapabilityPredicate::Any { predicates } => {
            predicates.iter().any(|p| predicate_matches(p, ctx))
        }
    }
}

fn restrictive_action(action: &OnExceededAction) -> EvaluatorDecision {
    match action {
        OnExceededAction::Deny { reason } => EvaluatorDecision::Deny {
            reason: reason.clone(),
        },
        OnExceededAction::PauseApproval { reason } => EvaluatorDecision::PauseApproval {
            reason: reason.clone(),
        },
    }
}

/// Parse a window string like `"24h"`, `"10m"`, `"30s"` into a [`Duration`].
/// Unknown units or malformed inputs return `None`.
fn parse_window(input: &str) -> Option<Duration> {
    let input = input.trim();
    if input.is_empty() {
        return None;
    }
    let (num, unit) = input.split_at(input.len() - 1);
    let num: u64 = num.parse().ok()?;
    let secs = match unit {
        "s" => num,
        "m" => num.checked_mul(60)?,
        "h" => num.checked_mul(3600)?,
        "d" => num.checked_mul(86_400)?,
        _ => return None,
    };
    Some(Duration::from_secs(secs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{ExtensionId, HookLocalId, HookVersion};

    fn tenant() -> ironclaw_host_api::TenantId {
        ironclaw_host_api::TenantId::new("alpha").expect("ok")
    }

    fn ctx(capability: &str) -> BeforeCapabilityHookContext {
        BeforeCapabilityHookContext::new(tenant(), capability.to_string(), [0u8; 32])
    }

    fn hook_id() -> HookId {
        HookId::derive(
            &ExtensionId("ext".to_string()),
            "1.0",
            &HookLocalId("h".to_string()),
            HookVersion::ONE,
        )
    }

    #[test]
    fn deny_capability_fires_on_match() {
        let evaluator = PredicateEvaluator::new();
        let spec = HookPredicateSpec::DenyCapability {
            when: CapabilityPredicate::NameEquals {
                name: "shell.exec".to_string(),
            },
            reason: "shell disabled".to_string(),
        };
        let denied = evaluator.evaluate(hook_id(), &spec, &ctx("shell.exec"));
        assert_eq!(
            denied,
            EvaluatorDecision::Deny {
                reason: "shell disabled".to_string()
            }
        );

        let allowed = evaluator.evaluate(hook_id(), &spec, &ctx("memory.read"));
        assert_eq!(allowed, EvaluatorDecision::Allow);
    }

    #[test]
    fn nested_predicate_matches_correctly() {
        let evaluator = PredicateEvaluator::new();
        let spec = HookPredicateSpec::DenyCapability {
            when: CapabilityPredicate::All {
                predicates: vec![
                    CapabilityPredicate::NameStartsWith {
                        prefix: "wallet.".to_string(),
                    },
                    CapabilityPredicate::Any {
                        predicates: vec![
                            CapabilityPredicate::NameEquals {
                                name: "wallet.sign".to_string(),
                            },
                            CapabilityPredicate::NameEquals {
                                name: "wallet.approve".to_string(),
                            },
                        ],
                    },
                ],
            },
            reason: "wallet locked".to_string(),
        };
        assert!(matches!(
            evaluator.evaluate(hook_id(), &spec, &ctx("wallet.sign")),
            EvaluatorDecision::Deny { .. }
        ));
        assert_eq!(
            evaluator.evaluate(hook_id(), &spec, &ctx("wallet.balance")),
            EvaluatorDecision::Allow
        );
        assert_eq!(
            evaluator.evaluate(hook_id(), &spec, &ctx("memory.read")),
            EvaluatorDecision::Allow
        );
    }

    #[test]
    fn invocation_count_cap_denies_after_limit() {
        let evaluator = PredicateEvaluator::new();
        let spec = HookPredicateSpec::RateOrValueCap {
            when: CapabilityPredicate::NameEquals {
                name: "cap.x".to_string(),
            },
            bound: ValueOrRateBound::InvocationCount {
                max: 3,
                window: "1h".to_string(),
            },
            on_exceeded: OnExceededAction::Deny {
                reason: "rate cap".to_string(),
            },
        };
        let now = Instant::now();
        for _ in 0..3 {
            let outcome = evaluator.evaluate_at(hook_id(), &spec, &ctx("cap.x"), now);
            assert_eq!(outcome, EvaluatorDecision::Allow);
        }
        let blocked = evaluator.evaluate_at(hook_id(), &spec, &ctx("cap.x"), now);
        assert_eq!(
            blocked,
            EvaluatorDecision::Deny {
                reason: "rate cap".to_string()
            }
        );
    }

    #[test]
    fn invocation_count_resets_after_window_expires() {
        let evaluator = PredicateEvaluator::new();
        let spec = HookPredicateSpec::RateOrValueCap {
            when: CapabilityPredicate::Always,
            bound: ValueOrRateBound::InvocationCount {
                max: 1,
                window: "10s".to_string(),
            },
            on_exceeded: OnExceededAction::Deny {
                reason: "exceeded".to_string(),
            },
        };
        let start = Instant::now();
        assert_eq!(
            evaluator.evaluate_at(hook_id(), &spec, &ctx("cap.x"), start),
            EvaluatorDecision::Allow
        );
        assert!(matches!(
            evaluator.evaluate_at(
                hook_id(),
                &spec,
                &ctx("cap.x"),
                start + Duration::from_secs(1)
            ),
            EvaluatorDecision::Deny { .. }
        ));
        // After the window expires, both prior entries are trimmed.
        assert_eq!(
            evaluator.evaluate_at(
                hook_id(),
                &spec,
                &ctx("cap.x"),
                start + Duration::from_secs(20)
            ),
            EvaluatorDecision::Allow
        );
    }

    #[test]
    fn invocation_count_partitions_by_capability_name() {
        let evaluator = PredicateEvaluator::new();
        let spec = HookPredicateSpec::RateOrValueCap {
            when: CapabilityPredicate::NameStartsWith {
                prefix: "shell.".to_string(),
            },
            bound: ValueOrRateBound::InvocationCount {
                max: 1,
                window: "1h".to_string(),
            },
            on_exceeded: OnExceededAction::Deny {
                reason: "exceeded".to_string(),
            },
        };
        let now = Instant::now();
        // shell.run hits its cap.
        assert_eq!(
            evaluator.evaluate_at(hook_id(), &spec, &ctx("shell.run"), now),
            EvaluatorDecision::Allow
        );
        assert!(matches!(
            evaluator.evaluate_at(hook_id(), &spec, &ctx("shell.run"), now),
            EvaluatorDecision::Deny { .. }
        ));
        // shell.exec has its own counter.
        assert_eq!(
            evaluator.evaluate_at(hook_id(), &spec, &ctx("shell.exec"), now),
            EvaluatorDecision::Allow
        );
    }

    #[test]
    fn parse_window_supports_basic_units() {
        assert_eq!(parse_window("30s"), Some(Duration::from_secs(30)));
        assert_eq!(parse_window("10m"), Some(Duration::from_secs(600)));
        assert_eq!(parse_window("24h"), Some(Duration::from_secs(86_400)));
        assert_eq!(parse_window("7d"), Some(Duration::from_secs(604_800)));
        assert_eq!(parse_window("notvalid"), None);
        assert_eq!(parse_window(""), None);
        assert_eq!(parse_window("100"), None);
    }

    #[test]
    fn unparseable_window_fails_closed() {
        let evaluator = PredicateEvaluator::new();
        let spec = HookPredicateSpec::RateOrValueCap {
            when: CapabilityPredicate::Always,
            bound: ValueOrRateBound::InvocationCount {
                max: 10,
                window: "abc".to_string(),
            },
            on_exceeded: OnExceededAction::Deny {
                reason: "bad".to_string(),
            },
        };
        assert!(matches!(
            evaluator.evaluate(hook_id(), &spec, &ctx("cap.x")),
            EvaluatorDecision::Deny { .. }
        ));
    }
}
