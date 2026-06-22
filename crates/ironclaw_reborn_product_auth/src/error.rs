//! Product-auth-owned composition error.
//!
//! `compose_provider_client` validates host/bootstrap-provided OAuth
//! backend configuration while building the provider client cluster.
//! Previously it returned `ironclaw_reborn_composition::RebornBuildError`,
//! which inverted the dependency direction (the product-auth cluster
//! cannot depend on the composition root). It now returns this local
//! error; composition maps it into `RebornBuildError` via a `From` impl in
//! its own `error.rs`, preserving the existing facade error surface.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum OAuthProviderCompositionError {
    #[error("invalid reborn composition configuration: {reason}")]
    InvalidConfig { reason: String },
}
