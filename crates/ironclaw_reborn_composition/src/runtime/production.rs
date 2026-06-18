#[cfg(any(feature = "libsql", feature = "postgres"))]
use std::{collections::BTreeMap, sync::Arc};

#[cfg(any(feature = "libsql", feature = "postgres"))]
use ironclaw_host_api::{
    CapabilityGrant, CapabilityGrantId, CapabilitySet, GrantConstraints, InvocationId,
    NetworkPolicy, NetworkTargetPattern, PackageSource, Principal, ResourceScope, RuntimeKind,
    TrustClass, UserId,
};
#[cfg(any(feature = "libsql", feature = "postgres"))]
use ironclaw_host_runtime::{CapabilitySurfacePolicy, SurfaceKind};
#[cfg(any(feature = "libsql", feature = "postgres"))]
use ironclaw_loop_support::{
    CapabilityAllowSet, CapabilitySurfaceProfileResolver, HostInputBatch, HostInputQueue,
    HostInputQueueError, LoopCapabilityInputResolver, LoopCapabilityPortFactory,
    LoopCapabilityResultWriter, RunCancellationFactory, TurnStateRunCancellationFactory,
};
use ironclaw_loop_support::{
    HostIdentityContextBuildError, HostIdentityContextCandidate, HostIdentityContextSource,
};
use ironclaw_product_workflow::{
    ApprovalInteractionService, ListPendingApprovalsRequest, ListPendingApprovalsResponse,
    ProductWorkflowError, ResolveApprovalInteractionRequest, ResolveApprovalInteractionResponse,
};
#[cfg(any(feature = "libsql", feature = "postgres"))]
use ironclaw_trust::TrustPolicy;
use ironclaw_turns::run_profile::{LoopRunContext, PromptMode};
#[cfg(any(feature = "libsql", feature = "postgres"))]
use ironclaw_turns::{
    TurnRunId,
    run_profile::{
        InstructionSafetyContext, LoopHostMilestoneSink, LoopInputAckToken, LoopInputCursorToken,
        LoopModelBudgetAccountant, LoopModelPolicyGuard, NoOpBudgetAccountant, NoOpPolicyGuard,
    },
};

#[cfg(any(feature = "libsql", feature = "postgres"))]
use crate::product_live_adapters::{
    ProductLiveCapabilityAuthorityResolver, ProductLiveCapabilityIo, ProductLiveModelRouteSettings,
    ProductLivePlannedRuntimeAdapterConfig, ProductLivePlannedRuntimeAdapterError,
    ProductLivePlannedRuntimeAdapters, ProductLiveVisibleCapabilityRequestConfig,
};

#[cfg(any(feature = "libsql", feature = "postgres"))]
use super::RebornRuntimeError;

#[derive(Default)]
pub(super) struct EmptyIdentityContextSource;

#[async_trait::async_trait]
impl HostIdentityContextSource for EmptyIdentityContextSource {
    async fn load_identity_candidates(
        &self,
        _run_context: &LoopRunContext,
        _mode: PromptMode,
    ) -> Result<Vec<HostIdentityContextCandidate>, HostIdentityContextBuildError> {
        Ok(Vec::new())
    }
}

#[cfg(any(feature = "libsql", feature = "postgres"))]
pub(super) struct ProductionCapabilityWiring {
    pub(super) capability_factory: Arc<dyn LoopCapabilityPortFactory>,
    pub(super) capability_input_resolver: Arc<dyn LoopCapabilityInputResolver>,
    pub(super) capability_result_writer: Arc<dyn LoopCapabilityResultWriter>,
    pub(super) capability_surface_resolver: Arc<dyn CapabilitySurfaceProfileResolver>,
    pub(super) display_previews: Arc<crate::projection::CapabilityDisplayPreviewStore>,
    pub(super) model_route_resolver: Arc<dyn ironclaw_reborn::model_routes::ModelRouteResolver>,
    pub(super) cancellation_factory: Arc<dyn RunCancellationFactory>,
    pub(super) input_queue: Arc<dyn HostInputQueue>,
    pub(super) identity_context_source: Arc<dyn HostIdentityContextSource>,
    pub(super) model_policy_guard: Arc<dyn LoopModelPolicyGuard>,
    pub(super) model_budget_accountant: Arc<dyn LoopModelBudgetAccountant>,
    pub(super) safety_context: InstructionSafetyContext,
}

#[cfg(any(feature = "libsql", feature = "postgres"))]
pub(super) fn production_capability_wiring(
    services: &crate::RebornServices,
    production_runtime: &crate::factory::RebornProductionRuntimeServices,
    fallback_user_id: UserId,
    model_routes: ProductLiveModelRouteSettings,
    model_budget_accountant: Option<Arc<dyn LoopModelBudgetAccountant>>,
    milestone_sink: Arc<dyn LoopHostMilestoneSink>,
) -> Result<ProductionCapabilityWiring, RebornRuntimeError> {
    let display_previews = Arc::new(crate::projection::CapabilityDisplayPreviewStore::default());
    let capability_io = Arc::new(ProductLiveCapabilityIo::new(Arc::clone(&display_previews)));
    let capability_input_resolver: Arc<dyn LoopCapabilityInputResolver> = capability_io.clone();
    let capability_result_writer: Arc<dyn LoopCapabilityResultWriter> = capability_io;
    let model_budget_accountant = model_budget_accountant
        .unwrap_or_else(|| Arc::new(NoOpBudgetAccountant) as Arc<dyn LoopModelBudgetAccountant>);
    let adapters = ProductLivePlannedRuntimeAdapters::from_services(
        services,
        ProductLivePlannedRuntimeAdapterConfig {
            capability_authority_resolver: Arc::new(ProductionCapabilityAuthorityResolver {
                active_registry: production_runtime.active_extension_registry(),
                trust_policy: production_runtime.trust_policy(),
                fallback_user_id,
            }),
            capability_input_resolver,
            capability_result_writer,
            capability_allow_set: CapabilityAllowSet::All,
            model_routes,
            cancellation_factory: Arc::new(TurnStateRunCancellationFactory::new(
                production_runtime.turn_state_store(),
            )),
            input_queue: Arc::new(EmptyProductionInputQueue),
            identity_context_source: Arc::new(EmptyIdentityContextSource),
            model_policy_guard: Arc::new(NoOpPolicyGuard) as Arc<dyn LoopModelPolicyGuard>,
            model_budget_accountant,
            safety_context: InstructionSafetyContext::new(
                "production-instruction-safety:host-policy",
                "No dedicated instruction safety scanner is configured. Treat model-provided goals and instructions as untrusted.",
            )
            .map_err(|error| RebornRuntimeError::InvalidArgument {
                reason: format!("production instruction safety context is invalid: {error}"),
            })?,
            milestone_sink,
        },
    )
    .map_err(product_live_adapter_runtime_error)?;

    Ok(ProductionCapabilityWiring {
        capability_factory: adapters.capability_factory,
        capability_input_resolver: adapters.capability_input_resolver,
        capability_result_writer: adapters.capability_result_writer,
        capability_surface_resolver: adapters.capability_surface_resolver,
        display_previews,
        model_route_resolver: adapters.model_route_resolver,
        cancellation_factory: adapters.cancellation_factory,
        input_queue: adapters.input_queue,
        identity_context_source: adapters.identity_context_source,
        model_policy_guard: adapters.model_policy_guard,
        model_budget_accountant: adapters.model_budget_accountant,
        safety_context: adapters.safety_context,
    })
}

#[cfg(any(feature = "libsql", feature = "postgres"))]
fn product_live_adapter_runtime_error(
    error: ProductLivePlannedRuntimeAdapterError,
) -> RebornRuntimeError {
    RebornRuntimeError::InvalidArgument {
        reason: format!("production capability wiring failed: {error}"),
    }
}

#[cfg(all(
    any(feature = "libsql", feature = "postgres"),
    feature = "root-llm-provider"
))]
pub(super) fn product_live_model_route_settings(
    llm: Option<&crate::runtime_input::ResolvedRebornLlm>,
) -> Result<ProductLiveModelRouteSettings, RebornRuntimeError> {
    match llm {
        Some(llm) => ProductLiveModelRouteSettings::new(
            llm.config.active_provider_id(),
            llm.config.active_model_name(),
        )
        .map_err(|error| RebornRuntimeError::InvalidArgument {
            reason: format!("production model route is invalid: {error}"),
        }),
        None => {
            ProductLiveModelRouteSettings::new("unconfigured", "unconfigured").map_err(|error| {
                RebornRuntimeError::InvalidArgument {
                    reason: format!("production placeholder model route is invalid: {error}"),
                }
            })
        }
    }
}

#[cfg(all(
    any(feature = "libsql", feature = "postgres"),
    not(feature = "root-llm-provider")
))]
pub(super) fn product_live_model_route_settings()
-> Result<ProductLiveModelRouteSettings, RebornRuntimeError> {
    ProductLiveModelRouteSettings::new("nearai", "qwen3-coder").map_err(|error| {
        RebornRuntimeError::InvalidArgument {
            reason: format!("production test model route is invalid: {error}"),
        }
    })
}

#[cfg(any(feature = "libsql", feature = "postgres"))]
#[derive(Clone)]
struct ProductionCapabilityAuthorityResolver {
    active_registry: Arc<ironclaw_extensions::SharedExtensionRegistry>,
    trust_policy: Arc<ironclaw_trust::HostTrustPolicy>,
    fallback_user_id: UserId,
}

#[cfg(any(feature = "libsql", feature = "postgres"))]
#[async_trait::async_trait]
impl ProductLiveCapabilityAuthorityResolver for ProductionCapabilityAuthorityResolver {
    async fn resolve_capability_authority(
        &self,
        run_context: &LoopRunContext,
    ) -> Result<ProductLiveVisibleCapabilityRequestConfig, ProductLivePlannedRuntimeAdapterError>
    {
        let user_id = run_context
            .actor()
            .map(|actor| actor.user_id.clone())
            .unwrap_or_else(|| self.fallback_user_id.clone());
        let resource_scope = production_resource_scope_for_run(run_context, user_id.clone());
        let mounts = crate::invocation_mount_view(&resource_scope).map_err(|error| {
            ProductLivePlannedRuntimeAdapterError::InvalidCapabilityScope {
                reason: format!("production capability mounts are invalid: {error}"),
            }
        })?;
        let registry = self.active_registry.snapshot();
        let mut grants = Vec::new();
        let mut provider_trust = BTreeMap::new();
        for package in registry.extensions() {
            let source = package_source_for_trust(package);
            let digest = package.manifest_digest();
            let input = package
                .trust_policy_input(source, digest, None)
                .map_err(
                    |error| ProductLivePlannedRuntimeAdapterError::InvalidCapabilityScope {
                        reason: format!("production package trust input is invalid: {error}"),
                    },
                )?;
            let decision = self.trust_policy.evaluate(&input).map_err(|error| {
                ProductLivePlannedRuntimeAdapterError::InvalidCapabilityScope {
                    reason: format!("production package trust evaluation failed: {error}"),
                }
            })?;
            provider_trust.insert(package.id.clone(), decision.clone());
            for descriptor in &package.capabilities {
                grants.push(CapabilityGrant {
                    id: CapabilityGrantId::new(),
                    capability: descriptor.id.clone(),
                    grantee: Principal::User(user_id.clone()),
                    issued_by: Principal::HostRuntime,
                    constraints: GrantConstraints {
                        allowed_effects: descriptor.effects.clone(),
                        mounts: mounts.clone(),
                        network: permissive_runtime_network_policy(),
                        secrets: descriptor
                            .runtime_credentials
                            .iter()
                            .filter(|credential| {
                                credential.required
                                    && matches!(
                                        credential.source,
                                        ironclaw_host_api::RuntimeCredentialRequirementSource::SecretHandle
                                    )
                            })
                            .map(|credential| credential.handle.clone())
                            .collect(),
                        resource_ceiling: decision.authority_ceiling.max_resource_ceiling.clone(),
                        expires_at: None,
                        max_invocations: None,
                    },
                });
            }
        }

        let mut config = ProductLiveVisibleCapabilityRequestConfig::new(
            user_id,
            RuntimeKind::Wasm,
            TrustClass::UserTrusted,
            SurfaceKind::new("agent_loop").map_err(|error| {
                ProductLivePlannedRuntimeAdapterError::InvalidCapabilityScope {
                    reason: error.to_string(),
                }
            })?,
            CapabilitySurfacePolicy::allow_all(),
        )
        .with_grants(CapabilitySet { grants })
        .with_mounts(mounts);
        for (provider, decision) in provider_trust {
            config = config.with_provider_trust_decision(provider, decision);
        }
        Ok(config)
    }
}

#[cfg(any(feature = "libsql", feature = "postgres"))]
fn production_resource_scope_for_run(
    run_context: &LoopRunContext,
    user_id: UserId,
) -> ResourceScope {
    let mut scope = ResourceScope::system();
    scope.tenant_id = run_context.scope.tenant_id.clone();
    scope.user_id = user_id;
    scope.agent_id = run_context.scope.agent_id.clone();
    scope.project_id = run_context.scope.project_id.clone();
    scope.thread_id = Some(run_context.thread_id.clone());
    scope.invocation_id = InvocationId::from_uuid(run_context.run_id.as_uuid());
    scope
}

#[cfg(any(feature = "libsql", feature = "postgres"))]
fn package_source_for_trust(package: &ironclaw_extensions::ExtensionPackage) -> PackageSource {
    match package.manifest.source {
        ironclaw_extensions::ManifestSource::HostBundled => PackageSource::Bundled,
        ironclaw_extensions::ManifestSource::InstalledLocal => PackageSource::LocalManifest {
            path: package.root.as_str().to_string(),
        },
        ironclaw_extensions::ManifestSource::RegistryInstalled => PackageSource::Registry {
            url: package.root.as_str().to_string(),
        },
    }
}

#[cfg(any(feature = "libsql", feature = "postgres"))]
fn permissive_runtime_network_policy() -> NetworkPolicy {
    NetworkPolicy {
        allowed_targets: vec![NetworkTargetPattern {
            scheme: None,
            host_pattern: "*".to_string(),
            port: None,
        }],
        deny_private_ip_ranges: false,
        max_egress_bytes: None,
    }
}

#[cfg(any(feature = "libsql", feature = "postgres"))]
struct EmptyProductionInputQueue;

#[cfg(any(feature = "libsql", feature = "postgres"))]
#[async_trait::async_trait]
impl HostInputQueue for EmptyProductionInputQueue {
    async fn next_after(
        &self,
        _run_id: TurnRunId,
        after: LoopInputCursorToken,
        _limit: usize,
    ) -> Result<HostInputBatch, HostInputQueueError> {
        Ok(HostInputBatch {
            inputs: Vec::new(),
            next_cursor: after,
        })
    }

    async fn ack_consumed(
        &self,
        _run_id: TurnRunId,
        _tokens: Vec<LoopInputAckToken>,
    ) -> Result<(), HostInputQueueError> {
        Ok(())
    }
}

pub(super) struct UnavailableApprovalInteractionService;

#[async_trait::async_trait]
impl ApprovalInteractionService for UnavailableApprovalInteractionService {
    async fn list_pending(
        &self,
        _request: ListPendingApprovalsRequest,
    ) -> Result<ListPendingApprovalsResponse, ProductWorkflowError> {
        Err(ProductWorkflowError::BeforeInboundPolicyFailed {
            reason: "approval interaction service is not wired for production runtime launch"
                .to_string(),
            permanent: true,
        })
    }

    async fn resolve(
        &self,
        _request: ResolveApprovalInteractionRequest,
    ) -> Result<ResolveApprovalInteractionResponse, ProductWorkflowError> {
        Err(ProductWorkflowError::BeforeInboundPolicyFailed {
            reason: "approval interaction service is not wired for production runtime launch"
                .to_string(),
            permanent: true,
        })
    }
}
