#![forbid(unsafe_code)]

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
