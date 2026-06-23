use std::sync::Arc;

use async_trait::async_trait;
use ironclaw_auth::{
    AuthProductScope, AuthProviderId, AuthSurface, CredentialAccountId, CredentialAccountService,
    CredentialRefreshRequest,
};
use ironclaw_host_api::{
    RuntimeCredentialUnauthorized, RuntimeCredentialUnauthorizedPolicy, RuntimeHttpEgress,
    RuntimeHttpEgressError, RuntimeHttpEgressRequest, RuntimeHttpEgressResponse,
};

pub(crate) struct RuntimeCredentialUnauthorizedRecoveryEgress {
    inner: Arc<dyn RuntimeHttpEgress>,
    credential_accounts: Arc<dyn CredentialAccountService>,
}

impl RuntimeCredentialUnauthorizedRecoveryEgress {
    pub(crate) fn new(
        inner: Arc<dyn RuntimeHttpEgress>,
        credential_accounts: Arc<dyn CredentialAccountService>,
    ) -> Self {
        Self {
            inner,
            credential_accounts,
        }
    }

    async fn recover_unauthorized_credential(&self, response: &RuntimeHttpEgressResponse) {
        let Some(unauthorized) = &response.credential_unauthorized else {
            return;
        };
        let Ok(account_uuid) = uuid::Uuid::parse_str(&unauthorized.account_id) else {
            tracing::warn!(
                account_id = %unauthorized.account_id,
                "runtime HTTP credential unauthorized marker carried an invalid account id"
            );
            return;
        };
        let account_id = CredentialAccountId::from_uuid(account_uuid);
        let scope = AuthProductScope::credential_owner(&unauthorized.scope, AuthSurface::Api);
        let Some(account_updated_at) = unauthorized.account_updated_at else {
            tracing::warn!(
                account_id = %unauthorized.account_id,
                "runtime HTTP credential unauthorized marker did not carry an account freshness marker"
            );
            return;
        };
        match unauthorized.unauthorized_policy {
            RuntimeCredentialUnauthorizedPolicy::RevokeAccount => {
                self.revoke_if_unchanged(&scope, account_id, account_updated_at)
                    .await;
            }
            RuntimeCredentialUnauthorizedPolicy::RefreshAccount => {
                self.refresh_if_unchanged(&scope, account_id, account_updated_at, unauthorized)
                    .await;
            }
        }
    }

    async fn revoke_if_unchanged(
        &self,
        scope: &AuthProductScope,
        account_id: CredentialAccountId,
        account_updated_at: ironclaw_host_api::Timestamp,
    ) {
        let account_id_for_log = account_id.to_string();
        match self
            .credential_accounts
            .revoke_if_unchanged(&scope, account_id, account_updated_at)
            .await
        {
            Ok(Some(_)) => {}
            Ok(None) => {
                tracing::info!(
                    account_id = %account_id_for_log,
                    "runtime HTTP credential unauthorized recovery skipped because account changed or disappeared after staging"
                );
                return;
            }
            Err(error) => {
                tracing::warn!(
                    err = %error,
                    "runtime HTTP credential unauthorized recovery could not conditionally revoke account"
                );
                return;
            }
        }
    }

    async fn refresh_if_unchanged(
        &self,
        scope: &AuthProductScope,
        account_id: CredentialAccountId,
        account_updated_at: ironclaw_host_api::Timestamp,
        unauthorized: &RuntimeCredentialUnauthorized,
    ) {
        let Ok(request) = refresh_request(scope, account_id, unauthorized) else {
            tracing::warn!(
                provider = %unauthorized.account_provider.as_str(),
                "runtime HTTP credential unauthorized marker carried an invalid provider id"
            );
            return;
        };
        match self
            .credential_accounts
            .refresh_if_unchanged(request, account_updated_at)
            .await
        {
            Ok(Some(_)) => {}
            Ok(None) => {
                tracing::info!(
                    account_id = %unauthorized.account_id,
                    "runtime HTTP credential unauthorized recovery skipped refresh because account changed or disappeared after staging"
                );
            }
            Err(error) => {
                tracing::warn!(
                    err = %error,
                    "runtime HTTP credential unauthorized recovery could not refresh account"
                );
            }
        }
    }
}

fn refresh_request(
    scope: &AuthProductScope,
    account_id: CredentialAccountId,
    unauthorized: &RuntimeCredentialUnauthorized,
) -> Result<CredentialRefreshRequest, ironclaw_auth::AuthProductError> {
    let provider = AuthProviderId::new(unauthorized.account_provider.as_str())
        .map_err(|_| ironclaw_auth::AuthProductError::MalformedConfig)?;
    let mut request = CredentialRefreshRequest::new(scope.clone(), provider, account_id);
    if let Some(requester_extension) = unauthorized.requester_extension.clone() {
        request = request.for_extension(requester_extension);
    }
    Ok(request)
}

#[async_trait]
impl RuntimeHttpEgress for RuntimeCredentialUnauthorizedRecoveryEgress {
    async fn execute(
        &self,
        request: RuntimeHttpEgressRequest,
    ) -> Result<RuntimeHttpEgressResponse, RuntimeHttpEgressError> {
        let response = self.inner.execute(request).await?;
        self.recover_unauthorized_credential(&response).await;
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use ironclaw_auth::{
        AuthProviderId, CredentialAccountLabel, CredentialAccountLookupRequest,
        CredentialAccountStatus, CredentialOwnership, InMemoryAuthProductServices,
        NewCredentialAccount, ProviderScope,
    };
    use ironclaw_host_api::{
        CapabilityId, CredentialStageError, ExtensionId, InvocationId, NetworkMethod,
        NetworkPolicy, ResourceScope, RuntimeCredentialAccountProviderId,
        RuntimeCredentialAccountSetup, RuntimeCredentialUnauthorized,
        RuntimeCredentialUnauthorizedPolicy, RuntimeKind, UserId,
    };
    use ironclaw_host_runtime::{
        RuntimeCredentialAccountRequest, RuntimeCredentialAccountResolver,
    };

    use super::*;

    #[tokio::test]
    async fn runtime_credential_unauthorized_recovery_revokes_marked_401_account() {
        let accounts = Arc::new(InMemoryAuthProductServices::new());
        let resource_scope = resource_scope();
        let auth_scope = AuthProductScope::credential_owner(&resource_scope, AuthSurface::Api);
        let account = seed_account(&accounts, auth_scope.clone()).await;
        let egress = Arc::new(FixedEgress {
            status: 401,
            credential_unauthorized: Some(RuntimeCredentialUnauthorized::new(
                resource_scope.clone(),
                RuntimeCredentialAccountProviderId::new("github").expect("provider"),
                account.id.to_string(),
                Some(account.updated_at),
                RuntimeCredentialUnauthorizedPolicy::RevokeAccount,
            )),
        });
        let wrapper = RuntimeCredentialUnauthorizedRecoveryEgress::new(egress, accounts.clone());

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
    async fn runtime_credential_unauthorized_recovery_makes_pat_auth_required_on_next_resolve() {
        let accounts = Arc::new(InMemoryAuthProductServices::new());
        let resource_scope = resource_scope();
        let auth_scope = AuthProductScope::credential_owner(&resource_scope, AuthSurface::Api);
        let account = seed_account(&accounts, auth_scope).await;
        let egress = Arc::new(FixedEgress {
            status: 401,
            credential_unauthorized: Some(RuntimeCredentialUnauthorized::new(
                resource_scope.clone(),
                RuntimeCredentialAccountProviderId::new("github").expect("provider"),
                account.id.to_string(),
                Some(account.updated_at),
                RuntimeCredentialUnauthorizedPolicy::RevokeAccount,
            )),
        });
        let wrapper = RuntimeCredentialUnauthorizedRecoveryEgress::new(egress, accounts.clone());

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
            credential_unauthorized: Some(RuntimeCredentialUnauthorized::new(
                resource_scope.clone(),
                RuntimeCredentialAccountProviderId::new("google").expect("provider"),
                account.id.to_string(),
                Some(account.updated_at),
                RuntimeCredentialUnauthorizedPolicy::RefreshAccount,
            )),
        });
        let wrapper = RuntimeCredentialUnauthorizedRecoveryEgress::new(egress, accounts.clone());

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
            credential_unauthorized: Some(RuntimeCredentialUnauthorized::new(
                resource_scope.clone(),
                RuntimeCredentialAccountProviderId::new("google").expect("provider"),
                account.id.to_string(),
                Some(account.updated_at),
                RuntimeCredentialUnauthorizedPolicy::RefreshAccount,
            )),
        });
        let wrapper = RuntimeCredentialUnauthorizedRecoveryEgress::new(egress, accounts.clone());

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
            credential_unauthorized: Some(
                RuntimeCredentialUnauthorized::new(
                    resource_scope.clone(),
                    RuntimeCredentialAccountProviderId::new("google").expect("provider"),
                    account.id.to_string(),
                    Some(account.updated_at),
                    RuntimeCredentialUnauthorizedPolicy::RefreshAccount,
                )
                .with_requester_extension(Some(owner_extension.clone())),
            ),
        });
        let wrapper = RuntimeCredentialUnauthorizedRecoveryEgress::new(egress, accounts.clone());

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
            credential_unauthorized: Some(RuntimeCredentialUnauthorized::new(
                resource_scope.clone(),
                RuntimeCredentialAccountProviderId::new("github").expect("provider"),
                account.id.to_string(),
                Some(account.updated_at),
                RuntimeCredentialUnauthorizedPolicy::RevokeAccount,
            )),
        });
        let wrapper = RuntimeCredentialUnauthorizedRecoveryEgress::new(egress, accounts.clone());

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
        let wrapper = RuntimeCredentialUnauthorizedRecoveryEgress::new(egress, accounts.clone());

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
        crate::product_auth_runtime_credentials::ProductAuthRuntimeCredentialResolver::new(
            Arc::new(
                crate::product_auth_runtime_credentials::ProductAuthRuntimeCredentialAccountSelector::new(
                    accounts,
                ),
            ),
        )
    }

    fn resource_scope() -> ResourceScope {
        ResourceScope::local_default(UserId::new("alice").unwrap(), InvocationId::new()).unwrap()
    }

    fn request(scope: ResourceScope) -> RuntimeHttpEgressRequest {
        RuntimeHttpEgressRequest {
            runtime: RuntimeKind::Wasm,
            scope,
            capability_id: CapabilityId::new("github.search").unwrap(),
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
}
