//! OpenAI Chat Completions provider that preserves provider-specific reasoning.
//!
//! This provider speaks the OpenAI Chat Completions wire format directly via
//! `reqwest`. It exists because rig-core's OpenAI Completions provider drops
//! two fields that several OpenAI-compatible backends require to be echoed
//! back on subsequent turns:
//!
//! - **`reasoning_content`** on the assistant message — DeepSeek thinking-mode
//!   models (`deepseek-reasoner`, `deepseek-v4-flash`) reject the next request
//!   with `"The reasoning_content in the thinking mode must be passed back to
//!   the API"` if it is missing. (#3201)
//! - **`thought_signature`** on each `tool_calls[*].function` — Gemini exposed
//!   via the OpenAI-compat endpoint (`/v1beta/openai`) returns this on tool
//!   calls and rejects the next request with `"Function call is missing a
//!   thought_signature in functionCall parts"` when it is absent. (#3225)
//!
//! Both fields are opaque to IronClaw; the provider captures them on the
//! response and writes them back into the assistant message on the wire when
//! the same call is referenced in a later turn. No business logic interprets
//! the values.
//!
//! Other extension fields a future provider might need to round-trip can be
//! added here following the same pattern.

use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use crate::llm::costs;
use crate::llm::error::LlmError;
use crate::llm::provider::{
    ChatMessage, CompletionRequest, CompletionResponse, ContentPart, FinishReason, LlmProvider,
    Role, ToolCall, ToolCompletionRequest, ToolCompletionResponse, ToolDefinition,
    sanitize_tool_messages, strip_unsupported_completion_params, strip_unsupported_tool_params,
};
use crate::llm::tool_schema::{ToolSchemaPolicy, shape_tool_schema};

/// HTTP client timeout floor — cheap protection against the global
/// timeout being set absurdly low. The user-supplied timeout still wins
/// when above this value.
const MIN_TIMEOUT_SECS: u64 = 30;

/// OpenAI-compatible Chat Completions provider.
pub struct OpenAiCompatibleProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    model_name: String,
    input_cost: Decimal,
    output_cost: Decimal,
    /// Provider id (e.g. "gemini", "deepseek") — used in log messages and
    /// surfaced in `LlmError` so the failover/circuit-breaker layers can
    /// identify the source of an error.
    provider_id: String,
    /// Parameter names this backend rejects (`temperature`, `max_tokens`,
    /// `stop_sequences`). Stripped before serialization.
    unsupported_params: HashSet<String>,
    /// Default additional parameters merged into every request body
    /// (e.g. provider-specific `extra_body`, `reasoning_effort`).
    default_additional_params: Option<serde_json::Value>,
    /// Headers attached to every request (auth, OpenRouter attribution, etc.).
    extra_headers: HeaderMap,
}

impl OpenAiCompatibleProvider {
    /// Build a new provider.
    ///
    /// `request_timeout_secs` is the upper bound for each HTTP request. The
    /// floor is `MIN_TIMEOUT_SECS` to prevent misconfiguration from making
    /// every call fail.
    pub fn new(
        provider_id: impl Into<String>,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
        request_timeout_secs: u64,
        extra_headers: HeaderMap,
    ) -> Result<Self, LlmError> {
        let timeout = Duration::from_secs(request_timeout_secs.max(MIN_TIMEOUT_SECS));
        let provider_id_str = provider_id.into();
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| LlmError::RequestFailed {
                provider: provider_id_str.clone(),
                reason: format!("Failed to build HTTP client: {e}"),
            })?;

        let model_str = model.into();
        let (input_cost, output_cost) =
            costs::model_cost(&model_str).unwrap_or_else(costs::default_cost);

        Ok(Self {
            client,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            model_name: model_str,
            input_cost,
            output_cost,
            provider_id: provider_id_str,
            unsupported_params: HashSet::new(),
            default_additional_params: None,
            extra_headers,
        })
    }

    pub fn with_unsupported_params(mut self, params: Vec<String>) -> Self {
        self.unsupported_params = params.into_iter().collect();
        self
    }

    pub fn with_additional_params(mut self, params: serde_json::Value) -> Self {
        self.default_additional_params = Some(params);
        self
    }

    /// Build the `/chat/completions` URL.
    fn endpoint(&self) -> String {
        format!("{}/chat/completions", self.base_url)
    }

    /// Wire-level POST. Returns the parsed response or a typed `LlmError`.
    async fn post_chat_completions(
        &self,
        body: serde_json::Value,
    ) -> Result<RawChatCompletionsResponse, LlmError> {
        let mut request = self
            .client
            .post(self.endpoint())
            .bearer_auth(&self.api_key)
            .header("Content-Type", "application/json");
        if !self.extra_headers.is_empty() {
            request = request.headers(self.extra_headers.clone());
        }

        let response = request
            .json(&body)
            .send()
            .await
            .map_err(|e| LlmError::RequestFailed {
                provider: self.provider_id.clone(),
                reason: format!("HTTP send failed: {e}"),
            })?;

        let status = response.status();
        let text = response.text().await.map_err(|e| LlmError::RequestFailed {
            provider: self.provider_id.clone(),
            reason: format!("Failed to read response body: {e}"),
        })?;

        if !status.is_success() {
            return Err(map_http_error(&self.provider_id, status, &text));
        }

        serde_json::from_str::<RawChatCompletionsResponse>(&text).map_err(|e| {
            LlmError::InvalidResponse {
                provider: self.provider_id.clone(),
                reason: format!("Failed to parse response JSON: {e} body={text}"),
            }
        })
    }

    /// Convert IronClaw messages + tools + extra knobs into the OpenAI Chat
    /// Completions request body.
    #[allow(clippy::too_many_arguments)]
    fn build_request_body(
        &self,
        mut messages: Vec<ChatMessage>,
        tools: Vec<ToolDefinition>,
        tool_choice: Option<String>,
        temperature: Option<f32>,
        max_tokens: Option<u32>,
        stop_sequences: Option<Vec<String>>,
        model_override: Option<&str>,
    ) -> serde_json::Value {
        sanitize_tool_messages(&mut messages);

        let wire_messages: Vec<WireMessage> = messages.iter().map(WireMessage::from_chat).collect();
        let wire_tools: Vec<WireTool> = tools.iter().map(WireTool::from_def).collect();

        let mut body = serde_json::json!({
            "model": model_override.unwrap_or(self.model_name.as_str()),
            "messages": wire_messages,
        });

        let body_obj = body
            .as_object_mut()
            .expect("just-built JSON object is mutable");

        if !wire_tools.is_empty() {
            body_obj.insert(
                "tools".to_string(),
                serde_json::to_value(&wire_tools).unwrap_or(serde_json::Value::Null),
            );
        }
        if let Some(choice) = tool_choice {
            body_obj.insert("tool_choice".to_string(), serde_json::Value::String(choice));
        }
        if let Some(temp) = temperature {
            body_obj.insert(
                "temperature".to_string(),
                serde_json::json!(round_f32_to_f64(temp)),
            );
        }
        if let Some(mt) = max_tokens {
            body_obj.insert("max_tokens".to_string(), serde_json::json!(mt));
        }
        if let Some(stops) = stop_sequences {
            body_obj.insert("stop".to_string(), serde_json::json!(stops));
        }

        // Merge provider-default additional params last so explicit fields above
        // win on conflict.
        if let Some(defaults) = self.default_additional_params.as_ref()
            && let Some(default_obj) = defaults.as_object()
        {
            for (k, v) in default_obj {
                body_obj.entry(k).or_insert_with(|| v.clone());
            }
        }

        body
    }
}

/// Round f32 to f64 without binary-precision artifacts. Some servers (e.g.
/// Zhipu/GLM) reject `0.6999...` as out of range when the user typed `0.7`.
/// Mirrors the helper in `rig_adapter::round_f32_to_f64`.
fn round_f32_to_f64(val: f32) -> f64 {
    ((val as f64) * 1_000_000.0).round() / 1_000_000.0
}

/// Map an HTTP failure to the appropriate typed `LlmError`. The retry /
/// circuit-breaker / failover layers branch on this enum, so categorising
/// the error correctly here matters.
fn map_http_error(provider: &str, status: reqwest::StatusCode, body: &str) -> LlmError {
    let lower = body.to_ascii_lowercase();

    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return LlmError::AuthFailed {
            provider: provider.to_string(),
        };
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return LlmError::RateLimited {
            provider: provider.to_string(),
            retry_after: None,
        };
    }
    if status == reqwest::StatusCode::PAYLOAD_TOO_LARGE
        || lower.contains("context_length_exceeded")
        || lower.contains("maximum context length")
    {
        return LlmError::ContextLengthExceeded { used: 0, limit: 0 };
    }

    LlmError::RequestFailed {
        provider: provider.to_string(),
        reason: format!("HTTP {status}: {body}"),
    }
}

#[async_trait]
impl LlmProvider for OpenAiCompatibleProvider {
    fn model_name(&self) -> &str {
        &self.model_name
    }

    fn cost_per_token(&self) -> (Decimal, Decimal) {
        (self.input_cost, self.output_cost)
    }

    async fn complete(
        &self,
        mut request: CompletionRequest,
    ) -> Result<CompletionResponse, LlmError> {
        let model_override = request.take_model_override();
        strip_unsupported_completion_params(&self.unsupported_params, &mut request);

        let body = self.build_request_body(
            request.messages,
            Vec::new(),
            None,
            request.temperature,
            request.max_tokens,
            request.stop_sequences,
            model_override.as_deref(),
        );

        let response = self.post_chat_completions(body).await?;
        let choice =
            response
                .choices
                .into_iter()
                .next()
                .ok_or_else(|| LlmError::InvalidResponse {
                    provider: self.provider_id.clone(),
                    reason: "Response had no choices".to_string(),
                })?;

        let text = choice.message.content.unwrap_or_default();
        let usage = response.usage.unwrap_or_default();

        Ok(CompletionResponse {
            content: text,
            input_tokens: usage.prompt_tokens.unwrap_or(0),
            output_tokens: usage.completion_tokens.unwrap_or(0),
            finish_reason: parse_finish_reason(choice.finish_reason.as_deref(), false),
            cache_read_input_tokens: usage
                .prompt_tokens_details
                .as_ref()
                .and_then(|d| d.cached_tokens)
                .unwrap_or(0),
            cache_creation_input_tokens: 0,
        })
    }

    async fn complete_with_tools(
        &self,
        mut request: ToolCompletionRequest,
    ) -> Result<ToolCompletionResponse, LlmError> {
        let model_override = request.take_model_override();
        strip_unsupported_tool_params(&self.unsupported_params, &mut request);

        let body = self.build_request_body(
            request.messages,
            request.tools,
            request.tool_choice,
            request.temperature,
            request.max_tokens,
            request.stop_sequences,
            model_override.as_deref(),
        );

        let response = self.post_chat_completions(body).await?;
        let choice =
            response
                .choices
                .into_iter()
                .next()
                .ok_or_else(|| LlmError::InvalidResponse {
                    provider: self.provider_id.clone(),
                    reason: "Response had no choices".to_string(),
                })?;

        let WireAssistantMessage {
            content,
            tool_calls: wire_tool_calls,
            reasoning_content,
        } = choice.message;

        let tool_calls: Vec<ToolCall> = wire_tool_calls
            .unwrap_or_default()
            .into_iter()
            .map(WireToolCall::into_tool_call)
            .collect();

        let has_tool_calls = !tool_calls.is_empty();
        let usage = response.usage.unwrap_or_default();

        Ok(ToolCompletionResponse {
            content,
            tool_calls,
            input_tokens: usage.prompt_tokens.unwrap_or(0),
            output_tokens: usage.completion_tokens.unwrap_or(0),
            finish_reason: parse_finish_reason(choice.finish_reason.as_deref(), has_tool_calls),
            cache_read_input_tokens: usage
                .prompt_tokens_details
                .as_ref()
                .and_then(|d| d.cached_tokens)
                .unwrap_or(0),
            cache_creation_input_tokens: 0,
            reasoning_content,
        })
    }

    fn active_model_name(&self) -> String {
        self.model_name.clone()
    }

    fn effective_model_name(&self, _requested_model: Option<&str>) -> String {
        // Like RigAdapter, the model is baked at construction time.
        self.active_model_name()
    }

    fn set_model(&self, _model: &str) -> Result<(), LlmError> {
        Err(LlmError::RequestFailed {
            provider: self.provider_id.clone(),
            reason: "Runtime model switching not supported for OpenAiCompatibleProvider; \
                     restart with a different LLM_MODEL"
                .to_string(),
        })
    }
}

fn parse_finish_reason(reason: Option<&str>, has_tool_calls: bool) -> FinishReason {
    if has_tool_calls {
        return FinishReason::ToolUse;
    }
    match reason {
        Some("tool_calls") | Some("function_call") => FinishReason::ToolUse,
        Some("length") | Some("max_tokens") => FinishReason::Length,
        Some("content_filter") => FinishReason::ContentFilter,
        Some("stop") | Some("end_turn") | None => FinishReason::Stop,
        Some(_) => FinishReason::Unknown,
    }
}

// ── Wire types ─────────────────────────────────────────────────────────────

/// A message on the wire — what we send and what comes back. Both directions
/// share fields, but request shape only needs `role`, `content`, optionally
/// `tool_calls` / `tool_call_id` / `name`, and `reasoning_content` when
/// echoing back to the upstream provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WireMessage {
    role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<WireToolCall>>,
    /// Echoed back to providers (e.g. DeepSeek thinking mode) that require it
    /// on the assistant message in the next turn. Captured from response,
    /// rendered into request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_content: Option<String>,
}

impl WireMessage {
    fn from_chat(msg: &ChatMessage) -> Self {
        let role = match msg.role {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
        }
        .to_string();

        // Build content. For multimodal user messages, render as the OpenAI
        // content-parts array. Otherwise, send a string.
        let content = if matches!(msg.role, Role::User) && !msg.content_parts.is_empty() {
            let mut parts: Vec<serde_json::Value> = Vec::new();
            if !msg.content.is_empty() {
                parts.push(serde_json::json!({
                    "type": "text",
                    "text": msg.content,
                }));
            }
            for p in &msg.content_parts {
                if let ContentPart::ImageUrl { image_url } = p {
                    let mut image_obj = serde_json::json!({ "url": image_url.url });
                    if let Some(detail) = image_url.detail.as_deref() {
                        image_obj["detail"] = serde_json::Value::String(detail.to_string());
                    }
                    parts.push(serde_json::json!({
                        "type": "image_url",
                        "image_url": image_obj,
                    }));
                }
            }
            Some(serde_json::Value::Array(parts))
        } else if msg.content.is_empty() && msg.tool_calls.as_ref().is_some_and(|c| !c.is_empty()) {
            // Assistant messages with tool_calls and no text content: omit
            // the content field entirely. Some providers reject `content: ""`.
            None
        } else {
            Some(serde_json::Value::String(msg.content.clone()))
        };

        let tool_calls = msg
            .tool_calls
            .as_ref()
            .filter(|c| !c.is_empty())
            .map(|calls| calls.iter().map(WireToolCall::from_tool_call).collect());

        Self {
            role,
            content,
            tool_call_id: msg.tool_call_id.clone(),
            name: msg.name.clone(),
            tool_calls,
            reasoning_content: msg.reasoning_content.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WireToolCall {
    id: String,
    #[serde(rename = "type", default = "default_tool_type")]
    call_type: String,
    function: WireToolFunction,
}

fn default_tool_type() -> String {
    "function".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WireToolFunction {
    name: String,
    /// OpenAI Chat Completions encodes `arguments` as a JSON-encoded *string*
    /// — not a JSON object. We serialize/deserialize accordingly.
    arguments: String,
    /// Gemini's `thought_signature` rides on the function payload via the
    /// OpenAI-compat endpoint. Captured on response, sent back on next turn.
    /// Other providers ignore unknown fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thought_signature: Option<String>,
}

impl WireToolCall {
    fn from_tool_call(tc: &ToolCall) -> Self {
        Self {
            id: tc.id.clone(),
            call_type: "function".to_string(),
            function: WireToolFunction {
                name: tc.name.clone(),
                arguments: serde_json::to_string(&tc.arguments)
                    .unwrap_or_else(|_| "{}".to_string()),
                thought_signature: tc.signature.clone(),
            },
        }
    }

    fn into_tool_call(self) -> ToolCall {
        // Arguments come as a JSON string; parse to Value, falling back to
        // an empty object if the model produced something unparseable.
        let arguments: serde_json::Value = serde_json::from_str(&self.function.arguments)
            .unwrap_or_else(|_| serde_json::json!({}));
        ToolCall {
            id: self.id,
            name: self.function.name,
            arguments,
            reasoning: None,
            signature: self.function.thought_signature,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct WireTool {
    #[serde(rename = "type")]
    tool_type: String,
    function: WireToolDef,
}

#[derive(Debug, Clone, Serialize)]
struct WireToolDef {
    name: String,
    description: String,
    parameters: serde_json::Value,
}

impl WireTool {
    fn from_def(td: &ToolDefinition) -> Self {
        let mut description = td.description.clone();
        let parameters = shape_tool_schema(
            ToolSchemaPolicy::StrictOpenAi,
            &td.parameters,
            &mut description,
        );
        Self {
            tool_type: "function".to_string(),
            function: WireToolDef {
                name: td.name.clone(),
                description,
                parameters,
            },
        }
    }
}

// ── Wire response types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
struct RawChatCompletionsResponse {
    choices: Vec<WireChoice>,
    #[serde(default)]
    usage: Option<WireUsage>,
}

#[derive(Debug, Clone, Deserialize)]
struct WireChoice {
    message: WireAssistantMessage,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct WireAssistantMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<WireToolCall>>,
    /// DeepSeek (and other providers in thinking mode) emit this on the
    /// assistant message. Captured here and surfaced to the caller via
    /// `ToolCompletionResponse.reasoning_content` so the next turn can echo it.
    #[serde(default)]
    reasoning_content: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct WireUsage {
    #[serde(default)]
    prompt_tokens: Option<u32>,
    #[serde(default)]
    completion_tokens: Option<u32>,
    #[serde(default)]
    prompt_tokens_details: Option<WirePromptTokensDetails>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct WirePromptTokensDetails {
    #[serde(default)]
    cached_tokens: Option<u32>,
}

/// Convenience builder used by `mod.rs` registry path.
///
/// Wraps `OpenAiCompatibleProvider::new` with a pre-built `HeaderMap`.
pub fn build_extra_headers(headers: &[(String, String)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (k, v) in headers {
        let name = match HeaderName::from_bytes(k.as_bytes()) {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(header = %k, error = %e, "Skipping extra header: invalid name");
                continue;
            }
        };
        let value = match HeaderValue::from_str(v) {
            Ok(val) => val,
            Err(e) => {
                tracing::warn!(header = %k, error = %e, "Skipping extra header: invalid value");
                continue;
            }
        };
        map.insert(name, value);
    }
    map
}

/// Helper to construct an `Arc<dyn LlmProvider>` for use in the registry path.
#[allow(clippy::too_many_arguments)]
pub fn create_provider(
    provider_id: impl Into<String>,
    base_url: impl Into<String>,
    api_key: impl Into<String>,
    model: impl Into<String>,
    request_timeout_secs: u64,
    extra_headers: HeaderMap,
    unsupported_params: Vec<String>,
    additional_params: Option<serde_json::Value>,
) -> Result<Arc<dyn LlmProvider>, LlmError> {
    let mut provider = OpenAiCompatibleProvider::new(
        provider_id,
        base_url,
        api_key,
        model,
        request_timeout_secs,
        extra_headers,
    )?
    .with_unsupported_params(unsupported_params);
    if let Some(params) = additional_params {
        provider = provider.with_additional_params(params);
    }
    Ok(Arc::new(provider))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> OpenAiCompatibleProvider {
        OpenAiCompatibleProvider::new(
            "test-provider",
            "https://example.test/v1",
            "test-key",
            "test-model",
            120,
            HeaderMap::new(),
        )
        .expect("provider construction")
    }

    #[test]
    fn round_f32_avoids_binary_precision_artifacts() {
        // Direct cast produces 0.6999999... — that has shipped breakage on
        // strict OpenAI-compat servers. Round to 6 decimals.
        assert_eq!(round_f32_to_f64(0.7_f32), 0.7_f64);
        assert_eq!(round_f32_to_f64(0.0_f32), 0.0_f64);
        assert_eq!(round_f32_to_f64(1.5_f32), 1.5_f64);
    }

    #[test]
    fn map_http_error_classifies_auth_and_rate_limit() {
        let auth = map_http_error("p", reqwest::StatusCode::UNAUTHORIZED, "no key");
        assert!(matches!(auth, LlmError::AuthFailed { .. }));
        let forbidden = map_http_error("p", reqwest::StatusCode::FORBIDDEN, "no perms");
        assert!(matches!(forbidden, LlmError::AuthFailed { .. }));
        let rate = map_http_error("p", reqwest::StatusCode::TOO_MANY_REQUESTS, "slow down");
        assert!(matches!(rate, LlmError::RateLimited { .. }));
    }

    #[test]
    fn map_http_error_detects_context_overflow_in_body() {
        let body = "{\"error\":\"context_length_exceeded\"}";
        let err = map_http_error("p", reqwest::StatusCode::BAD_REQUEST, body);
        assert!(matches!(err, LlmError::ContextLengthExceeded { .. }));
    }

    #[test]
    fn parse_finish_reason_uses_tool_calls_signal() {
        // When the provider returned tool calls but finish_reason is anything,
        // we surface ToolUse so the agent dispatches accordingly.
        assert_eq!(
            parse_finish_reason(Some("stop"), true),
            FinishReason::ToolUse
        );
        assert_eq!(
            parse_finish_reason(Some("length"), false),
            FinishReason::Length
        );
        assert_eq!(
            parse_finish_reason(Some("content_filter"), false),
            FinishReason::ContentFilter
        );
        assert_eq!(parse_finish_reason(None, false), FinishReason::Stop);
    }

    /// Regression for #3201 — DeepSeek requires `reasoning_content` to be
    /// echoed back on the assistant message in the next turn. The wire
    /// converter must serialize it when present.
    #[test]
    fn reasoning_content_is_serialized_on_assistant_messages() {
        let mut msg = ChatMessage::assistant("final answer");
        msg.reasoning_content = Some("step 1: think; step 2: respond".to_string());

        let wire = WireMessage::from_chat(&msg);
        let json = serde_json::to_value(&wire).unwrap();

        assert_eq!(
            json["reasoning_content"].as_str(),
            Some("step 1: think; step 2: respond"),
            "reasoning_content must round-trip onto the wire: {json}"
        );
    }

    /// Regression for #3201 — when `reasoning_content` is None, do NOT emit
    /// the field. (Some providers reject unknown null fields.)
    #[test]
    fn reasoning_content_is_omitted_when_none() {
        let msg = ChatMessage::assistant("hello");
        let json = serde_json::to_value(WireMessage::from_chat(&msg)).unwrap();
        assert!(
            json.get("reasoning_content").is_none(),
            "reasoning_content must be omitted when None: {json}"
        );
    }

    /// Regression for #3225 — Gemini's `thought_signature` must round-trip
    /// on each tool call. Capture from response, echo on next request.
    #[test]
    fn tool_call_signature_round_trips_through_wire_format() {
        let tc = ToolCall {
            id: "call_1".to_string(),
            name: "tool_search".to_string(),
            arguments: serde_json::json!({"query": "telegram"}),
            reasoning: None,
            signature: Some("opaque-sig-bytes".to_string()),
        };

        let wire = WireToolCall::from_tool_call(&tc);
        let json = serde_json::to_value(&wire).unwrap();
        assert_eq!(
            json["function"]["thought_signature"].as_str(),
            Some("opaque-sig-bytes"),
            "signature must serialize as thought_signature on the function payload: {json}"
        );

        // Now decode it back and verify the field comes through.
        let decoded: WireToolCall = serde_json::from_value(json).unwrap();
        let restored = decoded.into_tool_call();
        assert_eq!(restored.signature.as_deref(), Some("opaque-sig-bytes"));
    }

    /// Capture-side regression for #3225: when a Gemini OpenAI-compat
    /// response contains a `thought_signature` on a returned tool call,
    /// `WireToolCall::into_tool_call` must lift it onto `ToolCall.signature`
    /// so the agent can echo it back on the next request.
    #[test]
    fn tool_call_signature_captured_from_response_payload() {
        let body = serde_json::json!({
            "id": "tool_abc",
            "type": "function",
            "function": {
                "name": "tool_search",
                "arguments": "{\"q\":\"x\"}",
                "thought_signature": "captured-sig"
            }
        });
        let wire: WireToolCall = serde_json::from_value(body).unwrap();
        let tc = wire.into_tool_call();
        assert_eq!(tc.signature.as_deref(), Some("captured-sig"));
        assert_eq!(tc.name, "tool_search");
    }

    /// Capture-side regression for #3201: when DeepSeek returns
    /// `reasoning_content` on the assistant message, `WireAssistantMessage`
    /// must surface the field through deserialization.
    #[test]
    fn assistant_reasoning_content_captured_from_response_payload() {
        let body = serde_json::json!({
            "content": "answer text",
            "reasoning_content": "thought trace here"
        });
        let msg: WireAssistantMessage = serde_json::from_value(body).unwrap();
        assert_eq!(msg.content.as_deref(), Some("answer text"));
        assert_eq!(msg.reasoning_content.as_deref(), Some("thought trace here"));
    }

    /// Caller-level coverage for the request body builder. Verifies that
    /// `tool_calls`, `reasoning_content`, and `signature` all flow into the
    /// wire payload that `complete_with_tools` will POST. This protects the
    /// integration between `build_request_body` and `WireMessage::from_chat`
    /// — a unit test on either side alone would not catch a regression that
    /// drops the round-trip data when assembling the request.
    #[test]
    fn build_request_body_carries_round_trip_extensions_for_assistant_turn() {
        let p = provider();

        let tc = ToolCall {
            id: "call_x".to_string(),
            name: "tool_search".to_string(),
            arguments: serde_json::json!({"query": "telegram"}),
            reasoning: None,
            signature: Some("gemini-sig".to_string()),
        };
        let mut asst = ChatMessage::assistant_with_tool_calls(None, vec![tc]);
        asst.reasoning_content = Some("deepseek-thoughts".to_string());

        let messages = vec![
            ChatMessage::user("find telegram setup steps"),
            asst,
            ChatMessage::tool_result("call_x", "tool_search", "no matches"),
        ];

        let body = p.build_request_body(messages, vec![], None, None, None, None, None);

        let wire_msgs = body["messages"].as_array().expect("messages array");
        // The assistant message is index 1 in our input — verify both fields
        // are present on the wire.
        let assistant_wire = &wire_msgs[1];
        assert_eq!(
            assistant_wire["reasoning_content"].as_str(),
            Some("deepseek-thoughts"),
            "assistant reasoning_content must carry into request body: {assistant_wire}"
        );
        let tool_call_wire = &assistant_wire["tool_calls"][0];
        assert_eq!(
            tool_call_wire["function"]["thought_signature"].as_str(),
            Some("gemini-sig"),
            "tool call signature must carry into request body: {tool_call_wire}"
        );
    }

    /// `tool_choice` must be passed through verbatim when supplied. Strict
    /// OpenAI-compat servers reject the field if it shows up as anything
    /// other than the supported strings.
    #[test]
    fn build_request_body_passes_tool_choice() {
        let p = provider();
        let body = p.build_request_body(
            vec![ChatMessage::user("hi")],
            vec![],
            Some("required".to_string()),
            None,
            None,
            None,
            None,
        );
        assert_eq!(body["tool_choice"].as_str(), Some("required"));
    }

    /// Provider-level default `additional_params` get merged but never
    /// overwrite explicit fields. This protects providers like Ollama
    /// (`think: true`) and OpenRouter from clobbering temperature/model.
    #[test]
    fn build_request_body_merges_default_additional_params_without_override() {
        let p = OpenAiCompatibleProvider::new(
            "test",
            "https://example.test/v1",
            "k",
            "real-model",
            120,
            HeaderMap::new(),
        )
        .unwrap()
        .with_additional_params(serde_json::json!({
            "model": "should-not-clobber",
            "reasoning_effort": "low",
        }));

        let body = p.build_request_body(
            vec![ChatMessage::user("hi")],
            vec![],
            None,
            None,
            None,
            None,
            None,
        );

        assert_eq!(
            body["model"].as_str(),
            Some("real-model"),
            "explicit model must not be overridden by default additional params"
        );
        assert_eq!(body["reasoning_effort"].as_str(), Some("low"));
    }
}
