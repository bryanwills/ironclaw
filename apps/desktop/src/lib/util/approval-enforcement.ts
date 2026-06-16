import type { WorkItem, WorkItemApprovalBoundary } from '$lib/data/work-item';

export type ApprovalActionKind = WorkItemApprovalBoundary['kind'];

export type ApprovalCheckInput = {
  kind: ApprovalActionKind;
  workItem?: Pick<WorkItem, 'id' | 'approvalBoundaries'> | null;
  boundaryId?: string;
};

export type ApprovalCheckResult =
  | {
      allowed: true;
      boundary: WorkItemApprovalBoundary;
    }
  | {
      allowed: false;
      reason:
        | 'approval-not-required'
        | 'missing-work-item'
        | 'missing-boundary'
        | 'pending'
        | 'denied';
      boundary?: WorkItemApprovalBoundary;
    };

export const APPROVAL_REQUIRED_KINDS = [
  'send',
  'trade',
  'push',
  'pr',
  'export',
  'delete',
  'write'
] as const satisfies readonly ApprovalActionKind[];

const APPROVAL_REQUIRED_KIND_SET = new Set<ApprovalActionKind>(APPROVAL_REQUIRED_KINDS);

export function requiresApproval(kind: ApprovalActionKind): boolean {
  return APPROVAL_REQUIRED_KIND_SET.has(kind);
}

export function evaluateApprovalBoundary(input: ApprovalCheckInput): ApprovalCheckResult {
  if (!requiresApproval(input.kind)) {
    return { allowed: false, reason: 'approval-not-required' };
  }

  const workItem = input.workItem ?? null;
  if (!workItem) {
    return { allowed: false, reason: 'missing-work-item' };
  }

  const boundary = workItem.approvalBoundaries.find((candidate) => {
    if (input.boundaryId) return candidate.id === input.boundaryId;
    return candidate.kind === input.kind;
  });

  if (!boundary) {
    return { allowed: false, reason: 'missing-boundary' };
  }

  if (boundary.status === 'approved') {
    return { allowed: true, boundary };
  }

  return {
    allowed: false,
    reason: boundary.status,
    boundary
  };
}
