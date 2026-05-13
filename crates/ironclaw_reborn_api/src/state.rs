//! `ApiServices` — the dependency-injection bundle consumer surfaces use.
//
// TODO(reborn-api): full state trait + concrete bundle lands in a follow-up
// commit by a dedicated agent.

use std::sync::Arc;

use ironclaw_product_workflow::IdempotencyLedger;

use crate::auth::CallerAuthenticator;

/// The minimal service bundle a Reborn-API consumer surface needs. Concrete
/// product surfaces (WebChat v2, OpenAI-compat) extend this with their own
/// trait + state struct that holds the additional services they need
/// (`ProductWorkflow`, `EventStreamManager`, `OutboundPolicyService`, etc.).
#[derive(Clone)]
pub struct ApiServices {
    pub authenticator: Arc<dyn CallerAuthenticator>,
    pub idempotency_ledger: Arc<dyn IdempotencyLedger>,
}

/// Marker trait for state that can produce an [`ApiServices`] bundle.
/// Consumer crates implement this on their per-surface state struct so the
/// shared middleware (auth, idempotency, error mapping) can extract its
/// dependencies without knowing the concrete state type.
pub trait ApiState: Clone + Send + Sync + 'static {
    fn api_services(&self) -> &ApiServices;
}
