use std::sync::Arc;

use async_trait::async_trait;
use ironclaw_filesystem::LocalFilesystem;
use ironclaw_host_api::{InvocationId, MountView, ResourceScope, UserId};
use ironclaw_product_workflow::{
    LifecyclePackageKind, LifecyclePackageRef, LifecyclePhase, LifecycleProductAction,
    LifecycleProductContext, LifecycleProductFacade, LifecycleProductResponse,
    LifecycleReadinessBlocker, ProductWorkflowError,
};
use ironclaw_skills::{
    SkillInstallRequest, SkillManagementContext, SkillManagementError, SkillManagementErrorKind,
    SkillRemoveRequest, install_skill, list_skills, remove_skill,
};
use serde_json::{Value, json};
use tokio::sync::Mutex;

const SKILL_SEARCH_RESULT_LIMIT: usize = 50;

#[derive(Clone)]
pub(crate) struct RebornLocalSkillManagementPort {
    owner_user_id: UserId,
    filesystem: Arc<LocalFilesystem>,
    skill_management_mounts: MountView,
    skill_writes: Arc<Mutex<()>>,
}

impl RebornLocalSkillManagementPort {
    pub(crate) fn new(
        owner_user_id: UserId,
        filesystem: Arc<LocalFilesystem>,
        skill_management_mounts: MountView,
    ) -> Self {
        Self {
            owner_user_id,
            filesystem,
            skill_management_mounts,
            skill_writes: Arc::new(Mutex::new(())),
        }
    }

    fn skill_context(&self) -> Result<SkillManagementContext, ProductWorkflowError> {
        let scope = ResourceScope::local_default(self.owner_user_id.clone(), InvocationId::new())
            .map_err(invalid_skill_context)?;
        Ok(SkillManagementContext::new(
            self.filesystem.clone(),
            self.skill_management_mounts.clone(),
            scope,
        ))
    }

    async fn list(&self) -> Result<Vec<ironclaw_skills::SkillSummary>, ProductWorkflowError> {
        let context = self.skill_context()?;
        list_skills(&context).await.map_err(map_skill_error)
    }

    async fn install(
        &self,
        name: Option<&str>,
        content: &str,
    ) -> Result<ironclaw_skills::SkillInstallResult, ProductWorkflowError> {
        let _guard = self.skill_writes.lock().await;
        let context = self.skill_context()?;
        install_skill(&context, SkillInstallRequest { name, content })
            .await
            .map_err(map_skill_error)
    }

    async fn remove(
        &self,
        name: &str,
    ) -> Result<ironclaw_skills::SkillRemoveResult, ProductWorkflowError> {
        let _guard = self.skill_writes.lock().await;
        let context = self.skill_context()?;
        remove_skill(&context, SkillRemoveRequest { name })
            .await
            .map_err(map_skill_error)
    }
}

fn invalid_skill_context(error: impl std::fmt::Display) -> ProductWorkflowError {
    ProductWorkflowError::InvalidBindingRequest {
        reason: error.to_string(),
    }
}

#[derive(Clone)]
pub(crate) struct RebornLocalLifecycleFacade {
    skill_management: Arc<RebornLocalSkillManagementPort>,
}

impl RebornLocalLifecycleFacade {
    pub(crate) fn new(skill_management: Arc<RebornLocalSkillManagementPort>) -> Self {
        Self { skill_management }
    }

    async fn execute_action(
        &self,
        action: LifecycleProductAction,
    ) -> Result<LifecycleProductResponse, ProductWorkflowError> {
        match action {
            LifecycleProductAction::SkillSearch { query } => {
                let skills = self.skill_management.list().await?;
                let normalized_query = query.trim().to_lowercase();
                let mut matched_skills = Vec::new();
                let mut truncated = false;
                for skill in skills {
                    if normalized_query.is_empty()
                        || skill.name.to_lowercase().contains(&normalized_query)
                        || skill.description.to_lowercase().contains(&normalized_query)
                    {
                        if matched_skills.len() == SKILL_SEARCH_RESULT_LIMIT {
                            truncated = true;
                            break;
                        }
                        matched_skills.push(json!({
                            "name": skill.name,
                            "version": skill.version,
                            "description": skill.description,
                            "source": skill.source.as_str(),
                            "keywords": skill.keywords,
                            "tags": skill.tags,
                            "requires_skills": skill.requires_skills,
                        }));
                    }
                }
                let count = matched_skills.len();
                Ok(response_with_payload(
                    None,
                    LifecyclePhase::Installed,
                    json!({
                        "skills": matched_skills,
                        "count": count,
                        "limit": SKILL_SEARCH_RESULT_LIMIT,
                        "truncated": truncated,
                    }),
                ))
            }
            LifecycleProductAction::SkillInstall { name, content } => {
                let installed = self
                    .skill_management
                    .install(name.as_deref(), &content)
                    .await?;
                Ok(response_with_payload(
                    Some(skill_package_ref(&installed.name)?),
                    LifecyclePhase::Installed,
                    json!({
                        "installed": true,
                        "name": installed.name,
                    }),
                ))
            }
            LifecycleProductAction::SkillRemove { package_ref } => {
                package_ref.require_kind(LifecyclePackageKind::Skill)?;
                let removed = self
                    .skill_management
                    .remove(package_ref.id.as_str())
                    .await?;
                Ok(response_with_payload(
                    Some(skill_package_ref(&removed.name)?),
                    LifecyclePhase::Removed,
                    json!({
                        "removed": true,
                        "name": removed.name,
                    }),
                ))
            }
            LifecycleProductAction::ExtensionSearch { .. } => unsupported_projection(None),
            LifecycleProductAction::ExtensionInstall { package_ref }
            | LifecycleProductAction::ExtensionAuth { package_ref }
            | LifecycleProductAction::ExtensionActivate { package_ref }
            | LifecycleProductAction::ExtensionConfigure { package_ref, .. }
            | LifecycleProductAction::ExtensionRemove { package_ref } => {
                unsupported_projection(Some(package_ref.clone()))
            }
        }
    }
}

#[async_trait]
impl LifecycleProductFacade for RebornLocalLifecycleFacade {
    async fn execute(
        &self,
        _context: LifecycleProductContext,
        action: LifecycleProductAction,
    ) -> Result<LifecycleProductResponse, ProductWorkflowError> {
        self.execute_action(action).await
    }
}

fn skill_package_ref(name: &str) -> Result<LifecyclePackageRef, ProductWorkflowError> {
    LifecyclePackageRef::new(LifecyclePackageKind::Skill, name)
}

fn response_with_payload(
    package_ref: Option<LifecyclePackageRef>,
    phase: LifecyclePhase,
    payload: Value,
) -> LifecycleProductResponse {
    LifecycleProductResponse {
        package_ref,
        phase,
        blockers: Vec::new(),
        message: None,
        payload: Some(payload),
    }
}

fn unsupported_projection(
    package_ref: Option<LifecyclePackageRef>,
) -> Result<LifecycleProductResponse, ProductWorkflowError> {
    Ok(LifecycleProductResponse::projection(
        package_ref,
        LifecyclePhase::UnsupportedOrLegacy,
        vec![LifecycleReadinessBlocker::runtime(Some(
            "extension_lifecycle_store_unwired".to_string(),
        ))?],
    ))
}

fn map_skill_error(error: SkillManagementError) -> ProductWorkflowError {
    match error.kind() {
        SkillManagementErrorKind::InvalidInput
        | SkillManagementErrorKind::NotFound
        | SkillManagementErrorKind::Conflict
        | SkillManagementErrorKind::InvalidSkill => ProductWorkflowError::InvalidBindingRequest {
            reason: "skill management request rejected".to_string(),
        },
        SkillManagementErrorKind::FilesystemDenied => ProductWorkflowError::BindingAccessDenied,
        SkillManagementErrorKind::Resource => ProductWorkflowError::Transient {
            reason: "skill management resource unavailable".to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironclaw_host_api::{HostPath, MountAlias, MountGrant, MountPermissions, VirtualPath};

    #[tokio::test]
    async fn skill_lifecycle_facade_installs_lists_and_removes_via_skill_management() {
        let dir = tempfile::tempdir().expect("tempdir");
        let storage_root = dir.path().join("local-dev");
        std::fs::create_dir_all(&storage_root).expect("storage root");

        let mut filesystem = LocalFilesystem::new();
        filesystem
            .mount_local(
                VirtualPath::new("/projects").expect("valid virtual path"),
                HostPath::from_path_buf(storage_root.clone()),
            )
            .expect("mount storage root");
        let skill_management = Arc::new(RebornLocalSkillManagementPort::new(
            UserId::new("lifecycle-owner").expect("valid user"),
            Arc::new(filesystem),
            MountView::new(vec![
                MountGrant::new(
                    MountAlias::new("/skills").expect("valid alias"),
                    VirtualPath::new("/projects/skills").expect("valid path"),
                    MountPermissions::read_write_list_delete(),
                ),
                MountGrant::new(
                    MountAlias::new("/system/skills").expect("valid alias"),
                    VirtualPath::new("/projects/system/skills").expect("valid path"),
                    MountPermissions::read_only(),
                ),
            ])
            .expect("valid mount view"),
        ));
        let facade = RebornLocalLifecycleFacade::new(skill_management);

        let install = facade
            .execute_action(LifecycleProductAction::SkillInstall {
                name: None,
                content:
                    "---\nname: lifecycle-skill\ndescription: lifecycle test\n---\nUse lifecycle.\n"
                        .to_string(),
            })
            .await
            .expect("install skill");
        assert_eq!(install.phase, LifecyclePhase::Installed);
        assert_eq!(
            install.package_ref,
            Some(
                LifecyclePackageRef::new(LifecyclePackageKind::Skill, "lifecycle-skill")
                    .expect("valid skill ref")
            )
        );
        assert!(
            storage_root
                .join("skills/lifecycle-skill/SKILL.md")
                .exists()
        );

        let list = facade
            .execute_action(LifecycleProductAction::SkillSearch {
                query: "lifecycle".to_string(),
            })
            .await
            .expect("list skills");
        assert_eq!(list.phase, LifecyclePhase::Installed);
        assert_eq!(
            list.payload
                .as_ref()
                .and_then(|payload| payload.get("count"))
                .and_then(Value::as_u64),
            Some(1)
        );

        for index in 0..55 {
            facade
                .execute_action(LifecycleProductAction::SkillInstall {
                    name: Some(format!("bulk-skill-{index:02}")),
                    content: format!(
                        "---\nname: bulk-skill-{index:02}\ndescription: bulk test\n---\nUse bulk.\n"
                    ),
                })
                .await
                .expect("install bulk skill");
        }

        let all_skills = facade
            .execute_action(LifecycleProductAction::SkillSearch {
                query: String::new(),
            })
            .await
            .expect("list all skills");
        let payload = all_skills.payload.as_ref().expect("skill search payload");
        assert_eq!(payload.get("count").and_then(Value::as_u64), Some(50));
        assert_eq!(payload.get("limit").and_then(Value::as_u64), Some(50));
        assert_eq!(
            payload.get("truncated").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            payload
                .get("skills")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(50)
        );

        let wrong_kind = facade
            .execute_action(LifecycleProductAction::SkillRemove {
                package_ref: LifecyclePackageRef::new(
                    LifecyclePackageKind::Extension,
                    "lifecycle-skill",
                )
                .expect("valid extension ref"),
            })
            .await
            .expect_err("skill remove must reject non-skill package refs");
        assert!(matches!(
            wrong_kind,
            ProductWorkflowError::InvalidBindingRequest { .. }
        ));
        assert!(
            storage_root
                .join("skills/lifecycle-skill/SKILL.md")
                .exists()
        );

        let remove = facade
            .execute_action(LifecycleProductAction::SkillRemove {
                package_ref: LifecyclePackageRef::new(
                    LifecyclePackageKind::Skill,
                    "lifecycle-skill",
                )
                .expect("valid skill ref"),
            })
            .await
            .expect("remove skill");
        assert_eq!(remove.phase, LifecyclePhase::Removed);
        assert!(
            !storage_root
                .join("skills/lifecycle-skill/SKILL.md")
                .exists()
        );
    }
}
