//! Memory-document `RootFilesystem` adapters.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use ironclaw_filesystem::{
    DirEntry, FileStat, FileType, FilesystemError, FilesystemOperation, RootFilesystem,
};
use ironclaw_host_api::VirtualPath;

use crate::backend::{MemoryBackend, MemoryContext, RepositoryMemoryBackend};
use crate::chunking::{content_bytes_sha256, content_sha256};
use crate::events::{MemorySignificantEventSink, MemorySignificantEventSource};
use crate::indexer::MemoryDocumentIndexer;
use crate::path::{
    MemoryDocumentPath, MemoryDocumentScope, ParsedMemoryPath, memory_error, memory_not_found,
};
use crate::repo::{MemoryAppendOutcome, MemoryDocumentRepository, memory_direct_children};
use crate::safety::{
    DefaultPromptWriteSafetyPolicy, PromptProtectedPathRegistry, PromptSafetyAllowanceId,
    PromptWriteOperation, PromptWriteSafetyCheck, PromptWriteSafetyEnforcement,
    PromptWriteSafetyEventSink, PromptWriteSafetyPolicy, PromptWriteSource,
    enforce_prompt_write_safety, prompt_write_policy_requires_previous_content_hash,
    prompt_write_protected_classification, take_prompt_safety_allowance,
};
const MAX_MEMORY_APPEND_RETRIES: usize = 8;

fn memory_append_conflict_error(path: VirtualPath) -> FilesystemError {
    memory_error(
        path,
        FilesystemOperation::AppendFile,
        "memory document changed during append; retry limit exceeded",
    )
}

fn memory_context_with_prompt_safety_enforcement(
    context: &MemoryContext,
    enforcement: PromptWriteSafetyEnforcement,
) -> MemoryContext {
    let mut context = context.clone();
    if let Some(allowance) = enforcement.allowance {
        context = context.with_prompt_write_safety_allowance(allowance);
    }
    context.with_prompt_write_safety_enforced()
}

/// [`RootFilesystem`] adapter exposing any [`MemoryBackend`] as `/memory` files.
pub struct MemoryBackendFilesystemAdapter {
    backend: Arc<dyn MemoryBackend>,
    prompt_safety_policy: Option<Arc<dyn PromptWriteSafetyPolicy>>,
    prompt_safety_event_sink: Option<Arc<dyn PromptWriteSafetyEventSink>>,
    prompt_protected_path_registry: PromptProtectedPathRegistry,
    prompt_safety_config_overridden: bool,
    one_shot_prompt_safety_allowance: Mutex<Option<PromptSafetyAllowanceId>>,
}

impl MemoryBackendFilesystemAdapter {
    pub fn new<B>(backend: Arc<B>) -> Self
    where
        B: MemoryBackend + 'static,
    {
        let backend: Arc<dyn MemoryBackend> = backend;
        Self::from_dyn(backend)
    }

    pub fn from_dyn(backend: Arc<dyn MemoryBackend>) -> Self {
        let registry = PromptProtectedPathRegistry::default();
        Self {
            backend,
            prompt_safety_policy: Some(Arc::new(DefaultPromptWriteSafetyPolicy::with_registry(
                registry.clone(),
            ))),
            prompt_safety_event_sink: None,
            prompt_protected_path_registry: registry,
            prompt_safety_config_overridden: false,
            one_shot_prompt_safety_allowance: Mutex::new(None),
        }
    }

    pub fn with_prompt_write_safety_policy<P>(mut self, policy: Arc<P>) -> Self
    where
        P: PromptWriteSafetyPolicy + 'static,
    {
        let policy: Arc<dyn PromptWriteSafetyPolicy> = policy;
        self.prompt_safety_policy = Some(policy);
        self.prompt_safety_config_overridden = true;
        self
    }

    pub fn without_prompt_write_safety_policy(mut self) -> Self {
        self.prompt_safety_policy = None;
        self.prompt_safety_config_overridden = true;
        self
    }

    pub fn with_prompt_write_safety_event_sink<S>(mut self, event_sink: Arc<S>) -> Self
    where
        S: PromptWriteSafetyEventSink + 'static,
    {
        let event_sink: Arc<dyn PromptWriteSafetyEventSink> = event_sink;
        self.prompt_safety_event_sink = Some(event_sink);
        // **Sink config is observability, not policy override.** Adding an
        // audit sink does *not* mean the host is replacing the backend's
        // policy — it means the host wants every safety event to land in a
        // specific durable seam. Flipping `prompt_safety_config_overridden`
        // here would cause the adapter to take over enforcement, skipping a
        // stricter backend policy that the operator never intended to
        // bypass (zmanian #3180 HIGH `filesystem.rs:47`). Policy overrides
        // are now scoped to the explicit `with_prompt_write_safety_policy`
        // / `without_prompt_write_safety_policy` /
        // `with_prompt_protected_path_registry` builders.
        self
    }

    /// Installs an explicit prompt-write safety allowance for the next protected write only.
    ///
    /// The allowance is consumed before policy evaluation so shared filesystem adapters cannot
    /// accidentally retain a bypass for later unrelated callers.
    pub fn with_one_shot_prompt_write_safety_allowance(
        self,
        allowance: PromptSafetyAllowanceId,
    ) -> Self {
        if let Ok(mut slot) = self.one_shot_prompt_safety_allowance.lock() {
            *slot = Some(allowance);
        }
        self
    }

    pub fn with_prompt_protected_path_registry(
        mut self,
        registry: PromptProtectedPathRegistry,
    ) -> Self {
        self.prompt_protected_path_registry = registry;
        self.prompt_safety_config_overridden = true;
        self
    }

    fn ensure_file_documents(
        &self,
        path: &VirtualPath,
        operation: FilesystemOperation,
    ) -> Result<(), FilesystemError> {
        if self.backend.capabilities().file_documents {
            Ok(())
        } else {
            Err(memory_error(
                path.clone(),
                operation,
                "memory backend does not support file documents",
            ))
        }
    }

    fn parse_file_path(
        &self,
        path: &VirtualPath,
        operation: FilesystemOperation,
    ) -> Result<MemoryDocumentPath, FilesystemError> {
        let parsed = ParsedMemoryPath::from_virtual_path(path, operation)?;
        let Some(relative_path) = parsed.relative_path else {
            return Err(memory_error(
                path.clone(),
                operation,
                "memory document path must include a file path after project id",
            ));
        };
        Ok(MemoryDocumentPath {
            scope: parsed.scope,
            relative_path,
        })
    }
}

#[async_trait]
impl RootFilesystem for MemoryBackendFilesystemAdapter {
    async fn read_file(&self, path: &VirtualPath) -> Result<Vec<u8>, FilesystemError> {
        self.ensure_file_documents(path, FilesystemOperation::ReadFile)?;
        let document_path = self.parse_file_path(path, FilesystemOperation::ReadFile)?;
        let context = MemoryContext::new(document_path.scope().clone());
        self.backend
            .read_document(&context, &document_path)
            .await?
            .ok_or_else(|| memory_not_found(path.clone(), FilesystemOperation::ReadFile))
    }

    async fn write_file(&self, path: &VirtualPath, bytes: &[u8]) -> Result<(), FilesystemError> {
        self.ensure_file_documents(path, FilesystemOperation::WriteFile)?;
        let document_path = self.parse_file_path(path, FilesystemOperation::WriteFile)?;
        let mut context = MemoryContext::new(document_path.scope().clone());
        let is_protected = prompt_write_protected_classification(
            self.prompt_safety_policy.as_ref(),
            &self.prompt_protected_path_registry,
            &document_path,
        )
        .is_some();
        let backend_capabilities = self.backend.capabilities();
        let backend_will_enforce_protected_path = backend_capabilities.prompt_write_safety
            && self
                .backend
                .prompt_write_safety_protects_path(&document_path);
        // The adapter must enforce whenever the path is protected and the
        // wrapped backend will *not* enforce for THIS path — relying on
        // the bare `prompt_write_safety` capability flag is insufficient
        // because a backend can advertise the capability while reporting
        // `prompt_write_safety_protects_path() == false` for adapter-
        // classified protected files (SOUL.md, AGENTS.md, …). Without
        // this path-level check the adapter skips its policy and the
        // backend does nothing → unprotected write through the
        // filesystem surface (zmanian #3180 HIGH `filesystem.rs:196`).
        let adapter_should_enforce_prompt_safety = is_protected
            && (!backend_will_enforce_protected_path || self.prompt_safety_config_overridden);
        let prompt_safety_allowance = if is_protected || backend_will_enforce_protected_path {
            take_prompt_safety_allowance(
                &self.one_shot_prompt_safety_allowance,
                path,
                FilesystemOperation::WriteFile,
            )?
        } else {
            None
        };
        if let Some(allowance) = &prompt_safety_allowance {
            context = context.with_prompt_write_safety_allowance(allowance.clone());
        }
        let mut backend_context = context.clone();
        if adapter_should_enforce_prompt_safety {
            let content = std::str::from_utf8(bytes).map_err(|_| {
                memory_error(
                    path.clone(),
                    FilesystemOperation::WriteFile,
                    "memory document content must be UTF-8",
                )
            })?;
            let previous_hash = if prompt_write_policy_requires_previous_content_hash(
                self.prompt_safety_policy.as_ref(),
            ) {
                self.backend
                    .read_document(&context, &document_path)
                    .await?
                    .and_then(|bytes| std::str::from_utf8(&bytes).ok().map(content_sha256))
            } else {
                None
            };
            let enforcement = enforce_prompt_write_safety(
                self.prompt_safety_policy.as_ref(),
                self.prompt_safety_event_sink.as_ref(),
                &self.prompt_protected_path_registry,
                PromptWriteSafetyCheck {
                    scope: context.scope(),
                    path: &document_path,
                    operation: PromptWriteOperation::Write,
                    source: PromptWriteSource::MemoryFilesystemAdapter,
                    content,
                    previous_content_hash: previous_hash.as_deref(),
                    allowance: context.prompt_write_safety_allowance(),
                    audit_context: context.audit_context(),
                    filesystem_operation: FilesystemOperation::WriteFile,
                },
            )
            .await?;
            backend_context = memory_context_with_prompt_safety_enforcement(&context, enforcement);
        }
        self.backend
            .write_document(&backend_context, &document_path, bytes)
            .await
    }

    async fn append_file(&self, path: &VirtualPath, bytes: &[u8]) -> Result<(), FilesystemError> {
        self.ensure_file_documents(path, FilesystemOperation::AppendFile)?;
        let document_path = self.parse_file_path(path, FilesystemOperation::AppendFile)?;
        let mut context = MemoryContext::new(document_path.scope().clone());
        let is_protected = prompt_write_protected_classification(
            self.prompt_safety_policy.as_ref(),
            &self.prompt_protected_path_registry,
            &document_path,
        )
        .is_some();
        let backend_capabilities = self.backend.capabilities();
        let backend_will_enforce_protected_path = backend_capabilities.prompt_write_safety
            && self
                .backend
                .prompt_write_safety_protects_path(&document_path);
        // See `write_file` for the rationale — same path-level rule for
        // append (zmanian #3180 HIGH `filesystem.rs:196`).
        let adapter_should_enforce_prompt_safety = is_protected
            && (!backend_will_enforce_protected_path || self.prompt_safety_config_overridden);
        let prompt_safety_allowance = if is_protected || backend_will_enforce_protected_path {
            take_prompt_safety_allowance(
                &self.one_shot_prompt_safety_allowance,
                path,
                FilesystemOperation::AppendFile,
            )?
        } else {
            None
        };
        if let Some(allowance) = &prompt_safety_allowance {
            context = context.with_prompt_write_safety_allowance(allowance.clone());
        }

        for _ in 0..MAX_MEMORY_APPEND_RETRIES {
            let previous = self.backend.read_document(&context, &document_path).await?;
            let expected_previous_hash = previous.as_deref().map(content_bytes_sha256);
            let previous_bytes = previous.unwrap_or_default();
            let previous_prompt_hash = if adapter_should_enforce_prompt_safety
                && prompt_write_policy_requires_previous_content_hash(
                    self.prompt_safety_policy.as_ref(),
                ) {
                std::str::from_utf8(&previous_bytes)
                    .ok()
                    .map(content_sha256)
            } else {
                None
            };
            let mut combined = previous_bytes;
            combined.extend_from_slice(bytes);
            let mut backend_context = context.clone();
            if adapter_should_enforce_prompt_safety {
                let content = std::str::from_utf8(&combined).map_err(|_| {
                    memory_error(
                        path.clone(),
                        FilesystemOperation::AppendFile,
                        "memory document content must be UTF-8",
                    )
                })?;
                let enforcement = enforce_prompt_write_safety(
                    self.prompt_safety_policy.as_ref(),
                    self.prompt_safety_event_sink.as_ref(),
                    &self.prompt_protected_path_registry,
                    PromptWriteSafetyCheck {
                        scope: context.scope(),
                        path: &document_path,
                        operation: PromptWriteOperation::Append,
                        source: PromptWriteSource::MemoryFilesystemAdapter,
                        content,
                        previous_content_hash: previous_prompt_hash.as_deref(),
                        allowance: context.prompt_write_safety_allowance(),
                        audit_context: context.audit_context(),
                        filesystem_operation: FilesystemOperation::AppendFile,
                    },
                )
                .await?;
                backend_context =
                    memory_context_with_prompt_safety_enforcement(&context, enforcement);
            }
            match self
                .backend
                .compare_and_append_document(
                    &backend_context,
                    &document_path,
                    expected_previous_hash.as_deref(),
                    bytes,
                )
                .await?
            {
                MemoryAppendOutcome::Appended => return Ok(()),
                MemoryAppendOutcome::Conflict => continue,
            }
        }
        Err(memory_append_conflict_error(path.clone()))
    }

    async fn list_dir(&self, path: &VirtualPath) -> Result<Vec<DirEntry>, FilesystemError> {
        self.ensure_file_documents(path, FilesystemOperation::ListDir)?;
        let parsed = ParsedMemoryPath::from_virtual_path(path, FilesystemOperation::ListDir)?;
        let context = MemoryContext::new(parsed.scope.clone());
        let documents = self.backend.list_documents(&context, &parsed.scope).await?;
        if let Some(relative_path) = parsed.relative_path.as_deref()
            && documents
                .iter()
                .any(|document| document.relative_path() == relative_path)
        {
            return Err(memory_error(
                path.clone(),
                FilesystemOperation::ListDir,
                "not a directory",
            ));
        }
        memory_direct_children(path, parsed.relative_path.as_deref(), documents)
    }

    async fn stat(&self, path: &VirtualPath) -> Result<FileStat, FilesystemError> {
        self.ensure_file_documents(path, FilesystemOperation::Stat)?;
        let parsed = ParsedMemoryPath::from_virtual_path(path, FilesystemOperation::Stat)?;
        let context = MemoryContext::new(parsed.scope.clone());
        let documents = self.backend.list_documents(&context, &parsed.scope).await?;
        if let Some(relative_path) = parsed.relative_path.as_deref() {
            if let Some(document) = documents
                .iter()
                .find(|document| document.relative_path() == relative_path)
            {
                let len = self
                    .backend
                    .read_document(&context, document)
                    .await?
                    .map(|bytes| bytes.len() as u64)
                    .unwrap_or(0);
                return Ok(FileStat {
                    path: path.clone(),
                    file_type: FileType::File,
                    len,
                });
            }
            let directory_prefix = format!("{relative_path}/");
            if documents
                .iter()
                .any(|document| document.relative_path().starts_with(&directory_prefix))
            {
                return Ok(FileStat {
                    path: path.clone(),
                    file_type: FileType::Directory,
                    len: 0,
                });
            }
            return Err(memory_not_found(path.clone(), FilesystemOperation::Stat));
        }

        if documents.is_empty() {
            return Err(memory_not_found(path.clone(), FilesystemOperation::Stat));
        }
        Ok(FileStat {
            path: path.clone(),
            file_type: FileType::Directory,
            len: 0,
        })
    }
}

/// Compatibility [`RootFilesystem`] facade for repository-backed memory documents.
///
/// New code should prefer composing [`RepositoryMemoryBackend`] with
/// [`MemoryBackendFilesystemAdapter`] directly. This facade keeps the historical
/// repository constructor surface while delegating write/append policy, schema,
/// indexing, and memory-event behavior to the repository-backed backend so the
/// rules live in one Implementation.
pub struct MemoryDocumentFilesystem {
    backend: RepositoryMemoryBackend<dyn MemoryDocumentRepository>,
    one_shot_prompt_safety_allowance: Mutex<Option<PromptSafetyAllowanceId>>,
}

impl MemoryDocumentFilesystem {
    pub fn new<R>(repository: Arc<R>) -> Self
    where
        R: MemoryDocumentRepository + 'static,
    {
        let repository: Arc<dyn MemoryDocumentRepository> = repository;
        Self::from_dyn(repository)
    }

    pub fn from_dyn(repository: Arc<dyn MemoryDocumentRepository>) -> Self {
        Self {
            backend: RepositoryMemoryBackend::new(repository)
                .with_memory_event_source(MemorySignificantEventSource::MemoryDocumentFilesystem),
            one_shot_prompt_safety_allowance: Mutex::new(None),
        }
    }

    pub fn with_indexer<I>(mut self, indexer: Arc<I>) -> Self
    where
        I: MemoryDocumentIndexer + 'static,
    {
        self.backend = self.backend.with_indexer(indexer);
        self
    }

    pub fn with_prompt_write_safety_policy<P>(mut self, policy: Arc<P>) -> Self
    where
        P: PromptWriteSafetyPolicy + 'static,
    {
        self.backend = self.backend.with_prompt_write_safety_policy(policy);
        self
    }

    pub fn without_prompt_write_safety_policy(mut self) -> Self {
        self.backend = self.backend.without_prompt_write_safety_policy();
        self
    }

    pub fn with_prompt_write_safety_event_sink<S>(mut self, event_sink: Arc<S>) -> Self
    where
        S: PromptWriteSafetyEventSink + 'static,
    {
        self.backend = self.backend.with_prompt_write_safety_event_sink(event_sink);
        self
    }

    pub fn with_memory_event_sink<S>(mut self, event_sink: Arc<S>) -> Self
    where
        S: MemorySignificantEventSink + 'static,
    {
        self.backend = self.backend.with_memory_event_sink(event_sink);
        self
    }

    /// Installs an explicit prompt-write safety allowance for the next protected write only.
    ///
    /// The allowance is consumed before policy evaluation so shared filesystem adapters cannot
    /// accidentally retain a bypass for later unrelated callers.
    pub fn with_one_shot_prompt_write_safety_allowance(
        self,
        allowance: PromptSafetyAllowanceId,
    ) -> Self {
        if let Ok(mut slot) = self.one_shot_prompt_safety_allowance.lock() {
            *slot = Some(allowance);
        }
        self
    }

    pub fn with_prompt_protected_path_registry(
        mut self,
        registry: PromptProtectedPathRegistry,
    ) -> Self {
        self.backend = self.backend.with_prompt_protected_path_registry(registry);
        self
    }

    fn parse_file_path(
        &self,
        path: &VirtualPath,
        operation: FilesystemOperation,
    ) -> Result<MemoryDocumentPath, FilesystemError> {
        let parsed = ParsedMemoryPath::from_virtual_path(path, operation)?;
        let Some(relative_path) = parsed.relative_path else {
            return Err(memory_error(
                path.clone(),
                operation,
                "memory document path must include a file path after project id",
            ));
        };
        Ok(MemoryDocumentPath {
            scope: parsed.scope,
            relative_path,
        })
    }

    fn context_for_write(
        &self,
        path: &VirtualPath,
        operation: FilesystemOperation,
        document_path: &MemoryDocumentPath,
    ) -> Result<MemoryContext, FilesystemError> {
        let mut context = MemoryContext::new(document_path.scope().clone());
        if self
            .backend
            .prompt_write_safety_protects_path(document_path)
            && let Some(allowance) = take_prompt_safety_allowance(
                &self.one_shot_prompt_safety_allowance,
                path,
                operation,
            )?
        {
            context = context.with_prompt_write_safety_allowance(allowance);
        }
        Ok(context)
    }

    async fn list_for_scope(
        &self,
        scope: &MemoryDocumentScope,
    ) -> Result<Vec<MemoryDocumentPath>, FilesystemError> {
        let context = MemoryContext::new(scope.clone());
        self.backend.list_documents(&context, scope).await
    }
}

#[async_trait]
impl RootFilesystem for MemoryDocumentFilesystem {
    async fn read_file(&self, path: &VirtualPath) -> Result<Vec<u8>, FilesystemError> {
        let document_path = self.parse_file_path(path, FilesystemOperation::ReadFile)?;
        let context = MemoryContext::new(document_path.scope().clone());
        self.backend
            .read_document(&context, &document_path)
            .await?
            .ok_or_else(|| memory_not_found(path.clone(), FilesystemOperation::ReadFile))
    }

    async fn write_file(&self, path: &VirtualPath, bytes: &[u8]) -> Result<(), FilesystemError> {
        let document_path = self.parse_file_path(path, FilesystemOperation::WriteFile)?;
        let context =
            self.context_for_write(path, FilesystemOperation::WriteFile, &document_path)?;
        self.backend
            .write_document(&context, &document_path, bytes)
            .await
    }

    async fn append_file(&self, path: &VirtualPath, bytes: &[u8]) -> Result<(), FilesystemError> {
        let document_path = self.parse_file_path(path, FilesystemOperation::AppendFile)?;
        let context =
            self.context_for_write(path, FilesystemOperation::AppendFile, &document_path)?;
        for _ in 0..MAX_MEMORY_APPEND_RETRIES {
            let previous = self.backend.read_document(&context, &document_path).await?;
            let expected_previous_hash = previous.as_deref().map(content_bytes_sha256);
            match self
                .backend
                .compare_and_append_document(
                    &context,
                    &document_path,
                    expected_previous_hash.as_deref(),
                    bytes,
                )
                .await?
            {
                MemoryAppendOutcome::Appended => return Ok(()),
                MemoryAppendOutcome::Conflict => continue,
            }
        }
        Err(memory_append_conflict_error(path.clone()))
    }

    async fn list_dir(&self, path: &VirtualPath) -> Result<Vec<DirEntry>, FilesystemError> {
        let parsed = ParsedMemoryPath::from_virtual_path(path, FilesystemOperation::ListDir)?;
        let documents = self.list_for_scope(&parsed.scope).await?;
        if let Some(relative_path) = parsed.relative_path.as_deref()
            && documents
                .iter()
                .any(|document| document.relative_path() == relative_path)
        {
            return Err(memory_error(
                path.clone(),
                FilesystemOperation::ListDir,
                "not a directory",
            ));
        }
        memory_direct_children(path, parsed.relative_path.as_deref(), documents)
    }

    async fn stat(&self, path: &VirtualPath) -> Result<FileStat, FilesystemError> {
        let parsed = ParsedMemoryPath::from_virtual_path(path, FilesystemOperation::Stat)?;
        let documents = self.list_for_scope(&parsed.scope).await?;
        if let Some(relative_path) = parsed.relative_path.as_deref() {
            if let Some(document) = documents
                .iter()
                .find(|document| document.relative_path() == relative_path)
            {
                let context = MemoryContext::new(document.scope().clone());
                let len = self
                    .backend
                    .read_document(&context, document)
                    .await?
                    .map(|bytes| bytes.len() as u64)
                    .unwrap_or(0);
                return Ok(FileStat {
                    path: path.clone(),
                    file_type: FileType::File,
                    len,
                });
            }
            let directory_prefix = format!("{relative_path}/");
            if documents
                .iter()
                .any(|document| document.relative_path().starts_with(&directory_prefix))
            {
                return Ok(FileStat {
                    path: path.clone(),
                    file_type: FileType::Directory,
                    len: 0,
                });
            }
            return Err(memory_not_found(path.clone(), FilesystemOperation::Stat));
        }

        if documents.is_empty() {
            return Err(memory_not_found(path.clone(), FilesystemOperation::Stat));
        }
        Ok(FileStat {
            path: path.clone(),
            file_type: FileType::Directory,
            len: 0,
        })
    }
}
