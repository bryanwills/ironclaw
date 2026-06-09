//! [`EmbeddingProvider`] trait and shared [`EmbeddingError`] type.

use async_trait::async_trait;

/// Error type for embedding operations.
#[derive(Debug, thiserror::Error)]
pub enum EmbeddingError {
    #[error("HTTP request failed: {0}")]
    HttpError(String),

    #[error("Invalid response: {0}")]
    InvalidResponse(String),

    #[error("Rate limited, retry after {retry_after:?}")]
    RateLimited {
        retry_after: Option<std::time::Duration>,
    },

    #[error("Authentication failed")]
    AuthFailed,

    #[error("Text too long: {length} > {max}")]
    TextTooLong { length: usize, max: usize },

    #[error("Invalid provider URL '{url}': {reason}")]
    InvalidUrl { url: String, reason: String },
}

impl From<reqwest::Error> for EmbeddingError {
    fn from(e: reqwest::Error) -> Self {
        EmbeddingError::HttpError(e.to_string())
    }
}

/// Trait for embedding providers.
#[async_trait]
pub trait EmbeddingProvider: Send + Sync {
    /// Get the embedding dimension.
    fn dimension(&self) -> usize;

    /// Get the model name.
    fn model_name(&self) -> &str;

    /// Provider family identifier — `"openai"`, `"nearai"`, `"ollama"`, or
    /// `"bedrock"`. Used to tailor operator-facing hints (e.g. which credential
    /// to check on an auth failure). All four production providers override
    /// this; the `"unknown"` default is only reached by test doubles and maps
    /// to the generic OpenAI-flavored hint.
    fn provider_name(&self) -> &str {
        "unknown"
    }

    /// Maximum input length in **bytes** (matches `str::len()` semantics).
    ///
    /// Provider implementations enforce this against `text.len()`, which
    /// counts UTF-8 bytes, not Unicode characters. Implementations document
    /// the byte budget for their underlying model (typically derived from a
    /// token limit; e.g. 8191 tokens ≈ 32_000 bytes for the OpenAI
    /// embedding family).
    fn max_input_length(&self) -> usize;

    /// Generate an embedding for a single text.
    async fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError>;

    /// Generate embeddings for multiple texts (batched).
    ///
    /// Default implementation calls embed() for each text.
    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        let mut embeddings = Vec::with_capacity(texts.len());
        for text in texts {
            embeddings.push(self.embed(text).await?);
        }
        Ok(embeddings)
    }
}

/// Enforce `max` (bytes) for every item in a batch.
///
/// The `embed_batch` overrides (OpenAI, NEAR AI, Ollama) issue a single
/// batched request, so — unlike the per-item `embed` path — they must validate
/// each input themselves before hitting the provider. Shared here so the three
/// overrides stay in lockstep (#3752).
pub(crate) fn ensure_batch_within_limit(
    texts: &[String],
    max: usize,
) -> Result<(), EmbeddingError> {
    for text in texts {
        if text.len() > max {
            return Err(EmbeddingError::TextTooLong {
                length: text.len(),
                max,
            });
        }
    }
    Ok(())
}
