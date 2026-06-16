import { describe, expect, it } from 'vitest';

import type { PlannedWorkItemInput } from './work-router';
import { shouldKeepRoutedWorkInChat } from './chat-work-routing';
import { orchestrateChiefOfStaffAsk } from './workflow-orchestrator';

function route(overrides: Partial<PlannedWorkItemInput> = {}): PlannedWorkItemInput {
  return {
    title: 'Draft services agreement',
    objective: 'draft me a services agreement based on this',
    domain: 'legal',
    runbookIds: ['legal'],
    status: 'waiting-approval',
    dossier: [
      {
        label: 'Document(s) to review',
        state: 'available',
        provenance: 'attachment'
      }
    ],
    approvalBoundaries: [
      {
        id: 'approval-send-or-file',
        action: 'Send or file',
        kind: 'other',
        payload: 'Future outbound send or file write requires approval.',
        reason: 'Runbook Legal requires approval for this step.',
        status: 'pending'
      }
    ],
    artifacts: [
      {
        id: 'artifact-redline',
        type: 'proposed redline',
        title: 'Proposed redline',
        status: 'planned',
        provenance: ['ask']
      }
    ],
    watches: [],
    openApprovals: ['Send or file'],
    followUps: [],
    nextAction: 'Review approval: Send or file',
    ...overrides
  };
}

describe('shouldKeepRoutedWorkInChat', () => {
  it('keeps normal draft/review work in chat even when the runbook has future steps', () => {
    expect(shouldKeepRoutedWorkInChat(route())).toBe(true);
  });

  it('keeps missing-context work in chat so the assistant can ask for the file', () => {
    expect(
      shouldKeepRoutedWorkInChat(
        route({
          dossier: [
            { label: 'Document(s) to review', state: 'missing', provenance: 'runbook:legal' }
          ]
        })
      )
    ).toBe(true);
  });

  it('does not keep routed work in chat when it has a real external approval boundary', () => {
    expect(
      shouldKeepRoutedWorkInChat(
        route({
          approvalBoundaries: [
            {
              id: 'approval-send',
              action: 'Send message or reply',
              kind: 'send',
              payload: 'Any outbound message requested by this ask.',
              reason: 'Detected from an explicit requested action.',
              status: 'pending'
            }
          ]
        })
      )
    ).toBe(false);
  });

  it('does not keep routed work in chat for watch or monitor work', () => {
    expect(
      shouldKeepRoutedWorkInChat(
        route({
          watches: [
            {
              id: 'watch-renewal',
              trigger: 'Renewal date changes',
              cadence: 'daily',
              source: 'workspace',
              next_check: null,
              escalation: 'Surface renewal changes before taking action.',
              status: 'active'
            }
          ]
        })
      )
    ).toBe(false);
  });

  it('keeps attached PDF services-agreement generation in chat for the model to answer', () => {
    const result = orchestrateChiefOfStaffAsk({
      ask: 'Using the attached services agreement PDF as the template, generate a new services agreement for Atlas Harbor Analytics, Inc. and Northstar Forge Labs Ltd. Fees are USD 95,000 over four milestones, term is 12 months, governing law is New York, and no external send or filing is approved.',
      hasAttachments: true
    });

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') return;
    expect(shouldKeepRoutedWorkInChat(result.route.workItem)).toBe(true);
  });
});
