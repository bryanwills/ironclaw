//! Canonical per-caller thread-scope resolution.
//!
//! Multi-user WebChat pins each run to its authenticated caller, and the
//! loop host writes that run's thread under `owners/<caller>`. Every
//! subsequent read/write for the run must resolve the SAME owner — both
//! the loop host's thread ports ([`crate::loop_driver_host`]) AND the
//! loop-exit completion-evidence read ([`crate::loop_exit_applier`]).
//!
//! [`ThreadScopeResolver::resolve`] is the single definition of that
//! owner-rewrite rule. Both subsystems call it, so the rule cannot drift
//! between them — a second hand-rolled copy silently regressing
//! multi-user isolation is exactly the maintainability hazard this
//! removes.

use ironclaw_threads::ThreadScope;
use ironclaw_turns::{TurnActor, TurnLifecycleEvent, TurnRunState, TurnScope};

/// Canonical owner-scoping rule for per-caller thread isolation.
pub struct ThreadScopeResolver;

impl ThreadScopeResolver {
    /// Re-point `base`'s `owner_user_id` at the run's authenticated
    /// `actor`, so each caller's thread I/O is isolated to its own
    /// `owners/<user>` subtree.
    ///
    /// Only rewrites when the base scope is owner-scoped: an owner-less
    /// base (no declared owner) or an actor-less run is returned
    /// unchanged, so single-operator and system flows are untouched.
    pub(crate) fn resolve(base: &ThreadScope, actor: Option<&TurnActor>) -> ThreadScope {
        let mut scope = base.clone();
        if scope.owner_user_id.is_some()
            && let Some(actor) = actor
        {
            scope.owner_user_id = Some(actor.user_id.clone());
        }
        scope
    }

    pub(crate) fn resolve_for_turn(
        base: &ThreadScope,
        turn_scope: &TurnScope,
        actor: Option<&TurnActor>,
    ) -> ThreadScope {
        if turn_scope.has_explicit_thread_owner() {
            let mut scope = base.clone();
            scope.owner_user_id = turn_scope.explicit_owner_user_id().cloned();
            return scope;
        }
        Self::resolve(base, actor)
    }

    /// Derive a [`ThreadScope`] from a [`TurnLifecycleEvent`].
    ///
    /// Returns `Err` when the scope cannot be derived (e.g. agentless turn).
    /// The owner-fallback rule mirrors [`lifecycle_owner_user_id`]: prefer the
    /// explicit thread owner from `scope.thread_owner`, fall back to
    /// `event.owner_user_id` (which the event publisher already resolved as
    /// `explicit_owner OR actor.user_id`).
    ///
    /// Call sites that handle derivation failure as a non-fatal skip must use
    /// this method rather than re-implementing the owner-fallback locally.
    pub fn derive_for_terminal_event(
        event: &TurnLifecycleEvent,
    ) -> Result<ThreadScope, &'static str> {
        let Some(agent_id) = event.scope.agent_id.clone() else {
            return Err("agentless turn scope — no ThreadScope");
        };
        let owner_user_id = event
            .scope
            .explicit_owner_user_id()
            .cloned()
            .or_else(|| event.owner_user_id.clone());
        Ok(ThreadScope {
            tenant_id: event.scope.tenant_id.clone(),
            agent_id,
            project_id: event.scope.project_id.clone(),
            owner_user_id,
            mission_id: None,
        })
    }

    /// Derive a [`ThreadScope`] from a [`TurnRunState`].
    ///
    /// Returns `Err` when the scope cannot be derived (e.g. agentless turn).
    /// Owner precedence: explicit thread owner from `scope.thread_owner`, then
    /// the run's actor user id.
    ///
    /// Call sites that handle derivation failure as a non-fatal skip must use
    /// this method rather than re-implementing the owner-fallback locally.
    pub fn derive_for_terminal_state(state: &TurnRunState) -> Result<ThreadScope, &'static str> {
        let Some(agent_id) = state.scope.agent_id.clone() else {
            return Err("agentless turn scope — no ThreadScope");
        };
        let owner_user_id = state
            .scope
            .explicit_owner_user_id()
            .cloned()
            .or_else(|| state.actor.as_ref().map(|a| a.user_id.clone()));
        Ok(ThreadScope {
            tenant_id: state.scope.tenant_id.clone(),
            agent_id,
            project_id: state.scope.project_id.clone(),
            owner_user_id,
            mission_id: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironclaw_host_api::{AgentId, TenantId, UserId};

    fn scope(owner: Option<&str>) -> ThreadScope {
        ThreadScope {
            tenant_id: TenantId::new("tenant").expect("tenant"),
            agent_id: AgentId::new("agent").expect("agent"),
            project_id: None,
            owner_user_id: owner.map(|o| UserId::new(o).expect("user")),
            mission_id: None,
        }
    }

    fn actor(user: &str) -> TurnActor {
        TurnActor::new(UserId::new(user).expect("user"))
    }

    #[test]
    fn rewrites_owner_to_run_actor_when_base_is_owner_scoped() {
        let base = scope(Some("runtime-owner"));
        let a = ThreadScopeResolver::resolve(&base, Some(&actor("alice")));
        let b = ThreadScopeResolver::resolve(&base, Some(&actor("bob")));
        assert_eq!(a.owner_user_id.as_ref().map(|u| u.as_str()), Some("alice"));
        assert_eq!(b.owner_user_id.as_ref().map(|u| u.as_str()), Some("bob"));
    }

    #[test]
    fn leaves_owner_unchanged_when_run_has_no_actor() {
        let base = scope(Some("runtime-owner"));
        let resolved = ThreadScopeResolver::resolve(&base, None);
        assert_eq!(
            resolved.owner_user_id.as_ref().map(|u| u.as_str()),
            Some("runtime-owner"),
        );
    }

    #[test]
    fn leaves_owner_less_base_unchanged_even_with_an_actor() {
        let base = scope(None);
        let resolved = ThreadScopeResolver::resolve(&base, Some(&actor("alice")));
        assert!(
            resolved.owner_user_id.is_none(),
            "an owner-agnostic base must stay system/shared-scoped"
        );
    }

    #[test]
    fn explicit_turn_owner_overrides_actor_rewrite() {
        let base = scope(Some("runtime-owner"));
        let turn_scope = TurnScope::new_with_owner(
            base.tenant_id.clone(),
            Some(base.agent_id.clone()),
            base.project_id.clone(),
            ironclaw_host_api::ThreadId::new("thread").unwrap(),
            None,
        );

        let resolved =
            ThreadScopeResolver::resolve_for_turn(&base, &turn_scope, Some(&actor("alice")));

        assert_eq!(resolved.owner_user_id, None);
    }
}
