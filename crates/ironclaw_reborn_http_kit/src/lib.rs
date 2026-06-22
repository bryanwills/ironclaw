#![forbid(unsafe_code)]

//! Descriptor-driven HTTP serving kit for the Reborn WebChat v2 surface.
//!
//! Composes the fully-layered WebChat v2 axum `Router` — security
//! headers, CORS, panic boundary, global + per-route body limits,
//! WebSocket same-origin enforcement, bearer auth, per-route rate
//! limits — from `ironclaw_host_api::ingress::IngressRouteDescriptor`s,
//! and merges host-supplied [`ProtectedRouteMount`] /
//! [`PublicRouteMount`] route fragments into the same policy stack.
//!
//! Product route families (product-auth OAuth, Slack host surfaces,
//! OpenAI-compat, SSO login) reach the composed app exclusively through
//! the mount vocabulary on [`WebuiServeConfig`]; this crate carries no
//! product-specific routing knowledge. Host composition
//! (`ironclaw_reborn_composition`) converts product services into
//! mounts and calls [`compose_webui_v2_app`].
//!
//! Per the `reborn_product_api_crates_do_not_bind_http_ingress`
//! architecture contract, this crate exposes `Router`s and descriptors
//! only — it never binds listeners or drives the axum serve loop.

mod body_limit;
mod operator_auth;
mod rate_limit;
mod route_match;
mod serve;
mod ws_origin;

pub use rate_limit::RateLimitConfigError;
pub use serve::{
    ProtectedRouteMount, PublicRouteDrain, PublicRouteDrains, PublicRouteMount,
    WebuiAuthentication, WebuiAuthenticator, WebuiServeConfig, WebuiServeConfigError,
    WebuiServeError, WebuiV2App, compose_webui_v2_app,
};
