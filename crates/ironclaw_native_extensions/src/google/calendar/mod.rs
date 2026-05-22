//! Google Calendar native extension package.
//!
//! [`manifest`] declares the HostBundled `ExtensionPackage` (nine capability
//! descriptors); [`handlers`] holds the nine first-party capability handler
//! implementations. [`register_calendar`] populates a [`RegistrationOutput`]
//! with the package and the keyed handlers.

pub mod handlers;
pub mod manifest;

use std::sync::Arc;

use ironclaw_host_api::CapabilityId;
use ironclaw_host_runtime::FirstPartyCapabilityHandler;
use ironclaw_oauth::OAuthProvider;

use crate::google::credential::GoogleCredentialResolver;
use crate::google::scopes;
use crate::{NativeExtensionError, RegistrationOutput};

use handlers::{
    AddAttendeesHandler, CalendarHandlerDeps, CreateEventHandler, DeleteEventHandler,
    FindFreeSlotsHandler, GetEventHandler, ListCalendarsHandler, ListEventsHandler,
    SetReminderHandler, UpdateEventHandler,
};
use manifest::{calendar_package, capability_id};

/// Build a keyed `(CapabilityId, handler)` pair, mapping id-construction
/// failure to a [`NativeExtensionError`].
fn keyed(
    short_name: &str,
    handler: Arc<dyn FirstPartyCapabilityHandler>,
) -> Result<(CapabilityId, Arc<dyn FirstPartyCapabilityHandler>), NativeExtensionError> {
    let id = CapabilityId::new(capability_id(short_name))?;
    Ok((id, handler))
}

/// Register the Google Calendar package and its nine capability handlers into
/// `output`.
///
/// `resolver` is the shared credential resolver (used by handlers for the
/// scope-mismatch preflight); `provider` is the shared Google `OAuthProvider`.
/// Handlers do not own an HTTP transport — they issue calls through the
/// per-invocation `runtime_http_egress` the host supplies in
/// `InvocationServices`. Read capabilities require the `calendar.readonly`
/// scope; write capabilities require `calendar.events`.
pub fn register_calendar(
    resolver: Arc<GoogleCredentialResolver>,
    provider: Arc<dyn OAuthProvider>,
    output: &mut RegistrationOutput,
) -> Result<(), NativeExtensionError> {
    output.packages.push(calendar_package()?);

    let read_scopes = vec![scopes::CALENDAR_READONLY.to_string()];
    let write_scopes = vec![scopes::CALENDAR_EVENTS.to_string()];

    let read_deps = CalendarHandlerDeps::new(resolver.clone(), provider.clone(), read_scopes);
    let write_deps = CalendarHandlerDeps::new(resolver, provider, write_scopes);

    let handlers: Vec<(&str, Arc<dyn FirstPartyCapabilityHandler>)> = vec![
        (
            "list_calendars",
            Arc::new(ListCalendarsHandler::new(read_deps.clone())),
        ),
        (
            "list_events",
            Arc::new(ListEventsHandler::new(read_deps.clone())),
        ),
        (
            "get_event",
            Arc::new(GetEventHandler::new(read_deps.clone())),
        ),
        (
            "find_free_slots",
            Arc::new(FindFreeSlotsHandler::new(read_deps)),
        ),
        (
            "create_event",
            Arc::new(CreateEventHandler::new(write_deps.clone())),
        ),
        (
            "update_event",
            Arc::new(UpdateEventHandler::new(write_deps.clone())),
        ),
        (
            "delete_event",
            Arc::new(DeleteEventHandler::new(write_deps.clone())),
        ),
        (
            "add_attendees",
            Arc::new(AddAttendeesHandler::new(write_deps.clone())),
        ),
        (
            "set_reminder",
            Arc::new(SetReminderHandler::new(write_deps)),
        ),
    ];

    for (short_name, handler) in handlers {
        output.handlers.push(keyed(short_name, handler)?);
    }
    Ok(())
}
