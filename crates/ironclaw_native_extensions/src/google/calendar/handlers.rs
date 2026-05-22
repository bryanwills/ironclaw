//! First-party capability handlers for the nine Google Calendar capabilities.
//!
//! Each handler is an `Arc`-shared struct holding the construction-time
//! dependencies (the credential resolver and the shared `OAuthProvider`). On
//! dispatch a handler:
//!
//! 1. parses and validates its typed input,
//! 2. resolves the shared `google_oauth_token` credential metadata for the
//!    request scope, failing closed on a missing credential or a scope
//!    mismatch (the handler reads only `granted_scopes`/`missing_scopes`, never
//!    the raw token),
//! 3. issues the Google Calendar API call through the per-invocation
//!    [`RuntimeHttpEgress`] supplied in `request.services.runtime_http_egress`,
//!    declaring a host-staged credential injection so the host egress service
//!    leases, injects, redacts, and audits the `google_oauth_token` — the
//!    handler never holds the access token or its own HTTP transport,
//! 4. projects the raw Google response onto a whitelisted output struct so no
//!    access token or internal id leaks into handler output.
//!
//! Routing through `runtime_http_egress` keeps these handlers behind the
//! host's fail-closed egress boundary (`HostHttpEgressService`): staged
//! network policy, credential injection, redaction, auditing, and the ability
//! to disable outbound HTTP in tests all apply. Building a standalone
//! transport would bypass that boundary.
//!
//! Approval gating for the five write capabilities is *not* implemented here —
//! it is descriptor-level (`PermissionMode::Ask` + `EffectKind::ExternalWrite`,
//! see [`super::manifest`]). The host authorization layer is responsible for
//! blocking an unapproved write before `dispatch` is ever called.

use std::time::Instant;

use async_trait::async_trait;
use ironclaw_host_api::{
    NetworkMethod, NetworkPolicy, ResourceScope, ResourceUsage, RuntimeCredentialInjection,
    RuntimeCredentialSource, RuntimeCredentialTarget, RuntimeDispatchErrorKind,
    RuntimeHttpEgressError, RuntimeHttpEgressReasonCode, RuntimeHttpEgressRequest, RuntimeKind,
    SecretHandle,
};
use ironclaw_host_runtime::{
    FirstPartyCapabilityError, FirstPartyCapabilityHandler, FirstPartyCapabilityRequest,
    FirstPartyCapabilityResult,
};
use ironclaw_oauth::OAuthProvider;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

use crate::google::credential::{
    GOOGLE_CREDENTIAL_NAME, GoogleCredentialError, GoogleCredentialResolver,
};

const CALENDAR_API_BASE: &str = "https://www.googleapis.com/calendar/v3";

/// Cap on a Google Calendar response body (1 MiB).
const RESPONSE_BODY_LIMIT: u64 = 1024 * 1024;

/// Per-call host-egress timeout.
const TIMEOUT_MS: u32 = 30_000;

/// Shared construction-time dependencies for every calendar handler.
///
/// Handlers no longer own an HTTP client: the transport is the per-invocation
/// [`RuntimeHttpEgress`](ironclaw_host_api::RuntimeHttpEgress) from
/// `InvocationServices`. The resolver is retained only to read credential
/// metadata (`granted_scopes`) for a scope-mismatch preflight; the raw token
/// is leased and injected by the host egress service.
#[derive(Clone)]
pub struct CalendarHandlerDeps {
    resolver: Arc<GoogleCredentialResolver>,
    provider: Arc<dyn OAuthProvider>,
    /// OAuth scopes this capability requires (`calendar.readonly` /
    /// `calendar.events`).
    required_scopes: Vec<String>,
}

impl CalendarHandlerDeps {
    pub fn new(
        resolver: Arc<GoogleCredentialResolver>,
        provider: Arc<dyn OAuthProvider>,
        required_scopes: Vec<String>,
    ) -> Self {
        Self {
            resolver,
            provider,
            required_scopes,
        }
    }

    /// Preflight the shared Google credential, failing closed on a missing
    /// credential or an OAuth scope mismatch.
    ///
    /// This only inspects credential *metadata*: it never returns or logs the
    /// access token. The token itself is leased and injected by the host
    /// egress service via the staged credential-injection plan.
    async fn preflight_credential(
        &self,
        scope: &ResourceScope,
    ) -> Result<(), FirstPartyCapabilityError> {
        let credential = self
            .resolver
            .resolve(scope, self.provider.as_ref(), &self.required_scopes)
            .await
            .map_err(map_credential_error)?;
        if !credential.missing_scopes.is_empty() {
            // Scope mismatch is an authorization failure the user must resolve
            // by re-consenting; surface it as a client error (phase-5 scope).
            // The auth-required run-state transition is owned by the phase-2
            // host obligation layer.
            return Err(FirstPartyCapabilityError::new(
                RuntimeDispatchErrorKind::Client,
            ));
        }
        Ok(())
    }
}

/// Map a credential-resolution failure to a redacted dispatch error.
fn map_credential_error(error: GoogleCredentialError) -> FirstPartyCapabilityError {
    let kind = match error {
        // Missing credential: fail closed — the user has not connected Google.
        // The host obligation layer (phase 2) is responsible for translating
        // this into an auth-required run-state transition / OAuth bootstrap.
        GoogleCredentialError::Missing => RuntimeDispatchErrorKind::Client,
        _ => RuntimeDispatchErrorKind::Backend,
    };
    FirstPartyCapabilityError::new(kind)
}

/// Map a host runtime-egress failure to a redacted [`RuntimeDispatchErrorKind`].
///
/// Mirrors the built-in `builtin.http` handler's mapping so first-party
/// network failures are classified consistently.
fn map_egress_error(error: &RuntimeHttpEgressError) -> FirstPartyCapabilityError {
    let kind = match error.reason_code() {
        RuntimeHttpEgressReasonCode::CredentialUnavailable => RuntimeDispatchErrorKind::Client,
        RuntimeHttpEgressReasonCode::RequestDenied => RuntimeDispatchErrorKind::InputEncode,
        RuntimeHttpEgressReasonCode::NetworkError => RuntimeDispatchErrorKind::NetworkDenied,
        RuntimeHttpEgressReasonCode::ResponseError => RuntimeDispatchErrorKind::OutputDecode,
        RuntimeHttpEgressReasonCode::ResponseBodyLimitExceeded => {
            RuntimeDispatchErrorKind::OutputTooLarge
        }
    };
    FirstPartyCapabilityError::new(kind)
}

/// Parse a handler's typed input, mapping a decode failure to `InputEncode`.
fn parse_input<T: for<'de> Deserialize<'de>>(input: Value) -> Result<T, FirstPartyCapabilityError> {
    serde_json::from_value(input)
        .map_err(|_| FirstPartyCapabilityError::new(RuntimeDispatchErrorKind::InputEncode))
}

/// Serialize a handler's whitelisted output, mapping a failure to `InvalidResult`.
fn encode_output<T: Serialize>(output: &T) -> Result<Value, FirstPartyCapabilityError> {
    serde_json::to_value(output)
        .map_err(|_| FirstPartyCapabilityError::new(RuntimeDispatchErrorKind::InvalidResult))
}

/// Build a `FirstPartyCapabilityResult` with wall-clock and output-byte usage.
fn finish(output: Value, started: Instant) -> FirstPartyCapabilityResult {
    let wall_clock_ms = started.elapsed().as_millis().try_into().unwrap_or(u64::MAX);
    let output_bytes = serde_json::to_vec(&output)
        .map(|b| b.len() as u64)
        .unwrap_or(0);
    FirstPartyCapabilityResult::new(
        output,
        ResourceUsage {
            wall_clock_ms,
            output_bytes,
            ..ResourceUsage::default()
        },
    )
}

/// URL-encode a path segment (calendar id / event id) so ids containing `@`,
/// `#`, or `/` cannot escape the intended Calendar API path.
fn encode_segment(segment: &str) -> String {
    let mut encoded = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// The host-staged credential-injection plan for a Google Calendar call.
///
/// The handler declares *what* should be injected — the `google_oauth_token`
/// secret, into the `authorization` header with a `Bearer ` prefix — sourced
/// from a `StagedObligation` for this capability. The host egress service
/// (`HostHttpEgressService`) is what leases the secret and performs the
/// injection; the handler never touches the token material.
fn google_credential_injection(
    capability_id: &ironclaw_host_api::CapabilityId,
) -> Result<RuntimeCredentialInjection, FirstPartyCapabilityError> {
    let handle = SecretHandle::new(GOOGLE_CREDENTIAL_NAME)
        .map_err(|_| FirstPartyCapabilityError::new(RuntimeDispatchErrorKind::Backend))?;
    Ok(RuntimeCredentialInjection {
        handle,
        source: RuntimeCredentialSource::StagedObligation {
            capability_id: capability_id.clone(),
        },
        target: RuntimeCredentialTarget::Header {
            name: "authorization".to_string(),
            prefix: Some("Bearer ".to_string()),
        },
        required: true,
    })
}

/// Issue a Google Calendar API call through the host runtime-egress boundary.
///
/// `body` is `None` for `GET`/`DELETE` and `Some(json)` for write methods. The
/// JSON response body is parsed and returned; an empty `2xx` body (Google
/// `DELETE`) becomes [`Value::Null`].
async fn call_google(
    request: &FirstPartyCapabilityRequest,
    method: NetworkMethod,
    url: String,
    body: Option<Value>,
) -> Result<Value, FirstPartyCapabilityError> {
    let egress = request
        .services
        .runtime_http_egress
        .as_ref()
        .ok_or_else(|| FirstPartyCapabilityError::new(RuntimeDispatchErrorKind::NetworkDenied))?
        .clone();

    let mut headers = Vec::new();
    let body_bytes = match body {
        Some(value) => {
            headers.push(("content-type".to_string(), "application/json".to_string()));
            serde_json::to_vec(&value).map_err(|_| {
                FirstPartyCapabilityError::new(RuntimeDispatchErrorKind::InputEncode)
            })?
        }
        None => Vec::new(),
    };

    let http_request = RuntimeHttpEgressRequest {
        runtime: RuntimeKind::FirstParty,
        scope: request.scope.clone(),
        capability_id: request.capability_id.clone(),
        method,
        url,
        headers,
        body: body_bytes,
        // First-party network policy is staged in HostHttpEgressService from
        // the grant obligation for this scope/capability; this fallback field
        // is ignored on the production path and only used by test services.
        network_policy: NetworkPolicy::default(),
        credential_injections: vec![google_credential_injection(&request.capability_id)?],
        response_body_limit: Some(RESPONSE_BODY_LIMIT),
        timeout_ms: Some(TIMEOUT_MS),
    };

    let response = tokio::task::spawn_blocking(move || egress.execute(http_request))
        .await
        .map_err(|_| FirstPartyCapabilityError::new(RuntimeDispatchErrorKind::Backend))?
        .map_err(|error| map_egress_error(&error))?;

    if !(200..300).contains(&response.status) {
        // Non-2xx Google responses (auth/scope/quota failures) are surfaced as
        // client errors in phase-5 scope; the phase-2 host layer owns the
        // auth-required run-state transition.
        return Err(FirstPartyCapabilityError::new(
            RuntimeDispatchErrorKind::Client,
        ));
    }
    if response.body.iter().all(u8::is_ascii_whitespace) {
        // Empty 2xx body (Google `DELETE`) is a valid, successful result.
        return Ok(Value::Null);
    }
    serde_json::from_slice(&response.body)
        .map_err(|_| FirstPartyCapabilityError::new(RuntimeDispatchErrorKind::OutputDecode))
}

// ---------------------------------------------------------------------------
// Whitelisted output projections.
//
// Output structs deliberately project only non-sensitive, whitelisted fields
// (id, summary, times, attendees, status, links, reminders). The raw Google
// response is never echoed, and the access token never appears in output.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct CalendarSummary {
    id: String,
    summary: Option<String>,
    description: Option<String>,
    time_zone: Option<String>,
    primary: Option<bool>,
    access_role: Option<String>,
}

impl CalendarSummary {
    fn from_google(value: &Value) -> Self {
        Self {
            id: string_field(value, "id").unwrap_or_default(),
            summary: string_field(value, "summary"),
            description: string_field(value, "description"),
            time_zone: string_field(value, "timeZone"),
            primary: value.get("primary").and_then(Value::as_bool),
            access_role: string_field(value, "accessRole"),
        }
    }
}

#[derive(Debug, Serialize)]
struct ListCalendarsOutput {
    calendars: Vec<CalendarSummary>,
}

#[derive(Debug, Serialize)]
struct EventTime {
    date: Option<String>,
    date_time: Option<String>,
    time_zone: Option<String>,
}

impl EventTime {
    fn from_google(value: Option<&Value>) -> Option<Self> {
        let value = value?;
        Some(Self {
            date: string_field(value, "date"),
            date_time: string_field(value, "dateTime"),
            time_zone: string_field(value, "timeZone"),
        })
    }
}

#[derive(Debug, Serialize)]
struct EventAttendee {
    email: Option<String>,
    display_name: Option<String>,
    response_status: Option<String>,
    optional: Option<bool>,
    organizer: Option<bool>,
}

impl EventAttendee {
    fn from_google(value: &Value) -> Self {
        Self {
            email: string_field(value, "email"),
            display_name: string_field(value, "displayName"),
            response_status: string_field(value, "responseStatus"),
            optional: value.get("optional").and_then(Value::as_bool),
            organizer: value.get("organizer").and_then(Value::as_bool),
        }
    }
}

#[derive(Debug, Serialize)]
struct ReminderOverride {
    method: Option<String>,
    minutes: Option<i64>,
}

#[derive(Debug, Serialize)]
struct EventReminders {
    use_default: Option<bool>,
    overrides: Vec<ReminderOverride>,
}

impl EventReminders {
    fn from_google(value: Option<&Value>) -> Option<Self> {
        let value = value?;
        let overrides = value
            .get("overrides")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| ReminderOverride {
                        method: string_field(item, "method"),
                        minutes: item.get("minutes").and_then(Value::as_i64),
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            use_default: value.get("useDefault").and_then(Value::as_bool),
            overrides,
        })
    }
}

/// Whitelisted projection of a Google Calendar event.
///
/// Internal fields (`iCalUID`, `etag`, `sequence`, `kind`, raw `extendedProperties`)
/// are intentionally dropped. Only user-meaningful, non-sensitive fields are kept.
#[derive(Debug, Serialize)]
struct EventOutput {
    id: String,
    status: Option<String>,
    summary: Option<String>,
    description: Option<String>,
    location: Option<String>,
    html_link: Option<String>,
    start: Option<EventTime>,
    end: Option<EventTime>,
    attendees: Vec<EventAttendee>,
    reminders: Option<EventReminders>,
}

impl EventOutput {
    fn from_google(value: &Value) -> Self {
        let attendees = value
            .get("attendees")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(EventAttendee::from_google).collect())
            .unwrap_or_default();
        Self {
            id: string_field(value, "id").unwrap_or_default(),
            status: string_field(value, "status"),
            summary: string_field(value, "summary"),
            description: string_field(value, "description"),
            location: string_field(value, "location"),
            html_link: string_field(value, "htmlLink"),
            start: EventTime::from_google(value.get("start")),
            end: EventTime::from_google(value.get("end")),
            attendees,
            reminders: EventReminders::from_google(value.get("reminders")),
        }
    }
}

#[derive(Debug, Serialize)]
struct ListEventsOutput {
    events: Vec<EventOutput>,
    next_page_token: Option<String>,
}

#[derive(Debug, Serialize)]
struct DeletedEventOutput {
    id: String,
    deleted: bool,
}

#[derive(Debug, Serialize)]
struct FreeBusyInterval {
    start: Option<String>,
    end: Option<String>,
}

#[derive(Debug, Serialize)]
struct FreeSlotsOutput {
    /// The free-window query bounds, echoed back.
    window_start: String,
    window_end: String,
    /// Busy intervals merged across all queried calendars.
    busy: Vec<FreeBusyInterval>,
    /// Free intervals computed as the complement of `busy` within the window.
    free: Vec<FreeBusyInterval>,
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

// ---------------------------------------------------------------------------
// Typed inputs.
// ---------------------------------------------------------------------------

fn default_calendar_id() -> String {
    "primary".to_string()
}

#[derive(Debug, Deserialize)]
struct ListEventsInput {
    #[serde(default = "default_calendar_id")]
    calendar_id: String,
    #[serde(default)]
    time_min: Option<String>,
    #[serde(default)]
    time_max: Option<String>,
    #[serde(default)]
    max_results: Option<u32>,
    #[serde(default)]
    page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GetEventInput {
    #[serde(default = "default_calendar_id")]
    calendar_id: String,
    event_id: String,
}

#[derive(Debug, Deserialize)]
struct FindFreeSlotsInput {
    time_min: String,
    time_max: String,
    #[serde(default)]
    calendar_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct CreateEventInput {
    #[serde(default = "default_calendar_id")]
    calendar_id: String,
    /// The Google `events.insert` request body. Passed through verbatim so the
    /// caller controls summary/start/end/attendees/etc.
    event: Value,
}

#[derive(Debug, Deserialize)]
struct UpdateEventInput {
    #[serde(default = "default_calendar_id")]
    calendar_id: String,
    event_id: String,
    /// Partial event body merged via `events.patch`.
    patch: Value,
}

#[derive(Debug, Deserialize)]
struct DeleteEventInput {
    #[serde(default = "default_calendar_id")]
    calendar_id: String,
    event_id: String,
}

#[derive(Debug, Deserialize)]
struct AttendeeInput {
    email: String,
    #[serde(default)]
    optional: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct AddAttendeesInput {
    #[serde(default = "default_calendar_id")]
    calendar_id: String,
    event_id: String,
    attendees: Vec<AttendeeInput>,
}

#[derive(Debug, Deserialize)]
struct ReminderInput {
    method: String,
    minutes: i64,
}

#[derive(Debug, Deserialize)]
struct SetReminderInput {
    #[serde(default = "default_calendar_id")]
    calendar_id: String,
    event_id: String,
    #[serde(default)]
    use_default: bool,
    #[serde(default)]
    reminders: Vec<ReminderInput>,
}

// ---------------------------------------------------------------------------
// Read handlers.
// ---------------------------------------------------------------------------

/// `google-calendar.list_calendars` — list the user's calendars.
pub struct ListCalendarsHandler {
    deps: CalendarHandlerDeps,
}

impl ListCalendarsHandler {
    pub fn new(deps: CalendarHandlerDeps) -> Self {
        Self { deps }
    }
}

#[async_trait]
impl FirstPartyCapabilityHandler for ListCalendarsHandler {
    async fn dispatch(
        &self,
        request: FirstPartyCapabilityRequest,
    ) -> Result<FirstPartyCapabilityResult, FirstPartyCapabilityError> {
        let started = Instant::now();
        self.deps.preflight_credential(&request.scope).await?;
        let url = format!("{CALENDAR_API_BASE}/users/me/calendarList");
        let body = call_google(&request, NetworkMethod::Get, url, None).await?;
        let calendars = body
            .get("items")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(CalendarSummary::from_google).collect())
            .unwrap_or_default();
        let output = encode_output(&ListCalendarsOutput { calendars })?;
        Ok(finish(output, started))
    }
}

/// `google-calendar.list_events` — list events on a calendar.
pub struct ListEventsHandler {
    deps: CalendarHandlerDeps,
}

impl ListEventsHandler {
    pub fn new(deps: CalendarHandlerDeps) -> Self {
        Self { deps }
    }
}

#[async_trait]
impl FirstPartyCapabilityHandler for ListEventsHandler {
    async fn dispatch(
        &self,
        request: FirstPartyCapabilityRequest,
    ) -> Result<FirstPartyCapabilityResult, FirstPartyCapabilityError> {
        let started = Instant::now();
        let input: ListEventsInput = parse_input(request.input.clone())?;
        self.deps.preflight_credential(&request.scope).await?;
        let mut url = format!(
            "{CALENDAR_API_BASE}/calendars/{}/events?singleEvents=true&orderBy=startTime",
            encode_segment(&input.calendar_id)
        );
        if let Some(time_min) = &input.time_min {
            url.push_str(&format!("&timeMin={}", encode_segment(time_min)));
        }
        if let Some(time_max) = &input.time_max {
            url.push_str(&format!("&timeMax={}", encode_segment(time_max)));
        }
        if let Some(max_results) = input.max_results {
            url.push_str(&format!("&maxResults={max_results}"));
        }
        if let Some(page_token) = &input.page_token {
            url.push_str(&format!("&pageToken={}", encode_segment(page_token)));
        }
        let body = call_google(&request, NetworkMethod::Get, url, None).await?;
        let events = body
            .get("items")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(EventOutput::from_google).collect())
            .unwrap_or_default();
        let output = encode_output(&ListEventsOutput {
            events,
            next_page_token: string_field(&body, "nextPageToken"),
        })?;
        Ok(finish(output, started))
    }
}

/// `google-calendar.get_event` — fetch one event by id.
pub struct GetEventHandler {
    deps: CalendarHandlerDeps,
}

impl GetEventHandler {
    pub fn new(deps: CalendarHandlerDeps) -> Self {
        Self { deps }
    }
}

#[async_trait]
impl FirstPartyCapabilityHandler for GetEventHandler {
    async fn dispatch(
        &self,
        request: FirstPartyCapabilityRequest,
    ) -> Result<FirstPartyCapabilityResult, FirstPartyCapabilityError> {
        let started = Instant::now();
        let input: GetEventInput = parse_input(request.input.clone())?;
        self.deps.preflight_credential(&request.scope).await?;
        let url = format!(
            "{CALENDAR_API_BASE}/calendars/{}/events/{}",
            encode_segment(&input.calendar_id),
            encode_segment(&input.event_id)
        );
        let body = call_google(&request, NetworkMethod::Get, url, None).await?;
        let output = encode_output(&EventOutput::from_google(&body))?;
        Ok(finish(output, started))
    }
}

/// `google-calendar.find_free_slots` — free/busy computation over calendars.
pub struct FindFreeSlotsHandler {
    deps: CalendarHandlerDeps,
}

impl FindFreeSlotsHandler {
    pub fn new(deps: CalendarHandlerDeps) -> Self {
        Self { deps }
    }
}

#[async_trait]
impl FirstPartyCapabilityHandler for FindFreeSlotsHandler {
    async fn dispatch(
        &self,
        request: FirstPartyCapabilityRequest,
    ) -> Result<FirstPartyCapabilityResult, FirstPartyCapabilityError> {
        let started = Instant::now();
        let input: FindFreeSlotsInput = parse_input(request.input.clone())?;
        self.deps.preflight_credential(&request.scope).await?;
        let calendar_ids = if input.calendar_ids.is_empty() {
            vec![default_calendar_id()]
        } else {
            input.calendar_ids.clone()
        };
        let request_body = serde_json::json!({
            "timeMin": input.time_min,
            "timeMax": input.time_max,
            "items": calendar_ids
                .iter()
                .map(|id| serde_json::json!({ "id": id }))
                .collect::<Vec<_>>(),
        });
        let url = format!("{CALENDAR_API_BASE}/freeBusy");
        let body = call_google(&request, NetworkMethod::Post, url, Some(request_body)).await?;
        let busy = merge_busy_intervals(&body);
        let free = complement_free_intervals(&input.time_min, &input.time_max, &busy);
        let output = encode_output(&FreeSlotsOutput {
            window_start: input.time_min,
            window_end: input.time_max,
            busy,
            free,
        })?;
        Ok(finish(output, started))
    }
}

/// Collect and sort all busy intervals across every calendar in a `freeBusy`
/// response.
fn merge_busy_intervals(body: &Value) -> Vec<FreeBusyInterval> {
    let mut intervals: Vec<FreeBusyInterval> = Vec::new();
    if let Some(calendars) = body.get("calendars").and_then(Value::as_object) {
        for calendar in calendars.values() {
            if let Some(busy) = calendar.get("busy").and_then(Value::as_array) {
                for slot in busy {
                    intervals.push(FreeBusyInterval {
                        start: string_field(slot, "start"),
                        end: string_field(slot, "end"),
                    });
                }
            }
        }
    }
    intervals.sort_by(|a, b| a.start.cmp(&b.start));
    intervals
}

/// Compute free intervals as the complement of `busy` within `[time_min, time_max]`.
///
/// Timestamps are compared lexicographically; RFC 3339 UTC strings sort
/// chronologically, which is what the Google `freeBusy` API returns.
fn complement_free_intervals(
    time_min: &str,
    time_max: &str,
    busy: &[FreeBusyInterval],
) -> Vec<FreeBusyInterval> {
    let mut free = Vec::new();
    let mut cursor = time_min.to_string();
    for slot in busy {
        let (Some(start), Some(end)) = (slot.start.as_ref(), slot.end.as_ref()) else {
            continue;
        };
        if start.as_str() > cursor.as_str() {
            free.push(FreeBusyInterval {
                start: Some(cursor.clone()),
                end: Some(start.clone()),
            });
        }
        if end.as_str() > cursor.as_str() {
            cursor = end.clone();
        }
    }
    if cursor.as_str() < time_max {
        free.push(FreeBusyInterval {
            start: Some(cursor),
            end: Some(time_max.to_string()),
        });
    }
    free
}

// ---------------------------------------------------------------------------
// Write handlers — all descriptor-gated with `PermissionMode::Ask`.
// ---------------------------------------------------------------------------

/// `google-calendar.create_event` — create a new event (RequiresApproval).
pub struct CreateEventHandler {
    deps: CalendarHandlerDeps,
}

impl CreateEventHandler {
    pub fn new(deps: CalendarHandlerDeps) -> Self {
        Self { deps }
    }
}

#[async_trait]
impl FirstPartyCapabilityHandler for CreateEventHandler {
    async fn dispatch(
        &self,
        request: FirstPartyCapabilityRequest,
    ) -> Result<FirstPartyCapabilityResult, FirstPartyCapabilityError> {
        let started = Instant::now();
        let input: CreateEventInput = parse_input(request.input.clone())?;
        self.deps.preflight_credential(&request.scope).await?;
        let url = format!(
            "{CALENDAR_API_BASE}/calendars/{}/events",
            encode_segment(&input.calendar_id)
        );
        let body = call_google(&request, NetworkMethod::Post, url, Some(input.event)).await?;
        let output = encode_output(&EventOutput::from_google(&body))?;
        Ok(finish(output, started))
    }
}

/// `google-calendar.update_event` — patch an existing event (RequiresApproval).
pub struct UpdateEventHandler {
    deps: CalendarHandlerDeps,
}

impl UpdateEventHandler {
    pub fn new(deps: CalendarHandlerDeps) -> Self {
        Self { deps }
    }
}

#[async_trait]
impl FirstPartyCapabilityHandler for UpdateEventHandler {
    async fn dispatch(
        &self,
        request: FirstPartyCapabilityRequest,
    ) -> Result<FirstPartyCapabilityResult, FirstPartyCapabilityError> {
        let started = Instant::now();
        let input: UpdateEventInput = parse_input(request.input.clone())?;
        self.deps.preflight_credential(&request.scope).await?;
        let url = format!(
            "{CALENDAR_API_BASE}/calendars/{}/events/{}",
            encode_segment(&input.calendar_id),
            encode_segment(&input.event_id)
        );
        let body = call_google(&request, NetworkMethod::Patch, url, Some(input.patch)).await?;
        let output = encode_output(&EventOutput::from_google(&body))?;
        Ok(finish(output, started))
    }
}

/// `google-calendar.delete_event` — delete an event (RequiresApproval).
pub struct DeleteEventHandler {
    deps: CalendarHandlerDeps,
}

impl DeleteEventHandler {
    pub fn new(deps: CalendarHandlerDeps) -> Self {
        Self { deps }
    }
}

#[async_trait]
impl FirstPartyCapabilityHandler for DeleteEventHandler {
    async fn dispatch(
        &self,
        request: FirstPartyCapabilityRequest,
    ) -> Result<FirstPartyCapabilityResult, FirstPartyCapabilityError> {
        let started = Instant::now();
        let input: DeleteEventInput = parse_input(request.input.clone())?;
        self.deps.preflight_credential(&request.scope).await?;
        let url = format!(
            "{CALENDAR_API_BASE}/calendars/{}/events/{}",
            encode_segment(&input.calendar_id),
            encode_segment(&input.event_id)
        );
        call_google(&request, NetworkMethod::Delete, url, None).await?;
        let output = encode_output(&DeletedEventOutput {
            id: input.event_id,
            deleted: true,
        })?;
        Ok(finish(output, started))
    }
}

/// `google-calendar.add_attendees` — add attendees to an event (RequiresApproval).
pub struct AddAttendeesHandler {
    deps: CalendarHandlerDeps,
}

impl AddAttendeesHandler {
    pub fn new(deps: CalendarHandlerDeps) -> Self {
        Self { deps }
    }
}

#[async_trait]
impl FirstPartyCapabilityHandler for AddAttendeesHandler {
    async fn dispatch(
        &self,
        request: FirstPartyCapabilityRequest,
    ) -> Result<FirstPartyCapabilityResult, FirstPartyCapabilityError> {
        let started = Instant::now();
        let input: AddAttendeesInput = parse_input(request.input.clone())?;
        self.deps.preflight_credential(&request.scope).await?;
        let url = format!(
            "{CALENDAR_API_BASE}/calendars/{}/events/{}",
            encode_segment(&input.calendar_id),
            encode_segment(&input.event_id)
        );
        // Fetch the current event so attendees are merged, not overwritten.
        let current = call_google(&request, NetworkMethod::Get, url.clone(), None).await?;
        let mut attendees = current
            .get("attendees")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for attendee in &input.attendees {
            let mut entry = serde_json::Map::new();
            entry.insert("email".to_string(), Value::String(attendee.email.clone()));
            if let Some(optional) = attendee.optional {
                entry.insert("optional".to_string(), Value::Bool(optional));
            }
            attendees.push(Value::Object(entry));
        }
        let patch = serde_json::json!({ "attendees": attendees });
        let body = call_google(&request, NetworkMethod::Patch, url, Some(patch)).await?;
        let output = encode_output(&EventOutput::from_google(&body))?;
        Ok(finish(output, started))
    }
}

/// `google-calendar.set_reminder` — set reminder overrides (RequiresApproval).
pub struct SetReminderHandler {
    deps: CalendarHandlerDeps,
}

impl SetReminderHandler {
    pub fn new(deps: CalendarHandlerDeps) -> Self {
        Self { deps }
    }
}

#[async_trait]
impl FirstPartyCapabilityHandler for SetReminderHandler {
    async fn dispatch(
        &self,
        request: FirstPartyCapabilityRequest,
    ) -> Result<FirstPartyCapabilityResult, FirstPartyCapabilityError> {
        let started = Instant::now();
        let input: SetReminderInput = parse_input(request.input.clone())?;
        self.deps.preflight_credential(&request.scope).await?;
        let url = format!(
            "{CALENDAR_API_BASE}/calendars/{}/events/{}",
            encode_segment(&input.calendar_id),
            encode_segment(&input.event_id)
        );
        let overrides = input
            .reminders
            .iter()
            .map(|reminder| {
                serde_json::json!({
                    "method": reminder.method,
                    "minutes": reminder.minutes,
                })
            })
            .collect::<Vec<_>>();
        let patch = serde_json::json!({
            "reminders": {
                "useDefault": input.use_default,
                "overrides": overrides,
            }
        });
        let body = call_google(&request, NetworkMethod::Patch, url, Some(patch)).await?;
        let output = encode_output(&EventOutput::from_google(&body))?;
        Ok(finish(output, started))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_segment_escapes_path_breaking_characters() {
        assert_eq!(encode_segment("primary"), "primary");
        assert_eq!(encode_segment("user@example.com"), "user%40example.com");
        assert_eq!(encode_segment("a/b"), "a%2Fb");
    }

    #[test]
    fn complement_free_intervals_inverts_busy_windows() {
        let busy = vec![
            FreeBusyInterval {
                start: Some("2026-05-21T10:00:00Z".to_string()),
                end: Some("2026-05-21T11:00:00Z".to_string()),
            },
            FreeBusyInterval {
                start: Some("2026-05-21T13:00:00Z".to_string()),
                end: Some("2026-05-21T14:00:00Z".to_string()),
            },
        ];
        let free = complement_free_intervals("2026-05-21T09:00:00Z", "2026-05-21T17:00:00Z", &busy);
        assert_eq!(free.len(), 3);
        assert_eq!(free[0].start.as_deref(), Some("2026-05-21T09:00:00Z"));
        assert_eq!(free[0].end.as_deref(), Some("2026-05-21T10:00:00Z"));
        assert_eq!(free[2].end.as_deref(), Some("2026-05-21T17:00:00Z"));
    }

    #[test]
    fn event_output_drops_internal_fields() {
        let raw = serde_json::json!({
            "id": "evt-1",
            "iCalUID": "abc@google.com",
            "etag": "\"123\"",
            "sequence": 7,
            "summary": "Standup",
            "htmlLink": "https://calendar.google.com/event?eid=evt-1"
        });
        let projected = serde_json::to_value(EventOutput::from_google(&raw)).unwrap();
        assert_eq!(projected.get("id").and_then(Value::as_str), Some("evt-1"));
        assert!(projected.get("iCalUID").is_none());
        assert!(projected.get("etag").is_none());
        assert!(projected.get("sequence").is_none());
    }

    #[test]
    fn credential_injection_targets_authorization_header_with_bearer_prefix() {
        let capability_id =
            ironclaw_host_api::CapabilityId::new("google-calendar.list_events").unwrap();
        let injection = google_credential_injection(&capability_id).unwrap();
        assert_eq!(injection.handle.as_str(), GOOGLE_CREDENTIAL_NAME);
        assert!(injection.required);
        match injection.source {
            RuntimeCredentialSource::StagedObligation { capability_id: id } => {
                assert_eq!(id, capability_id);
            }
            RuntimeCredentialSource::SecretStoreLease => {
                panic!("must use a staged obligation, not a direct secret-store lease")
            }
        }
        match injection.target {
            RuntimeCredentialTarget::Header { name, prefix } => {
                assert_eq!(name, "authorization");
                assert_eq!(prefix.as_deref(), Some("Bearer "));
            }
            RuntimeCredentialTarget::QueryParam { .. } => {
                panic!("OAuth bearer token must be a header, not a query param")
            }
        }
    }
}
