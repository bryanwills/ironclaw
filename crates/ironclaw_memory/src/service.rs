//! IronClaw memory service contract for Reborn.
//!
//! This module owns the provider-neutral, host-facing IronClaw memory
//! operation shapes and the [`MemoryService`] trait. The default native
//! adapter and its storage behavior live in the `ironclaw_memory_native`
//! provider crate.

use std::fmt;

use async_trait::async_trait;
use chrono_tz::Tz;
use ironclaw_host_api::{CorrelationId, ResourceScope};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::metadata::DocumentMetadata;

const MAX_LOCALE_LEN: usize = 35;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryInvocation {
    pub scope: ResourceScope,
    pub correlation_id: CorrelationId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryServiceSearchRequest {
    pub query: String,
    pub limit: usize,
}

impl MemoryServiceSearchRequest {
    pub fn from_tool_input(input: &Value) -> Result<Self, MemoryServiceError> {
        let query = search_query(input)?.to_string();
        let limit = optional_u64(input, "limit")?.unwrap_or(5).clamp(1, 20) as usize;
        Ok(Self { query, limit })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryServiceSearchResult {
    pub content: String,
    pub score: f32,
    pub path: String,
    pub is_hybrid_match: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryServiceSearchResponse {
    pub query: String,
    pub results: Vec<MemoryServiceSearchResult>,
}

impl MemoryServiceSearchResponse {
    pub fn result_count(&self) -> usize {
        self.results.len()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemoryServiceWriteRequest {
    pub target: String,
    pub content: String,
    pub append: bool,
    pub old_string: Option<String>,
    pub new_string: Option<String>,
    pub replace_all: bool,
    pub metadata: Option<DocumentMetadata>,
    pub timezone: Option<String>,
}

impl MemoryServiceWriteRequest {
    pub fn from_tool_input(input: &Value) -> Result<Self, MemoryServiceError> {
        // Present-but-wrong-typed fields are rejected rather than silently
        // coerced to a default — e.g. `"append": "false"` must not become a
        // write/append, and a non-string `old_string` must not turn a patch into
        // an append. A missing field (or explicit null) still takes its default.
        let target = match input.get("target") {
            None | Some(Value::Null) => "daily_log".to_string(),
            Some(Value::String(target)) => target.to_string(),
            Some(_) => return Err(MemoryServiceError::input()),
        };
        let content = match input.get("content") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(content)) => content.to_string(),
            Some(_) => return Err(MemoryServiceError::input()),
        };
        let old_string = optional_string(input, "old_string")?;
        let new_string = optional_string(input, "new_string")?;
        let append = if target == "daily_log" {
            true
        } else {
            optional_bool(input, "append")?.unwrap_or(true)
        };
        let replace_all = optional_bool(input, "replace_all")?.unwrap_or(false);
        let metadata = match input.get("metadata") {
            None | Some(Value::Null) => None,
            Some(metadata @ Value::Object(_)) => Some(
                DocumentMetadata::try_from_value(metadata)
                    .map_err(|_| MemoryServiceError::input())?,
            ),
            Some(_) => return Err(MemoryServiceError::input()),
        };
        let timezone = optional_string(input, "timezone")?;
        Ok(Self {
            target,
            content,
            append,
            old_string,
            new_string,
            replace_all,
            metadata,
            timezone,
        })
    }
}

/// Outcome class of a memory write operation.
///
/// Status of a `profile_set` operation. The native provider only ever reports
/// success (`ok`); a failed write surfaces as an error, not a status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryProfileSetStatus {
    Ok,
}

/// Serializes to exactly `"cleared"` / `"written"` / `"patched"` via serde
/// snake_case, preserving the historical wire format that previously lived in
/// a `String` status field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryWriteStatus {
    Cleared,
    Written,
    Patched,
}

impl MemoryWriteStatus {
    /// The stable wire string for this status (matches serde snake_case output).
    pub fn as_wire_str(&self) -> &'static str {
        match self {
            MemoryWriteStatus::Cleared => "cleared",
            MemoryWriteStatus::Written => "written",
            MemoryWriteStatus::Patched => "patched",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryServiceWriteResponse {
    pub status: MemoryWriteStatus,
    pub path: String,
    pub append: bool,
    pub content_length: usize,
    pub replacements: Option<usize>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryServiceReadRequest {
    pub path: String,
}

impl MemoryServiceReadRequest {
    pub fn from_tool_input(input: &Value) -> Result<Self, MemoryServiceError> {
        if input.get("version").is_some()
            || input.get("list_versions").and_then(Value::as_bool) == Some(true)
        {
            return Err(MemoryServiceError::input());
        }
        Ok(Self {
            path: required_str(input, "path")?.to_string(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryServiceReadResponse {
    pub path: String,
    pub content: String,
    pub word_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryServiceTreeRequest {
    pub path: String,
    pub depth: usize,
}

impl MemoryServiceTreeRequest {
    pub fn from_tool_input(input: &Value) -> Result<Self, MemoryServiceError> {
        // A present path must be a string; missing/null lists from the scope root.
        let path = match input.get("path") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(path)) => path.clone(),
            Some(_) => return Err(MemoryServiceError::input()),
        };
        let depth = optional_u64(input, "depth")?.unwrap_or(1).clamp(1, 10) as usize;
        Ok(Self { path, depth })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryServiceTreeResponse {
    pub entries: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryServiceProfileSetRequest {
    pub fields: Map<String, Value>,
}

impl MemoryServiceProfileSetRequest {
    pub fn from_tool_input(input: &Value) -> Result<Self, MemoryServiceError> {
        Ok(Self {
            fields: validated_profile_fields(input)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryServiceProfileSetResponse {
    pub status: MemoryProfileSetStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryServiceContextRequest {
    pub query: String,
    pub max_snippets: usize,
    pub context_profile_id: MemoryContextProfileId,
}

/// Memory-owned context profile identifier.
///
/// Flows host → provider across the memory service boundary. Free-form profile
/// id (e.g. `"default"` and the disabled-context aliases), so validation is
/// minimal: non-empty. Constructed via [`MemoryContextProfileId::new`] or wire
/// deserialization, both routed through the same `validate`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct MemoryContextProfileId(String);

impl MemoryContextProfileId {
    fn validate(value: &str) -> Result<(), MemoryServiceError> {
        if value.is_empty() {
            return Err(MemoryServiceError::input());
        }
        Ok(())
    }

    pub fn new(raw: impl Into<String>) -> Result<Self, MemoryServiceError> {
        let value = raw.into();
        Self::validate(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }
}

impl TryFrom<String> for MemoryContextProfileId {
    type Error = MemoryServiceError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::validate(&value)?;
        Ok(Self(value))
    }
}

impl AsRef<str> for MemoryContextProfileId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for MemoryContextProfileId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl From<MemoryContextProfileId> for String {
    fn from(id: MemoryContextProfileId) -> Self {
        id.0
    }
}
// Deliberately no `From<String>` / `From<&str>` — infallible conversion would
// silently bypass validation.
// Deliberately no `Deref<Target = str>` — auto-deref would let `&id` silently
// coerce to `&str`, the implicit-conversion pattern this rule prevents.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryServiceContextSnippet {
    pub snippet_ref: String,
    pub safe_summary: String,
    pub model_content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryServiceErrorKind {
    Input,
    Operation,
    Unavailable,
}

/// A memory service failure.
///
/// `kind` + `message` are the sanitized, user-/model-safe surface. `source`
/// carries the underlying backend cause (filesystem/JSON/UTF-8/CAS error) so the
/// host can log and correlate the real failure — it is never rendered into the
/// user-facing `Display`. Construct operation/unavailable failures from a backend
/// error with [`MemoryServiceError::operation_from`] /
/// [`MemoryServiceError::unavailable_from`] rather than dropping the cause.
#[derive(Debug)]
pub struct MemoryServiceError {
    kind: MemoryServiceErrorKind,
    message: &'static str,
    source: Option<Box<dyn std::error::Error + Send + Sync + 'static>>,
}

impl std::fmt::Display for MemoryServiceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "IronClaw memory {:?}: {}",
            self.kind, self.message
        )
    }
}

impl std::error::Error for MemoryServiceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|source| source.as_ref() as &(dyn std::error::Error + 'static))
    }
}

impl MemoryServiceError {
    pub fn input() -> Self {
        Self {
            kind: MemoryServiceErrorKind::Input,
            message: "invalid memory request",
            source: None,
        }
    }

    pub fn operation() -> Self {
        Self {
            kind: MemoryServiceErrorKind::Operation,
            message: "memory operation failed",
            source: None,
        }
    }

    pub fn unavailable() -> Self {
        Self {
            kind: MemoryServiceErrorKind::Unavailable,
            message: "memory provider unavailable",
            source: None,
        }
    }

    /// Operation failure that preserves the underlying backend cause for logging.
    pub fn operation_from(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self {
            kind: MemoryServiceErrorKind::Operation,
            message: "memory operation failed",
            source: Some(Box::new(source)),
        }
    }

    /// Provider-unavailable failure that preserves the underlying backend cause.
    pub fn unavailable_from(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self {
            kind: MemoryServiceErrorKind::Unavailable,
            message: "memory provider unavailable",
            source: Some(Box::new(source)),
        }
    }

    pub fn kind(&self) -> MemoryServiceErrorKind {
        self.kind
    }
}

#[async_trait]
pub trait MemoryService: Send + Sync {
    async fn search(
        &self,
        invocation: MemoryInvocation,
        request: MemoryServiceSearchRequest,
    ) -> Result<MemoryServiceSearchResponse, MemoryServiceError> {
        let _ = (invocation, request);
        Err(MemoryServiceError::unavailable())
    }

    async fn write(
        &self,
        invocation: MemoryInvocation,
        request: MemoryServiceWriteRequest,
    ) -> Result<MemoryServiceWriteResponse, MemoryServiceError> {
        let _ = (invocation, request);
        Err(MemoryServiceError::unavailable())
    }

    async fn read(
        &self,
        invocation: MemoryInvocation,
        request: MemoryServiceReadRequest,
    ) -> Result<MemoryServiceReadResponse, MemoryServiceError> {
        let _ = (invocation, request);
        Err(MemoryServiceError::unavailable())
    }

    async fn tree(
        &self,
        invocation: MemoryInvocation,
        request: MemoryServiceTreeRequest,
    ) -> Result<MemoryServiceTreeResponse, MemoryServiceError> {
        let _ = (invocation, request);
        Err(MemoryServiceError::unavailable())
    }

    async fn profile_set(
        &self,
        invocation: MemoryInvocation,
        request: MemoryServiceProfileSetRequest,
    ) -> Result<MemoryServiceProfileSetResponse, MemoryServiceError> {
        let _ = (invocation, request);
        Err(MemoryServiceError::unavailable())
    }

    async fn retrieve_context(
        &self,
        invocation: MemoryInvocation,
        request: MemoryServiceContextRequest,
    ) -> Result<Vec<MemoryServiceContextSnippet>, MemoryServiceError> {
        let _ = (invocation, request);
        Err(MemoryServiceError::unavailable())
    }
}

fn search_query(input: &Value) -> Result<&str, MemoryServiceError> {
    for key in ["query", "q", "text", "pattern"] {
        if let Some(value) = input.get(key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed);
            }
        }
    }
    Err(MemoryServiceError::input())
}

fn required_str<'a>(input: &'a Value, key: &'static str) -> Result<&'a str, MemoryServiceError> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(MemoryServiceError::input)
}

/// A present field must be a u64; missing/null takes the caller default.
fn optional_u64(input: &Value, key: &'static str) -> Result<Option<u64>, MemoryServiceError> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(MemoryServiceError::input),
    }
}

/// A present field must be a string; missing/null takes the caller default.
fn optional_string(input: &Value, key: &str) -> Result<Option<String>, MemoryServiceError> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.to_string())),
        Some(_) => Err(MemoryServiceError::input()),
    }
}

/// A present field must be a bool; missing/null takes the caller default.
fn optional_bool(input: &Value, key: &str) -> Result<Option<bool>, MemoryServiceError> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(MemoryServiceError::input()),
    }
}

fn validated_profile_fields(input: &Value) -> Result<Map<String, Value>, MemoryServiceError> {
    let obj = input.as_object().ok_or_else(MemoryServiceError::input)?;
    let mut out = Map::new();
    for (key, value) in obj {
        match key.as_str() {
            "timezone" => {
                let value = value.as_str().ok_or_else(MemoryServiceError::input)?;
                value
                    .trim()
                    .parse::<Tz>()
                    .map_err(|_| MemoryServiceError::input())?;
                out.insert("timezone".into(), json!(value.trim()));
            }
            "locale" => {
                let value = value.as_str().ok_or_else(MemoryServiceError::input)?;
                validate_locale(value)?;
                out.insert("locale".into(), json!(value));
            }
            "location" => {
                let value = value.as_str().ok_or_else(MemoryServiceError::input)?.trim();
                if value.is_empty() || value.chars().count() > 200 || value.len() > 800 {
                    return Err(MemoryServiceError::input());
                }
                out.insert("location".into(), json!(value));
            }
            _ => return Err(MemoryServiceError::input()),
        }
    }
    if out.is_empty() {
        return Err(MemoryServiceError::input());
    }
    Ok(out)
}

fn validate_locale(value: &str) -> Result<(), MemoryServiceError> {
    if value.is_empty()
        || value.chars().count() > MAX_LOCALE_LEN
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
        || value.split('-').any(str::is_empty)
    {
        return Err(MemoryServiceError::input());
    }
    Ok(())
}
