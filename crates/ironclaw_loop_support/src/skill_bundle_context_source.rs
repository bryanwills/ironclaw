use std::sync::Arc;

use async_trait::async_trait;

use crate::{
    HostSkillContextBuildError, HostSkillContextCandidate, HostSkillContextSource,
    SkillBundleSource, SkillBundleSourceError, sort_skill_bundle_descriptors,
};
use ironclaw_turns::run_profile::{LoopRunContext, SkillVisibility};

/// Adapts portable skill bundles into model-context candidates.
///
/// This adapter is intentionally policy-thin: it requires host-supplied trust
/// and visibility metadata from [`SkillBundleDescriptor`], reads raw `SKILL.md`
/// content only for visible bundles, and leaves final snapshot trust/visibility
/// enforcement to [`crate::build_skill_run_snapshot`].
pub struct SkillBundleContextSource<S>
where
    S: SkillBundleSource + ?Sized,
{
    bundle_source: Arc<S>,
}

impl<S> SkillBundleContextSource<S>
where
    S: SkillBundleSource + ?Sized,
{
    pub fn new(bundle_source: Arc<S>) -> Self {
        Self { bundle_source }
    }

    pub fn bundle_source(&self) -> &Arc<S> {
        &self.bundle_source
    }
}

impl<S> std::fmt::Debug for SkillBundleContextSource<S>
where
    S: SkillBundleSource + ?Sized,
{
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SkillBundleContextSource")
            .field("bundle_source", &"<SkillBundleSource>")
            .finish()
    }
}

#[async_trait]
impl<S> HostSkillContextSource for SkillBundleContextSource<S>
where
    S: SkillBundleSource + ?Sized,
{
    async fn load_skill_context_candidates(
        &self,
        run_context: &LoopRunContext,
    ) -> Result<Vec<HostSkillContextCandidate>, HostSkillContextBuildError> {
        let mut descriptors = self
            .bundle_source
            .list_skill_bundles(run_context)
            .await
            .map_err(skill_bundle_source_error_to_context_error)?;
        sort_skill_bundle_descriptors(&mut descriptors);

        let mut candidates = Vec::with_capacity(descriptors.len());
        for descriptor in descriptors {
            let trust = descriptor.trust().cloned();
            let visibility = descriptor.visibility().copied();
            let ordering_key = descriptor.id().to_string();

            if trust.is_none() || visibility != Some(SkillVisibility::Visible) {
                candidates.push(
                    HostSkillContextCandidate::unavailable(trust, visibility)
                        .with_ordering_key(ordering_key),
                );
                continue;
            }

            let skill_md = self
                .bundle_source
                .read_skill_bundle_file(run_context, descriptor.id(), descriptor.skill_md_path())
                .await
                .map_err(skill_bundle_source_error_to_context_error)?;
            let skill_md =
                String::from_utf8(skill_md).map_err(|_| HostSkillContextBuildError::ParseFailed)?;

            candidates.push(
                HostSkillContextCandidate::new(skill_md, trust, visibility)
                    .with_ordering_key(ordering_key),
            );
        }

        Ok(candidates)
    }
}

fn skill_bundle_source_error_to_context_error(
    error: SkillBundleSourceError,
) -> HostSkillContextBuildError {
    match error {
        SkillBundleSourceError::SourceUnavailable
        | SkillBundleSourceError::BundleNotFound
        | SkillBundleSourceError::FileNotFound
        | SkillBundleSourceError::PermissionDenied => HostSkillContextBuildError::SourceUnavailable,
        SkillBundleSourceError::InvalidBundleId
        | SkillBundleSourceError::InvalidFilePath
        | SkillBundleSourceError::InvalidSkillBundle => HostSkillContextBuildError::ParseFailed,
        SkillBundleSourceError::ContentTooLarge => {
            HostSkillContextBuildError::ContextBudgetExceeded
        }
        SkillBundleSourceError::Internal => HostSkillContextBuildError::Internal,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use async_trait::async_trait;
    use ironclaw_skills::SkillTrust;
    use ironclaw_turns::{
        RunProfileResolutionRequest, RunProfileResolver, TurnId, TurnRunId, TurnScope,
        run_profile::InMemoryRunProfileResolver,
    };

    use super::*;
    use crate::{
        SkillBundleDescriptor, build_skill_run_snapshot,
        skill_context::build_skill_instruction_snippets,
    };
    use ironclaw_host_api::{AgentId, ProjectId, TenantId, ThreadId};

    fn skill_md(name: &str, description: &str, prompt: &str) -> Vec<u8> {
        format!("---\nname: {name}\ndescription: {description}\n---\n{prompt}\n").into_bytes()
    }

    async fn run_context() -> LoopRunContext {
        let scope = TurnScope::new(
            TenantId::new("tenant-a").unwrap(),
            Some(AgentId::new("agent-a").unwrap()),
            Some(ProjectId::new("project-a").unwrap()),
            ThreadId::new("thread-a").unwrap(),
        );
        let resolved = InMemoryRunProfileResolver::default()
            .resolve_run_profile(RunProfileResolutionRequest::interactive_default())
            .await
            .unwrap();
        LoopRunContext::new(scope, TurnId::new(), TurnRunId::new(), resolved)
    }

    fn descriptor(
        source_kind: crate::SkillSourceKind,
        name: &str,
        trust: Option<SkillTrust>,
        visibility: Option<SkillVisibility>,
    ) -> SkillBundleDescriptor {
        SkillBundleDescriptor::new(
            crate::SkillBundleId::new(source_kind, name).unwrap(),
            trust,
            visibility,
        )
    }

    #[derive(Default)]
    struct StaticSkillBundleSource {
        descriptors: Vec<SkillBundleDescriptor>,
        files: Mutex<HashMap<String, Vec<u8>>>,
        reads: Mutex<Vec<String>>,
    }

    impl StaticSkillBundleSource {
        fn new(descriptors: Vec<SkillBundleDescriptor>) -> Self {
            Self {
                descriptors,
                files: Mutex::new(HashMap::new()),
                reads: Mutex::new(Vec::new()),
            }
        }

        fn with_skill_md(
            self,
            source_kind: crate::SkillSourceKind,
            name: &str,
            body: Vec<u8>,
        ) -> Self {
            self.files
                .lock()
                .unwrap()
                .insert(format!("{source_kind}:{name}:SKILL.md"), body);
            self
        }

        fn reads(&self) -> Vec<String> {
            self.reads.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl SkillBundleSource for StaticSkillBundleSource {
        async fn list_skill_bundles(
            &self,
            _run_context: &LoopRunContext,
        ) -> Result<Vec<SkillBundleDescriptor>, SkillBundleSourceError> {
            Ok(self.descriptors.clone())
        }

        async fn read_skill_bundle_file(
            &self,
            _run_context: &LoopRunContext,
            bundle_id: &crate::SkillBundleId,
            path: &crate::SkillFilePath,
        ) -> Result<Vec<u8>, SkillBundleSourceError> {
            let key = format!("{bundle_id}:{path}");
            self.reads.lock().unwrap().push(key.clone());
            self.files
                .lock()
                .unwrap()
                .get(&key)
                .cloned()
                .ok_or(SkillBundleSourceError::FileNotFound)
        }
    }

    #[tokio::test]
    async fn adapter_reads_visible_trusted_bundle_into_model_snippet() {
        let source = Arc::new(
            StaticSkillBundleSource::new(vec![descriptor(
                crate::SkillSourceKind::System,
                "alpha",
                Some(SkillTrust::Trusted),
                Some(SkillVisibility::Visible),
            )])
            .with_skill_md(
                crate::SkillSourceKind::System,
                "alpha",
                skill_md("alpha", "safe alpha description", "trusted alpha prompt"),
            ),
        );
        let adapter = SkillBundleContextSource::new(source);

        let snippets = build_skill_instruction_snippets(&adapter, &run_context().await)
            .await
            .unwrap();

        assert_eq!(snippets.len(), 1);
        assert_eq!(snippets[0].snippet_ref, "skill:alpha");
        assert!(snippets[0].safe_summary.contains("safe alpha description"));
        assert!(snippets[0].safe_summary.contains("trusted alpha prompt"));
    }

    #[tokio::test]
    async fn adapter_keeps_installed_bundle_prompt_out_of_model_snippet() {
        let source = Arc::new(
            StaticSkillBundleSource::new(vec![descriptor(
                crate::SkillSourceKind::User,
                "alpha",
                Some(SkillTrust::Installed),
                Some(SkillVisibility::Visible),
            )])
            .with_skill_md(
                crate::SkillSourceKind::User,
                "alpha",
                skill_md(
                    "alpha",
                    "safe installed description",
                    "RAW_INSTALLED_PROMPT_SENTINEL",
                ),
            ),
        );
        let adapter = SkillBundleContextSource::new(source);

        let snippets = build_skill_instruction_snippets(&adapter, &run_context().await)
            .await
            .unwrap();

        assert_eq!(snippets.len(), 1);
        assert!(
            snippets[0]
                .safe_summary
                .contains("safe installed description")
        );
        assert!(
            !snippets[0]
                .safe_summary
                .contains("RAW_INSTALLED_PROMPT_SENTINEL")
        );
    }

    #[tokio::test]
    async fn adapter_does_not_read_hidden_or_denied_bundles() {
        let source = Arc::new(StaticSkillBundleSource::new(vec![
            descriptor(
                crate::SkillSourceKind::System,
                "hidden",
                Some(SkillTrust::Trusted),
                Some(SkillVisibility::Hidden),
            ),
            descriptor(
                crate::SkillSourceKind::User,
                "denied",
                Some(SkillTrust::Installed),
                Some(SkillVisibility::Denied),
            ),
        ]));
        let adapter = SkillBundleContextSource::new(Arc::clone(&source));

        let snippets = build_skill_instruction_snippets(&adapter, &run_context().await)
            .await
            .unwrap();

        assert!(snippets.is_empty());
        assert!(source.reads().is_empty());
    }

    #[tokio::test]
    async fn adapter_fails_closed_when_policy_metadata_is_missing_without_reads() {
        let source = Arc::new(StaticSkillBundleSource::new(vec![descriptor(
            crate::SkillSourceKind::User,
            "alpha",
            None,
            Some(SkillVisibility::Visible),
        )]));
        let adapter = SkillBundleContextSource::new(Arc::clone(&source));

        let candidates = adapter
            .load_skill_context_candidates(&run_context().await)
            .await
            .unwrap();
        let error = build_skill_run_snapshot(candidates).unwrap_err();

        assert_eq!(error, HostSkillContextBuildError::TrustDataMissing);
        assert!(source.reads().is_empty());
    }

    #[tokio::test]
    async fn adapter_sorts_candidates_by_bundle_descriptor_ordering_key() {
        let source = Arc::new(
            StaticSkillBundleSource::new(vec![
                descriptor(
                    crate::SkillSourceKind::User,
                    "bravo",
                    Some(SkillTrust::Trusted),
                    Some(SkillVisibility::Visible),
                ),
                descriptor(
                    crate::SkillSourceKind::System,
                    "alpha",
                    Some(SkillTrust::Trusted),
                    Some(SkillVisibility::Visible),
                ),
            ])
            .with_skill_md(
                crate::SkillSourceKind::User,
                "bravo",
                skill_md("bravo", "bravo description", "bravo prompt"),
            )
            .with_skill_md(
                crate::SkillSourceKind::System,
                "alpha",
                skill_md("alpha", "alpha description", "alpha prompt"),
            ),
        );
        let adapter = SkillBundleContextSource::new(source);

        let candidates = adapter
            .load_skill_context_candidates(&run_context().await)
            .await
            .unwrap();

        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.ordering_key.as_deref().unwrap())
                .collect::<Vec<_>>(),
            vec!["system:alpha", "user:bravo"]
        );
    }
}
