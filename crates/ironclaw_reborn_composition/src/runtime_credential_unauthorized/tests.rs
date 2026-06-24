use std::sync::Arc;

use ironclaw_auth::{
    AuthProductError, AuthProviderId, CredentialAccountLabel, CredentialAccountLookupRequest,
    CredentialAccountProjection, CredentialAccountStatus, CredentialOwnership,
    CredentialRecoveryProjection, CredentialRefreshReport, CredentialRefreshRequest,
    InMemoryAuthProductServices, NewCredentialAccount, ProviderScope,
};
use ironclaw_host_api::{
    CapabilityId, CapabilitySet, CorrelationId, CredentialStageError, ExecutionContext,
    ExtensionId, InvocationId, MountView, NetworkMethod, NetworkPolicy, ResourceEstimate,
    ResourceScope, ResourceUsage, RuntimeCredentialAccountProviderId,
    RuntimeCredentialAccountSetup, RuntimeCredentialAuthRequirement, RuntimeCredentialUnauthorized,
    RuntimeCredentialUnauthorizedPolicy, RuntimeKind, TrustClass, UserId,
};
use ironclaw_host_runtime::{
    CancelRuntimeWorkOutcome, CancelRuntimeWorkRequest, HostRuntime, HostRuntimeError,
    HostRuntimeHealth, HostRuntimeStatus, RuntimeCapabilityCompleted, RuntimeCapabilityOutcome,
    RuntimeCapabilityRequest, RuntimeCapabilityResumeRequest, RuntimeCredentialAccountRequest,
    RuntimeCredentialAccountResolver, RuntimeStatusRequest, VisibleCapabilityRequest,
    VisibleCapabilitySurface,
};
use ironclaw_trust::{AuthorityCeiling, EffectiveTrustClass, TrustDecision, TrustProvenance};

use crate::runtime_credential_reauth::RuntimeCredentialReauthHostRuntime;

use super::*;

#[tokio::test]
async fn runtime_credential_unauthorized_recovery_revokes_marked_401_account() {
    let accounts = Arc::new(InMemoryAuthProductServices::new());
    let resource_scope = resource_scope();
    let auth_scope = AuthProductScope::credential_owner(&resource_scope, AuthSurface::Api);
    let account = seed_account(&accounts, auth_scope.clone()).await;
    let egress = Arc::new(FixedEgress {
        status: 401,
        credential_unauthorized: Some(unauthorized_marker(
            &resource_scope,
            "github",
            &account,
            RuntimeCredentialUnauthorizedPolicy::RevokeAccount,
            github_auth_requirement(),
            None,
        )),
    });
    let reauth_bridge = Arc::new(RuntimeCredentialReauthBridge::default());
    let wrapper =
        RuntimeCredentialUnauthorizedRecoveryEgress::new(egress, accounts.clone(), reauth_bridge);

    wrapper
        .execute(request(resource_scope))
        .await
        .expect("egress response should pass through");

    let stored = accounts
        .get_account(CredentialAccountLookupRequest::new(auth_scope, account.id))
        .await
        .expect("lookup")
        .expect("account");
    assert_eq!(stored.status, CredentialAccountStatus::Revoked);
}

#[tokio::test]
async fn runtime_credential_unauthorized_recovery_records_same_run_auth_required_signal() {
    let accounts = Arc::new(InMemoryAuthProductServices::new());
    let resource_scope = resource_scope();
    let auth_scope = AuthProductScope::credential_owner(&resource_scope, AuthSurface::Api);
    let account = seed_account(&accounts, auth_scope).await;
    let egress = Arc::new(FixedEgress {
        status: 401,
        credential_unauthorized: Some(unauthorized_marker(
            &resource_scope,
            "github",
            &account,
            RuntimeCredentialUnauthorizedPolicy::RevokeAccount,
            github_auth_requirement(),
            None,
        )),
    });
    let reauth_bridge = Arc::new(RuntimeCredentialReauthBridge::default());
    let wrapper = RuntimeCredentialUnauthorizedRecoveryEgress::new(
        egress,
        accounts,
        Arc::clone(&reauth_bridge),
    );
    let runtime_request = request(resource_scope.clone());
    let capability_id = runtime_request.capability_id.clone();

    wrapper
        .execute(runtime_request)
        .await
        .expect("egress response should pass through");

    let signal = reauth_bridge
        .take_recovered_auth_required(&resource_scope, &capability_id)
        .expect("revoke should record same-run auth required");
    assert_eq!(
        signal.credential_requirements,
        vec![github_auth_requirement()]
    );
}

#[tokio::test]
async fn runtime_credential_unauthorized_recovery_requires_auth_when_refresh_leaves_token_unchanged()
 {
    let inner = Arc::new(InMemoryAuthProductServices::new());
    let resource_scope = resource_scope();
    let auth_scope = AuthProductScope::credential_owner(&resource_scope, AuthSurface::Api);
    let account = seed_oauth_account(&inner, auth_scope).await;
    let accounts = Arc::new(NoopRefreshCredentialAccounts {
        inner: Arc::clone(&inner),
    });
    let egress = Arc::new(FixedEgress {
        status: 401,
        credential_unauthorized: Some(unauthorized_marker(
            &resource_scope,
            "google",
            &account,
            RuntimeCredentialUnauthorizedPolicy::RefreshAccount,
            google_auth_requirement(),
            None,
        )),
    });
    let reauth_bridge = Arc::new(RuntimeCredentialReauthBridge::default());
    let wrapper = RuntimeCredentialUnauthorizedRecoveryEgress::new(
        egress,
        accounts,
        Arc::clone(&reauth_bridge),
    );
    let runtime_request = request(resource_scope.clone());
    let capability_id = runtime_request.capability_id.clone();

    wrapper
        .execute(runtime_request)
        .await
        .expect("egress response should pass through");

    let signal = reauth_bridge
        .take_recovered_auth_required(&resource_scope, &capability_id)
        .expect("unchanged refresh after 401 should require same-run auth");
    assert_eq!(
        signal.credential_requirements,
        vec![google_auth_requirement()]
    );
}

#[tokio::test]
async fn runtime_credential_reauth_host_runtime_opens_auth_gate_from_recovered_401() {
    let accounts = Arc::new(InMemoryAuthProductServices::new());
    let resource_scope = resource_scope();
    let auth_scope = AuthProductScope::credential_owner(&resource_scope, AuthSurface::Api);
    let account = seed_account(&accounts, auth_scope.clone()).await;
    let reauth_bridge = Arc::new(RuntimeCredentialReauthBridge::default());
    let recovery_egress = Arc::new(RuntimeCredentialUnauthorizedRecoveryEgress::new(
        Arc::new(FixedEgress {
            status: 401,
            credential_unauthorized: Some(unauthorized_marker(
                &resource_scope,
                "github",
                &account,
                RuntimeCredentialUnauthorizedPolicy::RevokeAccount,
                github_auth_requirement(),
                None,
            )),
        }),
        accounts.clone(),
        Arc::clone(&reauth_bridge),
    ));
    let runtime = RuntimeCredentialReauthHostRuntime::new(
        Arc::new(EgressCallingHostRuntime {
            egress: recovery_egress,
        }),
        reauth_bridge,
    );

    let outcome = runtime
        .invoke_capability(runtime_request(resource_scope.clone()))
        .await
        .expect("invoke should complete through reauth wrapper");

    let RuntimeCapabilityOutcome::AuthRequired(gate) = outcome else {
        panic!("expected auth gate from recovered 401, got {outcome:?}");
    };
    assert_eq!(gate.capability_id, capability_id());
    assert!(gate.required_secrets.is_empty());
    assert_eq!(
        gate.credential_requirements,
        vec![github_auth_requirement()]
    );
    let stored = accounts
        .get_account(CredentialAccountLookupRequest::new(auth_scope, account.id))
        .await
        .expect("lookup")
        .expect("account");
    assert_eq!(stored.status, CredentialAccountStatus::Revoked);
}

#[tokio::test]
async fn runtime_credential_reauth_host_runtime_leaves_unmarked_403_completed() {
    let accounts = Arc::new(InMemoryAuthProductServices::new());
    let resource_scope = resource_scope();
    let auth_scope = AuthProductScope::credential_owner(&resource_scope, AuthSurface::Api);
    let account = seed_account(&accounts, auth_scope.clone()).await;
    let reauth_bridge = Arc::new(RuntimeCredentialReauthBridge::default());
    let recovery_egress = Arc::new(RuntimeCredentialUnauthorizedRecoveryEgress::new(
        Arc::new(FixedEgress {
            status: 403,
            credential_unauthorized: None,
        }),
        accounts.clone(),
        Arc::clone(&reauth_bridge),
    ));
    let runtime = RuntimeCredentialReauthHostRuntime::new(
        Arc::new(EgressCallingHostRuntime {
            egress: recovery_egress,
        }),
        reauth_bridge,
    );

    let outcome = runtime
        .invoke_capability(runtime_request(resource_scope))
        .await
        .expect("invoke should complete");

    assert!(matches!(outcome, RuntimeCapabilityOutcome::Completed(_)));
    let stored = accounts
        .get_account(CredentialAccountLookupRequest::new(auth_scope, account.id))
        .await
        .expect("lookup")
        .expect("account");
    assert_eq!(stored.status, CredentialAccountStatus::Configured);
}

#[tokio::test]
async fn runtime_credential_unauthorized_recovery_makes_pat_auth_required_on_next_resolve() {
    let accounts = Arc::new(InMemoryAuthProductServices::new());
    let resource_scope = resource_scope();
    let auth_scope = AuthProductScope::credential_owner(&resource_scope, AuthSurface::Api);
    let account = seed_account(&accounts, auth_scope).await;
    let egress = Arc::new(FixedEgress {
        status: 401,
        credential_unauthorized: Some(unauthorized_marker(
            &resource_scope,
            "github",
            &account,
            RuntimeCredentialUnauthorizedPolicy::RevokeAccount,
            github_auth_requirement(),
            None,
        )),
    });
    let reauth_bridge = Arc::new(RuntimeCredentialReauthBridge::default());
    let wrapper =
        RuntimeCredentialUnauthorizedRecoveryEgress::new(egress, accounts.clone(), reauth_bridge);

    wrapper
        .execute(request(resource_scope.clone()))
        .await
        .expect("egress response should pass through");

    let resolver = runtime_credential_resolver(accounts);
    let error = resolver
        .resolve_access_secret(RuntimeCredentialAccountRequest {
            scope: &resource_scope,
            provider: &RuntimeCredentialAccountProviderId::new("github").expect("provider"),
            setup: &RuntimeCredentialAccountSetup::ManualToken,
            provider_scopes: &[],
            requester_extension: &ExtensionId::new("github").expect("extension id"),
        })
        .await
        .expect_err("revoked PAT should require auth on next resolution");
    assert_eq!(error, CredentialStageError::AuthRequired);
}

#[tokio::test]
async fn runtime_credential_unauthorized_recovery_refreshes_marked_401_account() {
    let accounts = Arc::new(InMemoryAuthProductServices::new());
    let resource_scope = resource_scope();
    let auth_scope = AuthProductScope::credential_owner(&resource_scope, AuthSurface::Api);
    let account = seed_oauth_account(&accounts, auth_scope.clone()).await;
    let egress = Arc::new(FixedEgress {
        status: 401,
        credential_unauthorized: Some(unauthorized_marker(
            &resource_scope,
            "google",
            &account,
            RuntimeCredentialUnauthorizedPolicy::RefreshAccount,
            google_auth_requirement(),
            None,
        )),
    });
    let reauth_bridge = Arc::new(RuntimeCredentialReauthBridge::default());
    let wrapper =
        RuntimeCredentialUnauthorizedRecoveryEgress::new(egress, accounts.clone(), reauth_bridge);

    wrapper
        .execute(request(resource_scope))
        .await
        .expect("egress response should pass through");

    let stored = accounts
        .get_account(CredentialAccountLookupRequest::new(auth_scope, account.id))
        .await
        .expect("lookup")
        .expect("account");
    assert_eq!(stored.status, CredentialAccountStatus::Configured);
    assert_ne!(stored.access_secret, account.access_secret);
}

#[tokio::test]
async fn runtime_credential_unauthorized_recovery_refreshes_oauth_before_next_resolve() {
    let accounts = Arc::new(InMemoryAuthProductServices::new());
    let resource_scope = resource_scope();
    let auth_scope = AuthProductScope::credential_owner(&resource_scope, AuthSurface::Api);
    let account = seed_oauth_account(&accounts, auth_scope).await;
    let old_access = account
        .access_secret
        .clone()
        .expect("seed oauth access secret");
    let egress = Arc::new(FixedEgress {
        status: 401,
        credential_unauthorized: Some(unauthorized_marker(
            &resource_scope,
            "google",
            &account,
            RuntimeCredentialUnauthorizedPolicy::RefreshAccount,
            google_auth_requirement(),
            None,
        )),
    });
    let reauth_bridge = Arc::new(RuntimeCredentialReauthBridge::default());
    let wrapper =
        RuntimeCredentialUnauthorizedRecoveryEgress::new(egress, accounts.clone(), reauth_bridge);

    wrapper
        .execute(request(resource_scope.clone()))
        .await
        .expect("egress response should pass through");

    let resolver = runtime_credential_resolver(accounts);
    let provider_scopes = vec!["drive".to_string()];
    let resolved = resolver
        .resolve_access_secret(RuntimeCredentialAccountRequest {
            scope: &resource_scope,
            provider: &RuntimeCredentialAccountProviderId::new("google").expect("provider"),
            setup: &RuntimeCredentialAccountSetup::OAuth { scopes: Vec::new() },
            provider_scopes: &provider_scopes,
            requester_extension: &ExtensionId::new("google-drive").expect("extension id"),
        })
        .await
        .expect("refreshed OAuth account should resolve on next use");
    assert_ne!(resolved.handle, old_access);
}

#[tokio::test]
async fn runtime_credential_unauthorized_recovery_refreshes_with_carried_requester() {
    let accounts = Arc::new(InMemoryAuthProductServices::new());
    let resource_scope = resource_scope();
    let auth_scope = AuthProductScope::credential_owner(&resource_scope, AuthSurface::Api);
    let owner_extension = ExtensionId::new("google-drive").expect("extension id");
    let account = seed_oauth_account_with_ownership(
        &accounts,
        auth_scope.clone(),
        CredentialOwnership::ExtensionOwned,
        Some(owner_extension.clone()),
    )
    .await;
    let egress = Arc::new(FixedEgress {
        status: 401,
        credential_unauthorized: Some(unauthorized_marker(
            &resource_scope,
            "google",
            &account,
            RuntimeCredentialUnauthorizedPolicy::RefreshAccount,
            google_auth_requirement(),
            Some(owner_extension.clone()),
        )),
    });
    let reauth_bridge = Arc::new(RuntimeCredentialReauthBridge::default());
    let wrapper =
        RuntimeCredentialUnauthorizedRecoveryEgress::new(egress, accounts.clone(), reauth_bridge);

    wrapper
        .execute(request(resource_scope))
        .await
        .expect("egress response should pass through");

    let stored = accounts
        .get_account(
            CredentialAccountLookupRequest::new(auth_scope, account.id)
                .for_extension(owner_extension),
        )
        .await
        .expect("lookup")
        .expect("account");
    assert_eq!(stored.status, CredentialAccountStatus::Configured);
    assert_ne!(stored.access_secret, account.access_secret);
}

#[tokio::test]
async fn runtime_credential_unauthorized_recovery_skips_stale_marker() {
    let accounts = Arc::new(InMemoryAuthProductServices::new());
    let resource_scope = resource_scope();
    let auth_scope = AuthProductScope::credential_owner(&resource_scope, AuthSurface::Api);
    let account = seed_account(&accounts, auth_scope.clone()).await;
    accounts
        .update_status(&auth_scope, account.id, CredentialAccountStatus::Inactive)
        .await
        .expect("touch account after staging");
    let egress = Arc::new(FixedEgress {
        status: 401,
        credential_unauthorized: Some(unauthorized_marker(
            &resource_scope,
            "github",
            &account,
            RuntimeCredentialUnauthorizedPolicy::RevokeAccount,
            github_auth_requirement(),
            None,
        )),
    });
    let reauth_bridge = Arc::new(RuntimeCredentialReauthBridge::default());
    let wrapper =
        RuntimeCredentialUnauthorizedRecoveryEgress::new(egress, accounts.clone(), reauth_bridge);

    wrapper
        .execute(request(resource_scope))
        .await
        .expect("egress response should pass through");

    let stored = accounts
        .get_account(CredentialAccountLookupRequest::new(auth_scope, account.id))
        .await
        .expect("lookup")
        .expect("account");
    assert_eq!(stored.status, CredentialAccountStatus::Inactive);
}

#[tokio::test]
async fn runtime_credential_unauthorized_recovery_leaves_unmarked_403_configured() {
    let accounts = Arc::new(InMemoryAuthProductServices::new());
    let resource_scope = resource_scope();
    let auth_scope = AuthProductScope::credential_owner(&resource_scope, AuthSurface::Api);
    let account = seed_account(&accounts, auth_scope.clone()).await;
    let egress = Arc::new(FixedEgress {
        status: 403,
        credential_unauthorized: None,
    });
    let reauth_bridge = Arc::new(RuntimeCredentialReauthBridge::default());
    let wrapper =
        RuntimeCredentialUnauthorizedRecoveryEgress::new(egress, accounts.clone(), reauth_bridge);

    wrapper
        .execute(request(resource_scope))
        .await
        .expect("egress response should pass through");

    let stored = accounts
        .get_account(CredentialAccountLookupRequest::new(auth_scope, account.id))
        .await
        .expect("lookup")
        .expect("account");
    assert_eq!(stored.status, CredentialAccountStatus::Configured);
}

struct FixedEgress {
    status: u16,
    credential_unauthorized: Option<RuntimeCredentialUnauthorized>,
}

#[async_trait]
impl RuntimeHttpEgress for FixedEgress {
    async fn execute(
        &self,
        _request: RuntimeHttpEgressRequest,
    ) -> Result<RuntimeHttpEgressResponse, RuntimeHttpEgressError> {
        Ok(RuntimeHttpEgressResponse {
            status: self.status,
            headers: Vec::new(),
            body: Vec::new(),
            saved_body: None,
            request_bytes: 0,
            response_bytes: 0,
            redaction_applied: false,
            credential_unauthorized: self.credential_unauthorized.clone(),
        })
    }
}

struct NoopRefreshCredentialAccounts {
    inner: Arc<InMemoryAuthProductServices>,
}

#[async_trait]
impl CredentialAccountService for NoopRefreshCredentialAccounts {
    async fn create_account(
        &self,
        _: NewCredentialAccount,
    ) -> Result<ironclaw_auth::CredentialAccount, AuthProductError> {
        unreachable!("noop-refresh fake only supports refresh_if_unchanged")
    }

    async fn get_account(
        &self,
        request: CredentialAccountLookupRequest,
    ) -> Result<Option<ironclaw_auth::CredentialAccount>, AuthProductError> {
        self.inner.get_account(request).await
    }

    async fn list_accounts(
        &self,
        _: ironclaw_auth::CredentialAccountListRequest,
    ) -> Result<ironclaw_auth::CredentialAccountListPage, AuthProductError> {
        unreachable!("noop-refresh fake only supports refresh_if_unchanged")
    }

    async fn update_status(
        &self,
        _: &AuthProductScope,
        _: CredentialAccountId,
        _: CredentialAccountStatus,
    ) -> Result<ironclaw_auth::CredentialAccount, AuthProductError> {
        unreachable!("noop-refresh fake only supports refresh_if_unchanged")
    }

    async fn refresh_if_unchanged(
        &self,
        request: CredentialRefreshRequest,
        expected_updated_at: ironclaw_host_api::Timestamp,
    ) -> Result<Option<CredentialRefreshReport>, AuthProductError> {
        let Some(account) = self
            .inner
            .get_account(CredentialAccountLookupRequest::new(
                request.scope.clone(),
                request.account_id,
            ))
            .await?
        else {
            return Ok(None);
        };
        if account.updated_at != expected_updated_at {
            return Ok(None);
        }
        let projection = account.projection();
        Ok(Some(CredentialRefreshReport {
            account: projection.clone(),
            recovery: CredentialRecoveryProjection::configured(
                account.provider.clone(),
                projection,
            ),
            refreshed: false,
        }))
    }

    async fn select_unique_configured_account(
        &self,
        _: ironclaw_auth::CredentialAccountSelectionRequest,
    ) -> Result<CredentialAccountProjection, AuthProductError> {
        unreachable!("noop-refresh fake only supports refresh_if_unchanged")
    }

    async fn project_credential_recovery(
        &self,
        _: ironclaw_auth::CredentialRecoveryRequest,
    ) -> Result<CredentialRecoveryProjection, AuthProductError> {
        unreachable!("noop-refresh fake only supports refresh_if_unchanged")
    }

    async fn select_configured_account(
        &self,
        _: ironclaw_auth::CredentialAccountChoiceRequest,
    ) -> Result<CredentialAccountProjection, AuthProductError> {
        unreachable!("noop-refresh fake only supports refresh_if_unchanged")
    }

    async fn refresh_account(
        &self,
        _: CredentialRefreshRequest,
    ) -> Result<CredentialRefreshReport, AuthProductError> {
        unreachable!("noop-refresh fake only supports refresh_if_unchanged")
    }
}

struct EgressCallingHostRuntime {
    egress: Arc<dyn RuntimeHttpEgress>,
}

#[async_trait]
impl HostRuntime for EgressCallingHostRuntime {
    async fn invoke_capability(
        &self,
        request: RuntimeCapabilityRequest,
    ) -> Result<RuntimeCapabilityOutcome, HostRuntimeError> {
        self.egress
            .execute(RuntimeHttpEgressRequest {
                runtime: RuntimeKind::Wasm,
                scope: request.context.resource_scope.clone(),
                capability_id: request.capability_id.clone(),
                method: NetworkMethod::Get,
                url: "https://api.example.test/requires-auth".to_string(),
                headers: Vec::new(),
                body: Vec::new(),
                network_policy: NetworkPolicy::default(),
                credential_injections: Vec::new(),
                response_body_limit: None,
                save_body_to: None,
                timeout_ms: None,
            })
            .await
            .map_err(|error| HostRuntimeError::unavailable(error.to_string()))?;
        Ok(RuntimeCapabilityOutcome::Completed(Box::new(
            RuntimeCapabilityCompleted {
                capability_id: request.capability_id,
                output: serde_json::json!({"ok": true}),
                display_preview: None,
                usage: ResourceUsage::default(),
            },
        )))
    }

    async fn resume_capability(
        &self,
        _request: RuntimeCapabilityResumeRequest,
    ) -> Result<RuntimeCapabilityOutcome, HostRuntimeError> {
        unreachable!("test runtime only invokes")
    }

    async fn visible_capabilities(
        &self,
        _request: VisibleCapabilityRequest,
    ) -> Result<VisibleCapabilitySurface, HostRuntimeError> {
        unreachable!("test runtime does not expose a surface")
    }

    async fn cancel_work(
        &self,
        _request: CancelRuntimeWorkRequest,
    ) -> Result<CancelRuntimeWorkOutcome, HostRuntimeError> {
        unreachable!("test runtime does not track cancellable work")
    }

    async fn runtime_status(
        &self,
        _request: RuntimeStatusRequest,
    ) -> Result<HostRuntimeStatus, HostRuntimeError> {
        unreachable!("test runtime does not report status")
    }

    async fn health(&self) -> Result<HostRuntimeHealth, HostRuntimeError> {
        unreachable!("test runtime does not report health")
    }
}

async fn seed_account(
    accounts: &InMemoryAuthProductServices,
    scope: AuthProductScope,
) -> ironclaw_auth::CredentialAccount {
    accounts
        .create_account(NewCredentialAccount {
            scope,
            provider: AuthProviderId::new("github").expect("provider"),
            label: CredentialAccountLabel::new("github account").expect("label"),
            status: CredentialAccountStatus::Configured,
            ownership: CredentialOwnership::UserReusable,
            owner_extension: None,
            granted_extensions: Vec::new(),
            access_secret: Some(
                ironclaw_host_api::SecretHandle::new("github-access")
                    .expect("access secret handle"),
            ),
            refresh_secret: None,
            scopes: vec![ProviderScope::new("repo").expect("scope")],
        })
        .await
        .expect("seed account")
}

async fn seed_oauth_account(
    accounts: &InMemoryAuthProductServices,
    scope: AuthProductScope,
) -> ironclaw_auth::CredentialAccount {
    seed_oauth_account_with_ownership(accounts, scope, CredentialOwnership::UserReusable, None)
        .await
}

async fn seed_oauth_account_with_ownership(
    accounts: &InMemoryAuthProductServices,
    scope: AuthProductScope,
    ownership: CredentialOwnership,
    owner_extension: Option<ExtensionId>,
) -> ironclaw_auth::CredentialAccount {
    accounts
        .create_account(NewCredentialAccount {
            scope,
            provider: AuthProviderId::new("google").expect("provider"),
            label: CredentialAccountLabel::new("google account").expect("label"),
            status: CredentialAccountStatus::Configured,
            ownership,
            owner_extension,
            granted_extensions: Vec::new(),
            access_secret: Some(
                ironclaw_host_api::SecretHandle::new("google-old-access")
                    .expect("access secret handle"),
            ),
            refresh_secret: Some(
                ironclaw_host_api::SecretHandle::new("google-refresh")
                    .expect("refresh secret handle"),
            ),
            scopes: vec![ProviderScope::new("drive").expect("scope")],
        })
        .await
        .expect("seed oauth account")
}

fn runtime_credential_resolver(
    accounts: Arc<InMemoryAuthProductServices>,
) -> crate::product_auth_runtime_credentials::ProductAuthRuntimeCredentialResolver {
    crate::product_auth_runtime_credentials::ProductAuthRuntimeCredentialResolver::new(Arc::new(
        crate::product_auth_runtime_credentials::ProductAuthRuntimeCredentialAccountSelector::new(
            accounts,
        ),
    ))
}

fn resource_scope() -> ResourceScope {
    ResourceScope::local_default(UserId::new("alice").unwrap(), InvocationId::new()).unwrap()
}

fn capability_id() -> CapabilityId {
    CapabilityId::new("github.search").unwrap()
}

fn request(scope: ResourceScope) -> RuntimeHttpEgressRequest {
    RuntimeHttpEgressRequest {
        runtime: RuntimeKind::Wasm,
        scope,
        capability_id: capability_id(),
        method: NetworkMethod::Get,
        url: "https://api.github.com/user".to_string(),
        headers: Vec::new(),
        body: Vec::new(),
        network_policy: NetworkPolicy {
            allowed_targets: Vec::new(),
            deny_private_ip_ranges: true,
            max_egress_bytes: None,
        },
        credential_injections: Vec::new(),
        response_body_limit: None,
        save_body_to: None,
        timeout_ms: None,
    }
}

fn runtime_request(scope: ResourceScope) -> RuntimeCapabilityRequest {
    RuntimeCapabilityRequest::new(
        execution_context_for_scope(scope),
        capability_id(),
        ResourceEstimate::default(),
        serde_json::json!({}),
        trust_decision(),
    )
}

fn execution_context_for_scope(scope: ResourceScope) -> ExecutionContext {
    ExecutionContext {
        invocation_id: scope.invocation_id,
        correlation_id: CorrelationId::new(),
        process_id: None,
        parent_process_id: None,
        tenant_id: scope.tenant_id.clone(),
        user_id: scope.user_id.clone(),
        agent_id: scope.agent_id.clone(),
        project_id: scope.project_id.clone(),
        mission_id: scope.mission_id.clone(),
        thread_id: scope.thread_id.clone(),
        extension_id: ExtensionId::new("github").expect("extension id"),
        runtime: RuntimeKind::Wasm,
        trust: TrustClass::UserTrusted,
        grants: CapabilitySet::default(),
        mounts: MountView::default(),
        resource_scope: scope,
    }
}

fn trust_decision() -> TrustDecision {
    TrustDecision {
        effective_trust: EffectiveTrustClass::user_trusted(),
        authority_ceiling: AuthorityCeiling {
            allowed_effects: vec![],
            max_resource_ceiling: None,
        },
        provenance: TrustProvenance::Default,
        evaluated_at: chrono::Utc::now(),
    }
}

fn github_auth_requirement() -> RuntimeCredentialAuthRequirement {
    RuntimeCredentialAuthRequirement {
        provider: RuntimeCredentialAccountProviderId::new("github").expect("provider"),
        setup: RuntimeCredentialAccountSetup::ManualToken,
        requester_extension: ExtensionId::new("github").expect("extension id"),
        provider_scopes: Vec::new(),
    }
}

fn google_auth_requirement() -> RuntimeCredentialAuthRequirement {
    RuntimeCredentialAuthRequirement {
        provider: RuntimeCredentialAccountProviderId::new("google").expect("provider"),
        setup: RuntimeCredentialAccountSetup::OAuth { scopes: Vec::new() },
        requester_extension: ExtensionId::new("google-drive").expect("extension id"),
        provider_scopes: vec!["drive".to_string()],
    }
}

fn unauthorized_marker(
    resource_scope: &ResourceScope,
    provider: &str,
    account: &ironclaw_auth::CredentialAccount,
    unauthorized_policy: RuntimeCredentialUnauthorizedPolicy,
    auth_requirement: RuntimeCredentialAuthRequirement,
    requester_extension: Option<ExtensionId>,
) -> RuntimeCredentialUnauthorized {
    RuntimeCredentialUnauthorized {
        scope: resource_scope.clone(),
        account_provider: RuntimeCredentialAccountProviderId::new(provider).expect("provider"),
        account_id: account.id.to_string(),
        account_updated_at: account.updated_at,
        requester_extension,
        auth_requirement,
        unauthorized_policy,
    }
}
