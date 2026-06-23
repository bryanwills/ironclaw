use ironclaw_host_api::runtime_policy::{
    ApprovalPolicy, AuditMode, DeploymentMode, EffectiveRuntimePolicy, FilesystemBackendKind,
    NetworkMode, ProcessBackendKind, RuntimeProfile, SecretMode,
};
use ironclaw_host_api::{CapabilityProfileId, ExtensionId};
use ironclaw_host_runtime::{
    MemoryProfileBindingConfig, MemoryProfileBindingDeployment, MemoryProfileBindingError,
    MemoryProfileBindingOverride, MemoryProfileBindingTarget, RequiredMemoryProfileId,
    resolve_memory_profile_bindings,
};

fn policy(deployment: DeploymentMode, profile: RuntimeProfile) -> EffectiveRuntimePolicy {
    EffectiveRuntimePolicy {
        deployment,
        requested_profile: profile,
        resolved_profile: profile,
        filesystem_backend: FilesystemBackendKind::ScopedVirtual,
        process_backend: ProcessBackendKind::None,
        network_mode: NetworkMode::Brokered,
        secret_mode: SecretMode::BrokeredHandles,
        approval_policy: ApprovalPolicy::AskAlways,
        audit_mode: AuditMode::Standard,
    }
}

fn local_dev_policy() -> EffectiveRuntimePolicy {
    policy(DeploymentMode::LocalSingleUser, RuntimeProfile::LocalDev)
}

fn production_policy() -> EffectiveRuntimePolicy {
    policy(
        DeploymentMode::HostedMultiTenant,
        RuntimeProfile::HostedSafe,
    )
}

fn third_party() -> MemoryProfileBindingTarget {
    MemoryProfileBindingTarget::extension("acme.memory").expect("valid extension id")
}

#[test]
fn unconfigured_required_profiles_default_to_native_when_available() {
    let resolved = resolve_memory_profile_bindings(
        &MemoryProfileBindingConfig::default_required_profiles(),
        &production_policy(),
        true,
    )
    .expect("native default resolves");

    for profile in RequiredMemoryProfileId::default_required() {
        assert_eq!(
            resolved
                .extension_for(profile)
                .expect("required profile resolved")
                .as_str(),
            "ironclaw.memory.native"
        );
    }
}

#[test]
fn semantic_search_is_recognized_but_not_default_required_until_vector_port_exists() {
    let resolved = resolve_memory_profile_bindings(
        &MemoryProfileBindingConfig::default_required_profiles(),
        &production_policy(),
        true,
    )
    .expect("native default resolves");

    assert!(
        resolved
            .extension_for(RequiredMemoryProfileId::SemanticSearch)
            .is_none()
    );

    let explicit = resolve_memory_profile_bindings(
        &MemoryProfileBindingConfig::new([RequiredMemoryProfileId::SemanticSearch]),
        &production_policy(),
        true,
    )
    .expect("explicit semantic search binding resolves when requested");
    assert_eq!(
        explicit
            .extension_for(RequiredMemoryProfileId::SemanticSearch)
            .expect("semantic search resolved")
            .as_str(),
        "ironclaw.memory.native"
    );
}

#[test]
fn native_unavailable_fails_required_profiles_without_local_disabled_binding() {
    let error = resolve_memory_profile_bindings(
        &MemoryProfileBindingConfig::default_required_profiles(),
        &local_dev_policy(),
        false,
    )
    .expect_err("required profiles cannot silently disappear");

    assert!(matches!(
        error,
        MemoryProfileBindingError::NativeUnavailable { .. }
    ));
}

#[test]
fn explicit_native_binding_fails_when_native_is_unavailable() {
    let error = resolve_memory_profile_bindings(
        &MemoryProfileBindingConfig::default_required_profiles().with_binding(
            RequiredMemoryProfileId::ContextRetrieval,
            MemoryProfileBindingTarget::native(),
        ),
        &local_dev_policy(),
        false,
    )
    .expect_err("explicit native binding still requires native to be available");

    assert!(matches!(
        error,
        MemoryProfileBindingError::NativeUnavailable {
            profile_id: RequiredMemoryProfileId::ContextRetrieval
        }
    ));
}

#[test]
fn local_disabled_binding_is_accepted_when_native_is_unavailable() {
    let mut config = MemoryProfileBindingConfig::default_required_profiles();
    for profile in RequiredMemoryProfileId::default_required() {
        config = config.with_binding(profile, MemoryProfileBindingTarget::disabled());
    }

    let resolved = resolve_memory_profile_bindings(&config, &local_dev_policy(), false)
        .expect("local disabled binding resolves");

    assert_eq!(
        resolved
            .extension_for(RequiredMemoryProfileId::ContextRetrieval)
            .expect("context profile resolved")
            .as_str(),
        "memory.disabled"
    );
}

#[test]
fn production_rejects_disabled_binding() {
    let error = resolve_memory_profile_bindings(
        &MemoryProfileBindingConfig::default_required_profiles().with_binding(
            RequiredMemoryProfileId::ContextRetrieval,
            MemoryProfileBindingTarget::disabled(),
        ),
        &production_policy(),
        true,
    )
    .expect_err("production cannot disable required memory");

    assert!(matches!(
        error,
        MemoryProfileBindingError::DisabledInProduction { .. }
    ));
}

#[test]
fn production_rejects_third_party_required_profile_binding_by_default() {
    let error = resolve_memory_profile_bindings(
        &MemoryProfileBindingConfig::default_required_profiles()
            .with_binding(RequiredMemoryProfileId::ContextRetrieval, third_party()),
        &production_policy(),
        true,
    )
    .expect_err("third-party memory requires an explicit production override");

    assert!(matches!(
        error,
        MemoryProfileBindingError::ThirdPartyBindingRequiresOverride { .. }
    ));
}

#[test]
fn production_accepts_third_party_binding_when_override_matches_exactly() {
    let target = third_party();
    let resolved = resolve_memory_profile_bindings(
        &MemoryProfileBindingConfig::default_required_profiles()
            .with_binding(RequiredMemoryProfileId::ContextRetrieval, target.clone())
            .with_third_party_override(MemoryProfileBindingOverride::new(
                RequiredMemoryProfileId::ContextRetrieval,
                target.extension_id().clone(),
                MemoryProfileBindingDeployment::from_policy(&production_policy()),
            )),
        &production_policy(),
        true,
    )
    .expect("exact override authorizes production third-party binding");

    assert_eq!(
        resolved
            .extension_for(RequiredMemoryProfileId::ContextRetrieval)
            .expect("context profile resolved"),
        target.extension_id()
    );
}

#[test]
fn production_override_must_match_profile_extension_and_deployment() {
    let target = third_party();
    let other_extension = ExtensionId::new("other.memory").expect("valid extension id");
    let local_deployment = MemoryProfileBindingDeployment::from_policy(&local_dev_policy());

    let mismatched_overrides = [
        MemoryProfileBindingOverride::new(
            RequiredMemoryProfileId::InteractionLog,
            target.extension_id().clone(),
            MemoryProfileBindingDeployment::from_policy(&production_policy()),
        ),
        MemoryProfileBindingOverride::new(
            RequiredMemoryProfileId::ContextRetrieval,
            other_extension,
            MemoryProfileBindingDeployment::from_policy(&production_policy()),
        ),
        MemoryProfileBindingOverride::new(
            RequiredMemoryProfileId::ContextRetrieval,
            target.extension_id().clone(),
            local_deployment,
        ),
    ];

    for override_entry in mismatched_overrides {
        let config = MemoryProfileBindingConfig::default_required_profiles()
            .with_binding(RequiredMemoryProfileId::ContextRetrieval, target.clone())
            .with_third_party_override(override_entry);

        let error = resolve_memory_profile_bindings(&config, &production_policy(), true)
            .expect_err("mismatched override must not authorize binding");

        assert!(matches!(
            error,
            MemoryProfileBindingError::ThirdPartyBindingRequiresOverride { .. }
        ));
    }
}

#[test]
fn unknown_or_empty_ids_are_rejected_by_typed_constructors() {
    assert!(MemoryProfileBindingTarget::extension("").is_err());
    assert!(ExtensionId::new("").is_err());
    assert!(CapabilityProfileId::new("").is_err());

    let unknown_profile =
        CapabilityProfileId::new("memory.unknown_profile.v1").expect("syntactically valid id");
    assert!(RequiredMemoryProfileId::new(unknown_profile).is_err());

    assert_eq!(
        RequiredMemoryProfileId::new(
            CapabilityProfileId::new("memory.semantic_search.v1").expect("valid profile id")
        )
        .expect("known memory profile"),
        RequiredMemoryProfileId::SemanticSearch
    );
}
