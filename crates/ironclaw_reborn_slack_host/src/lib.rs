#![forbid(unsafe_code)]

//! Reborn-native Slack host-beta route cluster.
//!
//! Owns the Slack host-beta product route surface extracted from
//! `ironclaw_reborn_composition`: Slack Events ingress, channel route
//! administration, personal binding/pairing, durable Slack host state,
//! Slack egress, outbound target discovery, and behavior-preserving mount
//! builders. Composition supplies runtime handles and re-exports this facade.
//!
//! This crate exposes route mounts/descriptors only. Host composition remains
//! responsible for binding listeners and serving HTTP.

mod slack_actor_identity;
mod slack_channel_routes;
mod slack_delivery;
mod slack_dm_open;
mod slack_egress;
mod slack_host_beta;
mod slack_host_state;
mod slack_outbound_targets;
mod slack_pairing_notifier;
mod slack_personal_binding;
mod slack_personal_binding_pairing;
mod slack_personal_binding_pairing_serve;
mod slack_personal_binding_serve;
mod slack_serve;

pub use ironclaw_reborn_product_auth::{AuthChallengeProvider, AuthChallengeView};
pub use slack_actor_identity::{
    RebornUserIdentityLookup, RebornUserIdentityLookupError, SlackUserIdentityActorResolver,
    slack_user_identity_provider_user_id,
};
pub use slack_channel_routes::{
    InMemorySlackChannelRouteStore, SlackChannelRoute, SlackChannelRouteAdminRouteConfig,
    SlackChannelRouteAssignment, SlackChannelRouteError, SlackChannelRouteKey,
    SlackChannelRouteListPage, SlackChannelRouteStore, WEBUI_V2_CHANNELS_SLACK_ALLOWED_PATH,
    WEBUI_V2_CHANNELS_SLACK_ROUTES_PATH, WEBUI_V2_CHANNELS_SLACK_SUBJECTS_PATH,
    slack_channel_route_admin_route_mount,
};
pub use slack_delivery::{
    SlackFinalReplyDeliveryObserver, SlackFinalReplyDeliveryServices,
    SlackFinalReplyDeliverySettings,
};
pub use slack_egress::{
    SlackEgressCredential, SlackEgressCredentialError, SlackEgressCredentialProvider,
    SlackProtocolHttpEgress, StaticSlackEgressCredentialProvider,
};
pub use slack_host_beta::{
    SLACK_SIGNATURE_HEADER, SLACK_TIMESTAMP_HEADER, SlackHostBetaActorUserResolver,
    SlackHostBetaBuildError, SlackHostBetaChannelRoute, SlackHostBetaConfig,
    SlackHostBetaConfigInput, SlackHostBetaMounts, SlackHostRuntimeHandles,
    build_slack_events_route_mount_with_actor_user_resolver_with_handles,
    build_slack_events_route_mount_with_handles, build_slack_host_beta_mounts_with_handles,
    slack_bot_token_handle, slack_egress_scope_template, slack_protocol_egress_with_handles,
};
pub use slack_host_state::FilesystemSlackHostState;
pub use slack_outbound_targets::{
    InMemorySlackPersonalDmTargetStore, SLACK_OUTBOUND_TARGET_LIST_PAGE_SIZE,
    SlackConfiguredChannelRoute, SlackHostBetaOutboundTargetProvider,
    SlackOutboundTargetProviderConfig, SlackPersonalDmTarget, SlackPersonalDmTargetError,
    SlackPersonalDmTargetKey, SlackPersonalDmTargetProvisioner, SlackPersonalDmTargetStore,
    slack_reply_target_binding_ref_from_raw, slack_shared_channel_reply_target_binding_ref,
};
pub use slack_personal_binding::{
    RebornIdentityProviderId, RebornIdentityProviderUserId, RebornUserIdentityBinding,
    RebornUserIdentityBindingError, RebornUserIdentityBindingStore,
    SlackPersonalBindingInstallation, SlackPersonalBindingPrincipal, SlackPersonalUserBindingError,
    SlackPersonalUserBindingRequest, SlackPersonalUserBindingService,
};
pub use slack_personal_binding_pairing::{
    IssuedSlackPersonalBindingPairingChallenge, SlackPairingActorResolver,
    SlackPersonalBindingPairingChallenge, SlackPersonalBindingPairingChallengeStore,
    SlackPersonalBindingPairingCode, SlackPersonalBindingPairingError,
    SlackPersonalBindingPairingNotification, SlackPersonalBindingPairingNotifier,
    SlackPersonalBindingPairingService,
};
pub use slack_personal_binding_pairing_serve::{
    SlackPersonalBindingPairingRedeemResponse, SlackPersonalBindingPairingRouteConfig,
    WEBUI_V2_EXTENSION_PAIRING_REDEEM_PATH, slack_personal_binding_pairing_route_mount,
};
pub use slack_personal_binding_serve::{
    SLACK_PERSONAL_BINDING_OAUTH_CALLBACK_PATH, SLACK_PERSONAL_BINDING_OAUTH_START_PATH,
    SlackPersonalBindingAuthorizationUrl, SlackPersonalBindingOAuthClient,
    SlackPersonalBindingOAuthError, SlackPersonalBindingOAuthIdentity,
    SlackPersonalBindingRouteConfig, SlackPersonalBindingRouteConfigError,
    SlackPersonalBindingRouteMount, SlackPersonalBindingRouteState,
    SlackPersonalBindingStartResponse, slack_personal_binding_route_mount,
};
pub use slack_serve::{
    ResolvedSlackIngress, ResolvedSlackInstallation, SLACK_EVENTS_PATH, SlackApiAppId,
    SlackChannelId, SlackEnterpriseId, SlackEnvelopeMetadata, SlackEventsRouteState,
    SlackEventsWebhookDispatcher, SlackIngressError, SlackInstallationRateLimitConfig,
    SlackInstallationRateLimiter, SlackInstallationRecord, SlackInstallationResolver,
    SlackInstallationSelector, SlackTeamId, SlackUserId, StaticSlackInstallationResolver,
    slack_events_route_descriptors, slack_events_route_mount,
};
