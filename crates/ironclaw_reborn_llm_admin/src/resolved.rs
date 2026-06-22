#[derive(Debug, Clone)]
pub struct ResolvedRebornLlm {
    provider_id: String,
    model: String,
    config: ironclaw_llm::LlmConfig,
}

impl ResolvedRebornLlm {
    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn config(&self) -> &ironclaw_llm::LlmConfig {
        &self.config
    }

    pub fn into_llm_config(self) -> ironclaw_llm::LlmConfig {
        self.config
    }

    pub fn from_llm_config(config: ironclaw_llm::LlmConfig) -> Self {
        Self {
            provider_id: config.active_provider_id(),
            model: config.active_model_name(),
            config,
        }
    }
}
