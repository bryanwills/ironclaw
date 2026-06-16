export const APPROVAL_REQUIRED_KINDS = Object.freeze([
  'send',
  'trade',
  'push',
  'pr',
  'export',
  'delete',
  'write'
]);

const APPROVAL_REQUIRED_KIND_SET = new Set(APPROVAL_REQUIRED_KINDS);

export function requiresApproval(kind) {
  return APPROVAL_REQUIRED_KIND_SET.has(kind);
}

export function evaluateApprovalBoundary(input = {}) {
  const kind = input.kind;
  if (!requiresApproval(kind)) {
    return { allowed: false, reason: 'approval-not-required' };
  }

  const workItem = input.workItem || null;
  if (!workItem) {
    return { allowed: false, reason: 'missing-work-item' };
  }

  const boundaries = Array.isArray(workItem.approvalBoundaries) ? workItem.approvalBoundaries : [];
  const boundary = boundaries.find((candidate) => {
    if (!candidate) return false;
    if (input.boundaryId) return candidate.id === input.boundaryId;
    return candidate.kind === kind;
  });

  if (!boundary) {
    return { allowed: false, reason: 'missing-boundary' };
  }

  if (boundary.status === 'approved') {
    return { allowed: true, boundary };
  }

  return {
    allowed: false,
    reason: boundary.status || 'pending',
    boundary
  };
}
