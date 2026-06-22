#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use ironclaw_host_api::{
        CapabilityDescriptor, CapabilityGrant, CapabilityGrantId, CapabilityId, CapabilitySet,
        EffectKind, ExecutionContext, ExtensionId, GrantConstraints, MountView, NetworkPolicy,
        NetworkTargetPattern, PermissionMode, Principal, RuntimeKind, TrustClass, UserId,
    };
    use ironclaw_host_runtime::{
        CapabilitySurfacePolicy, RuntimeFailureKind, SurfaceKind, VisibleCapabilityRequest,
        VisibleCapabilitySurface,
    };
    use ironclaw_trust::{AuthorityCeiling, EffectiveTrustClass, TrustDecision, TrustProvenance};

    use crate::{RebornBuildInput, RebornServices, build_reborn_services};
    use ironclaw_reborn_extension_host::{
        EXTENSION_ACTIVATE_CAPABILITY_ID, EXTENSION_INSTALL_CAPABILITY_ID,
        EXTENSION_LIFECYCLE_CAPABILITY_IDS, EXTENSION_REMOVE_CAPABILITY_ID,
        EXTENSION_SEARCH_CAPABILITY_ID, RebornLocalExtensionManagementPort,
    };

    #[tokio::test]
    async fn local_dev_agent_surface_exposes_extension_lifecycle_tools() {
        let dir = tempfile::tempdir().expect("tempdir");
        let services = build_reborn_services(RebornBuildInput::local_dev(
            "extension-tools-surface-owner",
            dir.path().join("local-dev"),
        ))
        .await
        .expect("local-dev services build");
        let runtime = services
            .host_runtime
            .as_ref()
            .expect("host runtime composed");

        let surface = runtime
            .visible_capabilities(visible_request(EXTENSION_LIFECYCLE_CAPABILITY_IDS))
            .await
            .expect("visible capabilities");
        let ids = surface_capability_ids(&surface);

        assert!(ids.contains(&EXTENSION_SEARCH_CAPABILITY_ID));
        assert!(ids.contains(&EXTENSION_INSTALL_CAPABILITY_ID));
        assert!(ids.contains(&EXTENSION_ACTIVATE_CAPABILITY_ID));
        assert!(ids.contains(&EXTENSION_REMOVE_CAPABILITY_ID));

        let search = descriptor_for(&surface, EXTENSION_SEARCH_CAPABILITY_ID);
        assert_eq!(search.default_permission, PermissionMode::Allow);
        assert_eq!(
            search.parameters_schema.get("required"),
            None,
            "extension_search query should be optional so models can list all extensions"
        );

        let install = descriptor_for(&surface, EXTENSION_INSTALL_CAPABILITY_ID);
        assert_eq!(install.default_permission, PermissionMode::Ask);
        assert!(
            install.description.contains("already installed")
                && install
                    .description
                    .contains(EXTENSION_ACTIVATE_CAPABILITY_ID),
            "extension_install description should route already-installed failures to activation: {}",
            install.description
        );
        assert_eq!(
            install.parameters_schema["required"],
            serde_json::json!(["extension_id"])
        );

        let activate = descriptor_for(&surface, EXTENSION_ACTIVATE_CAPABILITY_ID);
        assert!(
            activate.effects.contains(&EffectKind::Network),
            "hosted MCP activation needs runtime HTTP egress for discovery"
        );
    }

    #[tokio::test]
    async fn local_dev_extension_lifecycle_tools_manage_visible_extension_surface() {
        let dir = tempfile::tempdir().expect("tempdir");
        let storage_root = dir.path().join("local-dev");
        let services = build_reborn_services(RebornBuildInput::local_dev(
            "extension-tools-owner",
            storage_root.clone(),
        ))
        .await
        .expect("local-dev services build");
        let runtime = services
            .host_runtime
            .as_ref()
            .expect("host runtime composed");
        let extension_management = services
            .local_runtime
            .as_ref()
            .expect("local runtime substrate")
            .extension_management
            .as_ref()
            .expect("extension management")
            .clone();
        let search = invoke_json(
            &services,
            EXTENSION_SEARCH_CAPABILITY_ID,
            serde_json::json!({"query": "github"}),
        )
        .await
        .expect("search succeeds");
        assert_eq!(search["payload"]["kind"], "extension_search");
        assert_eq!(search["payload"]["count"], 1);

        let install = invoke_json(
            &services,
            EXTENSION_INSTALL_CAPABILITY_ID,
            serde_json::json!({"extension_id": "github"}),
        )
        .await
        .expect("install succeeds");
        assert_eq!(install["payload"]["installed"], true);
        assert!(
            storage_root
                .join("system/extensions/github/manifest.toml")
                .exists()
        );

        let before_activate = active_extension_capability_ids(&extension_management).await;
        assert!(
            !before_activate
                .iter()
                .any(|id| id == "github.search_issues")
        );

        let activate = invoke_json(
            &services,
            EXTENSION_ACTIVATE_CAPABILITY_ID,
            serde_json::json!({"extension_id": "github"}),
        )
        .await
        .expect("activate succeeds");
        assert_eq!(activate["payload"]["activated"], true);

        let after_activate = active_extension_capability_ids(&extension_management).await;
        assert!(after_activate.iter().any(|id| id == "github.search_issues"));
        assert!(after_activate.iter().any(|id| id == "github.get_issue"));
        let health = runtime.health().await.expect("runtime health");
        assert!(
            !health.missing_runtime_backends.contains(&RuntimeKind::Wasm),
            "activated GitHub WASM capabilities require a registered WASM runtime"
        );

        let remove = invoke_json(
            &services,
            EXTENSION_REMOVE_CAPABILITY_ID,
            serde_json::json!({"extension_id": "github"}),
        )
        .await
        .expect("remove succeeds");
        assert_eq!(remove["payload"]["removed"], true);

        let after_remove = active_extension_capability_ids(&extension_management).await;
        assert!(!after_remove.iter().any(|id| id == "github.search_issues"));
        assert!(!storage_root.join("system/extensions/github").exists());
    }

    #[tokio::test]
    async fn local_dev_extension_activate_routes_hosted_mcp_discovery_through_runtime_egress() {
        let dir = tempfile::tempdir().expect("tempdir");
        let storage_root = dir.path().join("local-dev");
        let services = build_reborn_services(RebornBuildInput::local_dev(
            "extension-tools-hosted-mcp-owner",
            storage_root.clone(),
        ))
        .await
        .expect("local-dev services build");
        let extension_management = services
            .local_runtime
            .as_ref()
            .expect("local runtime substrate")
            .extension_management
            .as_ref()
            .expect("extension management")
            .clone();

        invoke_json(
            &services,
            EXTENSION_INSTALL_CAPABILITY_ID,
            serde_json::json!({"extension_id": "notion"}),
        )
        .await
        .expect("install succeeds");

        let activate = invoke_json(
            &services,
            EXTENSION_ACTIVATE_CAPABILITY_ID,
            serde_json::json!({"extension_id": "notion"}),
        )
        .await
        .expect("hosted MCP activation succeeds");
        assert_eq!(activate["payload"]["activated"], true);

        let active = active_extension_capability_ids(&extension_management).await;
        assert!(active.iter().any(|id| id == "notion.notion-get-self"));
        assert!(
            storage_root
                .join("system/extensions/notion/manifest.toml")
                .exists()
        );
    }

    #[tokio::test]
    async fn local_dev_extension_lifecycle_tool_lists_all_and_rejects_malformed_inputs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let services = build_reborn_services(RebornBuildInput::local_dev(
            "extension-tools-invalid-owner",
            dir.path().join("local-dev"),
        ))
        .await
        .expect("local-dev services build");
        let list_all = invoke_json(
            &services,
            EXTENSION_SEARCH_CAPABILITY_ID,
            serde_json::json!({}),
        )
        .await
        .expect("search without a query should list all extensions");
        assert_eq!(list_all["payload"]["kind"], "extension_search");
        assert!(
            list_all["payload"]["count"].as_u64().unwrap_or_default() > 0,
            "list-all extension search should return the bundled local-dev packages"
        );
        assert_eq!(
            invoke_json(
                &services,
                EXTENSION_INSTALL_CAPABILITY_ID,
                serde_json::json!({})
            )
            .await,
            Err(RuntimeFailureKind::InvalidInput)
        );
        assert_eq!(
            invoke_json(
                &services,
                EXTENSION_INSTALL_CAPABILITY_ID,
                serde_json::json!({"extension_id": "unknown-extension"})
            )
            .await,
            Err(RuntimeFailureKind::InvalidInput)
        );
    }

    async fn invoke_json(
        services: &RebornServices,
        capability_id: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value, RuntimeFailureKind> {
        crate::approval_test_support::invoke_json_with_local_dev_approval(
            services,
            capability_id,
            execution_context([capability_id]),
            input,
            trust_decision(),
        )
        .await
    }

    async fn active_extension_capability_ids(
        extension_management: &RebornLocalExtensionManagementPort,
    ) -> Vec<String> {
        extension_management
            .active_model_visible_capabilities()
            .await
            .expect("active extension capabilities")
            .into_iter()
            .map(|capability| capability.id.as_str().to_string())
            .collect()
    }

    fn visible_request<'a>(
        capability_ids: impl IntoIterator<Item = &'a str>,
    ) -> VisibleCapabilityRequest {
        let mut provider_trust = BTreeMap::new();
        provider_trust.insert(ExtensionId::new("builtin").unwrap(), trust_decision());
        provider_trust.insert(ExtensionId::new("github").unwrap(), trust_decision());
        VisibleCapabilityRequest::new(
            execution_context(capability_ids),
            SurfaceKind::new("agent_loop").unwrap(),
        )
        .with_policy(CapabilitySurfacePolicy::allow_all())
        .with_provider_trust(provider_trust)
    }

    fn execution_context<'a>(
        capability_ids: impl IntoIterator<Item = &'a str>,
    ) -> ExecutionContext {
        let caller = ExtensionId::new("extension-tool-test-caller").expect("valid extension id");
        ExecutionContext::local_default(
            UserId::new("extension-tool-test-user").expect("valid user id"),
            caller.clone(),
            RuntimeKind::FirstParty,
            TrustClass::FirstParty,
            CapabilitySet {
                grants: capability_ids
                    .into_iter()
                    .map(|capability_id| capability_grant(capability_id, caller.clone()))
                    .collect(),
            },
            MountView::default(),
        )
        .expect("valid execution context")
    }

    fn capability_grant(capability_id: &str, grantee: ExtensionId) -> CapabilityGrant {
        CapabilityGrant {
            id: CapabilityGrantId::new(),
            capability: CapabilityId::new(capability_id).expect("valid capability id"),
            grantee: Principal::Extension(grantee),
            issued_by: Principal::HostRuntime,
            constraints: GrantConstraints {
                allowed_effects: allowed_effects(),
                mounts: MountView::default(),
                network: NetworkPolicy {
                    allowed_targets: vec![NetworkTargetPattern {
                        scheme: None,
                        host_pattern: "*".to_string(),
                        port: None,
                    }],
                    deny_private_ip_ranges: true,
                    max_egress_bytes: None,
                },
                secrets: Vec::new(),
                resource_ceiling: None,
                expires_at: None,
                max_invocations: None,
            },
        }
    }

    fn surface_capability_ids(surface: &VisibleCapabilitySurface) -> Vec<&str> {
        surface
            .capabilities
            .iter()
            .map(|capability| capability.descriptor.id.as_str())
            .collect()
    }

    fn descriptor_for<'a>(
        surface: &'a VisibleCapabilitySurface,
        capability_id: &str,
    ) -> &'a CapabilityDescriptor {
        surface
            .capabilities
            .iter()
            .find(|capability| capability.descriptor.id.as_str() == capability_id)
            .map(|capability| &capability.descriptor)
            .expect("capability descriptor")
    }

    fn allowed_effects() -> Vec<EffectKind> {
        vec![
            EffectKind::DispatchCapability,
            EffectKind::ReadFilesystem,
            EffectKind::WriteFilesystem,
            EffectKind::Network,
        ]
    }

    fn trust_decision() -> TrustDecision {
        TrustDecision {
            effective_trust: EffectiveTrustClass::user_trusted(),
            authority_ceiling: AuthorityCeiling {
                allowed_effects: allowed_effects(),
                max_resource_ceiling: None,
            },
            provenance: TrustProvenance::Default,
            evaluated_at: chrono::Utc::now(),
        }
    }
}
