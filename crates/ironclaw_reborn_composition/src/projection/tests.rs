use super::turn_events::WEBUI_TURN_EVENT_PAGE_LIMIT;
use super::*;

use async_trait::async_trait;
use ironclaw_event_projections::{
    CapabilityActivityProjection, ProjectionSnapshot, ThreadTimeline,
};
use ironclaw_events::{InMemoryDurableEventLog, RuntimeEvent};
use ironclaw_host_api::{
    AgentId, CapabilityId, ExtensionId, InvocationId, ResourceScope, RuntimeKind, TenantId,
    ThreadId, UserId,
};
use ironclaw_product_adapters::{
    CapabilityActivityStatusView, ProductOutboundEnvelope, ProductOutboundPayload,
};
use ironclaw_turns::{
    AcceptedMessageRef, CancelRunRequest, CancelRunResponse, EventCursor as TurnEventCursor,
    GateRef, GetRunStateRequest, ResumeTurnRequest, ResumeTurnResponse, RunProfileId,
    RunProfileVersion, SourceBindingRef, SubmitTurnRequest, SubmitTurnResponse, TurnError,
    TurnEventKind, TurnEventPage, TurnLifecycleEvent, TurnRunState, TurnStatus,
};

#[tokio::test]
async fn webui_event_stream_drains_run_status_projection_from_event_stream_manager() {
    let tenant_id = TenantId::new("webui-events-tenant").unwrap();
    let user_id = UserId::new("webui-events-user").unwrap();
    let agent_id = AgentId::new("webui-events-agent").unwrap();
    let thread_id = ThreadId::new("webui-events-thread").unwrap();
    let invocation_id = InvocationId::new();
    let event_log = Arc::new(InMemoryDurableEventLog::new());
    event_log
        .append(RuntimeEvent::model_started(
            ResourceScope {
                tenant_id: tenant_id.clone(),
                user_id: user_id.clone(),
                agent_id: Some(agent_id.clone()),
                project_id: None,
                mission_id: None,
                thread_id: Some(thread_id.clone()),
                invocation_id,
            },
            CapabilityId::new("loop.model").unwrap(),
        ))
        .await
        .unwrap();

    let event_log: Arc<dyn DurableEventLog> = event_log;
    let actor = TurnActor::new(user_id);
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-events-reply").unwrap(),
    );
    let events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor,
            scope: TurnScope::new(tenant_id, Some(agent_id), None, thread_id),
            after_cursor: None,
        })
        .await
        .unwrap();

    assert_eq!(events.len(), 1);
    let ProductOutboundPayload::ProjectionSnapshot { state } = events[0].payload() else {
        panic!("expected projection snapshot");
    };
    assert_eq!(state.items.len(), 1);
    assert!(matches!(
        state.items[0],
        ProductProjectionItem::RunStatus { ref status, .. } if status == "running"
    ));
}

#[tokio::test]
async fn webui_event_stream_drains_capability_activity_from_projection() {
    let tenant_id = TenantId::new("webui-activity-tenant").unwrap();
    let user_id = UserId::new("webui-activity-user").unwrap();
    let agent_id = AgentId::new("webui-activity-agent").unwrap();
    let thread_id = ThreadId::new("webui-activity-thread").unwrap();
    let invocation_id = InvocationId::new();
    let capability = CapabilityId::new("script.echo").unwrap();
    let event_log = Arc::new(InMemoryDurableEventLog::new());
    event_log
        .append(RuntimeEvent::dispatch_requested(
            resource_scope(&tenant_id, &user_id, &agent_id, &thread_id, invocation_id),
            capability.clone(),
        ))
        .await
        .unwrap();

    let event_log: Arc<dyn DurableEventLog> = event_log;
    let actor = TurnActor::new(user_id);
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-activity-reply").unwrap(),
    );
    let events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor,
            scope: TurnScope::new(tenant_id, Some(agent_id), None, thread_id.clone()),
            after_cursor: None,
        })
        .await
        .unwrap();

    assert!(events.iter().any(|event| {
        matches!(
            event.payload(),
            ProductOutboundPayload::CapabilityActivity(activity)
                if activity.invocation_id == invocation_id
                    && activity.thread_id.as_ref() == Some(&thread_id)
                    && activity.capability_id == capability
                    && activity.status == CapabilityActivityStatusView::Started
        )
    }));
}

#[tokio::test]
async fn webui_event_stream_preserves_sanitized_capability_activity_error_kind() {
    let tenant_id = TenantId::new("webui-activity-redacted-tenant").unwrap();
    let user_id = UserId::new("webui-activity-redacted-user").unwrap();
    let agent_id = AgentId::new("webui-activity-redacted-agent").unwrap();
    let thread_id = ThreadId::new("webui-activity-redacted-thread").unwrap();
    let invocation_id = InvocationId::new();
    let event_log = Arc::new(InMemoryDurableEventLog::new());
    event_log
        .append(RuntimeEvent::dispatch_failed(
            resource_scope(&tenant_id, &user_id, &agent_id, &thread_id, invocation_id),
            CapabilityId::new("script.echo").unwrap(),
            Some(ExtensionId::new("script").unwrap()),
            Some(RuntimeKind::Script),
            "raw failure /tmp/private-host-path SECRET_SENTINEL_sk_live",
        ))
        .await
        .unwrap();

    let event_log: Arc<dyn DurableEventLog> = event_log;
    let actor = TurnActor::new(user_id);
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-activity-redacted-reply").unwrap(),
    );
    let events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor,
            scope: TurnScope::new(tenant_id, Some(agent_id), None, thread_id),
            after_cursor: None,
        })
        .await
        .unwrap();

    assert!(events.iter().any(|event| {
        matches!(
            event.payload(),
            ProductOutboundPayload::CapabilityActivity(activity)
                if activity.invocation_id == invocation_id
                    && activity.status == CapabilityActivityStatusView::Failed
                    && activity.error_kind.as_deref() == Some("Unclassified")
        )
    }));
}

#[tokio::test]
async fn webui_event_stream_resumes_inside_multi_payload_runtime_projection_item() {
    let tenant_id = TenantId::new("webui-activity-resume-tenant").unwrap();
    let user_id = UserId::new("webui-activity-resume-user").unwrap();
    let agent_id = AgentId::new("webui-activity-resume-agent").unwrap();
    let thread_id = ThreadId::new("webui-activity-resume-thread").unwrap();
    let invocation_id = InvocationId::new();
    let event_log = Arc::new(InMemoryDurableEventLog::new());
    event_log
        .append(RuntimeEvent::dispatch_requested(
            resource_scope(&tenant_id, &user_id, &agent_id, &thread_id, invocation_id),
            CapabilityId::new("script.echo").unwrap(),
        ))
        .await
        .unwrap();

    let event_log: Arc<dyn DurableEventLog> = event_log;
    let actor = TurnActor::new(user_id);
    let scope = TurnScope::new(tenant_id, Some(agent_id), None, thread_id);
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-activity-resume-reply").unwrap(),
    );
    let initial_events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor: actor.clone(),
            scope: scope.clone(),
            after_cursor: None,
        })
        .await
        .unwrap();

    assert_eq!(initial_events.len(), 2);
    assert!(matches!(
        initial_events[0].payload(),
        ProductOutboundPayload::ProjectionSnapshot { .. }
    ));
    assert!(matches!(
        initial_events[1].payload(),
        ProductOutboundPayload::CapabilityActivity(_)
    ));
    let partial_cursor =
        parse_webui_projection_cursor(initial_events[0].projection_cursor().as_str()).unwrap();
    assert!(partial_cursor.runtime.is_none());
    assert!(partial_cursor.runtime_item.is_some());
    assert_eq!(partial_cursor.runtime_payloads_delivered, 1);

    let resumed_events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor,
            scope,
            after_cursor: Some(initial_events[0].projection_cursor().clone()),
        })
        .await
        .unwrap();

    assert_eq!(resumed_events.len(), 1);
    assert!(matches!(
        resumed_events[0].payload(),
        ProductOutboundPayload::CapabilityActivity(activity)
            if activity.invocation_id == invocation_id
    ));
    let resumed_cursor =
        parse_webui_projection_cursor(resumed_events[0].projection_cursor().as_str()).unwrap();
    assert!(resumed_cursor.runtime.is_some());
    assert_eq!(resumed_cursor.runtime_payloads_delivered, 0);
}

#[tokio::test]
async fn webui_event_stream_accepts_legacy_partial_origin_cursor() {
    let tenant_id = TenantId::new("webui-activity-legacy-tenant").unwrap();
    let user_id = UserId::new("webui-activity-legacy-user").unwrap();
    let agent_id = AgentId::new("webui-activity-legacy-agent").unwrap();
    let thread_id = ThreadId::new("webui-activity-legacy-thread").unwrap();
    let invocation_id = InvocationId::new();
    let event_log = Arc::new(InMemoryDurableEventLog::new());
    event_log
        .append(RuntimeEvent::dispatch_requested(
            resource_scope(&tenant_id, &user_id, &agent_id, &thread_id, invocation_id),
            CapabilityId::new("script.echo").unwrap(),
        ))
        .await
        .unwrap();

    let event_log: Arc<dyn DurableEventLog> = event_log;
    let actor = TurnActor::new(user_id);
    let scope = TurnScope::new(tenant_id, Some(agent_id), None, thread_id);
    let legacy_cursor = product_cursor_from_webui_cursor(&WebuiProjectionCursor {
        runtime: None,
        runtime_item: None,
        turn: None,
        runtime_payloads_delivered: 1,
    })
    .unwrap();
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-activity-legacy-reply").unwrap(),
    );

    let resumed_events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor,
            scope,
            after_cursor: Some(legacy_cursor),
        })
        .await
        .unwrap();

    assert_eq!(resumed_events.len(), 1);
    assert!(matches!(
        resumed_events[0].payload(),
        ProductOutboundPayload::CapabilityActivity(activity)
            if activity.invocation_id == invocation_id
    ));
}

#[test]
fn webui_projection_snapshot_retains_activity_fanout_for_resumable_delivery() {
    let tenant_id = TenantId::new("webui-activity-cap-tenant").unwrap();
    let user_id = UserId::new("webui-activity-cap-user").unwrap();
    let agent_id = AgentId::new("webui-activity-cap-agent").unwrap();
    let thread_id = ThreadId::new("webui-activity-cap-thread").unwrap();
    let capability = CapabilityId::new("script.echo").unwrap();
    let actor = TurnActor::new(user_id);
    let scope = TurnScope::new(tenant_id, Some(agent_id), None, thread_id.clone());
    let projection_scope = runtime_projection_scope(&actor, &scope);
    let cursor =
        EventProjectionCursor::for_scope(projection_scope, ironclaw_events::EventCursor::new(1));
    let snapshot = ProjectionSnapshot {
        timeline: ThreadTimeline {
            entries: Vec::new(),
        },
        runs: vec![RunStatusProjection {
            invocation_id: InvocationId::new(),
            capability_id: capability.clone(),
            thread_id: Some(thread_id.clone()),
            status: RunProjectionStatus::Running,
            provider: None,
            runtime: None,
            process_id: None,
            error_kind: None,
            last_cursor: ironclaw_events::EventCursor::new(1),
            updated_at: chrono::Utc::now(),
        }],
        capability_activities: (0..(WEBUI_PROJECTION_PAGE_LIMIT + 10))
            .map(|index| CapabilityActivityProjection {
                invocation_id: InvocationId::new(),
                capability_id: capability.clone(),
                thread_id: Some(thread_id.clone()),
                status: ironclaw_event_projections::CapabilityActivityStatus::Running,
                provider: None,
                runtime: None,
                process_id: None,
                output_bytes: None,
                error_kind: None,
                last_cursor: ironclaw_events::EventCursor::new(index as u64 + 1),
                updated_at: chrono::Utc::now(),
            })
            .collect(),
        next_cursor: cursor.clone(),
        truncated: false,
    };

    let (_, _, payloads, total, _) = snapshot_payloads(
        &scope,
        snapshot,
        cursor.clone(),
        EventProjectionCursor::origin_for_scope(cursor.scope.clone()),
        None,
        0,
        WEBUI_PROJECTION_PAGE_LIMIT + 11,
    )
    .unwrap()
    .unwrap();

    assert_eq!(total, WEBUI_PROJECTION_PAGE_LIMIT + 11);
    assert_eq!(payloads.len(), WEBUI_PROJECTION_PAGE_LIMIT + 11);
    assert!(matches!(
        &payloads[0].payload,
        ProductOutboundPayload::ProjectionSnapshot { state } if state.items.len() == 1
    ));
    assert_eq!(
        payloads
            .iter()
            .filter(|payload| matches!(
                payload.payload,
                ProductOutboundPayload::CapabilityActivity(_)
            ))
            .count(),
        WEBUI_PROJECTION_PAGE_LIMIT + 10
    );
}

#[tokio::test]
async fn webui_event_stream_resumes_overflow_activity_fanout_without_dropping() {
    let tenant_id = TenantId::new("webui-activity-overflow-tenant").unwrap();
    let user_id = UserId::new("webui-activity-overflow-user").unwrap();
    let agent_id = AgentId::new("webui-activity-overflow-agent").unwrap();
    let thread_id = ThreadId::new("webui-activity-overflow-thread").unwrap();
    let capability = CapabilityId::new("script.echo").unwrap();
    let activity_count = WEBUI_RUNTIME_ITEM_MAX_PAYLOADS + 3;
    let event_log = Arc::new(InMemoryDurableEventLog::new());
    for _ in 0..activity_count {
        event_log
            .append(RuntimeEvent::dispatch_requested(
                resource_scope(
                    &tenant_id,
                    &user_id,
                    &agent_id,
                    &thread_id,
                    InvocationId::new(),
                ),
                capability.clone(),
            ))
            .await
            .unwrap();
    }

    let event_log: Arc<dyn DurableEventLog> = event_log;
    let actor = TurnActor::new(user_id);
    let scope = TurnScope::new(tenant_id, Some(agent_id), None, thread_id);
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-activity-overflow-reply").unwrap(),
    );
    let initial_events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor: actor.clone(),
            scope: scope.clone(),
            after_cursor: None,
        })
        .await
        .unwrap();

    assert_eq!(initial_events.len(), WEBUI_RUNTIME_ITEM_MAX_PAYLOADS);
    let initial_cursor = parse_webui_projection_cursor(
        initial_events
            .last()
            .expect("initial event")
            .projection_cursor()
            .as_str(),
    )
    .unwrap();
    assert!(initial_cursor.runtime.is_none());
    assert_eq!(
        initial_cursor.runtime_item.expect("runtime item").as_u64(),
        activity_count as u64
    );
    assert_eq!(
        initial_cursor.runtime_payloads_delivered,
        WEBUI_RUNTIME_ITEM_MAX_PAYLOADS
    );
    assert!(matches!(
        initial_events[0].payload(),
        ProductOutboundPayload::ProjectionSnapshot { .. }
    ));

    let resumed_events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor,
            scope,
            after_cursor: Some(
                initial_events
                    .last()
                    .expect("initial event")
                    .projection_cursor()
                    .clone(),
            ),
        })
        .await
        .unwrap();

    assert_eq!(resumed_events.len(), 4);
    let emitted_activity_count = initial_events
        .iter()
        .chain(resumed_events.iter())
        .filter(|event| {
            matches!(
                event.payload(),
                ProductOutboundPayload::CapabilityActivity(_)
            )
        })
        .count();
    assert_eq!(emitted_activity_count, activity_count);
    let resumed_cursor = parse_webui_projection_cursor(
        resumed_events
            .last()
            .expect("resumed event")
            .projection_cursor()
            .as_str(),
    )
    .unwrap();
    assert!(resumed_cursor.runtime.is_some());
    assert_eq!(resumed_cursor.runtime_payloads_delivered, 0);

    let final_events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor: TurnActor::new(UserId::new("webui-activity-overflow-user").unwrap()),
            scope: TurnScope::new(
                TenantId::new("webui-activity-overflow-tenant").unwrap(),
                Some(AgentId::new("webui-activity-overflow-agent").unwrap()),
                None,
                ThreadId::new("webui-activity-overflow-thread").unwrap(),
            ),
            after_cursor: Some(
                resumed_events
                    .last()
                    .expect("resumed event")
                    .projection_cursor()
                    .clone(),
            ),
        })
        .await
        .unwrap();
    assert!(final_events.is_empty());
}

#[tokio::test]
async fn webui_event_stream_mints_resumable_cursors_for_long_valid_scope_ids() {
    let tenant_id = TenantId::new(long_test_id("tenant", 't')).unwrap();
    let user_id = UserId::new(long_test_id("user", 'u')).unwrap();
    let agent_id = AgentId::new(long_test_id("agent", 'a')).unwrap();
    let thread_id = ThreadId::new(long_test_id("thread", 'h')).unwrap();
    let capability = CapabilityId::new("script.echo").unwrap();
    let event_log = Arc::new(InMemoryDurableEventLog::new());
    for _ in 0..(WEBUI_RUNTIME_ITEM_MAX_PAYLOADS + 1) {
        event_log
            .append(RuntimeEvent::dispatch_requested(
                resource_scope(
                    &tenant_id,
                    &user_id,
                    &agent_id,
                    &thread_id,
                    InvocationId::new(),
                ),
                capability.clone(),
            ))
            .await
            .unwrap();
    }

    let event_log: Arc<dyn DurableEventLog> = event_log;
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-activity-long-scope-reply").unwrap(),
    );
    let events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor: TurnActor::new(user_id),
            scope: TurnScope::new(tenant_id, Some(agent_id), None, thread_id),
            after_cursor: None,
        })
        .await
        .unwrap();

    assert_eq!(events.len(), WEBUI_RUNTIME_ITEM_MAX_PAYLOADS);
    assert!(
        events
            .iter()
            .all(|event| event.projection_cursor().as_str().len() <= 1024)
    );
}

#[tokio::test]
async fn webui_event_stream_rebases_stale_partial_activity_cursor() {
    let tenant_id = TenantId::new("webui-activity-stale-tenant").unwrap();
    let user_id = UserId::new("webui-activity-stale-user").unwrap();
    let agent_id = AgentId::new("webui-activity-stale-agent").unwrap();
    let thread_id = ThreadId::new("webui-activity-stale-thread").unwrap();
    let capability = CapabilityId::new("script.echo").unwrap();
    let event_log = Arc::new(InMemoryDurableEventLog::new());
    for _ in 0..WEBUI_RUNTIME_ITEM_MAX_PAYLOADS {
        event_log
            .append(RuntimeEvent::dispatch_requested(
                resource_scope(
                    &tenant_id,
                    &user_id,
                    &agent_id,
                    &thread_id,
                    InvocationId::new(),
                ),
                capability.clone(),
            ))
            .await
            .unwrap();
    }

    let event_log_dyn: Arc<dyn DurableEventLog> = event_log.clone();
    let actor = TurnActor::new(user_id.clone());
    let scope = TurnScope::new(
        tenant_id.clone(),
        Some(agent_id.clone()),
        None,
        thread_id.clone(),
    );
    let services = build_reborn_projection_services(
        event_log_dyn,
        ReplyTargetBindingRef::new("webui-activity-stale-reply").unwrap(),
    );
    let initial_events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor: actor.clone(),
            scope: scope.clone(),
            after_cursor: None,
        })
        .await
        .unwrap();
    let stale_cursor = initial_events
        .last()
        .expect("initial event")
        .projection_cursor()
        .clone();

    event_log
        .append(RuntimeEvent::dispatch_requested(
            resource_scope(
                &tenant_id,
                &user_id,
                &agent_id,
                &thread_id,
                InvocationId::new(),
            ),
            capability,
        ))
        .await
        .unwrap();

    let resumed_events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor,
            scope,
            after_cursor: Some(stale_cursor),
        })
        .await
        .unwrap();

    assert_eq!(resumed_events.len(), WEBUI_RUNTIME_ITEM_MAX_PAYLOADS);
    assert!(matches!(
        resumed_events[0].payload(),
        ProductOutboundPayload::ProjectionSnapshot { .. }
    ));
    let resumed_cursor = parse_webui_projection_cursor(
        resumed_events
            .last()
            .expect("resumed event")
            .projection_cursor()
            .as_str(),
    )
    .unwrap();
    assert_eq!(
        resumed_cursor.runtime_item.expect("runtime item").as_u64(),
        WEBUI_RUNTIME_ITEM_MAX_PAYLOADS as u64 + 1
    );
    assert_eq!(
        resumed_cursor.runtime_payloads_delivered,
        WEBUI_RUNTIME_ITEM_MAX_PAYLOADS
    );
}

#[tokio::test]
async fn webui_event_stream_drains_completed_and_failed_capability_activity_metadata() {
    let tenant_id = TenantId::new("webui-activity-terminal-tenant").unwrap();
    let user_id = UserId::new("webui-activity-terminal-user").unwrap();
    let agent_id = AgentId::new("webui-activity-terminal-agent").unwrap();
    let thread_id = ThreadId::new("webui-activity-terminal-thread").unwrap();
    let completed_invocation = InvocationId::new();
    let failed_invocation = InvocationId::new();
    let capability = CapabilityId::new("script.echo").unwrap();
    let provider = ExtensionId::new("script").unwrap();
    let event_log = Arc::new(InMemoryDurableEventLog::new());
    event_log
        .append(RuntimeEvent::dispatch_succeeded(
            resource_scope(
                &tenant_id,
                &user_id,
                &agent_id,
                &thread_id,
                completed_invocation,
            ),
            capability.clone(),
            provider.clone(),
            RuntimeKind::Script,
            64,
        ))
        .await
        .unwrap();
    event_log
        .append(RuntimeEvent::dispatch_failed(
            resource_scope(
                &tenant_id,
                &user_id,
                &agent_id,
                &thread_id,
                failed_invocation,
            ),
            capability.clone(),
            Some(provider),
            Some(RuntimeKind::Script),
            "policy_denied",
        ))
        .await
        .unwrap();

    let event_log: Arc<dyn DurableEventLog> = event_log;
    let actor = TurnActor::new(user_id);
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-activity-terminal-reply").unwrap(),
    );
    let events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor,
            scope: TurnScope::new(tenant_id, Some(agent_id), None, thread_id),
            after_cursor: None,
        })
        .await
        .unwrap();

    assert!(events.iter().any(|event| {
        matches!(
            event.payload(),
            ProductOutboundPayload::CapabilityActivity(activity)
                if activity.invocation_id == completed_invocation
                    && activity.status == CapabilityActivityStatusView::Completed
                    && activity.output_bytes == Some(64)
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event.payload(),
            ProductOutboundPayload::CapabilityActivity(activity)
                if activity.invocation_id == failed_invocation
                    && activity.status == CapabilityActivityStatusView::Failed
                    && activity.error_kind.as_deref() == Some("policy_denied")
        )
    }));
}

#[tokio::test]
async fn webui_event_stream_resumes_after_serialized_projection_cursor() {
    let tenant_id = TenantId::new("webui-events-tenant").unwrap();
    let user_id = UserId::new("webui-events-user").unwrap();
    let agent_id = AgentId::new("webui-events-agent").unwrap();
    let thread_id = ThreadId::new("webui-events-thread").unwrap();
    let first_run = InvocationId::new();
    let second_run = InvocationId::new();
    let event_log = Arc::new(InMemoryDurableEventLog::new());
    event_log
        .append(RuntimeEvent::model_started(
            resource_scope(&tenant_id, &user_id, &agent_id, &thread_id, first_run),
            CapabilityId::new("loop.model").unwrap(),
        ))
        .await
        .unwrap();

    let event_log_dyn: Arc<dyn DurableEventLog> = event_log.clone();
    let actor = TurnActor::new(user_id.clone());
    let services = build_reborn_projection_services(
        event_log_dyn,
        ReplyTargetBindingRef::new("webui-events-reply").unwrap(),
    );
    let first = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor: actor.clone(),
            scope: TurnScope::new(
                tenant_id.clone(),
                Some(agent_id.clone()),
                None,
                thread_id.clone(),
            ),
            after_cursor: None,
        })
        .await
        .unwrap();

    event_log
        .append(RuntimeEvent::model_started(
            resource_scope(&tenant_id, &user_id, &agent_id, &thread_id, second_run),
            CapabilityId::new("loop.model").unwrap(),
        ))
        .await
        .unwrap();
    let resumed = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor,
            scope: TurnScope::new(tenant_id, Some(agent_id), None, thread_id),
            after_cursor: Some(first[0].projection_cursor().clone()),
        })
        .await
        .unwrap();

    assert!(contains_run_status(&resumed, second_run, "running"));
    assert!(!contains_run_status(&resumed, first_run, "running"));
}

#[tokio::test]
async fn webui_event_stream_resumes_mixed_batch_without_skipping_turn_event() {
    let tenant_id = TenantId::new("webui-events-tenant").unwrap();
    let user_id = UserId::new("webui-events-user").unwrap();
    let agent_id = AgentId::new("webui-events-agent").unwrap();
    let thread_id = ThreadId::new("webui-events-thread").unwrap();
    let runtime_run = InvocationId::new();
    let turn_run = TurnRunId::new();
    let event_log = Arc::new(InMemoryDurableEventLog::new());
    event_log
        .append(RuntimeEvent::model_started(
            resource_scope(&tenant_id, &user_id, &agent_id, &thread_id, runtime_run),
            CapabilityId::new("loop.model").unwrap(),
        ))
        .await
        .unwrap();

    let scope = TurnScope::new(
        tenant_id.clone(),
        Some(agent_id.clone()),
        None,
        thread_id.clone(),
    );
    let event_log_dyn: Arc<dyn DurableEventLog> = event_log;
    let actor = TurnActor::new(user_id.clone());
    let services = build_reborn_projection_services(
        event_log_dyn,
        ReplyTargetBindingRef::new("webui-events-reply").unwrap(),
    )
    .with_turn_events(
        Arc::new(FakeTurnEventSource {
            events: vec![TurnLifecycleEvent {
                cursor: TurnEventCursor(1),
                scope: scope.clone(),
                run_id: turn_run,
                status: TurnStatus::BlockedAuth,
                kind: TurnEventKind::Blocked,
                sanitized_reason: Some("GitHub authentication required".to_string()),
            }],
        }),
        Arc::new(FakeTurnCoordinator {
            state: turn_run_state(&scope, &user_id, turn_run, TurnEventCursor(1)),
        }),
    );

    let first = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor: actor.clone(),
            scope: scope.clone(),
            after_cursor: None,
        })
        .await
        .unwrap();

    assert_eq!(first.len(), 2);
    assert!(matches!(
        first[0].payload(),
        ProductOutboundPayload::ProjectionSnapshot { .. }
    ));
    assert!(matches!(
        first[1].payload(),
        ProductOutboundPayload::AuthPrompt(_)
    ));

    let resumed = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor,
            scope,
            after_cursor: Some(first[0].projection_cursor().clone()),
        })
        .await
        .unwrap();

    assert_eq!(resumed.len(), 1);
    assert!(matches!(
        resumed[0].payload(),
        ProductOutboundPayload::AuthPrompt(prompt)
            if prompt.turn_run_id == turn_run
                && prompt.auth_request_ref == "gate:auth-required"
    ));
}

#[tokio::test]
async fn webui_event_stream_rejects_foreign_composite_turn_cursor() {
    let tenant_id = TenantId::new("webui-events-tenant").unwrap();
    let user_id = UserId::new("webui-events-user").unwrap();
    let agent_id = AgentId::new("webui-events-agent").unwrap();
    let thread_a = ThreadId::new("webui-events-thread-a").unwrap();
    let thread_b = ThreadId::new("webui-events-thread-b").unwrap();
    let event_log: Arc<dyn DurableEventLog> = Arc::new(InMemoryDurableEventLog::new());
    let scope_a = TurnScope::new(
        tenant_id.clone(),
        Some(agent_id.clone()),
        None,
        thread_a.clone(),
    );
    let scope_b = TurnScope::new(tenant_id, Some(agent_id), None, thread_b);
    let cursor = product_cursor_from_webui_cursor(&WebuiProjectionCursor {
        runtime: None,
        runtime_item: None,
        turn: Some(TurnEventProjectionCursor::for_scope(
            scope_a,
            TurnEventCursor(10),
        )),
        runtime_payloads_delivered: 0,
    })
    .unwrap();
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-events-reply").unwrap(),
    );

    let error = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor: TurnActor::new(user_id),
            scope: scope_b,
            after_cursor: Some(cursor),
        })
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        ProductAdapterError::InvalidIdentifier {
            kind: "projection_cursor",
            ..
        }
    ));
}

#[tokio::test]
async fn webui_event_stream_rejects_foreign_composite_runtime_cursor() {
    let tenant_id = TenantId::new("webui-events-tenant").unwrap();
    let user_id = UserId::new("webui-events-user").unwrap();
    let agent_id = AgentId::new("webui-events-agent").unwrap();
    let thread_a = ThreadId::new("webui-events-thread-a").unwrap();
    let thread_b = ThreadId::new("webui-events-thread-b").unwrap();
    let event_log: Arc<dyn DurableEventLog> = Arc::new(InMemoryDurableEventLog::new());
    let actor = TurnActor::new(user_id);
    let scope_a = TurnScope::new(
        tenant_id.clone(),
        Some(agent_id.clone()),
        None,
        thread_a.clone(),
    );
    let scope_b = TurnScope::new(tenant_id, Some(agent_id), None, thread_b);
    let cursor = product_cursor_from_webui_cursor(&WebuiProjectionCursor {
        runtime: Some(EventProjectionCursor::origin_for_scope(
            runtime_projection_scope(&actor, &scope_a),
        )),
        runtime_item: None,
        turn: None,
        runtime_payloads_delivered: 1,
    })
    .unwrap();
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-events-reply").unwrap(),
    );

    let error = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor,
            scope: scope_b,
            after_cursor: Some(cursor),
        })
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        ProductAdapterError::InvalidIdentifier {
            kind: "projection_cursor",
            ..
        }
    ));
}

#[tokio::test]
async fn webui_event_stream_emits_keepalive_when_only_turn_cursor_advances() {
    let tenant_id = TenantId::new("webui-events-tenant").unwrap();
    let user_id = UserId::new("webui-events-user").unwrap();
    let agent_id = AgentId::new("webui-events-agent").unwrap();
    let thread_id = ThreadId::new("webui-events-thread").unwrap();
    let scope = TurnScope::new(
        tenant_id.clone(),
        Some(agent_id.clone()),
        None,
        thread_id.clone(),
    );
    let run_id = TurnRunId::new();
    let event_log: Arc<dyn DurableEventLog> = Arc::new(InMemoryDurableEventLog::new());
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-events-reply").unwrap(),
    )
    .with_turn_events(
        Arc::new(FakeTurnEventSource {
            events: vec![TurnLifecycleEvent {
                cursor: TurnEventCursor(1),
                scope: scope.clone(),
                run_id,
                status: TurnStatus::Running,
                kind: TurnEventKind::RunnerHeartbeat,
                sanitized_reason: None,
            }],
        }),
        Arc::new(FakeTurnCoordinator {
            state: turn_run_state(&scope, &user_id, run_id, TurnEventCursor(1)),
        }),
    );

    let events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor: TurnActor::new(user_id),
            scope: scope.clone(),
            after_cursor: None,
        })
        .await
        .unwrap();

    assert_eq!(events.len(), 1);
    assert!(matches!(
        events[0].payload(),
        ProductOutboundPayload::KeepAlive
    ));
    let parsed = parse_webui_projection_cursor(events[0].projection_cursor().as_str()).unwrap();
    assert_eq!(
        parsed.turn,
        Some(TurnEventProjectionCursor::for_scope(
            scope,
            TurnEventCursor(1)
        ))
    );
}

#[tokio::test]
async fn webui_event_stream_reads_past_filtered_turn_event_pages() {
    let tenant_id = TenantId::new("webui-events-tenant").unwrap();
    let user_id = UserId::new("webui-events-user").unwrap();
    let agent_id = AgentId::new("webui-events-agent").unwrap();
    let thread_id = ThreadId::new("webui-events-thread").unwrap();
    let scope = TurnScope::new(
        tenant_id.clone(),
        Some(agent_id.clone()),
        None,
        thread_id.clone(),
    );
    let run_id = TurnRunId::new();
    let mut events = (1..=WEBUI_TURN_EVENT_PAGE_LIMIT as u64)
        .map(|cursor| TurnLifecycleEvent {
            cursor: TurnEventCursor(cursor),
            scope: scope.clone(),
            run_id,
            status: TurnStatus::Running,
            kind: TurnEventKind::RunnerHeartbeat,
            sanitized_reason: None,
        })
        .collect::<Vec<_>>();
    events.push(TurnLifecycleEvent {
        cursor: TurnEventCursor(WEBUI_TURN_EVENT_PAGE_LIMIT as u64 + 1),
        scope: scope.clone(),
        run_id,
        status: TurnStatus::BlockedAuth,
        kind: TurnEventKind::Blocked,
        sanitized_reason: Some("GitHub authentication required".to_string()),
    });
    let event_log: Arc<dyn DurableEventLog> = Arc::new(InMemoryDurableEventLog::new());
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-events-reply").unwrap(),
    )
    .with_turn_events(
        Arc::new(FakeTurnEventSource { events }),
        Arc::new(FakeTurnCoordinator {
            state: turn_run_state(
                &scope,
                &user_id,
                run_id,
                TurnEventCursor(WEBUI_TURN_EVENT_PAGE_LIMIT as u64 + 1),
            ),
        }),
    );

    let events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor: TurnActor::new(user_id),
            scope,
            after_cursor: None,
        })
        .await
        .unwrap();

    assert_eq!(events.len(), 1);
    assert!(matches!(
        events[0].payload(),
        ProductOutboundPayload::AuthPrompt(prompt)
            if prompt.turn_run_id == run_id
                && prompt.body == "GitHub authentication required"
    ));
}

#[tokio::test]
async fn webui_event_stream_does_not_prompt_for_stale_blocked_event() {
    let tenant_id = TenantId::new("webui-events-tenant").unwrap();
    let user_id = UserId::new("webui-events-user").unwrap();
    let agent_id = AgentId::new("webui-events-agent").unwrap();
    let thread_id = ThreadId::new("webui-events-thread").unwrap();
    let scope = TurnScope::new(
        tenant_id.clone(),
        Some(agent_id.clone()),
        None,
        thread_id.clone(),
    );
    let run_id = TurnRunId::new();
    let mut state = turn_run_state(&scope, &user_id, run_id, TurnEventCursor(1));
    state.event_cursor = TurnEventCursor(2);
    let event_log: Arc<dyn DurableEventLog> = Arc::new(InMemoryDurableEventLog::new());
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-events-reply").unwrap(),
    )
    .with_turn_events(
        Arc::new(FakeTurnEventSource {
            events: vec![TurnLifecycleEvent {
                cursor: TurnEventCursor(1),
                scope: scope.clone(),
                run_id,
                status: TurnStatus::BlockedAuth,
                kind: TurnEventKind::Blocked,
                sanitized_reason: Some("stale auth gate".to_string()),
            }],
        }),
        Arc::new(FakeTurnCoordinator { state }),
    );

    let events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor: TurnActor::new(user_id),
            scope,
            after_cursor: None,
        })
        .await
        .unwrap();

    assert_eq!(events.len(), 1);
    assert!(matches!(
        events[0].payload(),
        ProductOutboundPayload::ProjectionUpdate { .. }
    ));
}

#[tokio::test]
async fn webui_event_stream_uses_request_actor_for_projection_scope() {
    let tenant_id = TenantId::new("webui-events-tenant").unwrap();
    let owner_user_id = UserId::new("webui-events-owner").unwrap();
    let other_user_id = UserId::new("webui-events-other").unwrap();
    let agent_id = AgentId::new("webui-events-agent").unwrap();
    let thread_id = ThreadId::new("webui-events-thread").unwrap();
    let event_log = Arc::new(InMemoryDurableEventLog::new());
    event_log
        .append(RuntimeEvent::model_started(
            resource_scope(
                &tenant_id,
                &owner_user_id,
                &agent_id,
                &thread_id,
                InvocationId::new(),
            ),
            CapabilityId::new("loop.model").unwrap(),
        ))
        .await
        .unwrap();

    let event_log: Arc<dyn DurableEventLog> = event_log;
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-events-reply").unwrap(),
    );
    let events = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor: TurnActor::new(other_user_id),
            scope: TurnScope::new(tenant_id, Some(agent_id), None, thread_id),
            after_cursor: None,
        })
        .await
        .unwrap();

    assert!(
        events.is_empty(),
        "projection stream must not read another user's event stream through a hidden runtime actor"
    );
}

#[tokio::test]
async fn webui_event_stream_rejects_malformed_projection_cursor() {
    let tenant_id = TenantId::new("webui-events-tenant").unwrap();
    let user_id = UserId::new("webui-events-user").unwrap();
    let agent_id = AgentId::new("webui-events-agent").unwrap();
    let thread_id = ThreadId::new("webui-events-thread").unwrap();
    let event_log: Arc<dyn DurableEventLog> = Arc::new(InMemoryDurableEventLog::new());
    let actor = TurnActor::new(user_id);
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-events-reply").unwrap(),
    );

    let error = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor,
            scope: TurnScope::new(tenant_id, Some(agent_id), None, thread_id),
            after_cursor: Some(ProductProjectionCursor::new("not-json").unwrap()),
        })
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        ProductAdapterError::InvalidIdentifier {
            kind: "projection_cursor",
            ..
        }
    ));
}

#[tokio::test]
async fn webui_event_stream_rejects_runtime_delivery_offset_above_payload_limit() {
    let tenant_id = TenantId::new("webui-events-tenant").unwrap();
    let user_id = UserId::new("webui-events-user").unwrap();
    let agent_id = AgentId::new("webui-events-agent").unwrap();
    let thread_id = ThreadId::new("webui-events-thread").unwrap();
    let event_log: Arc<dyn DurableEventLog> = Arc::new(InMemoryDurableEventLog::new());
    let actor = TurnActor::new(user_id);
    let scope = TurnScope::new(tenant_id, Some(agent_id), None, thread_id);
    let cursor = product_cursor_from_webui_cursor(&WebuiProjectionCursor {
        runtime: Some(EventProjectionCursor::origin_for_scope(
            runtime_projection_scope(&actor, &scope),
        )),
        runtime_item: None,
        turn: None,
        runtime_payloads_delivered: WEBUI_RUNTIME_ITEM_MAX_PAYLOADS + 2,
    })
    .unwrap();
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-events-reply").unwrap(),
    );

    let error = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor,
            scope,
            after_cursor: Some(cursor),
        })
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        ProductAdapterError::InvalidIdentifier {
            kind: "projection_cursor",
            ..
        }
    ));
}

#[tokio::test]
async fn webui_event_stream_rejects_runtime_delivery_offset_above_item_payload_count() {
    let tenant_id = TenantId::new("webui-events-tenant").unwrap();
    let user_id = UserId::new("webui-events-user").unwrap();
    let agent_id = AgentId::new("webui-events-agent").unwrap();
    let thread_id = ThreadId::new("webui-events-thread").unwrap();
    let invocation_id = InvocationId::new();
    let event_log = Arc::new(InMemoryDurableEventLog::new());
    event_log
        .append(RuntimeEvent::dispatch_requested(
            resource_scope(&tenant_id, &user_id, &agent_id, &thread_id, invocation_id),
            CapabilityId::new("script.echo").unwrap(),
        ))
        .await
        .unwrap();

    let event_log: Arc<dyn DurableEventLog> = event_log;
    let actor = TurnActor::new(user_id);
    let scope = TurnScope::new(tenant_id, Some(agent_id), None, thread_id);
    let cursor = product_cursor_from_webui_cursor(&WebuiProjectionCursor {
        runtime: Some(EventProjectionCursor::origin_for_scope(
            runtime_projection_scope(&actor, &scope),
        )),
        runtime_item: None,
        turn: None,
        runtime_payloads_delivered: 3,
    })
    .unwrap();
    let services = build_reborn_projection_services(
        event_log,
        ReplyTargetBindingRef::new("webui-events-reply").unwrap(),
    );

    let error = services
        .webui_event_stream()
        .drain(ProjectionSubscriptionRequest {
            actor,
            scope,
            after_cursor: Some(cursor),
        })
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        ProductAdapterError::InvalidIdentifier {
            kind: "projection_cursor",
            ..
        }
    ));
}

fn long_test_id(prefix: &str, character: char) -> String {
    format!("{prefix}-{}", character.to_string().repeat(96))
}

fn resource_scope(
    tenant_id: &TenantId,
    user_id: &UserId,
    agent_id: &AgentId,
    thread_id: &ThreadId,
    invocation_id: InvocationId,
) -> ResourceScope {
    ResourceScope {
        tenant_id: tenant_id.clone(),
        user_id: user_id.clone(),
        agent_id: Some(agent_id.clone()),
        project_id: None,
        mission_id: None,
        thread_id: Some(thread_id.clone()),
        invocation_id,
    }
}

fn contains_run_status(
    events: &[ProductOutboundEnvelope],
    invocation_id: InvocationId,
    expected_status: &str,
) -> bool {
    let expected_run_id = TurnRunId::from_uuid(invocation_id.as_uuid());
    events.iter().any(|event| match event.payload() {
        ProductOutboundPayload::ProjectionSnapshot { state }
        | ProductOutboundPayload::ProjectionUpdate { state } => state.items.iter().any(|item| {
            matches!(
                item,
                ProductProjectionItem::RunStatus { run_id, status }
                    if *run_id == expected_run_id && status == expected_status
            )
        }),
        _ => false,
    })
}

struct FakeTurnEventSource {
    events: Vec<TurnLifecycleEvent>,
}

#[async_trait]
impl TurnEventProjectionSource for FakeTurnEventSource {
    async fn read_turn_events_after(
        &self,
        scope: &TurnScope,
        after: Option<TurnEventCursor>,
        limit: usize,
    ) -> Result<TurnEventPage, TurnError> {
        let after = after.unwrap_or_default();
        let mut events = self
            .events
            .iter()
            .filter(|event| &event.scope == scope && event.cursor > after)
            .cloned()
            .collect::<Vec<_>>();
        events.sort_by_key(|event| event.cursor);
        let truncated = events.len() > limit;
        if truncated {
            events.truncate(limit);
        }
        let next_cursor = events.last().map(|event| event.cursor).unwrap_or(after);
        Ok(TurnEventPage {
            entries: events,
            next_cursor,
            truncated,
            rebase_required: None,
        })
    }
}

struct FakeTurnCoordinator {
    state: TurnRunState,
}

#[async_trait]
impl TurnCoordinator for FakeTurnCoordinator {
    async fn submit_turn(
        &self,
        _request: SubmitTurnRequest,
    ) -> Result<SubmitTurnResponse, TurnError> {
        unreachable!("projection tests only read run state")
    }

    async fn resume_turn(
        &self,
        _request: ResumeTurnRequest,
    ) -> Result<ResumeTurnResponse, TurnError> {
        unreachable!("projection tests only read run state")
    }

    async fn cancel_run(&self, _request: CancelRunRequest) -> Result<CancelRunResponse, TurnError> {
        unreachable!("projection tests only read run state")
    }

    async fn get_run_state(&self, request: GetRunStateRequest) -> Result<TurnRunState, TurnError> {
        if request.scope == self.state.scope && request.run_id == self.state.run_id {
            Ok(self.state.clone())
        } else {
            Err(TurnError::ScopeNotFound)
        }
    }
}

fn turn_run_state(
    scope: &TurnScope,
    user_id: &UserId,
    run_id: TurnRunId,
    cursor: TurnEventCursor,
) -> TurnRunState {
    TurnRunState {
        scope: scope.clone(),
        actor: Some(TurnActor::new(user_id.clone())),
        turn_id: ironclaw_turns::TurnId::new(),
        run_id,
        status: TurnStatus::BlockedAuth,
        accepted_message_ref: AcceptedMessageRef::new("message:auth-required").unwrap(),
        source_binding_ref: SourceBindingRef::new("source:auth-required").unwrap(),
        reply_target_binding_ref: ReplyTargetBindingRef::new("reply:auth-required").unwrap(),
        resolved_run_profile_id: RunProfileId::default_profile(),
        resolved_run_profile_version: RunProfileVersion::new(1),
        resolved_model_route: None,
        received_at: chrono::Utc::now(),
        checkpoint_id: None,
        gate_ref: Some(GateRef::new("gate:auth-required").unwrap()),
        failure: None,
        event_cursor: cursor,
    }
}
