use std::{path::PathBuf, sync::Arc};

use ironclaw_filesystem::{LocalFilesystem, RootFilesystem};
use ironclaw_host_api::{HostPath, UserId, VirtualPath};
use ironclaw_reborn_extension_host::{
    RebornLocalSkillManagementPort, SkillManagementMountResolver,
};

use crate::local_dev_mounts::scoped_skill_management_mount_view;

pub(crate) fn build_local_skill_management_port<F>(
    owner_user_id: UserId,
    filesystem: Arc<F>,
) -> Result<Arc<RebornLocalSkillManagementPort>, crate::RebornBuildError>
where
    F: RootFilesystem + 'static,
{
    let mount_resolver: Arc<SkillManagementMountResolver> =
        Arc::new(scoped_skill_management_mount_view);
    let filesystem: Arc<dyn RootFilesystem> = filesystem;
    Ok(Arc::new(
        RebornLocalSkillManagementPort::new_with_mount_resolver(
            owner_user_id,
            filesystem,
            mount_resolver,
        ),
    ))
}

pub(crate) fn build_existing_local_dev_skill_management_port(
    owner_id: impl Into<String>,
    local_dev_storage_root: impl Into<PathBuf>,
) -> Result<Option<Arc<RebornLocalSkillManagementPort>>, crate::RebornBuildError> {
    let owner_id = owner_id.into();
    let local_dev_storage_root = local_dev_storage_root.into();
    if !local_dev_storage_root.try_exists().map_err(|error| {
        crate::RebornBuildError::InvalidConfig {
            reason: format!("local-dev skill storage root could not be inspected: {error}"),
        }
    })? {
        return Ok(None);
    }
    if !local_dev_storage_root.is_dir() {
        return Err(crate::RebornBuildError::InvalidConfig {
            reason: "local-dev skill storage root is not a directory".to_string(),
        });
    }

    let mut filesystem = LocalFilesystem::new();
    filesystem.mount_local(
        VirtualPath::new("/projects")?,
        HostPath::from_path_buf(local_dev_storage_root),
    )?;
    let owner_user_id =
        UserId::new(owner_id).map_err(|error| crate::RebornBuildError::InvalidConfig {
            reason: error.to_string(),
        })?;
    build_local_skill_management_port(owner_user_id, Arc::new(filesystem)).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironclaw_host_api::{InvocationId, ResourceScope, TenantId};

    #[tokio::test]
    async fn default_skill_management_port_isolates_user_skill_roots_by_scope() {
        let dir = tempfile::tempdir().expect("tempdir");
        let storage_root = dir.path().join("local-dev");
        std::fs::create_dir_all(storage_root.join("system/skills/system-helper"))
            .expect("system skill dir");
        std::fs::write(
            storage_root.join("system/skills/system-helper/SKILL.md"),
            skill_content("system-helper"),
        )
        .expect("system skill");

        let mut filesystem = LocalFilesystem::new();
        filesystem
            .mount_local(
                VirtualPath::new("/projects").expect("valid virtual path"),
                HostPath::from_path_buf(storage_root.clone()),
            )
            .expect("mount storage root");
        let skill_management = build_local_skill_management_port(
            UserId::new("runtime-owner").expect("valid user"),
            Arc::new(filesystem),
        )
        .expect("skill management port");
        let alice_scope = skill_management_test_scope("tenant-alpha", "alice");
        let bob_scope = skill_management_test_scope("tenant-alpha", "bob");

        skill_management
            .install_for_scope(
                alice_scope.clone(),
                Some("shared-name"),
                &skill_content("shared-name"),
            )
            .await
            .expect("alice installs skill");

        let alice_skills = skill_management
            .list_for_scope(alice_scope)
            .await
            .expect("alice lists skills");
        assert!(alice_skills.iter().any(|skill| skill.name == "shared-name"));
        assert!(
            alice_skills
                .iter()
                .any(|skill| skill.name == "system-helper")
        );

        let bob_skills = skill_management
            .list_for_scope(bob_scope)
            .await
            .expect("bob lists skills");
        assert!(!bob_skills.iter().any(|skill| skill.name == "shared-name"));
        assert!(bob_skills.iter().any(|skill| skill.name == "system-helper"));
        assert!(
            storage_root
                .join("tenants/tenant-alpha/users/alice/skills/shared-name/SKILL.md")
                .exists()
        );
        assert!(
            !storage_root
                .join("tenants/tenant-alpha/users/bob/skills/shared-name/SKILL.md")
                .exists()
        );
    }

    fn skill_content(name: &str) -> String {
        format!("---\nname: {name}\ndescription: lifecycle test\n---\nUse lifecycle.\n")
    }

    fn skill_management_test_scope(tenant_id: &str, user_id: &str) -> ResourceScope {
        ResourceScope {
            tenant_id: TenantId::new(tenant_id).expect("tenant"),
            user_id: UserId::new(user_id).expect("user"),
            agent_id: None,
            project_id: None,
            mission_id: None,
            thread_id: None,
            invocation_id: InvocationId::new(),
        }
    }
}
