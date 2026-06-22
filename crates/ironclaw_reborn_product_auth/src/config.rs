//! Composition-time OAuth provider configuration vocabulary.
//!
//! These three config types describe the host/bootstrap-provided OAuth
//! backend wiring. They were relocated out of
//! `ironclaw_reborn_composition::input` so the product-auth cluster owns
//! the vocabulary it consumes (`product_auth_providers`, `oauth_gate`)
//! without the cluster having to depend back on the composition root.
//! Composition's `RebornBuildInput` builder re-imports them from here.

use ironclaw_auth::{AuthProductError, OAuthClientId, OAuthRedirectUri};
use secrecy::SecretString;

use crate::oauth_dcr::OAuthDcrProviderConfig;
use crate::oauth_provider_client::HostOAuthProviderSpec;

/// Composition-time OAuth client metadata.
///
/// `RebornBuildInput` owns this seam for product/bootstrap-provided values
/// until a settings-backed source exists.
#[derive(Clone)]
pub struct OAuthClientConfig {
    pub client_id: OAuthClientId,
    pub client_secret: Option<SecretString>,
    pub redirect_uri: OAuthRedirectUri,
    pub hosted_domain_hint: Option<String>,
}

impl OAuthClientConfig {
    pub fn new(
        client_id: impl Into<String>,
        redirect_uri: impl Into<String>,
        client_secret: Option<SecretString>,
    ) -> Result<Self, AuthProductError> {
        Ok(Self {
            client_id: OAuthClientId::new(client_id)?,
            client_secret,
            redirect_uri: OAuthRedirectUri::new(redirect_uri)?,
            hosted_domain_hint: None,
        })
    }

    pub fn with_hosted_domain_hint(mut self, hosted_domain_hint: impl Into<String>) -> Self {
        self.hosted_domain_hint = Some(hosted_domain_hint.into());
        self
    }
}

impl std::fmt::Debug for OAuthClientConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OAuthClientConfig")
            .field("client_id", &self.client_id.as_str())
            .field(
                "client_secret",
                &self.client_secret.as_ref().map(|_| "[REDACTED]"),
            )
            .field("redirect_uri", &self.redirect_uri)
            .field(
                "hosted_domain_hint",
                &self.hosted_domain_hint.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct OAuthProviderBackendConfig {
    pub spec: HostOAuthProviderSpec,
    pub client: OAuthClientConfig,
}

#[derive(Debug, Clone)]
pub struct OAuthDcrProviderBackendConfig {
    pub config: OAuthDcrProviderConfig,
}
