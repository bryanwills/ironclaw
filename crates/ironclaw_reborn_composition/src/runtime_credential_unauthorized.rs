use std::sync::Arc;

use crate::runtime_credential_reauth::RuntimeCredentialReauthBridge;
use async_trait::async_trait;
use ironclaw_auth::{
    AuthProductScope, AuthProviderId, AuthSurface, CredentialAccountId, CredentialAccountService,
    CredentialAccountStatus, CredentialRefreshRequest,
};
use ironclaw_host_api::{
    CapabilityId, ResourceScope, RuntimeCredentialUnauthorized,
    RuntimeCredentialUnauthorizedPolicy, RuntimeHttpEgress, RuntimeHttpEgressError,
    RuntimeHttpEgressRequest, RuntimeHttpEgressResponse,
};

pub(crate) struct RuntimeCredentialUnauthorizedRecoveryEgress {
    inner: Arc<dyn RuntimeHttpEgress>,
    credential_accounts: Arc<dyn CredentialAccountService>,
    reauth_bridge: Arc<RuntimeCredentialReauthBridge>,
}

impl RuntimeCredentialUnauthorizedRecoveryEgress {
    pub(crate) fn new(
        inner: Arc<dyn RuntimeHttpEgress>,
        credential_accounts: Arc<dyn CredentialAccountService>,
        reauth_bridge: Arc<RuntimeCredentialReauthBridge>,
    ) -> Self {
        Self {
            inner,
            credential_accounts,
            reauth_bridge,
        }
    }

    async fn recover_unauthorized_credential(
        &self,
        request_scope: &ResourceScope,
        capability_id: &CapabilityId,
        response: &RuntimeHttpEgressResponse,
    ) {
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
        let account_updated_at = unauthorized.account_updated_at;
        match unauthorized.unauthorized_policy {
            RuntimeCredentialUnauthorizedPolicy::RevokeAccount => {
                if self
                    .revoke_if_unchanged(
                        &scope,
                        account_id,
                        account_updated_at,
                        unauthorized.requester_extension.clone(),
                    )
                    .await
                {
                    self.record_recovered_auth_required(request_scope, capability_id, unauthorized);
                }
            }
            RuntimeCredentialUnauthorizedPolicy::RefreshAccount => {
                if self
                    .refresh_if_unchanged(&scope, account_id, account_updated_at, unauthorized)
                    .await
                {
                    self.record_recovered_auth_required(request_scope, capability_id, unauthorized);
                }
            }
        }
    }

    fn record_recovered_auth_required(
        &self,
        request_scope: &ResourceScope,
        capability_id: &CapabilityId,
        unauthorized: &RuntimeCredentialUnauthorized,
    ) {
        self.reauth_bridge.record_recovered_auth_required(
            request_scope,
            capability_id,
            vec![unauthorized.auth_requirement.clone()],
        );
    }

    async fn revoke_if_unchanged(
        &self,
        scope: &AuthProductScope,
        account_id: CredentialAccountId,
        account_updated_at: ironclaw_host_api::Timestamp,
        requester_extension: Option<ironclaw_host_api::ExtensionId>,
    ) -> bool {
        let account_id_for_log = account_id.to_string();
        match self
            .credential_accounts
            .revoke_if_unchanged(&scope, account_id, account_updated_at, requester_extension)
            .await
        {
            Ok(Some(_)) => true,
            Ok(None) => {
                tracing::info!(
                    account_id = %account_id_for_log,
                    "runtime HTTP credential unauthorized recovery skipped because account changed or disappeared after staging"
                );
                false
            }
            Err(error) => {
                tracing::warn!(
                    err = %error,
                    "runtime HTTP credential unauthorized recovery could not conditionally revoke account"
                );
                false
            }
        }
    }

    async fn refresh_if_unchanged(
        &self,
        scope: &AuthProductScope,
        account_id: CredentialAccountId,
        account_updated_at: ironclaw_host_api::Timestamp,
        unauthorized: &RuntimeCredentialUnauthorized,
    ) -> bool {
        let Ok(request) = refresh_request(scope, account_id, unauthorized) else {
            tracing::warn!(
                provider = %unauthorized.account_provider.as_str(),
                "runtime HTTP credential unauthorized marker carried an invalid provider id"
            );
            return false;
        };
        match self
            .credential_accounts
            .refresh_if_unchanged(request, account_updated_at)
            .await
        {
            Ok(Some(report)) => {
                if report.account.status != CredentialAccountStatus::Configured {
                    return true;
                }
                if !report.refreshed {
                    tracing::info!(
                        account_id = %unauthorized.account_id,
                        "runtime HTTP credential unauthorized recovery refresh left account unchanged; requiring re-auth"
                    );
                    return true;
                }
                false
            }
            Ok(None) => {
                tracing::info!(
                    account_id = %unauthorized.account_id,
                    "runtime HTTP credential unauthorized recovery skipped refresh because account changed or disappeared after staging"
                );
                false
            }
            Err(error) => {
                tracing::warn!(
                    err = %error,
                    "runtime HTTP credential unauthorized recovery could not refresh account"
                );
                false
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
        let request_scope = request.scope.clone();
        let capability_id = request.capability_id.clone();
        let response = self.inner.execute(request).await?;
        self.recover_unauthorized_credential(&request_scope, &capability_id, &response)
            .await;
        Ok(response)
    }
}

#[cfg(test)]
mod tests;
