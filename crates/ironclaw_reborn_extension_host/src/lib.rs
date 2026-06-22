#![forbid(unsafe_code)]

//! Reborn extension/MCP lifecycle host cluster.
//!
//! Owns the local extension catalog and lifecycle management, hosted MCP
//! discovery/runtime wiring, GSuite first-party handlers, extension lifecycle
//! built-in capabilities, and local skill lifecycle facade extracted from
//! `ironclaw_reborn_composition`.

mod available_extensions;
mod extension_installation_store;
mod extension_lifecycle;
mod extension_lifecycle_capabilities;
mod gsuite;
mod lifecycle;
mod mcp;
mod mcp_discovery;
mod nearai_mcp;

pub use available_extensions::{
    AvailableExtensionCatalog, AvailableExtensionPackage, gmail_manifest_digest,
    google_calendar_manifest_digest, google_docs_manifest_digest, google_drive_manifest_digest,
    google_sheets_manifest_digest, google_slides_manifest_digest, notion_mcp_manifest_digest,
    web_access_manifest_digest,
};
pub use extension_installation_store::FilesystemExtensionInstallationStore;
pub use extension_lifecycle::{
    ActiveExtensionCapability, ActiveExtensionPublisher, ExtensionActivationMode,
    RebornLocalExtensionManagementPort, restore_extension_lifecycle_state,
};
pub use extension_lifecycle_capabilities::{
    EXTENSION_ACTIVATE_CAPABILITY_ID, EXTENSION_INSTALL_CAPABILITY_ID,
    EXTENSION_LIFECYCLE_CAPABILITY_IDS, EXTENSION_REMOVE_CAPABILITY_ID,
    EXTENSION_SEARCH_CAPABILITY_ID, extend_builtin_first_party_package,
    insert_handlers as insert_extension_lifecycle_handlers,
};
pub use gsuite::{
    ProductAuthRuntimeGsuiteCredentialStager, bundled_gsuite_extension_packages,
    bundled_gsuite_first_party_handlers, register_bundled_gsuite_first_party_handlers,
};
pub use lifecycle::{
    RebornLocalLifecycleFacade, RebornLocalSkillManagementError, RebornLocalSkillManagementPort,
    SkillManagementMountResolver, response_with_payload,
};
pub use mcp::hosted_http_mcp_runtime;
