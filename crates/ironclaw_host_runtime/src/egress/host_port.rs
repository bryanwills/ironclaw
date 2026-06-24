use std::sync::Arc;

use ironclaw_capabilities::{
    CapabilityObligationHandler, CapabilityObligationPhase, CapabilityObligationRequest,
};
use ironclaw_host_api::{
    CapabilityId, CapabilitySet, ExecutionContext, ExtensionId, MountView, Obligation,
    ResourceEstimate, ResourceScope, RuntimeCredentialAccountIdentity, RuntimeCredentialInjection,
    RuntimeCredentialSource, RuntimeCredentialTarget, RuntimeCredentialUnauthorized,
    RuntimeHttpEgress, RuntimeHttpEgressError, RuntimeHttpEgressRequest, RuntimeHttpEgressResponse,
    RuntimeKind, SecretHandle, TrustClass,
};
use ironclaw_secrets::SecretMaterial;

use crate::obligations::RuntimeSecretInjectionStore;

/// Canonical host-runtime one-shot secret material staging port.
///
/// This is for host-owned adapters that already hold trusted secret material
/// and need the shared runtime HTTP egress to inject it without exposing the
/// material through request headers.
#[derive(Clone)]
pub struct RuntimeSecretMaterialStager {
    secret_injection_store: Arc<RuntimeSecretInjectionStore>,
}

/// Alias for [`ironclaw_host_api::CredentialStageError`].
pub type RuntimeSecretStageError = ironclaw_host_api::CredentialStageError;

impl RuntimeSecretMaterialStager {
    pub(crate) fn new(secret_injection_store: Arc<RuntimeSecretInjectionStore>) -> Self {
        Self {
            secret_injection_store,
        }
    }

    pub async fn stage_secret_material_once(
        &self,
        target_scope: &ResourceScope,
        capability_id: &CapabilityId,
        handle: &SecretHandle,
        material: SecretMaterial,
    ) -> Result<(), RuntimeSecretStageError> {
        self.stage_secret_material_once_with_account(
            target_scope,
            capability_id,
            handle,
            material,
            None,
        )
        .await
    }

    pub async fn stage_secret_material_once_with_account(
        &self,
        target_scope: &ResourceScope,
        capability_id: &CapabilityId,
        handle: &SecretHandle,
        material: SecretMaterial,
        credential_account: Option<RuntimeCredentialAccountIdentity>,
    ) -> Result<(), RuntimeSecretStageError> {
        self.secret_injection_store
            .insert_with_credential_account(
                target_scope,
                capability_id,
                handle,
                material,
                credential_account,
            )
            .map_err(|_| RuntimeSecretStageError::Backend)
    }

    fn discard_secret_material_for_capability(
        &self,
        target_scope: &ResourceScope,
        capability_id: &CapabilityId,
    ) {
        if let Err(error) = self
            .secret_injection_store
            .discard_for_capability(target_scope, capability_id)
        {
            tracing::debug!(
                error = ?error,
                capability_id = %capability_id,
                "host HTTP egress failed to discard staged secret material"
            );
        }
    }
}

#[derive(Clone)]
pub struct HostRuntimeHttpEgressPort {
    runtime_http_egress: Arc<dyn RuntimeHttpEgress>,
    obligation_handler: Arc<dyn CapabilityObligationHandler>,
    secret_stager: RuntimeSecretMaterialStager,
}

pub struct HostRuntimeHttpEgressRequest {
    pub extension_id: ExtensionId,
    pub trust: TrustClass,
    pub request: RuntimeHttpEgressRequest,
    pub credentials: Vec<HostRuntimeCredentialMaterial>,
}

pub struct HostRuntimeCredentialMaterial {
    pub handle: SecretHandle,
    pub material: SecretMaterial,
    pub target: RuntimeCredentialTarget,
    pub required: bool,
    pub credential_account: Option<RuntimeCredentialAccountIdentity>,
}

impl HostRuntimeHttpEgressPort {
    pub(crate) fn new(
        runtime_http_egress: Arc<dyn RuntimeHttpEgress>,
        obligation_handler: Arc<dyn CapabilityObligationHandler>,
        secret_stager: RuntimeSecretMaterialStager,
    ) -> Self {
        Self {
            runtime_http_egress,
            obligation_handler,
            secret_stager,
        }
    }

    pub async fn execute(
        &self,
        mut request: HostRuntimeHttpEgressRequest,
    ) -> Result<RuntimeHttpEgressResponse, RuntimeHttpEgressError> {
        if !request.request.credential_injections.is_empty() {
            return Err(RuntimeHttpEgressError::Credential {
                reason: "host-mediated HTTP egress does not accept caller-provided credential injections"
                    .to_string(),
            });
        }
        self.authorize_network_egress(&request).await?;
        let staged_scope = request.request.scope.clone();
        let staged_capability_id = request.request.capability_id.clone();
        let staged_credentials = !request.credentials.is_empty();
        let staged_unauthorized_identity = match self
            .stage_credentials(&mut request.request, request.credentials)
            .await
        {
            Ok(identity) => identity,
            Err(error) => {
                if staged_credentials {
                    self.secret_stager.discard_secret_material_for_capability(
                        &staged_scope,
                        &staged_capability_id,
                    );
                }
                return Err(error);
            }
        };
        let result = self
            .runtime_http_egress
            .execute(request.request)
            .await
            .map(|mut response| {
                super::attach_credential_unauthorized_on_401(
                    &mut response,
                    staged_unauthorized_identity,
                );
                response
            });
        if staged_credentials {
            self.secret_stager
                .discard_secret_material_for_capability(&staged_scope, &staged_capability_id);
        }
        result
    }

    async fn stage_credentials(
        &self,
        request: &mut RuntimeHttpEgressRequest,
        credentials: Vec<HostRuntimeCredentialMaterial>,
    ) -> Result<Option<RuntimeCredentialUnauthorized>, RuntimeHttpEgressError> {
        let mut unauthorized_identity = None::<RuntimeCredentialUnauthorized>;
        let mut ambiguous_unauthorized_identity = false;
        for credential in credentials {
            let credential_account = credential.credential_account.clone();
            self.secret_stager
                .stage_secret_material_once_with_account(
                    &request.scope,
                    &request.capability_id,
                    &credential.handle,
                    credential.material,
                    credential_account.clone(),
                )
                .await
                .map_err(|_| RuntimeHttpEgressError::Credential {
                    reason: "host credential material could not be staged".to_string(),
                })?;
            if let Some(account) = credential_account
                && let Some(candidate) = account.marker_on_unauthorized()
            {
                if let Some(existing) = &unauthorized_identity {
                    if existing != &candidate {
                        ambiguous_unauthorized_identity = true;
                    }
                } else {
                    unauthorized_identity = Some(candidate);
                }
            }
            request
                .credential_injections
                .push(RuntimeCredentialInjection {
                    handle: credential.handle,
                    source: RuntimeCredentialSource::StagedObligation {
                        capability_id: request.capability_id.clone(),
                    },
                    target: credential.target,
                    required: credential.required,
                });
        }
        Ok(if ambiguous_unauthorized_identity {
            None
        } else {
            unauthorized_identity
        })
    }

    async fn authorize_network_egress(
        &self,
        request: &HostRuntimeHttpEgressRequest,
    ) -> Result<(), RuntimeHttpEgressError> {
        let context = execution_context_for_host_http_egress(
            &request.request.scope,
            request.extension_id.clone(),
            request.request.runtime,
            request.trust,
        )?;
        let estimate = ResourceEstimate {
            network_egress_bytes: request.request.network_policy.max_egress_bytes,
            ..ResourceEstimate::default()
        };
        self.obligation_handler
            .satisfy(CapabilityObligationRequest {
                phase: CapabilityObligationPhase::Invoke,
                context: &context,
                capability_id: &request.request.capability_id,
                estimate: &estimate,
                obligations: &[Obligation::ApplyNetworkPolicy {
                    policy: request.request.network_policy.clone(),
                }],
            })
            .await
            .map_err(|error| RuntimeHttpEgressError::Request {
                reason: format!("host network egress policy was not authorized: {error}"),
                request_bytes: 0,
                response_bytes: 0,
            })
    }
}

fn execution_context_for_host_http_egress(
    scope: &ResourceScope,
    extension_id: ExtensionId,
    runtime: RuntimeKind,
    trust: TrustClass,
) -> Result<ExecutionContext, RuntimeHttpEgressError> {
    let context = ExecutionContext {
        invocation_id: scope.invocation_id,
        correlation_id: ironclaw_host_api::CorrelationId::new(),
        process_id: None,
        parent_process_id: None,
        tenant_id: scope.tenant_id.clone(),
        user_id: scope.user_id.clone(),
        agent_id: scope.agent_id.clone(),
        project_id: scope.project_id.clone(),
        mission_id: scope.mission_id.clone(),
        thread_id: scope.thread_id.clone(),
        extension_id,
        runtime,
        trust,
        grants: CapabilitySet::default(),
        mounts: MountView::default(),
        resource_scope: scope.clone(),
    };
    context
        .validate()
        .map_err(|error| RuntimeHttpEgressError::Credential {
            reason: format!("invalid host HTTP egress context: {error}"),
        })?;
    Ok(context)
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use async_trait::async_trait;
    use ironclaw_capabilities::{
        CapabilityObligationError, CapabilityObligationFailureKind, CapabilityObligationRequest,
    };
    use ironclaw_host_api::{
        ExtensionId, InvocationId, NetworkMethod, NetworkPolicy, NetworkScheme,
        NetworkTargetPattern, RuntimeCredentialAccountProviderId, RuntimeCredentialAccountSetup,
        RuntimeCredentialAuthRequirement, RuntimeCredentialUnauthorizedPolicy,
        RuntimeHttpEgressResponse, UserId,
    };

    use super::*;

    struct AllowObligations;

    #[async_trait]
    impl CapabilityObligationHandler for AllowObligations {
        async fn satisfy(
            &self,
            _request: CapabilityObligationRequest<'_>,
        ) -> Result<(), CapabilityObligationError> {
            Ok(())
        }
    }

    struct DenyNetworkObligations;

    #[async_trait]
    impl CapabilityObligationHandler for DenyNetworkObligations {
        async fn satisfy(
            &self,
            _request: CapabilityObligationRequest<'_>,
        ) -> Result<(), CapabilityObligationError> {
            Err(CapabilityObligationError::Failed {
                kind: CapabilityObligationFailureKind::Network,
            })
        }
    }

    struct RecordingRuntimeHttpEgress {
        calls: AtomicUsize,
        response: Result<RuntimeHttpEgressResponse, RuntimeHttpEgressError>,
    }

    impl RecordingRuntimeHttpEgress {
        fn ok() -> Self {
            Self::responding(200)
        }

        fn responding(status: u16) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                response: Ok(RuntimeHttpEgressResponse {
                    status,
                    headers: Vec::new(),
                    body: Vec::new(),
                    saved_body: None,
                    request_bytes: 0,
                    response_bytes: 0,
                    redaction_applied: false,
                    credential_unauthorized: None,
                }),
            }
        }

        fn failing() -> Self {
            Self {
                calls: AtomicUsize::new(0),
                response: Err(RuntimeHttpEgressError::Network {
                    reason: "network_error".to_string(),
                    request_bytes: 17,
                    response_bytes: 0,
                }),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl RuntimeHttpEgress for RecordingRuntimeHttpEgress {
        async fn execute(
            &self,
            _request: RuntimeHttpEgressRequest,
        ) -> Result<RuntimeHttpEgressResponse, RuntimeHttpEgressError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.response.clone()
        }
    }

    #[tokio::test]
    async fn host_runtime_http_egress_rejects_caller_provided_credential_injections() {
        let egress = Arc::new(RecordingRuntimeHttpEgress::ok());
        let port = host_port(egress.clone(), Arc::new(AllowObligations), secret_store());
        let mut request = host_request();
        request
            .request
            .credential_injections
            .push(RuntimeCredentialInjection {
                handle: secret_handle(),
                source: RuntimeCredentialSource::StagedObligation {
                    capability_id: capability_id(),
                },
                target: RuntimeCredentialTarget::Header {
                    name: "authorization".to_string(),
                    prefix: Some("Bearer ".to_string()),
                },
                required: true,
            });

        let error = port
            .execute(request)
            .await
            .expect_err("caller-provided credential injections must be rejected");

        assert!(matches!(error, RuntimeHttpEgressError::Credential { .. }));
        assert_eq!(egress.calls(), 0);
    }

    #[tokio::test]
    async fn host_runtime_http_egress_maps_network_policy_denial_to_request_error() {
        let egress = Arc::new(RecordingRuntimeHttpEgress::ok());
        let port = host_port(
            egress.clone(),
            Arc::new(DenyNetworkObligations),
            secret_store(),
        );

        let error = port
            .execute(host_request())
            .await
            .expect_err("policy denial must fail before runtime egress");

        assert!(matches!(error, RuntimeHttpEgressError::Request { .. }));
        assert_eq!(error.stable_runtime_reason(), "request_denied");
        assert_eq!(egress.calls(), 0);
    }

    #[tokio::test]
    async fn host_runtime_http_egress_discards_staged_secret_after_delegate_failure() {
        let store = secret_store();
        let egress = Arc::new(RecordingRuntimeHttpEgress::failing());
        let port = host_port(egress, Arc::new(AllowObligations), Arc::clone(&store));
        let mut request = host_request();
        let scope = request.request.scope.clone();
        let capability_id = request.request.capability_id.clone();
        let handle = secret_handle();
        request.credentials.push(HostRuntimeCredentialMaterial {
            handle: handle.clone(),
            material: SecretMaterial::from("host-held-token"),
            target: RuntimeCredentialTarget::Header {
                name: "authorization".to_string(),
                prefix: Some("Bearer ".to_string()),
            },
            required: true,
            credential_account: None,
        });

        let error = port
            .execute(request)
            .await
            .expect_err("delegate egress failure should bubble");

        assert!(matches!(error, RuntimeHttpEgressError::Network { .. }));
        assert!(
            store
                .take(&scope, &capability_id, &handle)
                .expect("staged secret store should be readable")
                .is_none(),
            "host-staged material should be discarded after delegate failure"
        );
    }

    #[tokio::test]
    async fn host_runtime_http_egress_attaches_credential_unauthorized_marker_on_401_only() {
        let egress = Arc::new(RecordingRuntimeHttpEgress::responding(401));
        let port = host_port(egress, Arc::new(AllowObligations), secret_store());
        let mut request = host_request();
        let scope = request.request.scope.clone();
        let account_id = "product-auth-account-123".to_string();
        request.credentials.push(HostRuntimeCredentialMaterial {
            handle: SecretHandle::new(account_id.clone()).expect("secret handle"),
            material: SecretMaterial::from("host-held-token"),
            target: RuntimeCredentialTarget::Header {
                name: "authorization".to_string(),
                prefix: Some("Bearer ".to_string()),
            },
            required: true,
            credential_account: Some(RuntimeCredentialAccountIdentity {
                scope: scope.clone(),
                account_provider: RuntimeCredentialAccountProviderId::new("github")
                    .expect("provider"),
                account_id: account_id.clone(),
                account_updated_at: Some(chrono::Utc::now()),
                requester_extension: None,
                auth_requirement: Some(auth_requirement("github")),
                unauthorized_policy: RuntimeCredentialUnauthorizedPolicy::RevokeAccount,
            }),
        });

        let response = port
            .execute(request)
            .await
            .expect("401 response should still succeed");

        let rejection = response
            .credential_unauthorized
            .expect("401 with an injected credential should attach unauthorized marker");
        assert_eq!(rejection.scope, scope);
        assert_eq!(rejection.account_id, account_id);
    }

    #[tokio::test]
    async fn host_runtime_http_egress_skips_credential_unauthorized_marker_when_ambiguous() {
        let egress = Arc::new(RecordingRuntimeHttpEgress::responding(401));
        let port = host_port(egress, Arc::new(AllowObligations), secret_store());
        let mut request = host_request();
        let scope = request.request.scope.clone();
        for account_id in ["product-auth-account-123", "product-auth-account-456"] {
            request.credentials.push(HostRuntimeCredentialMaterial {
                handle: SecretHandle::new(account_id).expect("secret handle"),
                material: SecretMaterial::from("host-held-token"),
                target: RuntimeCredentialTarget::Header {
                    name: format!("x-token-{account_id}"),
                    prefix: None,
                },
                required: true,
                credential_account: Some(RuntimeCredentialAccountIdentity {
                    scope: scope.clone(),
                    account_provider: RuntimeCredentialAccountProviderId::new("github")
                        .expect("provider"),
                    account_id: account_id.to_string(),
                    account_updated_at: Some(chrono::Utc::now()),
                    requester_extension: None,
                    auth_requirement: Some(auth_requirement("github")),
                    unauthorized_policy: RuntimeCredentialUnauthorizedPolicy::RevokeAccount,
                }),
            });
        }

        let response = port
            .execute(request)
            .await
            .expect("401 response should still succeed");

        assert!(
            response.credential_unauthorized.is_none(),
            "a 401 with multiple credential accounts must not guess which account was rejected"
        );
    }

    #[tokio::test]
    async fn host_runtime_http_egress_skips_credential_unauthorized_marker_when_recovery_metadata_differs()
     {
        let egress = Arc::new(RecordingRuntimeHttpEgress::responding(401));
        let port = host_port(egress, Arc::new(AllowObligations), secret_store());
        let mut request = host_request();
        let scope = request.request.scope.clone();
        let account_id = "product-auth-account-123".to_string();
        let account_updated_at = chrono::Utc::now();
        for (header, requester_extension, unauthorized_policy) in [
            (
                "x-token-primary",
                "github",
                RuntimeCredentialUnauthorizedPolicy::RevokeAccount,
            ),
            (
                "x-token-secondary",
                "github-alt",
                RuntimeCredentialUnauthorizedPolicy::RefreshAccount,
            ),
        ] {
            request.credentials.push(HostRuntimeCredentialMaterial {
                handle: SecretHandle::new(header).expect("secret handle"),
                material: SecretMaterial::from("host-held-token"),
                target: RuntimeCredentialTarget::Header {
                    name: header.to_string(),
                    prefix: None,
                },
                required: true,
                credential_account: Some(RuntimeCredentialAccountIdentity {
                    scope: scope.clone(),
                    account_provider: RuntimeCredentialAccountProviderId::new("github")
                        .expect("provider"),
                    account_id: account_id.clone(),
                    account_updated_at: Some(account_updated_at),
                    requester_extension: Some(
                        ExtensionId::new(requester_extension).expect("extension id"),
                    ),
                    auth_requirement: Some(RuntimeCredentialAuthRequirement {
                        requester_extension: ExtensionId::new(requester_extension)
                            .expect("extension id"),
                        ..auth_requirement("github")
                    }),
                    unauthorized_policy,
                }),
            });
        }

        let response = port
            .execute(request)
            .await
            .expect("401 response should still succeed");

        assert!(
            response.credential_unauthorized.is_none(),
            "a 401 with conflicting recovery metadata must not guess which recovery flow to run"
        );
    }

    #[tokio::test]
    async fn host_runtime_http_egress_does_not_attach_credential_unauthorized_marker_on_403() {
        let egress = Arc::new(RecordingRuntimeHttpEgress::responding(403));
        let port = host_port(egress, Arc::new(AllowObligations), secret_store());
        let mut request = host_request();
        request.credentials.push(HostRuntimeCredentialMaterial {
            handle: secret_handle(),
            material: SecretMaterial::from("host-held-token"),
            target: RuntimeCredentialTarget::Header {
                name: "authorization".to_string(),
                prefix: Some("Bearer ".to_string()),
            },
            required: true,
            credential_account: Some(RuntimeCredentialAccountIdentity {
                scope: request.request.scope.clone(),
                account_provider: RuntimeCredentialAccountProviderId::new("github")
                    .expect("provider"),
                account_id: "product-auth-account-123".to_string(),
                account_updated_at: Some(chrono::Utc::now()),
                requester_extension: None,
                auth_requirement: Some(auth_requirement("github")),
                unauthorized_policy: RuntimeCredentialUnauthorizedPolicy::RevokeAccount,
            }),
        });

        let response = port
            .execute(request)
            .await
            .expect("403 response should still succeed");

        assert!(
            response.credential_unauthorized.is_none(),
            "403 must not attach a credential unauthorized marker"
        );
    }

    #[tokio::test]
    async fn host_runtime_http_egress_attaches_refresh_policy_marker_on_401() {
        let egress = Arc::new(RecordingRuntimeHttpEgress::responding(401));
        let port = host_port(egress, Arc::new(AllowObligations), secret_store());
        let mut request = host_request();
        request.credentials.push(HostRuntimeCredentialMaterial {
            handle: secret_handle(),
            material: SecretMaterial::from("host-held-oauth-access-token"),
            target: RuntimeCredentialTarget::Header {
                name: "authorization".to_string(),
                prefix: Some("Bearer ".to_string()),
            },
            required: true,
            credential_account: Some(RuntimeCredentialAccountIdentity {
                scope: request.request.scope.clone(),
                account_provider: RuntimeCredentialAccountProviderId::new("google")
                    .expect("provider"),
                account_id: "oauth-account-123".to_string(),
                account_updated_at: Some(chrono::Utc::now()),
                requester_extension: None,
                auth_requirement: Some(auth_requirement("google")),
                unauthorized_policy: RuntimeCredentialUnauthorizedPolicy::RefreshAccount,
            }),
        });

        let response = port
            .execute(request)
            .await
            .expect("401 response should still succeed");

        assert_eq!(
            response
                .credential_unauthorized
                .expect("refreshable account should emit a recovery marker")
                .unauthorized_policy,
            RuntimeCredentialUnauthorizedPolicy::RefreshAccount
        );
    }

    fn host_port(
        egress: Arc<dyn RuntimeHttpEgress>,
        obligations: Arc<dyn CapabilityObligationHandler>,
        store: Arc<RuntimeSecretInjectionStore>,
    ) -> HostRuntimeHttpEgressPort {
        HostRuntimeHttpEgressPort::new(egress, obligations, RuntimeSecretMaterialStager::new(store))
    }

    fn host_request() -> HostRuntimeHttpEgressRequest {
        HostRuntimeHttpEgressRequest {
            extension_id: ExtensionId::new("test_extension").expect("extension id"),
            trust: TrustClass::System,
            request: RuntimeHttpEgressRequest {
                runtime: RuntimeKind::FirstParty,
                scope: scope(),
                capability_id: capability_id(),
                method: NetworkMethod::Get,
                url: "https://api.example.test/v1".to_string(),
                headers: Vec::new(),
                body: Vec::new(),
                network_policy: network_policy(),
                credential_injections: Vec::new(),
                response_body_limit: None,
                save_body_to: None,
                timeout_ms: None,
            },
            credentials: Vec::new(),
        }
    }

    fn scope() -> ResourceScope {
        ResourceScope::local_default(
            UserId::new("user:test").expect("user id"),
            InvocationId::new(),
        )
        .expect("scope")
    }

    fn capability_id() -> CapabilityId {
        CapabilityId::new("test.host_http").expect("capability id")
    }

    fn secret_handle() -> SecretHandle {
        SecretHandle::new("host-held-token").expect("secret handle")
    }

    fn secret_store() -> Arc<RuntimeSecretInjectionStore> {
        Arc::new(RuntimeSecretInjectionStore::new())
    }

    fn network_policy() -> NetworkPolicy {
        NetworkPolicy {
            allowed_targets: vec![NetworkTargetPattern {
                scheme: Some(NetworkScheme::Https),
                host_pattern: "api.example.test".to_string(),
                port: None,
            }],
            deny_private_ip_ranges: true,
            max_egress_bytes: Some(1024),
        }
    }

    fn auth_requirement(provider: &str) -> RuntimeCredentialAuthRequirement {
        RuntimeCredentialAuthRequirement {
            provider: RuntimeCredentialAccountProviderId::new(provider).expect("provider"),
            setup: RuntimeCredentialAccountSetup::ManualToken,
            requester_extension: ExtensionId::new("test_extension").expect("extension id"),
            provider_scopes: Vec::new(),
        }
    }
}
