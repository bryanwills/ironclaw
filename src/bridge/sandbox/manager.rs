//! [`ProjectSandboxManager`] — owns one [`DockerTransport`] per project.
//!
//! Lazily creates the per-project sandbox container on first use, hands out
//! a shared [`SandboxTransport`] handle that the project's
//! [`ContainerizedFilesystemBackend`] dispatches into, and exposes lifecycle
//! hooks (`shutdown_project`, `shutdown_all`) for engine teardown.
//!
//! The manager is the single owner of `bollard::Docker` so all sandbox
//! activity routes through one connection. The Phase 6 router constructs
//! exactly one `ProjectSandboxManager` and shares it across all projects.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use bollard::Docker;
use ironclaw_engine::{MountError, ProjectId};
use ironclaw_host_runtime::{SandboxCommandTransport, TenantSandboxProcessPort};
use tokio::sync::Mutex;
use tracing::debug;

use super::command_transport::DockerSandboxCommandTransport;
use super::docker_transport::DockerTransport;
use super::lifecycle;
use super::transport::SandboxTransport;

/// One process-wide manager that vends sandbox transports per project.
pub struct ProjectSandboxManager {
    docker: Docker,
    transports: Mutex<HashMap<ProjectId, Arc<DockerTransport>>>,
    command_transports: Mutex<HashMap<ProjectId, Arc<DockerTransport>>>,
}

impl std::fmt::Debug for ProjectSandboxManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectSandboxManager").finish()
    }
}

impl ProjectSandboxManager {
    pub fn new(docker: Docker) -> Self {
        Self {
            docker,
            transports: Mutex::new(HashMap::new()),
            command_transports: Mutex::new(HashMap::new()),
        }
    }

    /// Get-or-create the transport for `project_id`. The first call ensures
    /// the container is running and starts a `docker exec` session into the
    /// daemon; subsequent calls return the cached handle.
    ///
    /// The lock is held across `ensure_running` for the creating project so
    /// two concurrent calls for the same project_id don't spawn duplicate
    /// containers. This does head-of-line-block other projects during
    /// container creation (~1-2s), but avoids orphan containers that would
    /// accumulate until the idle reaper (not yet implemented) cleans them.
    pub async fn transport_for(
        &self,
        project_id: ProjectId,
        host_workspace_path: PathBuf,
    ) -> Result<Arc<dyn SandboxTransport>, MountError> {
        let mut guard = self.transports.lock().await;

        // Fast path: return cached transport.
        if let Some(existing) = guard.get(&project_id) {
            return Ok(existing.clone() as Arc<dyn SandboxTransport>);
        }

        // Slow path: create the container and transport while holding the
        // lock, so concurrent calls for the same project_id wait rather
        // than spawning a duplicate container.
        let container_id =
            lifecycle::ensure_running(&self.docker, project_id, &host_workspace_path).await?;
        debug!(
            project_id = %project_id,
            container_id = %container_id,
            "ProjectSandboxManager: created sandbox transport"
        );
        let transport = Arc::new(DockerTransport::new(self.docker.clone(), container_id));
        guard.insert(project_id, transport.clone());
        Ok(transport as Arc<dyn SandboxTransport>)
    }

    /// Get-or-create a Reborn sandbox process-command transport for `project_id`.
    ///
    /// This uses a separate Docker exec session from the containerized
    /// filesystem backend, so long-running commands cannot monopolize
    /// filesystem RPCs for the same project.
    #[allow(dead_code)]
    pub async fn command_transport_for(
        &self,
        project_id: ProjectId,
        host_workspace_path: PathBuf,
    ) -> Result<Arc<dyn SandboxCommandTransport>, MountError> {
        let mut guard = self.command_transports.lock().await;
        if let Some(existing) = guard.get(&project_id) {
            return Ok(Arc::new(DockerSandboxCommandTransport::new(
                existing.clone() as Arc<dyn SandboxTransport>
            )) as Arc<dyn SandboxCommandTransport>);
        }

        let container_id =
            lifecycle::ensure_running(&self.docker, project_id, &host_workspace_path).await?;
        debug!(
            project_id = %project_id,
            container_id = %container_id,
            "ProjectSandboxManager: created sandbox command transport"
        );
        let transport = Arc::new(DockerTransport::new(self.docker.clone(), container_id));
        guard.insert(project_id, transport.clone());
        Ok(Arc::new(DockerSandboxCommandTransport::new(transport))
            as Arc<dyn SandboxCommandTransport>)
    }

    /// Get-or-create the Reborn tenant-sandbox process port for `project_id`.
    ///
    /// Composition roots can pass the returned port to
    /// `HostRuntimeServices::with_tenant_sandbox_process_port` so planned
    /// `ProcessBackendKind::TenantSandbox` execution lands in the Docker
    /// sandbox daemon instead of local host processes.
    #[allow(dead_code)]
    pub async fn process_port_for(
        &self,
        project_id: ProjectId,
        host_workspace_path: PathBuf,
    ) -> Result<Arc<TenantSandboxProcessPort>, MountError> {
        let transport = self
            .command_transport_for(project_id, host_workspace_path)
            .await?;
        Ok(Arc::new(TenantSandboxProcessPort::new(transport)))
    }

    /// Stop and forget the cached transport for `project_id`. The container
    /// itself is left around (still on disk) so the next call resumes
    /// quickly. Use [`Self::reset_project`] for full removal.
    #[allow(dead_code)]
    pub async fn shutdown_project(&self, project_id: ProjectId) {
        let mut guard = self.transports.lock().await;
        let had_filesystem_transport = guard.remove(&project_id).is_some();
        drop(guard);
        let mut command_guard = self.command_transports.lock().await;
        let had_command_transport = command_guard.remove(&project_id).is_some();
        if had_filesystem_transport || had_command_transport {
            lifecycle::stop(&self.docker, project_id).await;
        }
    }

    /// Stop the container *and* remove it from Docker. Used by project
    /// deletion / explicit user reset. The host workspace directory stays
    /// untouched — it's the user's data, not the sandbox's.
    #[allow(dead_code)]
    pub async fn reset_project(&self, project_id: ProjectId) {
        let mut guard = self.transports.lock().await;
        guard.remove(&project_id);
        drop(guard);
        let mut command_guard = self.command_transports.lock().await;
        command_guard.remove(&project_id);
        lifecycle::stop(&self.docker, project_id).await;
        lifecycle::remove(&self.docker, project_id).await;
    }

    /// Stop every cached transport. Called at engine teardown.
    #[allow(dead_code)]
    pub async fn shutdown_all(&self) {
        let mut guard = self.transports.lock().await;
        let pids: Vec<ProjectId> = guard.keys().copied().collect();
        guard.clear();
        drop(guard);
        let mut command_guard = self.command_transports.lock().await;
        let command_pids: Vec<ProjectId> = command_guard.keys().copied().collect();
        command_guard.clear();
        let mut pids = pids;
        for pid in command_pids {
            if !pids.contains(&pid) {
                pids.push(pid);
            }
        }
        for pid in pids {
            lifecycle::stop(&self.docker, pid).await;
        }
    }
}
