//! Reborn-side text-only loop host composition.
//!
//! This module keeps the concrete Reborn loop-support wiring out of the root
//! `/src` app graph while giving callers one small factory for the context,
//! prompt, model, transcript, and empty capability ports needed by the text-only
//! loop path.

use std::sync::Arc;

use ironclaw_loop_support::{
    EmptyLoopCapabilityPort, HostManagedModelGateway, ThreadBackedLoopContextPort,
    ThreadBackedLoopModelPort, ThreadBackedLoopTranscriptPort,
};
use ironclaw_threads::{SessionThreadService, ThreadScope};
use ironclaw_turns::run_profile::{
    HostManagedLoopPromptPort, LoopHostMilestoneSink, LoopRunContext,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextOnlyLoopHostConfig {
    pub max_context_messages: usize,
    pub max_model_messages: usize,
}

impl Default for TextOnlyLoopHostConfig {
    fn default() -> Self {
        Self {
            max_context_messages: 16,
            max_model_messages: 16,
        }
    }
}

pub struct TextOnlyLoopHostPorts<S, G>
where
    S: SessionThreadService + ?Sized,
    G: HostManagedModelGateway + ?Sized,
{
    pub context: Arc<ThreadBackedLoopContextPort<S>>,
    pub prompt:
        HostManagedLoopPromptPort<ThreadBackedLoopContextPort<S>, dyn LoopHostMilestoneSink>,
    pub model: ThreadBackedLoopModelPort<S, G>,
    pub transcript: ThreadBackedLoopTranscriptPort<S>,
    pub capabilities: EmptyLoopCapabilityPort,
}

impl<S, G> TextOnlyLoopHostPorts<S, G>
where
    S: SessionThreadService + ?Sized,
    G: HostManagedModelGateway + ?Sized,
{
    pub fn new(
        thread_service: Arc<S>,
        thread_scope: ThreadScope,
        run_context: LoopRunContext,
        gateway: Arc<G>,
        milestone_sink: Arc<dyn LoopHostMilestoneSink>,
        config: TextOnlyLoopHostConfig,
    ) -> Self {
        let context = Arc::new(ThreadBackedLoopContextPort::new(
            Arc::clone(&thread_service),
            thread_scope.clone(),
            run_context.clone(),
            config.max_context_messages,
        ));
        let prompt = HostManagedLoopPromptPort::new(
            run_context.clone(),
            Arc::clone(&context),
            Arc::clone(&milestone_sink),
        )
        .with_default_message_limit(config.max_context_messages);
        Self {
            context,
            prompt,
            model: ThreadBackedLoopModelPort::with_milestone_sink(
                Arc::clone(&thread_service),
                thread_scope.clone(),
                run_context.clone(),
                gateway,
                config.max_model_messages,
                Arc::clone(&milestone_sink),
            ),
            transcript: ThreadBackedLoopTranscriptPort::with_milestone_sink(
                thread_service,
                thread_scope,
                run_context,
                milestone_sink,
            ),
            capabilities: EmptyLoopCapabilityPort,
        }
    }
}
