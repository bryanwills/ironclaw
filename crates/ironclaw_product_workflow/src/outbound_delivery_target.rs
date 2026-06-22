use async_trait::async_trait;
use ironclaw_turns::ReplyTargetBindingRef;

use crate::{
    reborn_services::{
        RebornOutboundDeliveryTargetCapabilities, RebornOutboundDeliveryTargetId,
        RebornOutboundDeliveryTargetSummary, RebornServicesError,
    },
    webui_inbound::WebUiAuthenticatedCaller,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundDeliveryTargetEntry {
    pub summary: RebornOutboundDeliveryTargetSummary,
    pub capabilities: RebornOutboundDeliveryTargetCapabilities,
    pub reply_target_binding_ref: ReplyTargetBindingRef,
}

#[async_trait]
pub trait OutboundDeliveryTargetProvider: Send + Sync {
    async fn list_outbound_delivery_targets(
        &self,
        caller: &WebUiAuthenticatedCaller,
    ) -> Result<Vec<OutboundDeliveryTargetEntry>, RebornServicesError>;

    async fn resolve_outbound_delivery_target(
        &self,
        caller: &WebUiAuthenticatedCaller,
        target_id: &RebornOutboundDeliveryTargetId,
    ) -> Result<Option<OutboundDeliveryTargetEntry>, RebornServicesError> {
        Ok(self
            .list_outbound_delivery_targets(caller)
            .await?
            .into_iter()
            .find(|entry| {
                entry.capabilities.final_replies
                    && entry.summary.target_id.as_str() == target_id.as_str()
            }))
    }

    async fn resolve_reply_target_binding(
        &self,
        caller: &WebUiAuthenticatedCaller,
        target: &ReplyTargetBindingRef,
    ) -> Result<Option<OutboundDeliveryTargetEntry>, RebornServicesError> {
        Ok(self
            .list_outbound_delivery_targets(caller)
            .await?
            .into_iter()
            .find(|entry| {
                entry.capabilities.final_replies
                    && entry.reply_target_binding_ref.as_str() == target.as_str()
            }))
    }
}
