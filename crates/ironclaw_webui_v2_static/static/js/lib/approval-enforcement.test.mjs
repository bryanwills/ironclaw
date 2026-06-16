import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPROVAL_REQUIRED_KINDS,
  evaluateApprovalBoundary,
  requiresApproval
} from './approval-enforcement.js';

function boundary(kind, status, id = `${kind}-${status}`) {
  return {
    id,
    kind,
    status,
    action: `${kind} action`,
    payload: `${kind} payload`,
    reason: `${kind} reason`
  };
}

test('requiresApproval pins the legacy approval action kinds', () => {
  assert.deepEqual(APPROVAL_REQUIRED_KINDS, [
    'send',
    'trade',
    'push',
    'pr',
    'export',
    'delete',
    'write'
  ]);
  for (const kind of APPROVAL_REQUIRED_KINDS) {
    assert.equal(requiresApproval(kind), true);
  }
  assert.equal(requiresApproval('read'), false);
  assert.equal(requiresApproval('other'), false);
});

test('evaluateApprovalBoundary lets non-risky work stay in chat', () => {
  assert.deepEqual(evaluateApprovalBoundary({ kind: 'other' }), {
    allowed: false,
    reason: 'approval-not-required'
  });
});

test('evaluateApprovalBoundary blocks risky work without a work item or matching boundary', () => {
  assert.deepEqual(evaluateApprovalBoundary({ kind: 'send', workItem: null }), {
    allowed: false,
    reason: 'missing-work-item'
  });
  assert.deepEqual(
    evaluateApprovalBoundary({
      kind: 'delete',
      workItem: { id: 'w1', approvalBoundaries: [boundary('send', 'approved')] }
    }),
    { allowed: false, reason: 'missing-boundary' }
  );
});

test('evaluateApprovalBoundary blocks pending and denied boundaries', () => {
  const pending = boundary('export', 'pending');
  const denied = boundary('export', 'denied');
  assert.deepEqual(
    evaluateApprovalBoundary({
      kind: 'export',
      workItem: { id: 'w1', approvalBoundaries: [pending] }
    }),
    { allowed: false, reason: 'pending', boundary: pending }
  );
  assert.deepEqual(
    evaluateApprovalBoundary({
      kind: 'export',
      workItem: { id: 'w1', approvalBoundaries: [denied] }
    }),
    { allowed: false, reason: 'denied', boundary: denied }
  );
});

test('evaluateApprovalBoundary allows only approved matching boundaries', () => {
  const approved = boundary('write', 'approved', 'write-ok');
  assert.deepEqual(
    evaluateApprovalBoundary({
      kind: 'write',
      workItem: { id: 'w1', approvalBoundaries: [approved] }
    }),
    { allowed: true, boundary: approved }
  );
});

test('evaluateApprovalBoundary honors explicit boundary ids', () => {
  const approvedSend = boundary('send', 'approved', 'send-ok');
  const pendingDelete = boundary('delete', 'pending', 'delete-pending');
  assert.deepEqual(
    evaluateApprovalBoundary({
      kind: 'delete',
      boundaryId: 'delete-pending',
      workItem: { id: 'w1', approvalBoundaries: [approvedSend, pendingDelete] }
    }),
    { allowed: false, reason: 'pending', boundary: pendingDelete }
  );
});
