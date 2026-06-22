#![forbid(unsafe_code)]

//! Reborn-native product/OAuth auth cluster.
//!
//! Owns the product-auth composition vocabulary extracted from
//! `ironclaw_reborn_composition`:
//!
//! - durable filesystem-backed auth-product services
//!   ([`product_auth_durable`]),
//! - the OAuth provider client cluster (host provider client, DCR + gate
//!   providers, provider composition),
//! - the manual-token flow and runtime-credential selection services,
//! - composition-time OAuth backend config vocabulary ([`config`]),
//! - and (under `webui-v2-beta`) the WebUI-mounted product-auth HTTP
//!   route surface ([`product_auth_serve`]).
//!
//! Composition depends on this crate and re-exports the public facade
//! surface, so existing downstream paths
//! (`ironclaw_reborn_composition::OAuthClientConfig`,
//! `::RebornProductAuthServices`, …) are preserved. This crate exposes
//! `Router`s / `IngressRouteDescriptor`s only; it never binds a listener
//! (the `reborn_product_api_crates_do_not_bind_http_ingress` contract).

mod auth;
mod auth_prompt;
mod config;
mod error;
mod google_oauth;
mod manual_token_flow;
mod notion_oauth;
mod oauth_dcr;
mod oauth_dcr_protocol;
mod oauth_gate;
mod oauth_provider_client;
mod product_auth_durable;
mod product_auth_providers;
mod product_auth_runtime_credentials;
#[cfg(feature = "webui-v2-beta")]
mod product_auth_serve;

#[cfg(test)]
mod auth_dcr_tests;

pub use auth::{
    RebornAuthContinuationDispatcher, RebornAuthProductError, RebornCredentialLifecycleError,
    RebornManualTokenChallenge, RebornManualTokenError, RebornManualTokenSetupRequest,
    RebornManualTokenSubmitRequest, RebornManualTokenSubmitResponse, RebornOAuthCallbackError,
    RebornOAuthCallbackOutcome, RebornOAuthCallbackRequest, RebornOAuthCallbackResponse,
    RebornProductAuthServicePorts, RebornProductAuthServices,
};
pub use auth_prompt::{
    AuthChallengeProvider, AuthChallengeView, auth_prompt_view_for_blocked_auth,
};
pub use config::{OAuthClientConfig, OAuthDcrProviderBackendConfig, OAuthProviderBackendConfig};
pub use error::OAuthProviderCompositionError;
pub use google_oauth::google_provider_spec;
pub use notion_oauth::{NOTION_PROVIDER_ID, notion_provider_spec};
pub use oauth_dcr::{OAuthDcrProvider, OAuthDcrProviderConfig, OAuthDcrProviderRegistry};
pub use oauth_gate::{
    GoogleOAuthGateProvider, GoogleOAuthGateProviderRegistry, OAuthGateChallengeRequest,
};
pub use oauth_provider_client::{HostOAuthProviderClient, HostOAuthProviderSpec};
pub use product_auth_durable::{FilesystemAuthProductServices, UnavailableAuthProviderClient};
pub use product_auth_providers::{OAuthProviderComposition, compose_provider_client};
pub use product_auth_runtime_credentials::{
    ProductAuthRuntimeCredentialResolver, RuntimeCredentialAccountSelectionRequest,
};
#[cfg(feature = "webui-v2-beta")]
pub use product_auth_serve::{
    ProductAuthRouteMount, ProductAuthRouteState, product_auth_route_mount,
};
