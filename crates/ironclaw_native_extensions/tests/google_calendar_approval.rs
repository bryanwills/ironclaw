//! Approval-gate, scope, credential, redaction, egress-routing, and
//! shared-credential lifecycle tests for the Google Calendar package.
//!
//! Approval gating for write capabilities is descriptor-level: the manifest
//! marks the five write capabilities `PermissionMode::Ask` with an
//! `ExternalWrite` effect, and the host authorization layer is what blocks an
//! unapproved write. These tests therefore assert the descriptor contract and
//! exercise a host-level gate seam, rather than re-implementing approval
//! inside the handler.

mod support;

use std::sync::Arc;

use ironclaw_host_api::{
    EffectKind, PermissionMode, RuntimeCredentialSource, RuntimeDispatchErrorKind,
};
use ironclaw_host_runtime::FirstPartyCapabilityHandler;
use ironclaw_native_extensions::google::calendar::handlers::{
    CreateEventHandler, ListEventsHandler,
};
use ironclaw_native_extensions::google::calendar::manifest::{
    CALENDAR_CAPABILITIES, CalendarCapabilityKind, calendar_package, capability_id,
};
use ironclaw_native_extensions::google::credential::{
    GOOGLE_CREDENTIAL_NAME, GoogleCredentialResolver,
};
use ironclaw_native_extensions::google::scopes;
use ironclaw_secrets::InMemorySecretStore;
use serde_json::json;

use support::{
    FakeEgress, build_deps, calendar_extension_id, calendar_request,
    calendar_request_without_egress, seed_token, test_scope,
};

// ---------------------------------------------------------------------------
// Package / descriptor assertions.
// ---------------------------------------------------------------------------

#[test]
fn calendar_package_declares_nine_capabilities() {
    let package = calendar_package().expect("calendar package builds");
    assert_eq!(package.id.as_str(), "google-calendar");
    assert_eq!(package.capabilities.len(), 9);
    assert_eq!(package.manifest.capabilities.len(), 9);
    assert_eq!(package.root.as_str(), "/system/extensions/google-calendar");
}

#[test]
fn write_capabilities_require_approval_and_external_write() {
    let package = calendar_package().expect("calendar package builds");
    let write_names = [
        "create_event",
        "update_event",
        "delete_event",
        "add_attendees",
        "set_reminder",
    ];
    for (short_name, _, kind) in CALENDAR_CAPABILITIES {
        let id = capability_id(short_name);
        let descriptor = package
            .capabilities
            .iter()
            .find(|cap| cap.id.as_str() == id)
            .unwrap_or_else(|| panic!("descriptor for {id} present"));
        match kind {
            CalendarCapabilityKind::Write => {
                assert!(
                    write_names.contains(short_name),
                    "{short_name} is a write cap"
                );
                // RequiresApproval -> PermissionMode::Ask.
                assert_eq!(
                    descriptor.default_permission,
                    PermissionMode::Ask,
                    "{short_name} must require approval"
                );
                assert!(
                    descriptor.effects.contains(&EffectKind::ExternalWrite),
                    "{short_name} must declare ExternalWrite"
                );
            }
            CalendarCapabilityKind::Read => {
                assert_eq!(
                    descriptor.default_permission,
                    PermissionMode::Allow,
                    "{short_name} is read-only"
                );
                assert!(
                    !descriptor.effects.contains(&EffectKind::ExternalWrite),
                    "{short_name} must not declare ExternalWrite"
                );
            }
        }
        // Every capability uses the shared Google secret and network.
        assert!(descriptor.effects.contains(&EffectKind::UseSecret));
        assert!(descriptor.effects.contains(&EffectKind::Network));
    }
}

// ---------------------------------------------------------------------------
// Egress routing: handlers must go through the host runtime-egress boundary.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn handler_fails_closed_when_runtime_http_egress_is_unavailable() {
    let scope = test_scope();
    let secrets = Arc::new(InMemorySecretStore::new());
    seed_token(&secrets, &scope, &[scopes::CALENDAR_READONLY]).await;
    let deps = build_deps(secrets, &[scopes::CALENDAR_READONLY]);
    let handler = ListEventsHandler::new(deps);

    // No runtime_http_egress wired -> the handler cannot reach the network and
    // must fail closed instead of falling back to a self-built transport.
    let error = handler
        .dispatch(calendar_request_without_egress(
            "list_events",
            scope,
            json!({ "calendar_id": "primary" }),
        ))
        .await
        .expect_err("missing host egress must fail");
    assert_eq!(error.kind(), RuntimeDispatchErrorKind::NetworkDenied);
}

#[tokio::test]
async fn handler_declares_staged_credential_injection_for_the_token() {
    let scope = test_scope();
    let secrets = Arc::new(InMemorySecretStore::new());
    seed_token(&secrets, &scope, &[scopes::CALENDAR_READONLY]).await;
    let egress = FakeEgress::single(200, json!({ "items": [] }));
    let deps = build_deps(secrets, &[scopes::CALENDAR_READONLY]);
    let handler = ListEventsHandler::new(deps);

    handler
        .dispatch(calendar_request(
            "list_events",
            scope,
            json!({ "calendar_id": "primary" }),
            egress.clone(),
        ))
        .await
        .expect("list_events succeeds");

    let recorded = egress.recorded();
    let injection = &recorded[0].credential_injections[0];
    assert_eq!(injection.handle.as_str(), GOOGLE_CREDENTIAL_NAME);
    assert!(injection.required);
    // Production HostHttpEgressService rejects direct secret-store leases for
    // runtime egress; the handler must declare a staged obligation.
    assert!(
        matches!(
            injection.source,
            RuntimeCredentialSource::StagedObligation { .. }
        ),
        "credential injection must use a staged obligation"
    );
}

// ---------------------------------------------------------------------------
// Approval gate: blocked -> approved -> succeeds; approval-unreachable fails
// closed. The descriptor `PermissionMode::Ask` is the gate the host evaluates
// before dispatch; this models that host gate seam.
// ---------------------------------------------------------------------------

/// Models the host-level authorization decision for a write capability.
enum ApprovalDecision {
    Granted,
    Denied,
    /// The approval service could not be reached — must fail closed.
    Unreachable,
}

/// Mimics the host gate: a write capability may only be dispatched once
/// approval is `Granted`. `Denied`/`Unreachable` must block the dispatch.
async fn dispatch_write_with_gate(
    decision: ApprovalDecision,
    handler: &CreateEventHandler,
    request: ironclaw_host_runtime::FirstPartyCapabilityRequest,
) -> Result<(), RuntimeDispatchErrorKind> {
    match decision {
        ApprovalDecision::Granted => handler
            .dispatch(request)
            .await
            .map(|_| ())
            .map_err(|e| e.kind()),
        // Fail closed: an undecided/unreachable approval never reaches the
        // handler, so the side-effecting write is not silently executed.
        ApprovalDecision::Denied | ApprovalDecision::Unreachable => {
            Err(RuntimeDispatchErrorKind::Client)
        }
    }
}

#[tokio::test]
async fn write_capability_blocked_then_approved_then_succeeds() {
    let scope = test_scope();
    let secrets = Arc::new(InMemorySecretStore::new());
    seed_token(&secrets, &scope, &[scopes::CALENDAR_EVENTS]).await;
    let egress = FakeEgress::single(
        200,
        json!({ "id": "evt-created-099", "status": "confirmed" }),
    );
    let deps = build_deps(secrets, &[scopes::CALENDAR_EVENTS]);
    let handler = CreateEventHandler::new(deps);

    let make_request = || {
        calendar_request(
            "create_event",
            scope.clone(),
            json!({ "calendar_id": "primary", "event": { "summary": "Sprint planning" } }),
            egress.clone(),
        )
    };

    // Blocked: approval denied -> handler never runs, no network call.
    let blocked =
        dispatch_write_with_gate(ApprovalDecision::Denied, &handler, make_request()).await;
    assert!(blocked.is_err());
    assert!(
        egress.recorded().is_empty(),
        "denied write must not call the API"
    );

    // Approved: handler runs, the write reaches the API.
    let approved =
        dispatch_write_with_gate(ApprovalDecision::Granted, &handler, make_request()).await;
    assert!(approved.is_ok(), "approved write succeeds");
    assert_eq!(egress.recorded().len(), 1);
}

#[tokio::test]
async fn write_capability_fails_closed_when_approval_unreachable() {
    let scope = test_scope();
    let secrets = Arc::new(InMemorySecretStore::new());
    seed_token(&secrets, &scope, &[scopes::CALENDAR_EVENTS]).await;
    let egress = FakeEgress::single(200, json!({ "id": "evt-created-099" }));
    let deps = build_deps(secrets, &[scopes::CALENDAR_EVENTS]);
    let handler = CreateEventHandler::new(deps);

    let result = dispatch_write_with_gate(
        ApprovalDecision::Unreachable,
        &handler,
        calendar_request(
            "create_event",
            scope,
            json!({ "calendar_id": "primary", "event": { "summary": "x" } }),
            egress.clone(),
        ),
    )
    .await;

    // Fail closed: unreachable approval blocks the write entirely.
    assert!(result.is_err());
    assert!(
        egress.recorded().is_empty(),
        "unreachable approval must not let the write through"
    );
}

// ---------------------------------------------------------------------------
// Scope mismatch and missing credential.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn scope_mismatch_fails_with_client_error() {
    let scope = test_scope();
    let secrets = Arc::new(InMemorySecretStore::new());
    // The token only granted gmail scope; the handler requires calendar.events.
    seed_token(&secrets, &scope, &[scopes::GMAIL_READONLY]).await;
    let egress = FakeEgress::single(200, json!({ "id": "evt" }));
    let deps = build_deps(secrets, &[scopes::CALENDAR_EVENTS]);
    let handler = CreateEventHandler::new(deps);

    let error = handler
        .dispatch(calendar_request(
            "create_event",
            scope,
            json!({ "calendar_id": "primary", "event": {} }),
            egress.clone(),
        ))
        .await
        .expect_err("scope mismatch must fail");
    assert_eq!(error.kind(), RuntimeDispatchErrorKind::Client);
    // The scope check happens before any network call.
    assert!(egress.recorded().is_empty());
}

#[tokio::test]
async fn missing_credential_fails_closed() {
    let scope = test_scope();
    // No token seeded for this scope.
    let secrets = Arc::new(InMemorySecretStore::new());
    let egress = FakeEgress::single(200, json!({ "items": [] }));
    let deps = build_deps(secrets, &[scopes::CALENDAR_READONLY]);
    let handler = ListEventsHandler::new(deps);

    let error = handler
        .dispatch(calendar_request(
            "list_events",
            scope,
            json!({ "calendar_id": "primary" }),
            egress.clone(),
        ))
        .await
        .expect_err("missing credential must fail");
    assert_eq!(error.kind(), RuntimeDispatchErrorKind::Client);
    assert!(egress.recorded().is_empty());
}

#[tokio::test]
async fn google_error_response_maps_to_client_error() {
    let scope = test_scope();
    let secrets = Arc::new(InMemorySecretStore::new());
    seed_token(&secrets, &scope, &[scopes::CALENDAR_READONLY]).await;
    // Credential resolves, but Google rejects the call with 403.
    let egress = FakeEgress::single(403, json!({ "error": { "status": "PERMISSION_DENIED" } }));
    let deps = build_deps(secrets, &[scopes::CALENDAR_READONLY]);
    let handler = ListEventsHandler::new(deps);

    let error = handler
        .dispatch(calendar_request(
            "list_events",
            scope,
            json!({ "calendar_id": "primary" }),
            egress,
        ))
        .await
        .expect_err("403 must fail");
    assert_eq!(error.kind(), RuntimeDispatchErrorKind::Client);
}

// ---------------------------------------------------------------------------
// Redaction: handler output must not leak the access token or internal ids.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn handler_output_redacts_token_and_internal_ids() {
    let scope = test_scope();
    let secrets = Arc::new(InMemorySecretStore::new());
    seed_token(&secrets, &scope, &[scopes::CALENDAR_READONLY]).await;
    // Raw Google event carries internal fields and a sequence number.
    let raw = json!({
        "kind": "calendar#events",
        "items": [{
            "kind": "calendar#event",
            "id": "evt-1",
            "iCalUID": "evt-1@google.com",
            "etag": "\"99\"",
            "sequence": 5,
            "summary": "Secret meeting",
            "htmlLink": "https://calendar.google.com/event?eid=evt-1"
        }]
    });
    let egress = FakeEgress::single(200, raw);
    let deps = build_deps(secrets, &[scopes::CALENDAR_READONLY]);
    let handler = ListEventsHandler::new(deps);

    let result = handler
        .dispatch(calendar_request(
            "list_events",
            scope,
            json!({ "calendar_id": "primary" }),
            egress.clone(),
        ))
        .await
        .expect("list_events succeeds");

    let serialized = serde_json::to_string(&result.output).expect("output serializes");
    // The OAuth access token must never appear in handler output.
    assert!(
        !serialized.contains("ada-access-token"),
        "output leaked the access token: {serialized}"
    );
    assert!(!serialized.to_lowercase().contains("bearer"));
    // Internal Google ids must be stripped from the projection.
    assert!(!serialized.contains("iCalUID"));
    assert!(!serialized.contains("etag"));
    assert!(!serialized.contains("sequence"));
    // Whitelisted fields are still present.
    assert!(serialized.contains("Secret meeting"));
    assert!(serialized.contains("evt-1"));

    // The handler must not place the token on the outbound request itself; the
    // host egress injects the staged credential.
    let recorded = egress.recorded();
    let request_serialized = format!("{:?}", recorded[0].headers);
    assert!(!request_serialized.contains("ada-access-token"));
}

// ---------------------------------------------------------------------------
// Shared-credential lifecycle: install Calendar + (simulated) Gmail both add
// refs; uninstalling Calendar keeps the credential row alive while Gmail still
// holds a ref.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn shared_credential_survives_calendar_uninstall_while_gmail_holds_ref() {
    let scope = test_scope();
    let secrets = Arc::new(InMemorySecretStore::new());
    seed_token(&secrets, &scope, &[scopes::CALENDAR_READONLY]).await;
    let resolver = GoogleCredentialResolver::new(secrets.clone());

    let calendar = calendar_extension_id();
    let gmail = ironclaw_host_api::ExtensionId::new("gmail").expect("gmail id");

    // Install Calendar, then (simulated) Gmail — both register a ref.
    resolver
        .add_ref(&scope, &calendar)
        .await
        .expect("calendar ref added");
    let refs = resolver
        .add_ref(&scope, &gmail)
        .await
        .expect("gmail ref added");
    assert_eq!(refs.len(), 2, "both extensions hold a credential ref");

    // Uninstall Calendar — Gmail still holds a ref, so the row survives.
    let remaining = resolver
        .remove_ref(&scope, &calendar)
        .await
        .expect("calendar ref removed");
    assert_eq!(remaining, vec![gmail.clone()]);

    // The shared credential is still resolvable for Gmail.
    let provider = support::test_provider();
    let credential = resolver
        .resolve(
            &scope,
            provider.as_ref(),
            &[scopes::CALENDAR_READONLY.to_string()],
        )
        .await
        .expect("credential row still alive for Gmail");
    assert!(!credential.granted_scopes.is_empty());

    // Uninstall Gmail too — refs empty, credential row is deleted.
    let empty = resolver
        .remove_ref(&scope, &gmail)
        .await
        .expect("gmail ref removed");
    assert!(empty.is_empty());
    let after = resolver
        .resolve(
            &scope,
            provider.as_ref(),
            &[scopes::CALENDAR_READONLY.to_string()],
        )
        .await;
    assert!(
        after.is_err(),
        "credential row must be gone once all refs are released"
    );
}
