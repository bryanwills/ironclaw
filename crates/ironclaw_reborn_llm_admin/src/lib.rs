#![forbid(unsafe_code)]

//! Reborn LLM provider/catalog admin cluster.
//!
//! Owns the LLM-admin composition vocabulary extracted from
//! `ironclaw_reborn_composition`: provider catalog resolution, custom provider
//! overlay persistence, operator-scoped API-key storage, live provider reload,
//! product-command provider administration, and (under `webui-v2-beta`) the
//! public NEAR AI login callback route mount.

mod llm_catalog;
mod llm_config_service;
mod llm_key_store;
mod llm_reload;
#[cfg(feature = "webui-v2-beta")]
mod nearai_login_serve;
mod provider_admin;
mod provider_admin_product_command;
mod provider_repo;
mod resolved;

pub use llm_catalog::{
    RebornLlmCatalogError, resolve_against_registry, resolve_llm_selection_against_catalog,
    resolve_reborn_runtime_llm,
};
pub use llm_config_service::{LlmReloadTrigger, NearAiLoginStateStore, RebornLlmConfigService};
pub use llm_key_store::{LlmKeyStore, LlmKeyStoreError};
pub use llm_reload::RebornLlmReloadAdapter;
#[cfg(feature = "webui-v2-beta")]
pub use nearai_login_serve::nearai_login_callback_mount;
pub use provider_admin::{
    RebornModelRoutesState, RebornProviderAdmin, RebornProviderAdminError, RebornProviderInfo,
    RebornProviderList, RebornProviderMetadata, RebornProviderSelection, RebornProviderStatus,
    RebornProviderWriteOutcome, RebornV1State,
};
pub use provider_admin_product_command::RebornProviderAdminProductCommandService;
pub use provider_repo::{ProviderRepo, ProviderRepoError};
pub use resolved::ResolvedRebornLlm;

#[cfg(test)]
use std::sync::Arc;

#[cfg(test)]
use ironclaw_filesystem::{RootFilesystem, ScopedFilesystem};
#[cfg(test)]
use ironclaw_host_api::{
    HostApiError, MountAlias, MountGrant, MountPermissions, MountView, ResourceScope, VirtualPath,
};

#[cfg(test)]
fn wrap_scoped<F>(root: Arc<F>) -> Arc<ScopedFilesystem<F>>
where
    F: RootFilesystem,
{
    Arc::new(ScopedFilesystem::new(root, invocation_mount_view))
}

#[cfg(test)]
const PER_USER_ALIASES: &[&str] = &[
    "/processes",
    "/secrets",
    "/authorization",
    "/outbound",
    "/run-state",
    "/approvals",
    "/threads",
    "/conversations",
    "/turns",
    "/checkpoint-state",
    "/resources",
    "/engine",
    "/skills",
    "/workspace",
];

#[cfg(test)]
fn invocation_mount_view(scope: &ResourceScope) -> Result<MountView, HostApiError> {
    invocation_mount_view_for_segments(
        resource_scope_path_segment(scope.tenant_id.as_str()),
        resource_scope_path_segment(scope.user_id.as_str()),
    )
}

#[cfg(test)]
fn resource_scope_path_segment(value: &str) -> &str {
    if value == ironclaw_host_api::SYSTEM_RESERVED_ID {
        "__system__"
    } else {
        value
    }
}

#[cfg(test)]
fn invocation_mount_view_for_segments(
    tenant_id: &str,
    user_id: &str,
) -> Result<MountView, HostApiError> {
    let tenant_user_prefix = format!("/tenants/{tenant_id}/users/{user_id}");
    let mut grants = Vec::with_capacity(PER_USER_ALIASES.len() + 2);
    for alias in PER_USER_ALIASES {
        let target = format!("{tenant_user_prefix}{alias}");
        grants.push(MountGrant::new(
            MountAlias::new(*alias)?,
            VirtualPath::new(target)?,
            MountPermissions::read_write_list_delete(),
        ));
    }
    grants.push(MountGrant::new(
        MountAlias::new("/tenant-shared")?,
        VirtualPath::new(format!("/tenants/{tenant_id}/shared"))?,
        MountPermissions::read_write(),
    ));
    for system_subroot in ["/system/settings", "/system/extensions", "/system/skills"] {
        grants.push(MountGrant::new(
            MountAlias::new(system_subroot)?,
            VirtualPath::new(system_subroot)?,
            MountPermissions::read_only(),
        ));
    }
    MountView::new(grants)
}
