use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use ironclaw_host_api::{AgentId, ProjectId, TenantId, ThreadId, UserId};
use ironclaw_loop_support::{
    HostManagedModelError, HostManagedModelErrorKind, HostManagedModelGateway,
    HostManagedModelRequest, HostManagedModelResponse,
};
use ironclaw_reborn::{TextOnlyLoopHostConfig, TextOnlyLoopHostPorts};
use ironclaw_threads::{
    AcceptInboundMessageRequest, EnsureThreadRequest, InMemorySessionThreadService, MessageContent,
    MessageKind, MessageStatus, SessionThreadService, ThreadHistoryRequest, ThreadScope,
};
use ironclaw_turns::{
    RunProfileResolutionRequest, RunProfileResolver, TurnId, TurnRunId, TurnScope,
    run_profile::{
        AgentLoopHostErrorKind, FinalizeAssistantMessage, InMemoryLoopHostMilestoneSink,
        InMemoryRunProfileResolver, LoopCapabilityPort, LoopContextPort, LoopContextRequest,
        LoopHostMilestone, LoopHostMilestoneKind, LoopModelMessage, LoopModelPort,
        LoopModelRequest, LoopRunContext, LoopTranscriptPort, ParentLoopOutput,
        VisibleCapabilityRequest,
    },
};

#[tokio::test]
async fn text_only_loop_host_ports_drive_model_reply_transcript_and_safe_milestones() {
    let fixture = ThreadFixture::new_with_user_content(
        "RAW_PROMPT_TEXT_SENTINEL sk-prompt-secret /host/path tool_input",
    )
    .await;
    let milestone_sink = Arc::new(InMemoryLoopHostMilestoneSink::default());
    let gateway = Arc::new(RecordingGateway::reply(
        "RAW_ASSISTANT_CONTENT_SENTINEL sk-output-secret /host/path tool_input",
    ));
    let ports = TextOnlyLoopHostPorts::new(
        Arc::clone(&fixture.thread_service),
        fixture.thread_scope.clone(),
        fixture.run_context.clone(),
        gateway.clone(),
        milestone_sink.clone(),
        TextOnlyLoopHostConfig {
            max_context_messages: 8,
            max_model_messages: 8,
        },
    );

    let surface = ports
        .capabilities
        .visible_capabilities(VisibleCapabilityRequest)
        .await
        .unwrap();
    assert!(surface.descriptors.is_empty());

    let context = ports
        .context
        .load_loop_context(LoopContextRequest {
            after: None,
            limit: 8,
        })
        .await
        .unwrap();
    assert_eq!(context.messages.len(), 1);
    assert_eq!(context.messages[0].safe_summary, "user message available");

    let model_response = ports
        .model
        .stream_model(LoopModelRequest {
            messages: context
                .messages
                .iter()
                .map(|message| LoopModelMessage {
                    role: message.role.clone(),
                    content_ref: message.message_ref.clone(),
                })
                .collect(),
            surface_version: None,
            model_preference: None,
        })
        .await
        .unwrap();
    let ParentLoopOutput::AssistantReply(reply) = model_response.output else {
        panic!("expected assistant reply");
    };

    let finalized_ref = ports
        .transcript
        .finalize_assistant_message(FinalizeAssistantMessage { reply })
        .await
        .unwrap();

    let history = fixture
        .thread_service
        .list_thread_history(ThreadHistoryRequest {
            scope: fixture.thread_scope.clone(),
            thread_id: fixture.thread_id.clone(),
        })
        .await
        .unwrap();
    let assistant = history
        .messages
        .iter()
        .find(|message| message.kind == MessageKind::Assistant)
        .expect("assistant reply must be written by the composed transcript port");
    assert_eq!(assistant.status, MessageStatus::Finalized);
    assert_eq!(
        assistant.content.as_deref(),
        Some("RAW_ASSISTANT_CONTENT_SENTINEL sk-output-secret /host/path tool_input")
    );
    assert_eq!(
        finalized_ref.as_str(),
        format!("msg:{}", assistant.message_id)
    );

    let requests = gateway.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].messages.len(), 1);
    assert_eq!(
        requests[0].messages[0].content,
        "RAW_PROMPT_TEXT_SENTINEL sk-prompt-secret /host/path tool_input"
    );
    drop(requests);

    let milestones = milestone_sink.milestones();
    assert_eq!(milestones.len(), 3);
    assert!(matches!(
        &milestones[0].kind,
        LoopHostMilestoneKind::ModelStarted {
            requested_model_profile_id: None
        }
    ));
    assert!(matches!(
        &milestones[1].kind,
        LoopHostMilestoneKind::ModelCompleted { effective_model_profile_id }
            if effective_model_profile_id == &fixture.run_context.resolved_run_profile.model_profile_id
    ));
    assert!(matches!(
        &milestones[2].kind,
        LoopHostMilestoneKind::AssistantReplyFinalized { message_ref }
            if message_ref == &finalized_ref
    ));
    assert!(milestones.iter().all(|milestone| {
        milestone.scope == fixture.run_context.scope
            && milestone.turn_id == fixture.run_context.turn_id
            && milestone.run_id == fixture.run_context.run_id
    }));

    assert_serialized_milestones_hide_sentinels(&milestones);
}

#[tokio::test]
async fn text_only_loop_host_ports_keep_failed_model_milestones_safe() {
    let fixture = ThreadFixture::new_with_user_content("RAW_PROMPT_TEXT_SENTINEL").await;
    let milestone_sink = Arc::new(InMemoryLoopHostMilestoneSink::default());
    let gateway = Arc::new(RecordingGateway::deny(
        "RAW_PROVIDER_ERROR invalid api key sk-provider-secret /host/path tool_input",
    ));
    let ports = TextOnlyLoopHostPorts::new(
        Arc::clone(&fixture.thread_service),
        fixture.thread_scope.clone(),
        fixture.run_context.clone(),
        gateway,
        milestone_sink.clone(),
        TextOnlyLoopHostConfig::default(),
    );

    let context = ports
        .context
        .load_loop_context(LoopContextRequest {
            after: None,
            limit: 8,
        })
        .await
        .unwrap();
    let error = ports
        .model
        .stream_model(LoopModelRequest {
            messages: context
                .messages
                .iter()
                .map(|message| LoopModelMessage {
                    role: message.role.clone(),
                    content_ref: message.message_ref.clone(),
                })
                .collect(),
            surface_version: None,
            model_preference: None,
        })
        .await
        .unwrap_err();

    assert_eq!(error.kind, AgentLoopHostErrorKind::PolicyDenied);
    let serialized_error = serde_json::to_string(&error).unwrap();
    assert!(!serialized_error.contains("RAW_PROVIDER_ERROR"));
    assert!(!serialized_error.contains("sk-provider-secret"));

    let milestones = milestone_sink.milestones();
    assert_eq!(milestones.len(), 1);
    assert!(matches!(
        &milestones[0].kind,
        LoopHostMilestoneKind::ModelStarted {
            requested_model_profile_id: None
        }
    ));
    assert_serialized_milestones_hide_sentinels(&milestones);
}

fn assert_serialized_milestones_hide_sentinels(milestones: &[LoopHostMilestone]) {
    let wire = serde_json::to_string(milestones).unwrap();
    for forbidden in [
        "RAW_PROMPT_TEXT_SENTINEL",
        "RAW_ASSISTANT_CONTENT_SENTINEL",
        "RAW_PROVIDER_ERROR",
        "invalid api key",
        "sk-prompt-secret",
        "sk-output-secret",
        "sk-provider-secret",
        "/host/path",
        "tool_input",
    ] {
        assert!(!wire.contains(forbidden), "milestone leaked {forbidden}");
    }
}

struct ThreadFixture {
    thread_service: Arc<InMemorySessionThreadService>,
    thread_scope: ThreadScope,
    thread_id: ThreadId,
    run_context: LoopRunContext,
}

impl ThreadFixture {
    async fn new_with_user_content(user_content: &str) -> Self {
        let thread_service = Arc::new(InMemorySessionThreadService::default());
        let tenant_id = TenantId::new("tenant-reborn-composition").unwrap();
        let agent_id = AgentId::new("agent-reborn-composition").unwrap();
        let project_id = ProjectId::new("project-reborn-composition").unwrap();
        let user_id = UserId::new("user-reborn-composition").unwrap();
        let thread_id = ThreadId::new("thread-reborn-composition").unwrap();
        let thread_scope = ThreadScope {
            tenant_id: tenant_id.clone(),
            agent_id: agent_id.clone(),
            project_id: Some(project_id.clone()),
            owner_user_id: Some(user_id.clone()),
            mission_id: None,
        };
        thread_service
            .ensure_thread(EnsureThreadRequest {
                scope: thread_scope.clone(),
                thread_id: Some(thread_id.clone()),
                created_by_actor_id: user_id.as_str().to_string(),
                title: None,
                metadata_json: None,
            })
            .await
            .unwrap();
        thread_service
            .accept_inbound_message(AcceptInboundMessageRequest {
                scope: thread_scope.clone(),
                thread_id: thread_id.clone(),
                actor_id: user_id.as_str().to_string(),
                source_binding_id: Some("source-cli".to_string()),
                reply_target_binding_id: Some("reply-cli".to_string()),
                external_event_id: Some("event-1".to_string()),
                content: MessageContent::text(user_content),
            })
            .await
            .unwrap();
        let turn_scope = TurnScope::new(
            tenant_id,
            Some(agent_id),
            Some(project_id),
            thread_id.clone(),
        );
        let resolved = InMemoryRunProfileResolver::default()
            .resolve_run_profile(RunProfileResolutionRequest::interactive_default())
            .await
            .unwrap();
        let run_context =
            LoopRunContext::new(turn_scope, TurnId::new(), TurnRunId::new(), resolved);
        Self {
            thread_service,
            thread_scope,
            thread_id,
            run_context,
        }
    }
}

struct RecordingGateway {
    requests: Mutex<Vec<HostManagedModelRequest>>,
    response: Result<HostManagedModelResponse, HostManagedModelError>,
}

impl RecordingGateway {
    fn reply(content: &str) -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            response: Ok(HostManagedModelResponse::assistant_reply(content)),
        }
    }

    fn deny(raw_detail: &str) -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            response: Err(HostManagedModelError::new(
                HostManagedModelErrorKind::PolicyDenied,
                raw_detail,
            )),
        }
    }
}

#[async_trait]
impl HostManagedModelGateway for RecordingGateway {
    async fn stream_model(
        &self,
        request: HostManagedModelRequest,
    ) -> Result<HostManagedModelResponse, HostManagedModelError> {
        self.requests.lock().unwrap().push(request);
        self.response.clone()
    }
}
