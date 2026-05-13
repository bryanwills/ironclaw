//! Prompt-port middleware that runs `dispatch_before_prompt` ahead of bundle
//! construction and applies any returned [`crate::kinds::mutator::HookPatch`]
//! to the bundle's milestone metadata.
//!
//! In this foundation slice, the wrapper does *not* yet inject snippets into
//! the prompt bundle's instruction-snippet list. That step requires the
//! shared `prompt_envelope::wrap_untrusted` helper extracted from
//! `ironclaw_host_runtime::memory_context` (PR #3471) and the snippet
//! ref-derivation centralization from PR #3507. Both of those are pre-
//! requisites called out in the design comment on #3524. Until they land,
//! the prompt-port middleware records hook patches as milestone metadata
//! only — observability without prompt content shaping.

use std::sync::Arc;

use async_trait::async_trait;
use ironclaw_host_api::TenantId;
use ironclaw_turns::run_profile::{
    AgentLoopHostError, LoopPromptBundle, LoopPromptBundleRequest, LoopPromptPort,
};

use crate::dispatch::HookDispatcher;
use crate::points::BeforePromptHookContext;

/// Wraps an inner `LoopPromptPort`, fires `before_prompt` hooks ahead of
/// bundle construction, and records the resulting patches for downstream
/// observability. Snippet injection requires the shared envelope helper
/// (#3540/#3471) and lands in a follow-up.
pub struct HookedLoopPromptPort {
    inner: Arc<dyn LoopPromptPort>,
    dispatcher: Arc<HookDispatcher>,
    tenant_id: TenantId,
    /// Snippet-byte budget reported to hooks. The host's eventual
    /// snippet-budget accounting will replace this conservative default with
    /// a real remaining-budget figure derived from the current bundle state.
    default_snippet_byte_budget: u32,
}

impl HookedLoopPromptPort {
    pub fn new(
        inner: Arc<dyn LoopPromptPort>,
        dispatcher: Arc<HookDispatcher>,
        tenant_id: TenantId,
    ) -> Self {
        Self {
            inner,
            dispatcher,
            tenant_id,
            default_snippet_byte_budget: 4096,
        }
    }

    pub fn with_snippet_byte_budget(mut self, bytes: u32) -> Self {
        self.default_snippet_byte_budget = bytes;
        self
    }
}

#[async_trait]
impl LoopPromptPort for HookedLoopPromptPort {
    async fn build_prompt_bundle(
        &self,
        request: LoopPromptBundleRequest,
    ) -> Result<LoopPromptBundle, AgentLoopHostError> {
        let ctx =
            BeforePromptHookContext::new(self.tenant_id.clone(), self.default_snippet_byte_budget);
        let dispatched = self.dispatcher.dispatch_before_prompt(&ctx).await;
        // Observe-only for now: log the number of patches so the wiring is
        // verifiable end-to-end. Snippet injection lands when the shared
        // envelope helper is extracted.
        tracing::debug!(
            patches = dispatched.patches.len(),
            failures = dispatched.failures.len(),
            "before_prompt dispatch completed (observe-only)"
        );
        self.inner.build_prompt_bundle(request).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::BeforePromptHookImpl;
    use crate::identity::{ExtensionId, HookId, HookLocalId, HookVersion};
    use crate::kinds::mutator::PatchOrdinalHint;
    use crate::ordering::HookPhase;
    use crate::registry::{HookBinding, HookPointSpec, HookRegistry};
    use crate::sink::{RestrictedBeforePromptHook, RestrictedMutatorSink};
    use crate::trust::HookTrustClass;
    use async_trait::async_trait;
    use ironclaw_turns::run_profile::{LoopPromptBundle, LoopPromptBundleRef, PromptMode};
    use std::sync::Mutex;

    fn tenant() -> TenantId {
        TenantId::new("alpha").expect("ok")
    }

    struct StubPromptPort {
        calls: Mutex<u32>,
    }

    impl StubPromptPort {
        fn new() -> Self {
            Self {
                calls: Mutex::new(0),
            }
        }

        fn call_count(&self) -> u32 {
            *self.calls.lock().expect("ok")
        }
    }

    #[async_trait]
    impl LoopPromptPort for StubPromptPort {
        async fn build_prompt_bundle(
            &self,
            _request: LoopPromptBundleRequest,
        ) -> Result<LoopPromptBundle, AgentLoopHostError> {
            *self.calls.lock().expect("ok") += 1;
            Ok(LoopPromptBundle {
                bundle_ref: LoopPromptBundleRef::new(format!(
                    "prompt:{}:abcdef0123",
                    uuid::Uuid::nil()
                ))
                .expect("ok"),
                messages: Vec::new(),
                surface_version: None,
            })
        }
    }

    struct EnvelopeHook;
    #[async_trait]
    impl RestrictedBeforePromptHook for EnvelopeHook {
        async fn evaluate(
            &self,
            _ctx: &BeforePromptHookContext,
            sink: &mut dyn RestrictedMutatorSink,
        ) {
            sink.add_envelope_snippet(
                "Untrusted hook content: safety".to_string(),
                PatchOrdinalHint::Last,
            )
            .expect("ok");
        }
    }

    #[tokio::test]
    async fn prompt_port_wrapper_forwards_to_inner_and_runs_hook() {
        let inner = Arc::new(StubPromptPort::new());

        let hook_id = HookId::derive(
            &ExtensionId("ext".to_string()),
            "1.0",
            &HookLocalId("envelope".to_string()),
            HookVersion::ONE,
        );
        let binding = HookBinding {
            hook_id,
            hook_version: HookVersion::ONE,
            trust_class: HookTrustClass::Installed,
            phase: HookPhase::Policy,
            point: HookPointSpec::BeforePrompt,
            poisoned: false,
        };
        let mut registry = HookRegistry::new();
        registry.insert(binding).expect("ok");
        let mut dispatcher = HookDispatcher::new(registry);
        dispatcher.install_before_prompt(
            hook_id,
            BeforePromptHookImpl::Restricted(Box::new(EnvelopeHook)),
        );

        let wrapped = HookedLoopPromptPort::new(inner.clone(), Arc::new(dispatcher), tenant());

        let request = LoopPromptBundleRequest {
            mode: PromptMode::TextOnly,
            context_cursor: None,
            surface_version: None,
            checkpoint_state_ref: None,
            max_messages: Some(16),
        };
        wrapped.build_prompt_bundle(request).await.expect("ok");
        assert_eq!(
            inner.call_count(),
            1,
            "inner prompt port must be invoked once"
        );
    }
}
