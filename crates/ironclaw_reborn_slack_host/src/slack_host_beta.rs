//! Host-beta Slack Events API composition.
//!
//! This module is the single composition point for the native Slack route:
//! the CLI supplies explicit host config, and this module reuses the already
//! assembled Reborn runtime services instead of creating a second agent loop.

use std::collections::HashSet;
use std::num::NonZeroUsize;
use std::sync::Arc;
use std::time::Duration;

use ironclaw_conversations::InMemoryConversationServices;
use ironclaw_filesystem::{RootFilesystem, ScopedFilesystem};
use ironclaw_host_api::{AgentId, ProjectId, ResourceScope, TenantId, UserId};
use ironclaw_host_runtime::HostRuntimeHttpEgressPort;
use ironclaw_outbound::{FilesystemOutboundStateStore, OutboundStateStore};
use ironclaw_product_adapters::{
    AdapterInstallationId, DeclaredEgressHost, DeclaredEgressTarget, DeliveryStatus,
    EgressCredentialHandle, ExternalActorRef, OutboundDeliverySink, ProductAdapter,
    ProductAdapterId, ProtocolHttpEgress,
};
use ironclaw_product_workflow::{
    ApprovalInteractionService, AuthInteractionService, DefaultInboundTurnService,
    DefaultProductWorkflow, OutboundDeliveryTargetProvider, ProductActorUserResolutionRequest,
    ProductActorUserResolver, ProductConversationBindingService, ProductConversationRouteKey,
    ProductConversationSubjectRouteResolver, ProductInstallationKey, ProductInstallationScope,
    ProductWorkflowError, StaticProductInstallationResolver,
};
use ironclaw_product_workflow_storage::RebornFilesystemIdempotencyLedger;
use ironclaw_slack_v2_adapter::{
    SLACK_API_HOST, SLACK_USER_ACTOR_KIND, SLACK_V2_ADAPTER_ID, SlackV2Adapter,
    SlackV2AdapterConfig, slack_request_signature_auth_requirement,
};
use ironclaw_threads::SessionThreadService;
use ironclaw_turns::TurnCoordinator;
use ironclaw_wasm_product_adapters::{
    EgressPolicy, HmacWebhookAuth, NativeProductAdapterRunner, NativeProductAdapterRunnerConfig,
    WebhookAuth,
};
use secrecy::{ExposeSecret, SecretString};
use thiserror::Error;

use crate::slack_actor_identity::SlackUserIdentityActorResolver;
use crate::slack_channel_routes::{
    SlackChannelRouteAdminRouteConfig, SlackChannelRouteStore, SlackChannelRouteSubjectResolver,
    slack_channel_route_admin_route_mount,
};
use crate::slack_delivery::{
    SlackFinalReplyDeliveryObserver, SlackFinalReplyDeliveryServices,
    SlackFinalReplyDeliverySettings,
};
use crate::slack_egress::{SlackProtocolHttpEgress, StaticSlackEgressCredentialProvider};
use crate::slack_host_state::FilesystemSlackHostState;
use crate::slack_outbound_targets::{
    SlackConfiguredChannelRoute, SlackHostBetaOutboundTargetProvider,
    SlackOutboundTargetProviderConfig, SlackPersonalDmTargetStore,
};
use crate::slack_pairing_notifier::SlackPairingChallengeHttpNotifier;
use crate::slack_personal_binding::{
    RebornUserIdentityBindingStore, SlackPersonalBindingInstallation,
    SlackPersonalUserBindingService,
};
use crate::slack_personal_binding_pairing::{
    SlackPairingActorResolver, SlackPersonalBindingPairingChallengeStore,
    SlackPersonalBindingPairingNotifier, SlackPersonalBindingPairingService,
};
use crate::slack_personal_binding_pairing_serve::{
    SlackPersonalBindingPairingRouteConfig, slack_personal_binding_pairing_route_mount,
};
use crate::slack_serve::{
    SlackEventsRouteState, SlackInstallationRecord, SlackInstallationSelector, SlackTeamId,
    StaticSlackInstallationResolver, slack_events_route_mount,
};
use ironclaw_reborn_http_kit::{ProtectedRouteMount, PublicRouteMount};

const SLACK_BOT_TOKEN_HANDLE: &str = "slack_bot_token";
pub const SLACK_SIGNATURE_HEADER: &str = "X-Slack-Signature";
pub const SLACK_TIMESTAMP_HEADER: &str = "X-Slack-Request-Timestamp";
const SLACK_WEBHOOK_WORKFLOW_TIMEOUT: Duration = Duration::from_secs(2);
const SLACK_MAX_IN_FLIGHT_WEBHOOKS: usize = 64;
const SLACK_IDEMPOTENCY_LEDGER_SETTLED_LIMIT: usize = 10_000;
const SLACK_IDEMPOTENCY_LEDGER_PRUNE_INTERVAL: usize = 1_000;

struct NoopSlackDeliverySink;

#[async_trait::async_trait]
impl OutboundDeliverySink for NoopSlackDeliverySink {
    async fn record(&self, _status: DeliveryStatus) {}
}

#[derive(Clone)]
pub struct SlackHostBetaConfig {
    pub tenant_id: TenantId,
    pub agent_id: AgentId,
    pub project_id: Option<ProjectId>,
    pub installation_id: AdapterInstallationId,
    pub team_id: SlackTeamId,
    pub installation_selector: SlackInstallationSelector,
    /// Optional Slack actor retained only for legacy static personal-binding
    /// tests/config. Tenant app host-beta resolution uses durable personal
    /// bindings and does not require a preselected Slack user.
    pub slack_actor: Option<ExternalActorRef>,
    /// Host/runtime user used for Slack host-mediated state, legacy static
    /// Slack actor mapping, and backward-compatible shared-route fallback when
    /// `shared_subject_user_id` is not configured.
    pub user_id: UserId,
    /// Optional user scope that owns Slack shared-channel execution, tools,
    /// skills, and memory in this beta route. Personal DM routes still use the
    /// paired actor as the subject.
    pub shared_subject_user_id: Option<UserId>,
    pub channel_routes: Vec<SlackHostBetaChannelRoute>,
    pub signing_secret: SecretString,
    pub bot_token: SecretString,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlackHostBetaChannelRoute {
    pub channel_id: String,
    pub subject_user_id: UserId,
}

impl SlackHostBetaChannelRoute {
    pub fn new(channel_id: impl Into<String>, subject_user_id: UserId) -> Self {
        Self {
            channel_id: channel_id.into(),
            subject_user_id,
        }
    }
}

pub struct SlackHostBetaConfigInput {
    pub tenant_id: TenantId,
    pub agent_id: AgentId,
    pub project_id: Option<ProjectId>,
    pub installation_id: String,
    pub team_id: SlackTeamId,
    pub api_app_id: Option<String>,
    pub slack_user_id: Option<String>,
    pub user_id: UserId,
    pub shared_subject_user_id: Option<UserId>,
    pub channel_routes: Vec<SlackHostBetaChannelRoute>,
    pub signing_secret: SecretString,
    pub bot_token: SecretString,
}

impl SlackHostBetaConfig {
    pub fn new(input: SlackHostBetaConfigInput) -> Result<Self, SlackHostBetaBuildError> {
        let installation_id = AdapterInstallationId::new(input.installation_id)
            .map_err(|reason| invalid_config("installation_id", reason.to_string()))?;
        let team_id = input.team_id;
        let installation_selector = match input.api_app_id {
            Some(api_app_id) => {
                SlackInstallationSelector::app_team(api_app_id, team_id.as_str().to_string())
            }
            None => SlackInstallationSelector::team(team_id.as_str().to_string()),
        };
        let mut seen_channel_ids = HashSet::new();
        for route in &input.channel_routes {
            if !seen_channel_ids.insert(route.channel_id.as_str()) {
                return Err(invalid_config(
                    "channel_routes",
                    format!("duplicate channel_id '{}'", route.channel_id),
                ));
            }
            slack_channel_route_key(&team_id, route)?;
        }
        let slack_actor = input
            .slack_user_id
            .map(|slack_user_id| {
                ExternalActorRef::new(SLACK_USER_ACTOR_KIND, slack_user_id, None::<String>)
                    .map_err(|reason| invalid_config("slack_user_id", reason.to_string()))
            })
            .transpose()?;
        Ok(Self {
            tenant_id: input.tenant_id,
            agent_id: input.agent_id,
            project_id: input.project_id,
            installation_id,
            team_id,
            installation_selector,
            slack_actor,
            user_id: input.user_id,
            shared_subject_user_id: input.shared_subject_user_id,
            channel_routes: input.channel_routes,
            signing_secret: input.signing_secret,
            bot_token: input.bot_token,
        })
    }
}

impl std::fmt::Debug for SlackHostBetaConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SlackHostBetaConfig")
            .field("tenant_id", &self.tenant_id)
            .field("agent_id", &self.agent_id)
            .field("project_id", &self.project_id)
            .field("installation_id", &self.installation_id)
            .field("team_id", &self.team_id)
            .field("installation_selector", &self.installation_selector)
            .field("slack_actor", &self.slack_actor)
            .field("user_id", &self.user_id)
            .field("shared_subject_user_id", &self.shared_subject_user_id)
            .field("channel_routes", &self.channel_routes)
            .field("signing_secret", &"[REDACTED]")
            .field("bot_token", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Error)]
pub enum SlackHostBetaBuildError {
    #[error("Slack host-beta requires local runtime HTTP egress")]
    RuntimeHttpEgressUnavailable,
    #[error("Slack host-beta requires durable host state")]
    DurableHostStateUnavailable,
    #[error(
        "Slack host-beta personal binding requires [slack].api_app_id for tenant app-scoped pairing"
    )]
    TenantAppSelectorRequired,
    #[error("invalid Slack host-beta config field {field}: {reason}")]
    InvalidConfig { field: &'static str, reason: String },
}

pub struct SlackHostBetaMounts {
    pub events: PublicRouteMount,
    /// Bearer-protected pairing-code redeem mount; attach via
    /// [`ironclaw_reborn_http_kit::WebuiServeConfig::with_protected_route_mount`].
    pub personal_binding_pairing: ProtectedRouteMount,
    /// Operator-gated channel-route admin mount; attach via
    /// [`ironclaw_reborn_http_kit::WebuiServeConfig::with_protected_route_mount`].
    pub channel_routes: ProtectedRouteMount,
    /// Internal target-authority handle consumed only by WebUI product-facade composition.
    pub outbound_delivery_target_provider: Arc<dyn OutboundDeliveryTargetProvider>,
}

pub struct SlackHostRuntimeHandles<F>
where
    F: RootFilesystem + 'static,
{
    pub host_state_filesystem: Arc<ScopedFilesystem<F>>,
    pub host_runtime_http_egress: HostRuntimeHttpEgressPort,
    pub webui_thread_service: Arc<dyn SessionThreadService>,
    pub webui_turn_coordinator: Arc<dyn TurnCoordinator>,
    pub webui_approval_interaction_service: Arc<dyn ApprovalInteractionService>,
    pub webui_auth_interaction_service: Arc<dyn AuthInteractionService>,
    pub auth_challenge_provider:
        Option<Arc<dyn ironclaw_reborn_product_auth::AuthChallengeProvider>>,
}

impl<F> SlackHostRuntimeHandles<F>
where
    F: RootFilesystem + 'static,
{
    pub fn new(
        host_state_filesystem: Arc<ScopedFilesystem<F>>,
        host_runtime_http_egress: HostRuntimeHttpEgressPort,
        webui_thread_service: Arc<dyn SessionThreadService>,
        webui_turn_coordinator: Arc<dyn TurnCoordinator>,
        webui_approval_interaction_service: Arc<dyn ApprovalInteractionService>,
        webui_auth_interaction_service: Arc<dyn AuthInteractionService>,
        auth_challenge_provider: Option<
            Arc<dyn ironclaw_reborn_product_auth::AuthChallengeProvider>,
        >,
    ) -> Self {
        Self {
            host_state_filesystem,
            host_runtime_http_egress,
            webui_thread_service,
            webui_turn_coordinator,
            webui_approval_interaction_service,
            webui_auth_interaction_service,
            auth_challenge_provider,
        }
    }
}
pub fn build_slack_events_route_mount_with_handles<F>(
    handles: &SlackHostRuntimeHandles<F>,
    config: SlackHostBetaConfig,
) -> Result<PublicRouteMount, SlackHostBetaBuildError>
where
    F: RootFilesystem + 'static,
{
    build_slack_host_beta_mounts_with_handles(handles, config).map(|mounts| mounts.events)
}

pub fn build_slack_host_beta_mounts_with_handles<F>(
    handles: &SlackHostRuntimeHandles<F>,
    config: SlackHostBetaConfig,
) -> Result<SlackHostBetaMounts, SlackHostBetaBuildError>
where
    F: RootFilesystem + 'static,
{
    if !matches!(
        config.installation_selector,
        SlackInstallationSelector::AppTeam { .. }
    ) {
        return Err(SlackHostBetaBuildError::TenantAppSelectorRequired);
    }
    let state = Arc::new(FilesystemSlackHostState::new(
        Arc::clone(&handles.host_state_filesystem),
        config.tenant_id.clone(),
        config.user_id.clone(),
        config.agent_id.clone(),
        config.project_id.clone(),
    ));
    let binding_store: Arc<dyn RebornUserIdentityBindingStore> = state.clone();
    let binding_service = SlackPersonalUserBindingService::new(
        [SlackPersonalBindingInstallation {
            tenant_id: config.tenant_id.clone(),
            installation_id: config.installation_id.clone(),
            selector: config.installation_selector.clone(),
        }],
        binding_store,
    );
    let token_handle = slack_bot_token_handle()?;
    let notifier: Arc<dyn SlackPersonalBindingPairingNotifier> =
        Arc::new(SlackPairingChallengeHttpNotifier::new(
            slack_protocol_egress_with_handles(handles, &config, token_handle.clone())?,
            token_handle,
        ));
    let challenge_store: Arc<dyn SlackPersonalBindingPairingChallengeStore> = state.clone();
    let pairing =
        SlackPersonalBindingPairingService::new(binding_service, challenge_store, notifier);
    let actor_user_resolver = Arc::new(SlackHostBetaActorUserResolver::new(
        config.installation_id.clone(),
        config.slack_actor.clone(),
        config.user_id.clone(),
        Arc::new(SlackUserIdentityActorResolver::new(state.clone())),
        Arc::new(SlackPairingActorResolver::new(
            state.clone(),
            pairing.clone(),
        )),
    ));
    let channel_route_store: Arc<dyn SlackChannelRouteStore> = state.clone();
    let personal_dm_target_store: Arc<dyn SlackPersonalDmTargetStore> = state.clone();
    let subject_route_resolver: Arc<dyn ProductConversationSubjectRouteResolver> =
        Arc::new(SlackChannelRouteSubjectResolver::new(
            config.tenant_id.clone(),
            config.installation_id.clone(),
            Arc::clone(&channel_route_store),
        ));
    let events = build_slack_events_route_mount_with_resolvers_with_handles(
        handles,
        config.clone(),
        actor_user_resolver,
        Some(subject_route_resolver),
    )?;
    let allowed_route_subjects = std::iter::once(config.user_id.clone())
        .chain(config.shared_subject_user_id.clone())
        .chain(
            config
                .channel_routes
                .iter()
                .map(|route| route.subject_user_id.clone()),
        );
    let channel_routes = SlackChannelRouteAdminRouteConfig::new(
        config.tenant_id.clone(),
        config.installation_id.clone(),
        config.team_id.as_str().to_string(),
        config.user_id.clone(),
        Arc::clone(&channel_route_store),
    )
    .with_allowed_subject_user_ids(allowed_route_subjects);

    Ok(SlackHostBetaMounts {
        events,
        personal_binding_pairing: slack_personal_binding_pairing_route_mount(
            SlackPersonalBindingPairingRouteConfig::new(pairing),
        ),
        channel_routes: slack_channel_route_admin_route_mount(channel_routes),
        outbound_delivery_target_provider: Arc::new(SlackHostBetaOutboundTargetProvider::new(
            SlackOutboundTargetProviderConfig {
                tenant_id: config.tenant_id.clone(),
                agent_id: config.agent_id.clone(),
                project_id: config.project_id.clone(),
                installation_id: config.installation_id.clone(),
                team_id: config.team_id.clone(),
                configured_channel_routes: config
                    .channel_routes
                    .iter()
                    .map(|route| {
                        SlackConfiguredChannelRoute::new(
                            route.channel_id.clone(),
                            route.subject_user_id.clone(),
                        )
                    })
                    .collect(),
            },
            channel_route_store,
            Arc::clone(&personal_dm_target_store),
        )),
    })
}

pub fn build_slack_events_route_mount_with_actor_user_resolver_with_handles<F>(
    handles: &SlackHostRuntimeHandles<F>,
    config: SlackHostBetaConfig,
    actor_user_resolver: Arc<dyn ProductActorUserResolver>,
) -> Result<PublicRouteMount, SlackHostBetaBuildError>
where
    F: RootFilesystem + 'static,
{
    build_slack_events_route_mount_with_resolvers_with_handles(
        handles,
        config,
        actor_user_resolver,
        None,
    )
}

fn build_slack_events_route_mount_with_resolvers_with_handles<F>(
    handles: &SlackHostRuntimeHandles<F>,
    config: SlackHostBetaConfig,
    actor_user_resolver: Arc<dyn ProductActorUserResolver>,
    subject_route_resolver: Option<Arc<dyn ProductConversationSubjectRouteResolver>>,
) -> Result<PublicRouteMount, SlackHostBetaBuildError>
where
    F: RootFilesystem + 'static,
{
    // The resolver controls inbound Slack actor binding. `config.user_id`
    // scopes host-mediated Slack bot-token egress and legacy static actor
    // mapping. Shared Slack channel execution is configured separately.
    tracing::warn!(
        "Slack host-beta uses in-memory conversation bindings; Slack conversation binding continuity is lost on process restart"
    );
    let adapter_id = ProductAdapterId::new(SLACK_V2_ADAPTER_ID)
        .map_err(|reason| invalid_config("adapter_id", reason.to_string()))?;
    let token_handle = slack_bot_token_handle()?;
    let adapter: Arc<dyn ProductAdapter> = Arc::new(SlackV2Adapter::new(SlackV2AdapterConfig {
        adapter_id: adapter_id.clone(),
        installation_id: config.installation_id.clone(),
        egress_credential_handle: token_handle.clone(),
        auth_requirement: slack_request_signature_auth_requirement(),
    }));

    let conversations = Arc::new(InMemoryConversationServices::default());
    let conversation_port: Arc<dyn ironclaw_conversations::ConversationBindingService> =
        conversations.clone();
    let actor_pairings: Arc<dyn ironclaw_conversations::ConversationActorPairingService> =
        conversations.clone();
    let mut scope = ProductInstallationScope::with_default_scope(
        config.tenant_id.clone(),
        config.agent_id.clone(),
        config.project_id.clone(),
    );
    scope = scope.with_default_subject_user_id(
        config
            .shared_subject_user_id
            .clone()
            .unwrap_or_else(|| config.user_id.clone()),
    );
    if let Some(subject_route_resolver) = subject_route_resolver {
        scope = scope
            .with_conversation_subject_route_resolver(subject_route_resolver)
            .without_default_subject_for_unrouted_shared_conversations();
    }
    for route in &config.channel_routes {
        let route_key = slack_channel_route_key(&config.team_id, route)?;
        scope = scope.with_conversation_subject_route(route_key, route.subject_user_id.clone());
    }
    let scope = scope.with_actor_user_resolver(actor_user_resolver, actor_pairings);
    let installation_resolver = StaticProductInstallationResolver::new([(
        ProductInstallationKey::new(adapter_id, config.installation_id.clone()),
        scope,
    )]);
    let binding = ProductConversationBindingService::new(conversation_port, installation_resolver);

    let inbound = Arc::new(DefaultInboundTurnService::new(
        binding.clone(),
        Arc::clone(&handles.webui_thread_service),
        Arc::clone(&handles.webui_turn_coordinator),
    ));
    let workflow = Arc::new(
        DefaultProductWorkflow::new(
            inbound,
            Arc::new(
                RebornFilesystemIdempotencyLedger::new(
                    Arc::clone(&handles.host_state_filesystem),
                    slack_egress_scope_template(&config),
                )
                .with_settled_entry_limit(
                    NonZeroUsize::new(SLACK_IDEMPOTENCY_LEDGER_SETTLED_LIMIT).ok_or_else(|| {
                        invalid_config("settled_entry_limit", "must be non-zero".to_string())
                    })?,
                )
                .with_settled_prune_interval(
                    NonZeroUsize::new(SLACK_IDEMPOTENCY_LEDGER_PRUNE_INTERVAL).ok_or_else(
                        || invalid_config("settled_prune_interval", "must be non-zero".to_string()),
                    )?,
                ),
            ),
            Arc::new(binding.clone()),
        )
        .with_approval_interaction_service(Arc::clone(&handles.webui_approval_interaction_service))
        .with_auth_interaction_service(Arc::clone(&handles.webui_auth_interaction_service)),
    );

    let runner = Arc::new(NativeProductAdapterRunner::with_config(
        adapter.clone(),
        workflow,
        WebhookAuth::Hmac(HmacWebhookAuth::new(
            SLACK_SIGNATURE_HEADER,
            SLACK_TIMESTAMP_HEADER,
            config.signing_secret.expose_secret().as_bytes().to_vec(),
            config.installation_id.as_str(),
        )),
        NativeProductAdapterRunnerConfig::new(
            SLACK_WEBHOOK_WORKFLOW_TIMEOUT,
            NonZeroUsize::new(SLACK_MAX_IN_FLIGHT_WEBHOOKS)
                .ok_or_else(|| invalid_config("max_in_flight", "must be non-zero".to_string()))?,
        ),
    ));

    let egress = slack_protocol_egress_with_handles(handles, &config, token_handle)?;
    let outbound = Arc::new(FilesystemOutboundStateStore::new(Arc::clone(
        &handles.host_state_filesystem,
    )));
    let outbound_store: Arc<dyn OutboundStateStore> = outbound.clone();
    let preferences: Arc<dyn ironclaw_outbound::CommunicationPreferenceRepository> = outbound;
    let delivery_sink: Arc<dyn OutboundDeliverySink> = Arc::new(NoopSlackDeliverySink);
    let observer = Arc::new(SlackFinalReplyDeliveryObserver::with_settings(
        SlackFinalReplyDeliveryServices {
            binding_service: Arc::new(binding),
            thread_service: Arc::clone(&handles.webui_thread_service),
            turn_coordinator: Arc::clone(&handles.webui_turn_coordinator),
            outbound_store,
            communication_preferences: preferences,
            adapter,
            egress,
            delivery_sink,
            auth_challenges: handles.auth_challenge_provider.clone(),
        },
        SlackFinalReplyDeliverySettings::default(),
    ));

    let slack_resolver = StaticSlackInstallationResolver::new([SlackInstallationRecord::new(
        config.tenant_id,
        config.installation_id,
        config.installation_selector,
        runner,
    )
    .with_workflow_observer(observer)]);

    Ok(slack_events_route_mount(
        SlackEventsRouteState::from_resolver(Arc::new(slack_resolver)),
    ))
}

pub(crate) fn slack_channel_route_key(
    team_id: &SlackTeamId,
    route: &SlackHostBetaChannelRoute,
) -> Result<ProductConversationRouteKey, SlackHostBetaBuildError> {
    ProductConversationRouteKey::new(Some(team_id.as_str().to_string()), route.channel_id.clone())
        .map_err(|reason| invalid_config("channel_routes", reason.to_string()))
}

pub fn slack_bot_token_handle() -> Result<EgressCredentialHandle, SlackHostBetaBuildError> {
    EgressCredentialHandle::new(SLACK_BOT_TOKEN_HANDLE)
        .map_err(|reason| invalid_config("bot_token_handle", reason.to_string()))
}

pub fn slack_protocol_egress_with_handles<F>(
    handles: &SlackHostRuntimeHandles<F>,
    config: &SlackHostBetaConfig,
    token_handle: EgressCredentialHandle,
) -> Result<Arc<dyn ProtocolHttpEgress>, SlackHostBetaBuildError>
where
    F: RootFilesystem + 'static,
{
    Ok(Arc::new(SlackProtocolHttpEgress::new(
        handles.host_runtime_http_egress.clone(),
        Arc::new(StaticSlackEgressCredentialProvider::new(
            token_handle.clone(),
            config.bot_token.expose_secret().to_string(),
        )),
        EgressPolicy::new(slack_declared_egress_targets(token_handle)?),
        slack_egress_scope_template(config),
    )))
}

pub fn slack_egress_scope_template(config: &SlackHostBetaConfig) -> ResourceScope {
    ResourceScope {
        tenant_id: config.tenant_id.clone(),
        user_id: config.user_id.clone(),
        agent_id: Some(config.agent_id.clone()),
        project_id: config.project_id.clone(),
        mission_id: None,
        thread_id: None,
        invocation_id: ironclaw_host_api::InvocationId::new(),
    }
}

fn slack_declared_egress_targets(
    token_handle: EgressCredentialHandle,
) -> Result<Vec<DeclaredEgressTarget>, SlackHostBetaBuildError> {
    let host = DeclaredEgressHost::new(SLACK_API_HOST)
        .map_err(|reason| invalid_config("slack_api_host", reason.to_string()))?;
    Ok(vec![DeclaredEgressTarget::new(host, Some(token_handle))])
}

#[derive(Clone)]
pub struct SlackHostBetaActorUserResolver {
    installation_id: AdapterInstallationId,
    legacy_slack_actor: Option<ExternalActorRef>,
    legacy_user_id: UserId,
    cached_identity: Arc<dyn ProductActorUserResolver>,
    pairing: Arc<dyn ProductActorUserResolver>,
}

impl SlackHostBetaActorUserResolver {
    pub fn new(
        installation_id: AdapterInstallationId,
        legacy_slack_actor: Option<ExternalActorRef>,
        legacy_user_id: UserId,
        cached_identity: Arc<dyn ProductActorUserResolver>,
        pairing: Arc<dyn ProductActorUserResolver>,
    ) -> Self {
        Self {
            installation_id,
            legacy_slack_actor,
            legacy_user_id,
            cached_identity,
            pairing,
        }
    }

    fn resolve_legacy_static_actor(
        &self,
        request: &ProductActorUserResolutionRequest,
    ) -> Option<UserId> {
        let legacy_actor = self.legacy_slack_actor.as_ref()?;
        if request.adapter_id.as_str() == SLACK_V2_ADAPTER_ID
            && request.installation_id == self.installation_id
            && request.external_actor_ref == *legacy_actor
        {
            return Some(self.legacy_user_id.clone());
        }
        None
    }
}

impl std::fmt::Debug for SlackHostBetaActorUserResolver {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SlackHostBetaActorUserResolver(..)")
    }
}

#[async_trait::async_trait]
impl ProductActorUserResolver for SlackHostBetaActorUserResolver {
    async fn resolve_product_actor_user(
        &self,
        request: ProductActorUserResolutionRequest,
    ) -> Result<Option<UserId>, ProductWorkflowError> {
        if let Some(user_id) = self.resolve_legacy_static_actor(&request) {
            return Ok(Some(user_id));
        }
        if let Some(user_id) = self
            .cached_identity
            .resolve_product_actor_user(request.clone())
            .await?
        {
            return Ok(Some(user_id));
        }
        self.pairing.resolve_product_actor_user(request).await
    }
}

fn invalid_config(field: &'static str, reason: String) -> SlackHostBetaBuildError {
    SlackHostBetaBuildError::InvalidConfig { field, reason }
}
