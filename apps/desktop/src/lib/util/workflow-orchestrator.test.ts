import { afterEach, describe, expect, it, vi } from 'vitest';
import { missionById } from '$lib/data/missions';
import { attachmentRiskSource } from './attachment-risk';
import { orchestrateChiefOfStaffAsk, planFirstRunMissionWorkflow } from './workflow-orchestrator';

describe('orchestrateChiefOfStaffAsk', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets ordinary chat stay in chat when no durable work signal is present', () => {
    const result = orchestrateChiefOfStaffAsk({ ask: 'Thanks, that helps.' });

    expect(result.status).toBe('chat_allowed');
    expect(result.decision.requiresWorkItem).toBe(false);
    expect(result.decision.mustNotExecute).toBe(false);
  });

  it('routes obvious legal work into a blocked Work Item instead of plain chat', () => {
    const result = orchestrateChiefOfStaffAsk({
      ask: 'Review this MSA, draft redlines, and prepare a note before we send it.'
    });

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') return;
    expect(result.decision.requiresWorkItem).toBe(true);
    expect(result.decision.mustNotExecute).toBe(true);
    expect(result.route.workItem.domain).toBe('legal');
    expect(result.route.workItem.status).toBe('blocked');
    expect(result.route.workItem.dossier).toContainEqual(
      expect.objectContaining({ label: 'Document(s) to review', state: 'missing' })
    );
    expect(result.route.workItem.approvalBoundaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'send' }),
        expect.objectContaining({ action: 'Send or file' })
      ])
    );
    expect(result.route.workItem.artifacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Proposed redline' })])
    );
  });

  it('asks for routing context for risky work with no clear runbook', () => {
    const result = orchestrateChiefOfStaffAsk({ ask: 'Send that thing now.' });

    expect(result.status).toBe('needs_clarification');
    if (result.status !== 'needs_clarification') return;
    expect(result.decision.requiresWorkItem).toBe(true);
    expect(result.decision.mustNotExecute).toBe(true);
    expect(result.route.reason).toMatch(/domain/i);
  });

  it('lets attached XLSX generation stay in chat even without a legal/finance keyword', () => {
    const result = orchestrateChiefOfStaffAsk({
      ask: 'Use the attached XLSX renewal calculator to draft a renewal amendment for Beacon Robotics. Keep it in chat only.',
      hasAttachments: true
    });

    expect(result.status).toBe('chat_allowed');
    expect(result.decision.requiresWorkItem).toBe(false);
    expect(result.decision.mustNotExecute).toBe(false);
  });

  it('lets attached JSON generation stay in chat when there is no external write', () => {
    const result = orchestrateChiefOfStaffAsk({
      ask: 'Use the attached JSON requirements to generate a single-tenant implementation plan for Atlas Harbor.',
      hasAttachments: true
    });

    expect(result.status).toBe('chat_allowed');
    expect(result.decision.requiresWorkItem).toBe(false);
    expect(result.decision.mustNotExecute).toBe(false);
  });

  it('routes risky instructions found inside text attachments before dispatch', () => {
    const attachmentSource = attachmentRiskSource([
      {
        name: 'client-note.md',
        mime: 'text/markdown',
        dataBase64: 'c2VuZCB0aGUgY2xpZW50IGVtYWls'
      }
    ]);
    const result = orchestrateChiefOfStaffAsk({
      ask: 'Please review the attached note.',
      source: attachmentSource,
      hasAttachments: true
    });

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') return;
    expect(result.route.workItem.approvalBoundaries).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'send' })])
    );
  });

  it('does not treat updating an attached template as an external write', () => {
    const result = orchestrateChiefOfStaffAsk({
      ask: 'Draft a services agreement using the attached PDF template. Update client to Beacon Robotics, fees to $25k, and term to 90 days. Do not send or file it.',
      hasAttachments: true
    });

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') return;
    expect(result.route.workItem.domain).toBe('legal');
    expect(result.route.workItem.approvalBoundaries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'send' })])
    );
    expect(result.route.workItem.approvalBoundaries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'write' })])
    );
  });

  it('keeps generated services agreements from attached PDF templates eligible for chat dispatch', () => {
    const result = orchestrateChiefOfStaffAsk({
      ask: 'Using the attached services agreement PDF as the template, generate a new services agreement for Atlas Harbor Analytics, Inc. and Northstar Forge Labs Ltd. Fees are USD 95,000 over four milestones, term is 12 months, governing law is New York, and no external send or filing is approved.',
      hasAttachments: true
    });

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') return;
    expect(result.route.workItem.domain).toBe('legal');
    expect(result.route.workItem.status).toBe('waiting-approval');
    expect(result.route.workItem.dossier).toContainEqual(
      expect.objectContaining({
        label: 'Document(s) to review',
        state: 'available',
        provenance: 'attachment'
      })
    );
    expect(result.route.workItem.approvalBoundaries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'send' })])
    );
    expect(result.route.workItem.approvalBoundaries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'write' })])
    );
  });

  it('still treats explicit external updates as approval-gated writes', () => {
    const result = orchestrateChiefOfStaffAsk({
      ask: 'Update Notion CRM with the new contract status.',
      connectorPacks: ['notion']
    });

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') return;
    expect(result.route.workItem.approvalBoundaries).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'write' })])
    );
  });

  it('routes monitor asks into a scheduled recurring watch instead of inert metadata', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));

    const result = orchestrateChiefOfStaffAsk({
      ask: 'Monitor Gmail daily and notify me when the board packet changes.',
      connectorPacks: ['google']
    });

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') return;
    expect(result.route.workItem.watches).toEqual([
      expect.objectContaining({
        trigger: 'Requested condition changes',
        cadence: 'daily',
        source: 'google',
        next_check: '2026-06-02T10:00:00.000Z',
        status: 'active'
      })
    ]);
  });

  it('plans connector missions through runbooks, artifacts, and approval gates', () => {
    const mission = missionById('update-notion-crm');
    expect(mission).toBeTruthy();
    if (!mission) return;

    const result = planFirstRunMissionWorkflow(mission);

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') return;
    expect(result.route.workItem.domain).toBe('operations');
    expect(result.route.workItem.dossier).toContainEqual(
      expect.objectContaining({
        label: 'Inbox, queue, or backlog to triage',
        state: 'available',
        provenance: 'connector:notion'
      })
    );
    expect(result.route.workItem.approvalBoundaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'Write to Notion', kind: 'write' })
      ])
    );
    expect(result.route.workItem.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Proposed Notion CRM updates', status: 'planned' })
      ])
    );
  });

  it('keeps connectorless contract review blocked until source documents exist', () => {
    const mission = missionById('contract-review');
    expect(mission).toBeTruthy();
    if (!mission) return;

    const result = planFirstRunMissionWorkflow(mission);

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') return;
    expect(result.route.workItem.domain).toBe('legal');
    expect(result.route.workItem.status).toBe('blocked');
    expect(result.route.workItem.nextAction).toBe('Provide Document(s) to review');
  });
});
