import type { PlannedWorkItemInput } from './work-router';
import { requiresApproval } from './approval-enforcement';

/**
 * Chat should stay chat for read/draft/analysis work the model can answer now.
 * Work Items are useful when there is a watch/monitor to track or a real
 * external side effect to approve. Missing context belongs in the conversation
 * too: the assistant can ask for the file instead of silently making a plan.
 */
export function shouldKeepRoutedWorkInChat(route: PlannedWorkItemInput): boolean {
  if (route.watches.length > 0) return false;
  if (route.approvalBoundaries.some((boundary) => requiresApproval(boundary.kind))) return false;

  return true;
}
