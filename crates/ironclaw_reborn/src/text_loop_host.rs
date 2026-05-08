//! Reborn-side text-only loop host composition.
//!
//! This module keeps the concrete Reborn loop-support wiring out of the root
//! `/src` app graph while giving callers one small factory for the context,
//! model, transcript, and empty capability ports needed by the text-only loop
//! path.

use std::sync::Arc;

use ironclaw_loop_support::{
    EmptyLoopCapabilityPort, HostManagedModelGateway, ThreadBackedLoopContextPort,
    ThreadBackedLoopModelPort, ThreadBackedLoopTranscriptPort,
};
use ironclaw_threads::{SessionThreadService, ThreadScope};
use ironclaw_turns::run_profile::{LoopHostMilestoneSink, LoopRunContext};

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

#[derive(Clone)]
pub struct TextOnlyLoopHostPorts<S, G>
where
    S: SessionThreadService + ?Sized,
    G: HostManagedModelGateway + ?Sized,
{
    pub context: ThreadBackedLoopContextPort<S>,
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
        Self {
            context: ThreadBackedLoopContextPort::new(
                Arc::clone(&thread_service),
                thread_scope.clone(),
                run_context.clone(),
                config.max_context_messages,
            ),
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
