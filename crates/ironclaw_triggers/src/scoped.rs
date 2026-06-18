use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use ironclaw_host_api::{AgentId, ProjectId, TenantId, ThreadId, UserId};

use crate::{
    ActiveTriggerScanCursor, ClaimDueFireOutcome, ClaimDueFireRequest, ClearActiveFireRequest,
    FireAcceptedRequest, FirePermanentFailedRequest, FireReplayedRequest,
    FireRetryableFailedRequest, FireTerminalFailedRequest, TriggerError, TriggerId, TriggerRecord,
    TriggerRepository, TriggerRunRecord,
};

pub struct HostScopedTriggerRepository {
    inner: Arc<dyn TriggerRepository>,
    tenant_id: TenantId,
    agent_id: Option<AgentId>,
    project_id: Option<ProjectId>,
}

impl HostScopedTriggerRepository {
    pub fn new(
        inner: Arc<dyn TriggerRepository>,
        tenant_id: TenantId,
        agent_id: Option<AgentId>,
        project_id: Option<ProjectId>,
    ) -> Self {
        Self {
            inner,
            tenant_id,
            agent_id,
            project_id,
        }
    }

    fn matches_record(&self, record: &TriggerRecord) -> bool {
        record.tenant_id == self.tenant_id
            && record.agent_id == self.agent_id
            && record.project_id == self.project_id
    }

    fn matches_scope(
        &self,
        tenant_id: &TenantId,
        agent_id: Option<&AgentId>,
        project_id: Option<&ProjectId>,
    ) -> bool {
        tenant_id == &self.tenant_id
            && agent_id == self.agent_id.as_ref()
            && project_id == self.project_id.as_ref()
    }

    async fn scoped_record(
        &self,
        tenant_id: TenantId,
        trigger_id: TriggerId,
    ) -> Result<Option<TriggerRecord>, TriggerError> {
        if tenant_id != self.tenant_id {
            return Ok(None);
        }
        Ok(self
            .inner
            .get_trigger(tenant_id, trigger_id)
            .await?
            .filter(|record| self.matches_record(record)))
    }
}

#[async_trait]
impl TriggerRepository for HostScopedTriggerRepository {
    async fn upsert_trigger(&self, record: TriggerRecord) -> Result<(), TriggerError> {
        if !self.matches_record(&record) {
            return Err(TriggerError::InvalidRecord {
                reason: "trigger record is outside configured host trigger scope".to_string(),
            });
        }
        self.inner.upsert_trigger(record).await
    }

    async fn get_trigger(
        &self,
        tenant_id: TenantId,
        trigger_id: TriggerId,
    ) -> Result<Option<TriggerRecord>, TriggerError> {
        self.scoped_record(tenant_id, trigger_id).await
    }

    async fn list_triggers(&self, tenant_id: TenantId) -> Result<Vec<TriggerRecord>, TriggerError> {
        if tenant_id != self.tenant_id {
            return Ok(Vec::new());
        }
        let mut records = self.inner.list_triggers(tenant_id).await?;
        records.retain(|record| self.matches_record(record));
        Ok(records)
    }

    async fn list_scoped_triggers(
        &self,
        tenant_id: TenantId,
        creator_user_id: UserId,
        agent_id: Option<AgentId>,
        project_id: Option<ProjectId>,
        limit: usize,
    ) -> Result<Vec<TriggerRecord>, TriggerError> {
        if !self.matches_scope(&tenant_id, agent_id.as_ref(), project_id.as_ref()) {
            return Ok(Vec::new());
        }
        self.inner
            .list_scoped_triggers(tenant_id, creator_user_id, agent_id, project_id, limit)
            .await
    }

    async fn remove_trigger(
        &self,
        tenant_id: TenantId,
        trigger_id: TriggerId,
    ) -> Result<Option<TriggerRecord>, TriggerError> {
        if self
            .scoped_record(tenant_id.clone(), trigger_id)
            .await?
            .is_none()
        {
            return Ok(None);
        }
        self.inner.remove_trigger(tenant_id, trigger_id).await
    }

    async fn remove_scoped_trigger(
        &self,
        tenant_id: TenantId,
        creator_user_id: UserId,
        agent_id: Option<AgentId>,
        project_id: Option<ProjectId>,
        trigger_id: TriggerId,
    ) -> Result<Option<TriggerRecord>, TriggerError> {
        if !self.matches_scope(&tenant_id, agent_id.as_ref(), project_id.as_ref()) {
            return Ok(None);
        }
        self.inner
            .remove_scoped_trigger(tenant_id, creator_user_id, agent_id, project_id, trigger_id)
            .await
    }

    async fn list_due_triggers(
        &self,
        now: ironclaw_host_api::Timestamp,
        limit: usize,
    ) -> Result<Vec<TriggerRecord>, TriggerError> {
        self.inner
            .list_due_triggers_for_scope(
                self.tenant_id.clone(),
                self.agent_id.clone(),
                self.project_id.clone(),
                now,
                limit,
            )
            .await
    }

    async fn list_active_triggers(&self, limit: usize) -> Result<Vec<TriggerRecord>, TriggerError> {
        self.list_active_triggers_after(None, limit).await
    }

    async fn list_active_triggers_after(
        &self,
        after: Option<ActiveTriggerScanCursor>,
        limit: usize,
    ) -> Result<Vec<TriggerRecord>, TriggerError> {
        self.inner
            .list_active_triggers_after_for_scope(
                self.tenant_id.clone(),
                self.agent_id.clone(),
                self.project_id.clone(),
                after,
                limit,
            )
            .await
    }

    async fn claim_due_fire(
        &self,
        request: ClaimDueFireRequest,
    ) -> Result<ClaimDueFireOutcome, TriggerError> {
        if self
            .scoped_record(request.tenant_id.clone(), request.trigger_id)
            .await?
            .is_none()
        {
            return Ok(ClaimDueFireOutcome::NotFound);
        }
        self.inner.claim_due_fire(request).await
    }

    async fn mark_fire_accepted(
        &self,
        request: FireAcceptedRequest,
    ) -> Result<Option<TriggerRecord>, TriggerError> {
        if self
            .scoped_record(request.tenant_id.clone(), request.trigger_id)
            .await?
            .is_none()
        {
            return Ok(None);
        }
        self.inner.mark_fire_accepted(request).await
    }

    async fn mark_fire_replayed(
        &self,
        request: FireReplayedRequest,
    ) -> Result<Option<TriggerRecord>, TriggerError> {
        if self
            .scoped_record(request.tenant_id.clone(), request.trigger_id)
            .await?
            .is_none()
        {
            return Ok(None);
        }
        self.inner.mark_fire_replayed(request).await
    }

    async fn mark_fire_retryable_failed(
        &self,
        request: FireRetryableFailedRequest,
    ) -> Result<Option<TriggerRecord>, TriggerError> {
        if self
            .scoped_record(request.tenant_id.clone(), request.trigger_id)
            .await?
            .is_none()
        {
            return Ok(None);
        }
        self.inner.mark_fire_retryable_failed(request).await
    }

    async fn mark_fire_permanently_failed(
        &self,
        request: FirePermanentFailedRequest,
    ) -> Result<Option<TriggerRecord>, TriggerError> {
        if self
            .scoped_record(request.tenant_id.clone(), request.trigger_id)
            .await?
            .is_none()
        {
            return Ok(None);
        }
        self.inner.mark_fire_permanently_failed(request).await
    }

    async fn mark_fire_terminally_failed(
        &self,
        request: FireTerminalFailedRequest,
    ) -> Result<Option<TriggerRecord>, TriggerError> {
        if self
            .scoped_record(request.tenant_id.clone(), request.trigger_id)
            .await?
            .is_none()
        {
            return Ok(None);
        }
        self.inner.mark_fire_terminally_failed(request).await
    }

    async fn clear_active_fire(
        &self,
        request: ClearActiveFireRequest,
    ) -> Result<Option<TriggerRecord>, TriggerError> {
        if self
            .scoped_record(request.tenant_id.clone(), request.trigger_id)
            .await?
            .is_none()
        {
            return Ok(None);
        }
        self.inner.clear_active_fire(request).await
    }

    async fn find_trigger_run_by_thread_id(
        &self,
        tenant_id: TenantId,
        thread_id: &ThreadId,
    ) -> Result<Option<(TriggerRecord, TriggerRunRecord)>, TriggerError> {
        let Some((record, run)) = self
            .inner
            .find_trigger_run_by_thread_id(tenant_id, thread_id)
            .await?
        else {
            return Ok(None);
        };
        if self.matches_record(&record) {
            Ok(Some((record, run)))
        } else {
            Ok(None)
        }
    }

    async fn list_trigger_run_history(
        &self,
        tenant_id: TenantId,
        trigger_id: TriggerId,
        limit: usize,
    ) -> Result<Vec<TriggerRunRecord>, TriggerError> {
        if self
            .scoped_record(tenant_id.clone(), trigger_id)
            .await?
            .is_none()
        {
            return Ok(Vec::new());
        }
        self.inner
            .list_trigger_run_history(tenant_id, trigger_id, limit)
            .await
    }

    async fn list_trigger_run_history_batch(
        &self,
        tenant_id: TenantId,
        trigger_ids: &[TriggerId],
        limit: usize,
    ) -> Result<HashMap<TriggerId, Vec<TriggerRunRecord>>, TriggerError> {
        if tenant_id != self.tenant_id || trigger_ids.is_empty() || limit == 0 {
            return Ok(HashMap::new());
        }
        let mut scoped_trigger_ids = Vec::with_capacity(trigger_ids.len());
        for trigger_id in trigger_ids {
            if self
                .scoped_record(tenant_id.clone(), *trigger_id)
                .await?
                .is_some()
            {
                scoped_trigger_ids.push(*trigger_id);
            }
        }
        self.inner
            .list_trigger_run_history_batch(tenant_id, &scoped_trigger_ids, limit)
            .await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use chrono::Utc;
    use ironclaw_host_api::{AgentId, ProjectId, TenantId, UserId};

    use crate::{
        ClaimDueFireOutcome, ClaimDueFireRequest, HostScopedTriggerRepository,
        InMemoryTriggerRepository, TriggerCompletionPolicy, TriggerId, TriggerRecord,
        TriggerRepository as _, TriggerSchedule, TriggerSourceKind, TriggerState,
    };

    #[tokio::test]
    async fn host_scoped_trigger_repository_does_not_claim_out_of_scope_due_trigger() {
        let inner = Arc::new(InMemoryTriggerRepository::default());
        let tenant_id = TenantId::new("scoped-trigger-tenant").expect("tenant");
        let creator_user_id = UserId::new("scoped-trigger-sso-user").expect("user");
        let agent_id = AgentId::new("scoped-trigger-agent").expect("agent");
        let project_id = ProjectId::new("scoped-trigger-project").expect("project");
        let other_agent_id = AgentId::new("scoped-trigger-other-agent").expect("agent");
        let fire_slot = Utc::now();
        let now = fire_slot + chrono::Duration::seconds(1);
        let matching_trigger_id = TriggerId::new();
        let other_trigger_id = TriggerId::new();
        let matching_record = test_trigger_record(
            tenant_id.clone(),
            creator_user_id.clone(),
            Some(agent_id.clone()),
            Some(project_id.clone()),
            matching_trigger_id,
            fire_slot,
        );
        let other_record = test_trigger_record(
            tenant_id.clone(),
            creator_user_id,
            Some(other_agent_id),
            Some(project_id.clone()),
            other_trigger_id,
            fire_slot,
        );
        inner
            .upsert_trigger(matching_record)
            .await
            .expect("insert matching trigger");
        inner
            .upsert_trigger(other_record)
            .await
            .expect("insert out-of-scope trigger");

        let scoped = HostScopedTriggerRepository::new(
            inner.clone(),
            tenant_id.clone(),
            Some(agent_id),
            Some(project_id),
        );
        let due = scoped
            .list_due_triggers(now, 10)
            .await
            .expect("list scoped due triggers");
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].trigger_id, matching_trigger_id);

        let out_of_scope_claim = scoped
            .claim_due_fire(ClaimDueFireRequest {
                tenant_id: tenant_id.clone(),
                trigger_id: other_trigger_id,
                fire_slot,
                now,
            })
            .await
            .expect("claim out-of-scope trigger");
        assert!(
            matches!(out_of_scope_claim, ClaimDueFireOutcome::NotFound),
            "out-of-scope trigger must be invisible to the host-scoped worker"
        );
        let other_after_claim = inner
            .get_trigger(tenant_id.clone(), other_trigger_id)
            .await
            .expect("load out-of-scope trigger")
            .expect("out-of-scope trigger exists");
        assert!(
            other_after_claim.active_fire_slot.is_none(),
            "out-of-scope trigger must not be claimed"
        );

        let matching_claim = scoped
            .claim_due_fire(ClaimDueFireRequest {
                tenant_id,
                trigger_id: matching_trigger_id,
                fire_slot,
                now,
            })
            .await
            .expect("claim matching trigger");
        assert!(
            matches!(matching_claim, ClaimDueFireOutcome::Claimed(_)),
            "matching trigger must remain claimable"
        );
    }

    fn test_trigger_record(
        tenant_id: TenantId,
        creator_user_id: UserId,
        agent_id: Option<AgentId>,
        project_id: Option<ProjectId>,
        trigger_id: TriggerId,
        next_run_at: chrono::DateTime<Utc>,
    ) -> TriggerRecord {
        TriggerRecord {
            trigger_id,
            tenant_id,
            creator_user_id,
            agent_id,
            project_id,
            name: "daily summary".to_string(),
            source: TriggerSourceKind::Schedule,
            schedule: TriggerSchedule::cron("0 8 * * *").expect("valid cron"),
            completion_policy: TriggerCompletionPolicy::Recurring,
            prompt: "summarize unread mail".to_string(),
            state: TriggerState::Scheduled,
            next_run_at,
            last_run_at: None,
            last_fired_slot: None,
            last_status: None,
            active_fire_slot: None,
            active_run_ref: None,
            created_at: next_run_at,
        }
    }
}
