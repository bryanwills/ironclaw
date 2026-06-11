/// Failure category identifier for model provider credit exhaustion.
/// Exposed for cross-crate consumers that project this category to a user-facing message.
pub const MODEL_CREDITS_EXHAUSTED_CATEGORY: &str = "model_credits_exhausted";

/// Failure category identifier for invalid or unavailable model credentials/configuration.
/// Exposed for cross-crate consumers that project this category to a user-facing message.
pub const MODEL_CREDENTIALS_OR_CONFIG_INVALID_CATEGORY: &str =
    "model_credentials_or_config_invalid";

pub(crate) const MODEL_CREDITS_EXHAUSTED_REASON_KIND:
    ironclaw_turns::run_profile::AgentLoopHostErrorReasonKind =
    ironclaw_turns::run_profile::AgentLoopHostErrorReasonKind::ModelCreditsExhausted;
