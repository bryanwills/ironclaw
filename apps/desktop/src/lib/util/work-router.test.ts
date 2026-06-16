import { describe, expect, it } from 'vitest';
import { planWorkAsk, type WorkRouteClassification } from './work-router';

describe('planWorkAsk', () => {
  it('routes a messy coding ask into work item + dossier + approval + artifact', () => {
    const classification: WorkRouteClassification = {
      domain: 'coding',
      confidence: 0.91,
      title: 'CI failure investigation',
      context: [
        {
          label: 'Repository or working directory',
          state: 'available',
          provenance: 'user:cwd',
          detail: 'User supplied a repository path.'
        },
        {
          label: 'Task or issue to address',
          state: 'available',
          provenance: 'user:ask'
        }
      ],
      riskyActions: [
        {
          action: 'Push branch',
          kind: 'push',
          payload: 'Push the finished fix branch.',
          reason: 'Leaves the local machine.'
        }
      ],
      expectedArtifacts: [{ type: 'pr-summary', title: 'PR summary', provenance: ['user:ask'] }]
    };

    const result = planWorkAsk({
      ask: "Fix the CI failure and prepare the PR summary. Don't push without asking.",
      classification
    });

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') return;
    expect(result.workItem.domain).toBe('coding');
    expect(result.workItem.status).toBe('waiting-approval');
    expect(result.workItem.runbookIds).toEqual(['coding']);
    expect(result.workItem.dossier.some((entry) => entry.state === 'available')).toBe(true);
    expect(result.workItem.approvalBoundaries.some((gate) => gate.kind === 'push')).toBe(true);
    expect(result.workItem.openApprovals).toContain('Push branch');
    expect(result.workItem.nextAction).toMatch(/^Review approval:/);
    expect(result.workItem.artifacts.some((artifact) => artifact.type === 'pr-summary')).toBe(true);
    expect(result.workItem.watches).toHaveLength(0);
  });

  it('asks for clarification instead of silently guessing low-confidence work', () => {
    const result = planWorkAsk({
      ask: 'Handle this somehow.',
      classification: { domain: 'unknown', confidence: 0.2 }
    });

    expect(result.status).toBe('needs_clarification');
    if (result.status !== 'needs_clarification') return;
    expect(result.question).toMatch(/domain/i);
  });

  it('finance work records missing context, gates trades, and creates a watch', () => {
    const classification: WorkRouteClassification = {
      domain: 'finance',
      confidence: 0.86,
      title: 'Concentration review',
      context: [
        {
          label: 'Holdings or positions',
          state: 'missing',
          provenance: 'runbook:finance',
          detail: 'Portfolio holdings are required before exposure can be computed.'
        }
      ],
      riskyActions: [
        {
          action: 'Place rebalance order',
          kind: 'trade',
          payload: 'Any order derived from the rebalance note.',
          reason: 'Trades require explicit human approval.'
        }
      ],
      expectedArtifacts: [{ type: 'decision-note', title: 'Finance decision note' }],
      watches: [
        {
          trigger: 'Exit window appears',
          cadence: 'market-hours',
          source: 'market-data',
          next_check: 'next market open',
          escalation: 'Ask user before drafting any order.'
        }
      ]
    };

    const result = planWorkAsk({
      ask: 'Review exposure and watch for an exit window.',
      classification
    });

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') return;
    expect(result.workItem.status).toBe('blocked');
    expect(result.workItem.dossier.some((entry) => entry.state === 'missing')).toBe(true);
    expect(result.workItem.approvalBoundaries.some((gate) => gate.kind === 'trade')).toBe(true);
    expect(result.workItem.watches[0]?.trigger).toBe('Exit window appears');
  });

  it('keeps multi-domain work as one parent matter with selected runbooks', () => {
    const classification: WorkRouteClassification = {
      domain: 'multi',
      confidence: 0.88,
      title: 'Acquisition review',
      domains: ['research', 'legal', 'finance', 'operations'],
      expectedArtifacts: [{ type: 'decision-memo', title: 'Combined decision memo' }]
    };

    const result = planWorkAsk({
      ask: 'Review this acquisition target across product, legal, finance, and integration risk.',
      classification
    });

    expect(result.status).toBe('routed');
    if (result.status !== 'routed') return;
    expect(result.workItem.domain).toBe('multi');
    expect(result.workItem.runbookIds).toEqual(['research', 'legal', 'finance', 'operations']);
    expect(result.workItem.artifacts.some((artifact) => artifact.type === 'decision-memo')).toBe(
      true
    );
  });
});
