use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use ironclaw_host_api::runtime_policy::{
    ApprovalPolicy, AuditMode, DeploymentMode, EffectiveRuntimePolicy, FilesystemBackendKind,
    NetworkMode, ProcessBackendKind, RuntimeProfile, SecretMode,
};
use ironclaw_host_api::{
    AgentId, CapabilityGrant, CapabilityGrantId, CapabilityId, CapabilitySet, CorrelationId,
    EffectKind, ExecutionContext, ExtensionId, GrantConstraints, InvocationId, MountPermissions,
    NetworkPolicy, Principal, ProjectId, ResourceScope, RuntimeKind, TenantId, TrustClass, UserId,
};
use ironclaw_host_runtime::{
    MEMORY_READ_CAPABILITY_ID, MEMORY_SEARCH_CAPABILITY_ID, RuntimeFailureKind,
};
use ironclaw_loop_support::{
    HostManagedModelError, HostManagedModelErrorKind, HostManagedModelGateway,
    HostManagedModelMessageRole, HostManagedModelRequest, HostManagedModelResponse,
};
use ironclaw_reborn_config::{RebornBootConfig, RebornHome, RebornProfile};
use ironclaw_trust::{AuthorityCeiling, EffectiveTrustClass, TrustDecision, TrustProvenance};
use ironclaw_turns::TurnStatus;
use ironclaw_turns::run_profile::{LoopCapabilityPort, ProviderToolCall, VisibleCapabilityRequest};
use serde_json::{Value, json};
use tokio::sync::Notify;

use crate::input::RebornBuildInput;
use crate::runtime_input::{PollSettings, RebornRuntimeIdentity, RebornRuntimeInput};

use super::build_reborn_runtime;

const TENANT_ID: &str = "learning-ws4-tenant";
const USER_ID: &str = "learning-ws4-user";
const AGENT_ID: &str = "learning-ws4-agent";
const RUNTIME_SEND_TIMEOUT: Duration = Duration::from_secs(10);
const REFLECTION_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const CORRECTION_TURN: &str = "Actually, from now on use pnpm for this repository.";
const RECALL_TURN: &str = "Which package manager should I use for this repository?";
const PACKAGE_MANAGER_KEY: &str = "package_manager";
const PACKAGE_MANAGER_PATH: &str = "keyed/preference/package_manager.md";
const PACKAGE_MANAGER_CONTENT: &str = "Use pnpm for this repository package manager.";
const REFLECTION_PROMPT_PREFIX: &str = "You are Reborn Lightweight Learning Reflection";

#[tokio::test]
async fn reflection_e2e_writes_learning_with_one_model_call_without_blocking_turn() {
    let root = tempfile::tempdir().expect("tempdir");
    let storage_root = root.path().join("local-dev");
    let gateway = Arc::new(ReflectionE2eGateway::new(true, true));
    let input = runtime_input(storage_root, gateway.clone(), true);

    let runtime = build_reborn_runtime(input).await.expect("runtime builds");
    let conversation = runtime.new_conversation().await.expect("conversation");

    let reply = send(&runtime, &conversation, CORRECTION_TURN).await;
    assert_eq!(
        reply.text.as_deref(),
        Some("Acknowledged: I will use pnpm for this repository.")
    );
    wait_for_reflection_model_call(gateway.as_ref()).await;
    assert_eq!(
        gateway.reflection_model_call_count(),
        1,
        "the turn must return after spawning exactly one held reflection model call"
    );

    gateway.release_reflection();
    let learning = wait_for_learning(&runtime).await;
    assert_reflection_learning(&learning);
    assert_eq!(
        gateway.reflection_model_call_count(),
        1,
        "reflection must use one model call and deterministic memory apply"
    );

    runtime.shutdown().await.expect("runtime shutdown");
}

#[tokio::test]
async fn reflection_e2e_recalled_learning_changes_next_turn_behavior() {
    let root = tempfile::tempdir().expect("tempdir");
    let storage_root = root.path().join("local-dev");
    let gateway = Arc::new(ReflectionE2eGateway::new(true, false));
    let input = runtime_input(storage_root, gateway.clone(), true);

    let runtime = build_reborn_runtime(input).await.expect("runtime builds");
    let conversation = runtime.new_conversation().await.expect("conversation");

    let correction = send(&runtime, &conversation, CORRECTION_TURN).await;
    assert_eq!(
        correction.text.as_deref(),
        Some("Acknowledged: I will use pnpm for this repository.")
    );
    assert_reflection_learning(&wait_for_learning(&runtime).await);

    let recall = send(&runtime, &conversation, RECALL_TURN).await;
    assert_eq!(
        recall.text.as_deref(),
        Some("Use pnpm for this repository.")
    );
    assert_eq!(
        gateway.reflection_model_call_count(),
        1,
        "the recall turn is not itself a reflection signal"
    );

    runtime.shutdown().await.expect("runtime shutdown");
}

#[tokio::test]
async fn learning_disabled_skips_reflection_model_call_and_memory_write() {
    let root = tempfile::tempdir().expect("tempdir");
    let storage_root = root.path().join("local-dev");
    let gateway = Arc::new(ReflectionE2eGateway::new(false, false));
    let input = runtime_input(storage_root, gateway.clone(), false);

    let runtime = build_reborn_runtime(input).await.expect("runtime builds");
    let conversation = runtime.new_conversation().await.expect("conversation");

    let reply = send(&runtime, &conversation, CORRECTION_TURN).await;
    assert_eq!(
        reply.text.as_deref(),
        Some("Acknowledged: I will use pnpm for this repository.")
    );

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        gateway.reflection_model_call_count(),
        0,
        "learning-disabled runtime must not construct the reflection sink"
    );
    let search = invoke_memory_json(
        &runtime,
        MEMORY_SEARCH_CAPABILITY_ID,
        json!({"query": "pnpm repository package manager", "limit": 5}),
    )
    .await
    .expect("disabled learning search");
    assert_eq!(
        search["result_count"],
        json!(0),
        "flag-off reflection path must not write learning memory"
    );

    runtime.shutdown().await.expect("runtime shutdown");
}

struct ReflectionE2eGateway {
    requests: StdMutex<Vec<HostManagedModelRequest>>,
    learning_enabled: bool,
    hold_reflection: bool,
    reflection_release: Notify,
}

impl ReflectionE2eGateway {
    fn new(learning_enabled: bool, hold_reflection: bool) -> Self {
        Self {
            requests: StdMutex::new(Vec::new()),
            learning_enabled,
            hold_reflection,
            reflection_release: Notify::new(),
        }
    }

    fn record_request(&self, request: HostManagedModelRequest) {
        self.requests
            .lock()
            .expect("reflection e2e request lock")
            .push(request);
    }

    fn recorded_requests(&self) -> Vec<HostManagedModelRequest> {
        self.requests
            .lock()
            .expect("reflection e2e request lock")
            .clone()
    }

    fn reflection_model_call_count(&self) -> usize {
        self.recorded_requests()
            .iter()
            .filter(|request| request_is_reflection_model_call(request))
            .count()
    }

    fn release_reflection(&self) {
        self.reflection_release.notify_one();
    }

    async fn reflection_response(
        &self,
        request: &HostManagedModelRequest,
    ) -> Result<HostManagedModelResponse, HostManagedModelError> {
        let reflection_input = latest_user_message(request)?;
        assert!(
            reflection_input.contains("Signal: correction_cue"),
            "reflection input should carry the deterministic correction signal: {reflection_input}"
        );
        assert!(
            reflection_input.contains(CORRECTION_TURN),
            "reflection input should include the committed correction turn: {reflection_input}"
        );

        if self.hold_reflection {
            self.reflection_release.notified().await;
        }

        Ok(HostManagedModelResponse::assistant_reply(
            json!({
                "key": PACKAGE_MANAGER_KEY,
                "category": "preference",
                "content": PACKAGE_MANAGER_CONTENT,
                "confidence": 9
            })
            .to_string(),
        ))
    }
}

#[async_trait]
impl HostManagedModelGateway for ReflectionE2eGateway {
    async fn stream_model(
        &self,
        request: HostManagedModelRequest,
    ) -> Result<HostManagedModelResponse, HostManagedModelError> {
        self.record_request(request.clone());
        if request_is_reflection_model_call(&request) {
            return self.reflection_response(&request).await;
        }
        normal_reply_without_capabilities(&request, self.learning_enabled)
    }

    async fn stream_model_with_capabilities(
        &self,
        request: HostManagedModelRequest,
        capabilities: Arc<dyn LoopCapabilityPort>,
    ) -> Result<HostManagedModelResponse, HostManagedModelError> {
        self.record_request(request.clone());
        assert_eq!(
            request_has_learning_persona(&request),
            self.learning_enabled,
            "normal turn learning persona presence must match config"
        );
        let user = latest_user_message(&request)?;
        if let Some(tool_message) = latest_tool_result_message(&request) {
            let call_id = tool_message
                .tool_result_provider_call
                .as_ref()
                .map(|provider_call| provider_call.provider_call_id.as_str());
            return normal_after_tool(
                user.as_str(),
                call_id,
                tool_message.content.as_str(),
                capabilities,
            )
            .await;
        }

        match user.as_str() {
            CORRECTION_TURN => Ok(HostManagedModelResponse::assistant_reply(
                "Acknowledged: I will use pnpm for this repository.",
            )),
            RECALL_TURN => {
                capability_response(
                    capabilities,
                    MEMORY_SEARCH_CAPABILITY_ID,
                    "reflection-search-package-manager",
                    json!({"query": "pnpm repository package manager", "limit": 5}),
                )
                .await
            }
            other => Err(model_error(format!(
                "unexpected reflection e2e user message: {other}"
            ))),
        }
    }
}

fn normal_reply_without_capabilities(
    request: &HostManagedModelRequest,
    learning_enabled: bool,
) -> Result<HostManagedModelResponse, HostManagedModelError> {
    assert_eq!(
        request_has_learning_persona(request),
        learning_enabled,
        "normal turn learning persona presence must match config"
    );
    let user = latest_user_message(request)?;
    match user.as_str() {
        CORRECTION_TURN => Ok(HostManagedModelResponse::assistant_reply(
            "Acknowledged: I will use pnpm for this repository.",
        )),
        other => Err(model_error(format!(
            "unexpected non-capability reflection e2e user message: {other}"
        ))),
    }
}

async fn normal_after_tool(
    user: &str,
    call_id: Option<&str>,
    tool_result: &str,
    capabilities: Arc<dyn LoopCapabilityPort>,
) -> Result<HostManagedModelResponse, HostManagedModelError> {
    match (user, call_id) {
        (RECALL_TURN, Some("reflection-search-package-manager")) => {
            assert!(
                tool_result.contains(PACKAGE_MANAGER_KEY),
                "search result should expose the reflected learning metadata: {tool_result}"
            );
            assert!(
                tool_result.contains(PACKAGE_MANAGER_CONTENT),
                "search result should expose the reflected learning content: {tool_result}"
            );
            capability_response(
                capabilities,
                MEMORY_READ_CAPABILITY_ID,
                "reflection-read-package-manager",
                json!({"path": PACKAGE_MANAGER_PATH}),
            )
            .await
        }
        (RECALL_TURN, Some("reflection-read-package-manager")) => {
            assert!(
                tool_result.contains(PACKAGE_MANAGER_CONTENT),
                "read result should expose the reflected learning content: {tool_result}"
            );
            assert!(
                tool_result.contains("\"source\":\"reflection\"")
                    || tool_result.contains("\"source\": \"reflection\"")
                    || tool_result.contains("source reflection"),
                "read result should expose reflection source metadata: {tool_result}"
            );
            assert!(
                tool_result.contains("\"confidence\":9")
                    || tool_result.contains("\"confidence\": 9")
                    || tool_result.contains("confidence 9"),
                "read result should expose confidence metadata: {tool_result}"
            );
            Ok(HostManagedModelResponse::assistant_reply(
                "Use pnpm for this repository.",
            ))
        }
        _ => Err(model_error(format!(
            "unexpected reflection e2e tool result for user={user:?} call_id={call_id:?}"
        ))),
    }
}

async fn wait_for_learning(runtime: &super::RebornRuntime) -> Value {
    tokio::time::timeout(REFLECTION_WRITE_TIMEOUT, async {
        loop {
            if let Ok(read) = invoke_memory_json(
                runtime,
                MEMORY_READ_CAPABILITY_ID,
                json!({"path": PACKAGE_MANAGER_PATH}),
            )
            .await
            {
                return read;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("reflection learning write should complete")
}

async fn wait_for_reflection_model_call(gateway: &ReflectionE2eGateway) {
    tokio::time::timeout(REFLECTION_WRITE_TIMEOUT, async {
        loop {
            if gateway.reflection_model_call_count() > 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("reflection model call should start");
}

fn assert_reflection_learning(learning: &Value) {
    assert_eq!(learning["path"], json!(PACKAGE_MANAGER_PATH));
    assert_eq!(learning["content"], json!(PACKAGE_MANAGER_CONTENT));
    assert_eq!(learning["key"], json!(PACKAGE_MANAGER_KEY));
    assert_eq!(learning["category"], json!("preference"));
    assert_eq!(learning["confidence"], json!(9));
    assert_eq!(learning["source"], json!("reflection"));
}

async fn capability_response(
    capabilities: Arc<dyn LoopCapabilityPort>,
    capability_id: &str,
    call_id: &str,
    arguments: Value,
) -> Result<HostManagedModelResponse, HostManagedModelError> {
    let capability_id = CapabilityId::new(capability_id).map_err(model_error)?;
    let surface = capabilities
        .visible_capabilities(VisibleCapabilityRequest)
        .await
        .map_err(model_error)?;
    assert!(
        surface
            .descriptors
            .iter()
            .any(|descriptor| descriptor.capability_id == capability_id),
        "expected capability {capability_id} to be visible"
    );
    let tool = capabilities
        .tool_definitions()
        .map_err(model_error)?
        .into_iter()
        .find(|definition| definition.capability_id == capability_id)
        .expect("provider tool definition");
    let candidate = capabilities
        .register_provider_tool_call(ProviderToolCall {
            provider_id: "test-provider".to_string(),
            provider_model_id: "test-model".to_string(),
            turn_id: Some("provider-turn".to_string()),
            id: call_id.to_string(),
            name: tool.name,
            arguments,
            response_reasoning: None,
            reasoning: None,
            signature: None,
        })
        .await
        .map_err(model_error)?;
    Ok(HostManagedModelResponse::capability_calls(
        vec![candidate],
        "",
    ))
}

async fn invoke_memory_json(
    runtime: &super::RebornRuntime,
    capability_id: &str,
    input: Value,
) -> Result<Value, RuntimeFailureKind> {
    crate::approval_test_support::invoke_json_with_local_dev_approval(
        runtime.services(),
        capability_id,
        memory_context(capability_id),
        input,
        trust_decision(),
    )
    .await
}

fn memory_context(capability_id: &str) -> ExecutionContext {
    let capability = CapabilityId::new(capability_id).expect("valid capability id");
    let extension_id = ExtensionId::new("learning-ws4-test").expect("valid extension id");
    let invocation_id = InvocationId::new();
    let tenant_id = TenantId::new(TENANT_ID).expect("valid tenant id");
    let user_id = UserId::new(USER_ID).expect("valid user id");
    let agent_id = AgentId::new(AGENT_ID).expect("valid agent id");
    let project_id: Option<ProjectId> = None;
    let memory_mounts =
        crate::local_dev_mounts::memory_mount_view(MountPermissions::read_write_list_delete())
            .expect("memory mounts");
    let resource_scope = ResourceScope {
        tenant_id: tenant_id.clone(),
        user_id: user_id.clone(),
        agent_id: Some(agent_id.clone()),
        project_id: project_id.clone(),
        mission_id: None,
        thread_id: None,
        invocation_id,
    };
    let context = ExecutionContext {
        invocation_id,
        correlation_id: CorrelationId::new(),
        process_id: None,
        parent_process_id: None,
        tenant_id,
        user_id,
        agent_id: Some(agent_id),
        project_id,
        mission_id: None,
        thread_id: None,
        extension_id: extension_id.clone(),
        runtime: RuntimeKind::FirstParty,
        trust: TrustClass::UserTrusted,
        grants: CapabilitySet {
            grants: vec![CapabilityGrant {
                id: CapabilityGrantId::new(),
                capability,
                grantee: Principal::Extension(extension_id),
                issued_by: Principal::HostRuntime,
                constraints: GrantConstraints {
                    allowed_effects: allowed_effects(),
                    mounts: memory_mounts.clone(),
                    network: NetworkPolicy::default(),
                    secrets: Vec::new(),
                    resource_ceiling: None,
                    expires_at: None,
                    max_invocations: None,
                },
            }],
        },
        mounts: memory_mounts,
        resource_scope,
    };
    context.validate().expect("valid execution context");
    context
}

fn runtime_input(
    storage_root: std::path::PathBuf,
    gateway: Arc<dyn HostManagedModelGateway>,
    learning_enabled: bool,
) -> RebornRuntimeInput {
    RebornRuntimeInput::from_services(
        RebornBuildInput::local_dev_with_profile(
            crate::RebornCompositionProfile::LocalDevYolo,
            USER_ID,
            storage_root.clone(),
        )
        .with_runtime_policy(local_yolo_runtime_policy()),
    )
    .with_identity(RebornRuntimeIdentity {
        tenant_id: TENANT_ID.to_string(),
        agent_id: AGENT_ID.to_string(),
        source_binding_id: "learning-ws4-source".to_string(),
        reply_target_binding_id: "learning-ws4-reply".to_string(),
    })
    .with_poll_settings(PollSettings {
        interval: Duration::from_millis(10),
        max_total: RUNTIME_SEND_TIMEOUT,
    })
    .with_boot_config(learning_boot(&storage_root, learning_enabled))
    .with_model_gateway_override(gateway)
}

fn local_yolo_runtime_policy() -> EffectiveRuntimePolicy {
    let mut policy =
        crate::local_dev_yolo_runtime_policy(true).expect("local-yolo policy resolves");
    policy.deployment = DeploymentMode::LocalSingleUser;
    policy.requested_profile = RuntimeProfile::LocalYolo;
    policy.resolved_profile = RuntimeProfile::LocalYolo;
    policy.filesystem_backend = FilesystemBackendKind::HostWorkspace;
    policy.process_backend = ProcessBackendKind::LocalHost;
    policy.network_mode = NetworkMode::DirectLogged;
    policy.secret_mode = SecretMode::ScrubbedEnv;
    policy.approval_policy = ApprovalPolicy::Minimal;
    policy.audit_mode = AuditMode::LocalMinimal;
    policy
}

fn learning_boot(storage_root: &std::path::Path, learning_enabled: bool) -> RebornBootConfig {
    let home = RebornHome::resolve_from_env_parts(
        Some(storage_root.as_os_str().to_os_string()),
        None,
        None,
    )
    .expect("reborn home");
    RebornBootConfig::new_with_learning_enabled(home, RebornProfile::LocalDevYolo, learning_enabled)
}

async fn send(
    runtime: &super::RebornRuntime,
    conversation: &super::ConversationId,
    text: &str,
) -> super::AssistantReply {
    let reply = tokio::time::timeout(
        RUNTIME_SEND_TIMEOUT,
        runtime.send_user_message(conversation, text),
    )
    .await
    .expect("runtime send should finish")
    .expect("runtime send should succeed");
    assert_eq!(reply.status, TurnStatus::Completed);
    reply
}

fn request_is_reflection_model_call(request: &HostManagedModelRequest) -> bool {
    request.messages.iter().any(|message| {
        message.role == HostManagedModelMessageRole::System
            && message.content.starts_with(REFLECTION_PROMPT_PREFIX)
    })
}

fn request_has_learning_persona(request: &HostManagedModelRequest) -> bool {
    request.messages.iter().any(|message| {
        message.role == HostManagedModelMessageRole::System
            && message.content.contains("Reborn Learning Persona")
    })
}

fn latest_user_message(request: &HostManagedModelRequest) -> Result<String, HostManagedModelError> {
    request
        .messages
        .iter()
        .rev()
        .find(|message| message.role == HostManagedModelMessageRole::User)
        .map(|message| message.content.clone())
        .ok_or_else(|| model_error("missing latest user message"))
}

fn latest_tool_result_message(
    request: &HostManagedModelRequest,
) -> Option<&ironclaw_loop_support::HostManagedModelMessage> {
    request
        .messages
        .last()
        .filter(|message| message.role == HostManagedModelMessageRole::ToolResult)
}

fn allowed_effects() -> Vec<EffectKind> {
    vec![
        EffectKind::DispatchCapability,
        EffectKind::ReadFilesystem,
        EffectKind::WriteFilesystem,
    ]
}

fn trust_decision() -> TrustDecision {
    TrustDecision {
        effective_trust: EffectiveTrustClass::user_trusted(),
        authority_ceiling: AuthorityCeiling {
            allowed_effects: allowed_effects(),
            max_resource_ceiling: None,
        },
        provenance: TrustProvenance::Default,
        evaluated_at: Utc::now(),
    }
}

fn model_error(error: impl std::fmt::Display) -> HostManagedModelError {
    HostManagedModelError::safe(HostManagedModelErrorKind::InvalidRequest, error.to_string())
}
