import { RUNBOOKS } from '$lib/data/runbooks';
import { describe, expect, it } from 'vitest';
import { planWorkAsk } from './work-router';
import {
  clarificationPracticalWorkScenarios,
  PRACTICAL_WORK_SCENARIOS,
  routedPracticalWorkScenarios
} from './workflow-scenarios';

const runbookIds = new Set(RUNBOOKS.map((runbook) => runbook.id));

function labelsWithState(
  entries: { label: string; state: 'used' | 'available' | 'missing' }[],
  state: 'used' | 'available' | 'missing'
): string[] {
  return entries.filter((entry) => entry.state === state).map((entry) => entry.label);
}

describe('practical work scenario corpus', () => {
  it('has stable ids, concrete asks, and failure criteria for every scenario', () => {
    const ids = new Set<string>();

    for (const scenario of PRACTICAL_WORK_SCENARIOS) {
      expect(scenario.id).toMatch(/^[a-z0-9-]+$/);
      expect(ids.has(scenario.id)).toBe(false);
      ids.add(scenario.id);
      expect(scenario.title.length).toBeGreaterThan(8);
      expect(scenario.userAsk.length).toBeGreaterThan(20);
      expect(scenario.expected.failureCriteria.length).toBeGreaterThanOrEqual(3);
      expect(scenario.expected.evidenceRequirements.length).toBeGreaterThan(0);
      expect(scenario.expected.collapseModes.length).toBeGreaterThan(0);
    }
  });

  it('covers each runbook domain plus multi-domain and explicit bypass attempts', () => {
    const domains = new Set(
      PRACTICAL_WORK_SCENARIOS.flatMap((scenario) =>
        scenario.classification.domain === 'multi'
          ? ['multi', ...(scenario.classification.domains ?? [])]
          : [scenario.classification.domain]
      )
    );
    const taggedBypass = PRACTICAL_WORK_SCENARIOS.filter((scenario) =>
      scenario.tags.some((tag) => ['bypass', 'prompt-injection', 'underspecified'].includes(tag))
    );

    expect(domains).toEqual(
      new Set(['coding', 'legal', 'finance', 'research', 'operations', 'multi', 'unknown'])
    );
    expect(taggedBypass.length).toBeGreaterThanOrEqual(3);
  });

  it('only references supported runbooks in routed scenarios', () => {
    for (const scenario of routedPracticalWorkScenarios) {
      expect(scenario.expected.runbooks.length).toBeGreaterThan(0);
      for (const runbook of scenario.expected.runbooks) {
        expect(runbookIds.has(runbook)).toBe(true);
      }
    }
  });

  it.each(routedPracticalWorkScenarios)(
    'routes $id into the expected Work Item contract',
    (scenario) => {
      const result = planWorkAsk({
        ask: scenario.userAsk,
        classification: scenario.classification
      });

      expect(result.status).toBe('routed');
      if (result.status !== 'routed') return;

      const { workItem } = result;
      expect(workItem.domain).toBe(scenario.expected.domain);
      expect(workItem.runbookIds).toEqual(scenario.expected.runbooks);
      expect(workItem.status).toBe(scenario.expected.status);

      const availableLabels = labelsWithState(workItem.dossier, 'available');
      const usedLabels = labelsWithState(workItem.dossier, 'used');
      const missingLabels = labelsWithState(workItem.dossier, 'missing');
      for (const label of scenario.expected.availableContext) {
        expect([...availableLabels, ...usedLabels]).toContain(label);
      }
      for (const label of scenario.expected.missingContext) {
        expect(missingLabels).toContain(label);
      }
      for (const label of scenario.expected.requiredContext) {
        expect(workItem.dossier.map((entry) => entry.label)).toContain(label);
      }

      for (const kind of scenario.expected.approvalKinds) {
        expect(workItem.approvalBoundaries.some((boundary) => boundary.kind === kind)).toBe(true);
      }
      for (const action of scenario.expected.approvalActions) {
        expect(workItem.approvalBoundaries.some((boundary) => boundary.action === action)).toBe(
          true
        );
        expect(workItem.openApprovals).toContain(action);
      }

      for (const type of scenario.expected.artifactTypes) {
        expect(workItem.artifacts.some((artifact) => artifact.type === type)).toBe(true);
      }
      for (const trigger of scenario.expected.watchTriggers) {
        expect(workItem.watches.some((watch) => watch.trigger === trigger)).toBe(true);
      }
      if (scenario.expected.nextActionIncludes) {
        expect(workItem.nextAction).toContain(scenario.expected.nextActionIncludes);
      }
    }
  );

  it.each(clarificationPracticalWorkScenarios)(
    'requires clarification for $id instead of silent chat collapse',
    (scenario) => {
      const result = planWorkAsk({
        ask: scenario.userAsk,
        classification: scenario.classification
      });

      expect(result.status).toBe('needs_clarification');
      if (result.status !== 'needs_clarification') return;
      expect(result.question).toMatch(/domain|context|source/i);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  );

  it('marks every explicit bypass attempt as approval-gated or clarification-only', () => {
    const bypassScenarios = PRACTICAL_WORK_SCENARIOS.filter((scenario) =>
      scenario.tags.some((tag) => ['bypass', 'prompt-injection', 'underspecified'].includes(tag))
    );

    for (const scenario of bypassScenarios) {
      const result = planWorkAsk({
        ask: scenario.userAsk,
        classification: scenario.classification
      });

      if (result.status === 'needs_clarification') {
        expect(scenario.expected.approvalActions).toHaveLength(0);
        expect(scenario.expected.collapseModes).toContain('no-recovery-path');
        continue;
      }

      expect(result.workItem.approvalBoundaries.length).toBeGreaterThan(0);
      expect(result.workItem.openApprovals.length).toBeGreaterThan(0);
      expect(scenario.expected.collapseModes).toContain('missing-approval');
    }
  });
});
