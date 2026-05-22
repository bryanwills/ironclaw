//! Read-path integration tests for the Google Calendar package.
//!
//! Exercises `list_calendars`, `list_events`, `get_event`, and
//! `find_free_slots` end to end through the `FirstPartyCapabilityHandler`
//! trait, driven by a fake `RuntimeHttpEgress` over recorded fixtures.

mod support;

use std::sync::Arc;

use ironclaw_host_api::RuntimeKind;
use ironclaw_host_runtime::FirstPartyCapabilityHandler;
use ironclaw_native_extensions::google::calendar::handlers::{
    FindFreeSlotsHandler, GetEventHandler, ListCalendarsHandler, ListEventsHandler,
};
use ironclaw_native_extensions::google::scopes;
use ironclaw_secrets::InMemorySecretStore;
use serde_json::{Value, json};

use support::{FakeEgress, build_deps, calendar_request, seed_token, test_scope};

fn fixture(name: &str) -> Value {
    let path = format!(
        "{}/tests/fixtures/google_api/calendar/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read fixture {path}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse fixture {path}: {e}"))
}

#[tokio::test]
async fn list_calendars_projects_whitelisted_fields() {
    let scope = test_scope();
    let secrets = Arc::new(InMemorySecretStore::new());
    seed_token(&secrets, &scope, &[scopes::CALENDAR_READONLY]).await;
    let egress = FakeEgress::single(200, fixture("calendar_list.json"));
    let deps = build_deps(secrets, &[scopes::CALENDAR_READONLY]);
    let handler = ListCalendarsHandler::new(deps);

    let result = handler
        .dispatch(calendar_request(
            "list_calendars",
            scope,
            json!({}),
            egress.clone(),
        ))
        .await
        .expect("list_calendars succeeds");

    let calendars = result
        .output
        .get("calendars")
        .and_then(Value::as_array)
        .unwrap();
    assert_eq!(calendars.len(), 2);
    assert_eq!(
        calendars[0].get("id").and_then(Value::as_str),
        Some("primary")
    );
    assert_eq!(
        calendars[0].get("primary").and_then(Value::as_bool),
        Some(true)
    );
    // etag is an internal field — it must not be projected into output.
    assert!(calendars[0].get("etag").is_none());

    // The handler issued exactly one GET to the calendarList endpoint, through
    // the host runtime-egress boundary (RuntimeKind::FirstParty).
    let recorded = egress.recorded();
    assert_eq!(recorded.len(), 1);
    assert!(recorded[0].url.contains("/users/me/calendarList"));
    assert_eq!(recorded[0].runtime, RuntimeKind::FirstParty);
    // The handler never sets an authorization header itself — the host egress
    // injects the staged credential.
    assert!(
        !recorded[0]
            .headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("authorization")),
        "handler must not inject the token itself"
    );
    assert_eq!(recorded[0].credential_injections.len(), 1);
}

#[tokio::test]
async fn list_events_applies_time_window_and_paging() {
    let scope = test_scope();
    let secrets = Arc::new(InMemorySecretStore::new());
    seed_token(&secrets, &scope, &[scopes::CALENDAR_READONLY]).await;
    let egress = FakeEgress::single(200, fixture("events_list.json"));
    let deps = build_deps(secrets, &[scopes::CALENDAR_READONLY]);
    let handler = ListEventsHandler::new(deps);

    let result = handler
        .dispatch(calendar_request(
            "list_events",
            scope,
            json!({
                "calendar_id": "primary",
                "time_min": "2026-05-21T00:00:00Z",
                "time_max": "2026-05-22T00:00:00Z",
                "max_results": 50
            }),
            egress.clone(),
        ))
        .await
        .expect("list_events succeeds");

    let events = result
        .output
        .get("events")
        .and_then(Value::as_array)
        .unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0].get("summary").and_then(Value::as_str),
        Some("Daily standup")
    );
    assert_eq!(
        result.output.get("next_page_token").and_then(Value::as_str),
        Some("CiAKGjBpNDd2Nm")
    );

    let recorded = egress.recorded();
    assert_eq!(recorded.len(), 1);
    let url = &recorded[0].url;
    assert!(url.contains("/calendars/primary/events"));
    assert!(url.contains("timeMin=2026-05-21T00%3A00%3A00Z"));
    assert!(url.contains("timeMax=2026-05-22T00%3A00%3A00Z"));
    assert!(url.contains("maxResults=50"));
}

#[tokio::test]
async fn get_event_returns_single_event() {
    let scope = test_scope();
    let secrets = Arc::new(InMemorySecretStore::new());
    seed_token(&secrets, &scope, &[scopes::CALENDAR_READONLY]).await;
    let egress = FakeEgress::single(200, fixture("event_get.json"));
    let deps = build_deps(secrets, &[scopes::CALENDAR_READONLY]);
    let handler = GetEventHandler::new(deps);

    let result = handler
        .dispatch(calendar_request(
            "get_event",
            scope,
            json!({ "calendar_id": "primary", "event_id": "evt-standup-001" }),
            egress.clone(),
        ))
        .await
        .expect("get_event succeeds");

    assert_eq!(
        result.output.get("id").and_then(Value::as_str),
        Some("evt-standup-001")
    );
    let recorded = egress.recorded();
    assert!(recorded[0].url.contains("/events/evt-standup-001"));
}

#[tokio::test]
async fn find_free_slots_inverts_busy_intervals() {
    let scope = test_scope();
    let secrets = Arc::new(InMemorySecretStore::new());
    seed_token(&secrets, &scope, &[scopes::CALENDAR_READONLY]).await;
    let egress = FakeEgress::single(200, fixture("free_busy.json"));
    let deps = build_deps(secrets, &[scopes::CALENDAR_READONLY]);
    let handler = FindFreeSlotsHandler::new(deps);

    let result = handler
        .dispatch(calendar_request(
            "find_free_slots",
            scope,
            json!({
                "time_min": "2026-05-21T09:00:00Z",
                "time_max": "2026-05-21T17:00:00Z",
                "calendar_ids": ["primary"]
            }),
            egress.clone(),
        ))
        .await
        .expect("find_free_slots succeeds");

    let busy = result.output.get("busy").and_then(Value::as_array).unwrap();
    assert_eq!(busy.len(), 2);
    let free = result.output.get("free").and_then(Value::as_array).unwrap();
    // Two busy windows inside the 9-17 range yield three free windows.
    assert_eq!(free.len(), 3);
    assert_eq!(
        free[0].get("start").and_then(Value::as_str),
        Some("2026-05-21T09:00:00Z")
    );
    assert_eq!(
        free[2].get("end").and_then(Value::as_str),
        Some("2026-05-21T17:00:00Z")
    );

    // free_busy is a POST to the /freeBusy endpoint.
    let recorded = egress.recorded();
    assert!(recorded[0].url.contains("/freeBusy"));
}
