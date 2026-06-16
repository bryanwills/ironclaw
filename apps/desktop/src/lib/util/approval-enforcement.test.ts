import { describe, expect, it } from 'vitest';
import type { WorkItemApprovalBoundary } from '$lib/data/work-item';
import { evaluateApprovalBoundary, requiresApproval } from './approval-enforcement';

function boundary(
  kind: WorkItemApprovalBoundary['kind'],
  status: WorkItemApprovalBoundary['status'],
  id = `${kind}-${status}`
): WorkItemApprovalBoundary {
  return {
    id,
    kind,
    status,
    action: `${kind} action`,
    payload: `${kind} payload`,
    reason: `${kind} reason`
  };
}

describe('evaluateApprovalBoundary', () => {
  it('does not require approval for non-risky other actions by default', () => {
    expect(requiresApproval('other')).toBe(false);
    expect(evaluateApprovalBoundary({ kind: 'other' })).toEqual({
      allowed: false,
      reason: 'approval-not-required'
    });
  });

  it('blocks risky dispatch without a Work Item', () => {
    expect(evaluateApprovalBoundary({ kind: 'send', workItem: null })).toEqual({
      allowed: false,
      reason: 'missing-work-item'
    });
  });

  it('blocks risky dispatch without a matching boundary', () => {
    expect(
      evaluateApprovalBoundary({
        kind: 'delete',
        workItem: { id: 'w1', approvalBoundaries: [boundary('send', 'approved')] }
      })
    ).toEqual({ allowed: false, reason: 'missing-boundary' });
  });

  it('blocks pending and denied matching boundaries', () => {
    const pending = boundary('export', 'pending');
    const denied = boundary('export', 'denied');
    expect(
      evaluateApprovalBoundary({
        kind: 'export',
        workItem: { id: 'w1', approvalBoundaries: [pending] }
      })
    ).toEqual({ allowed: false, reason: 'pending', boundary: pending });
    expect(
      evaluateApprovalBoundary({
        kind: 'export',
        workItem: { id: 'w1', approvalBoundaries: [denied] }
      })
    ).toEqual({ allowed: false, reason: 'denied', boundary: denied });
  });

  it('allows only an approved matching boundary', () => {
    const approved = boundary('write', 'approved', 'write-ok');
    expect(
      evaluateApprovalBoundary({
        kind: 'write',
        workItem: { id: 'w1', approvalBoundaries: [approved] }
      })
    ).toEqual({ allowed: true, boundary: approved });
  });

  it('honors explicit boundary ids so the wrong approved kind cannot satisfy another action', () => {
    const approvedSend = boundary('send', 'approved', 'send-ok');
    const pendingDelete = boundary('delete', 'pending', 'delete-pending');
    expect(
      evaluateApprovalBoundary({
        kind: 'delete',
        boundaryId: 'delete-pending',
        workItem: { id: 'w1', approvalBoundaries: [approvedSend, pendingDelete] }
      })
    ).toEqual({ allowed: false, reason: 'pending', boundary: pendingDelete });
  });
});
