//! HostBundled `ExtensionPackage` declaring the nine Google Calendar
//! capabilities.
//!
//! The manifest is descriptor-only: it carries the capability ids, effects,
//! and permission modes that the host authorization layer reads. The actual
//! handler implementations live in [`super::handlers`] and are registered as
//! first-party capability handlers separately.

use ironclaw_extensions::{
    CapabilityManifest, CapabilityVisibility, ExtensionError, ExtensionManifest, ExtensionPackage,
    ExtensionRuntime, MANIFEST_SCHEMA_VERSION, ManifestSource,
};
use ironclaw_host_api::{
    CapabilityId, CapabilityProfileSchemaRef, EffectKind, ExtensionId, PermissionMode,
    RequestedTrustClass, TrustClass, VirtualPath,
};

/// User-facing installed extension id. Capability ids must be prefixed with
/// `"{EXTENSION_ID}."` or [`ExtensionPackage::from_manifest`] rejects them.
pub const CALENDAR_EXTENSION_ID: &str = "google-calendar";

/// First-party runtime service name carried in the manifest.
pub const CALENDAR_SERVICE: &str = "google-calendar";

/// Effects of a read-only Calendar capability.
fn read_effects() -> Vec<EffectKind> {
    vec![
        EffectKind::DispatchCapability,
        EffectKind::Network,
        EffectKind::UseSecret,
    ]
}

/// Effects of a write Calendar capability — read effects plus `ExternalWrite`.
fn write_effects() -> Vec<EffectKind> {
    let mut effects = read_effects();
    effects.push(EffectKind::ExternalWrite);
    effects
}

/// Stable kind tag for a capability descriptor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CalendarCapabilityKind {
    /// Read capability: `PermissionMode::Allow`, no `ExternalWrite` effect.
    Read,
    /// Write capability: `PermissionMode::Ask` (RequiresApproval) plus
    /// `ExternalWrite`.
    Write,
}

impl CalendarCapabilityKind {
    fn permission(self) -> PermissionMode {
        match self {
            Self::Read => PermissionMode::Allow,
            Self::Write => PermissionMode::Ask,
        }
    }

    fn effects(self) -> Vec<EffectKind> {
        match self {
            Self::Read => read_effects(),
            Self::Write => write_effects(),
        }
    }
}

/// One row of the calendar capability table: `(short_name, description, kind)`.
/// The fully-qualified id is `"{CALENDAR_EXTENSION_ID}.{short_name}"`.
pub const CALENDAR_CAPABILITIES: &[(&str, &str, CalendarCapabilityKind)] = &[
    (
        "list_calendars",
        "List the calendars on the user's Google Calendar account.",
        CalendarCapabilityKind::Read,
    ),
    (
        "list_events",
        "List events on a Google Calendar within an optional time window.",
        CalendarCapabilityKind::Read,
    ),
    (
        "get_event",
        "Fetch a single Google Calendar event by id.",
        CalendarCapabilityKind::Read,
    ),
    (
        "find_free_slots",
        "Compute free/busy windows across one or more Google Calendars.",
        CalendarCapabilityKind::Read,
    ),
    (
        "create_event",
        "Create a new event on a Google Calendar.",
        CalendarCapabilityKind::Write,
    ),
    (
        "update_event",
        "Update fields on an existing Google Calendar event.",
        CalendarCapabilityKind::Write,
    ),
    (
        "delete_event",
        "Delete an event from a Google Calendar.",
        CalendarCapabilityKind::Write,
    ),
    (
        "add_attendees",
        "Add attendees to an existing Google Calendar event.",
        CalendarCapabilityKind::Write,
    ),
    (
        "set_reminder",
        "Set reminder overrides on a Google Calendar event.",
        CalendarCapabilityKind::Write,
    ),
];

/// Fully-qualified capability id for a calendar capability short name.
pub fn capability_id(short_name: &str) -> String {
    format!("{CALENDAR_EXTENSION_ID}.{short_name}")
}

fn capability_manifest(
    short_name: &str,
    description: &str,
    kind: CalendarCapabilityKind,
) -> Result<CapabilityManifest, ExtensionError> {
    Ok(CapabilityManifest {
        id: CapabilityId::new(capability_id(short_name))?,
        implements: Vec::new(),
        description: description.to_string(),
        effects: kind.effects(),
        default_permission: kind.permission(),
        visibility: CapabilityVisibility::Model,
        input_schema_ref: CapabilityProfileSchemaRef::new(format!(
            "schemas/google-calendar/{short_name}.input.v1.json"
        ))?,
        output_schema_ref: CapabilityProfileSchemaRef::new(format!(
            "schemas/google-calendar/{short_name}.output.v1.json"
        ))?,
        prompt_doc_ref: Some(CapabilityProfileSchemaRef::new(format!(
            "prompts/google-calendar/{short_name}.md"
        ))?),
        required_host_ports: Vec::new(),
        resource_profile: None,
    })
}

/// Build the HostBundled `ExtensionPackage` declaring all nine Google Calendar
/// capabilities.
pub fn calendar_package() -> Result<ExtensionPackage, ExtensionError> {
    let capabilities = CALENDAR_CAPABILITIES
        .iter()
        .map(|(short_name, description, kind)| capability_manifest(short_name, description, *kind))
        .collect::<Result<Vec<_>, ExtensionError>>()?;
    ExtensionPackage::from_manifest(
        ExtensionManifest {
            schema_version: MANIFEST_SCHEMA_VERSION.to_string(),
            id: ExtensionId::new(CALENDAR_EXTENSION_ID)?,
            name: "Google Calendar".to_string(),
            version: "0.1.0".to_string(),
            description: "First-party Google Calendar capabilities for Reborn.".to_string(),
            source: ManifestSource::HostBundled,
            requested_trust: RequestedTrustClass::FirstPartyRequested,
            descriptor_trust_default: TrustClass::Sandbox,
            runtime: ExtensionRuntime::FirstParty {
                service: CALENDAR_SERVICE.to_string(),
            },
            host_apis: Vec::new(),
            capabilities,
        },
        VirtualPath::new(format!("/system/extensions/{CALENDAR_EXTENSION_ID}"))?,
    )
}
