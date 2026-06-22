use std::{sync::Arc, time::Instant};

use async_trait::async_trait;
use ironclaw_extensions::{
    CapabilityManifest, CapabilityVisibility, ExtensionError, ExtensionPackage,
};
use ironclaw_host_api::{
    CapabilityId, CapabilityProfileSchemaRef, EffectKind, HostApiError, PermissionMode,
    ResourceEstimate, ResourceProfile, ResourceUsage, RuntimeDispatchErrorKind,
};
use ironclaw_host_runtime::{
    FirstPartyCapabilityError, FirstPartyCapabilityHandler, FirstPartyCapabilityRegistry,
    FirstPartyCapabilityRequest, FirstPartyCapabilityResult,
};
use ironclaw_product_workflow::{LifecyclePackageKind, LifecyclePackageRef, ProductWorkflowError};
use serde::Deserialize;

use crate::extension_lifecycle::ExtensionActivationMode;
use crate::extension_lifecycle::RebornLocalExtensionManagementPort;

pub const EXTENSION_SEARCH_CAPABILITY_ID: &str = "builtin.extension_search";
pub const EXTENSION_INSTALL_CAPABILITY_ID: &str = "builtin.extension_install";
pub const EXTENSION_ACTIVATE_CAPABILITY_ID: &str = "builtin.extension_activate";
pub const EXTENSION_REMOVE_CAPABILITY_ID: &str = "builtin.extension_remove";

pub const EXTENSION_LIFECYCLE_CAPABILITY_IDS: [&str; 4] = [
    EXTENSION_SEARCH_CAPABILITY_ID,
    EXTENSION_INSTALL_CAPABILITY_ID,
    EXTENSION_ACTIVATE_CAPABILITY_ID,
    EXTENSION_REMOVE_CAPABILITY_ID,
];

pub fn extend_builtin_first_party_package(
    mut package: ExtensionPackage,
) -> Result<ExtensionPackage, ExtensionError> {
    package.manifest.capabilities.extend(manifests()?);
    ExtensionPackage::from_manifest(package.manifest, package.root)
}

pub fn insert_handlers(
    registry: &mut FirstPartyCapabilityRegistry,
    extension_management: Arc<RebornLocalExtensionManagementPort>,
) -> Result<(), HostApiError> {
    let handler = Arc::new(ExtensionLifecycleToolHandler {
        extension_management,
    });
    for capability_id in EXTENSION_LIFECYCLE_CAPABILITY_IDS {
        registry.insert_handler(CapabilityId::new(capability_id)?, handler.clone());
    }
    Ok(())
}

fn manifests() -> Result<Vec<CapabilityManifest>, ExtensionError> {
    Ok(vec![
        lifecycle_manifest(
            EXTENSION_SEARCH_CAPABILITY_ID,
            "Search locally available Reborn extensions",
            vec![EffectKind::ReadFilesystem],
            PermissionMode::Allow,
        )?,
        lifecycle_manifest(
            EXTENSION_INSTALL_CAPABILITY_ID,
            "Install a locally available Reborn extension into durable local-dev lifecycle state. If install fails because the extension is already installed, use builtin.extension_activate instead.",
            vec![EffectKind::ReadFilesystem, EffectKind::WriteFilesystem],
            PermissionMode::Ask,
        )?,
        lifecycle_manifest(
            EXTENSION_ACTIVATE_CAPABILITY_ID,
            "Activate an installed Reborn extension for the model-visible local-dev capability surface",
            vec![
                EffectKind::ReadFilesystem,
                EffectKind::WriteFilesystem,
                EffectKind::Network,
            ],
            PermissionMode::Ask,
        )?,
        lifecycle_manifest(
            EXTENSION_REMOVE_CAPABILITY_ID,
            "Remove an installed Reborn extension from durable local-dev lifecycle state",
            vec![EffectKind::ReadFilesystem, EffectKind::WriteFilesystem],
            PermissionMode::Ask,
        )?,
    ])
}

fn lifecycle_manifest(
    id: &str,
    description: &str,
    effects: Vec<EffectKind>,
    default_permission: PermissionMode,
) -> Result<CapabilityManifest, ExtensionError> {
    let schema_name = id.strip_prefix("builtin.").unwrap_or(id).replace('.', "-");
    Ok(CapabilityManifest {
        id: CapabilityId::new(id)?,
        implements: Vec::new(),
        description: description.to_string(),
        effects,
        default_permission,
        visibility: CapabilityVisibility::Model,
        input_schema_ref: CapabilityProfileSchemaRef::new(format!(
            "schemas/builtin/{schema_name}.input.v1.json"
        ))?,
        output_schema_ref: CapabilityProfileSchemaRef::new(format!(
            "schemas/builtin/{schema_name}.output.v1.json"
        ))?,
        prompt_doc_ref: None,
        required_host_ports: Vec::new(),
        runtime_credentials: Vec::new(),
        resource_profile: Some(ResourceProfile {
            default_estimate: ResourceEstimate {
                wall_clock_ms: Some(100),
                output_bytes: Some(16 * 1024),
                ..ResourceEstimate::default()
            },
            hard_ceiling: None,
        }),
    })
}

struct ExtensionLifecycleToolHandler {
    extension_management: Arc<RebornLocalExtensionManagementPort>,
}

#[derive(Debug, Deserialize)]
struct SearchInput {
    #[serde(default)]
    query: String,
}

#[derive(Debug, Deserialize)]
struct ExtensionIdInput {
    extension_id: String,
}

#[async_trait]
impl FirstPartyCapabilityHandler for ExtensionLifecycleToolHandler {
    async fn dispatch(
        &self,
        request: FirstPartyCapabilityRequest,
    ) -> Result<FirstPartyCapabilityResult, FirstPartyCapabilityError> {
        let started = Instant::now();
        let response = match request.capability_id.as_str() {
            EXTENSION_SEARCH_CAPABILITY_ID => {
                let input: SearchInput = parse_input(request.input)?;
                self.extension_management.search(&input.query).await
            }
            EXTENSION_INSTALL_CAPABILITY_ID => {
                let input: ExtensionIdInput = parse_input(request.input)?;
                self.extension_management
                    .install(extension_package_ref(input.extension_id)?)
                    .await
            }
            EXTENSION_ACTIVATE_CAPABILITY_ID => {
                let input: ExtensionIdInput = parse_input(request.input)?;
                let package_ref = extension_package_ref(input.extension_id)?;
                let mode = ExtensionActivationMode::from_dispatch_context(
                    request.scope.clone(),
                    request.services.runtime_http_egress.clone(),
                );
                self.extension_management.activate(package_ref, mode).await
            }
            EXTENSION_REMOVE_CAPABILITY_ID => {
                let input: ExtensionIdInput = parse_input(request.input)?;
                self.extension_management
                    .remove(extension_package_ref(input.extension_id)?)
                    .await
            }
            _ => {
                return Err(FirstPartyCapabilityError::new(
                    RuntimeDispatchErrorKind::UndeclaredCapability,
                ));
            }
        }
        .map_err(lifecycle_error)?;

        let output = serde_json::to_value(response)
            .map_err(|_| FirstPartyCapabilityError::new(RuntimeDispatchErrorKind::OutputDecode))?;
        Ok(FirstPartyCapabilityResult::new(
            output,
            ResourceUsage {
                wall_clock_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
                ..ResourceUsage::default()
            },
        ))
    }
}

fn parse_input<T>(input: serde_json::Value) -> Result<T, FirstPartyCapabilityError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(input)
        .map_err(|_| FirstPartyCapabilityError::new(RuntimeDispatchErrorKind::InputEncode))
}

fn extension_package_ref(
    id: impl Into<String>,
) -> Result<LifecyclePackageRef, FirstPartyCapabilityError> {
    LifecyclePackageRef::new(LifecyclePackageKind::Extension, id)
        .map_err(|_| FirstPartyCapabilityError::new(RuntimeDispatchErrorKind::InputEncode))
}

fn lifecycle_error(error: ProductWorkflowError) -> FirstPartyCapabilityError {
    let kind = match error {
        ProductWorkflowError::InvalidBindingRequest { .. }
        | ProductWorkflowError::UnsupportedActionKind { .. } => {
            RuntimeDispatchErrorKind::InputEncode
        }
        ProductWorkflowError::Transient { .. } => RuntimeDispatchErrorKind::OperationFailed,
        _ => RuntimeDispatchErrorKind::OperationFailed,
    };
    FirstPartyCapabilityError::new(kind)
}
