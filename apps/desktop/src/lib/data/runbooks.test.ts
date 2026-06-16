import { describe, it, expect } from 'vitest';
import { RUNBOOKS, runbookByDomain, type ApprovalGate, type RunbookDomain } from './runbooks';

describe('runbooks data', () => {
  it('covers every domain exactly once with a unique id', () => {
    const expected: RunbookDomain[] = ['coding', 'legal', 'finance', 'research', 'operations'];
    const ids = RUNBOOKS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(expected));
  });

  it('looks up a runbook by domain', () => {
    expect(runbookByDomain('coding')?.display_name).toBe('Coding');
    expect(runbookByDomain('not-a-domain')).toBeUndefined();
  });

  it('gives every runbook a non-empty display_name and summary', () => {
    for (const r of RUNBOOKS) {
      expect(r.display_name.length).toBeGreaterThan(0);
      expect(r.summary.length).toBeGreaterThan(0);
    }
  });

  it('gives every runbook required inputs, steps, artifacts, and verification', () => {
    for (const r of RUNBOOKS) {
      expect(r.required_inputs.length).toBeGreaterThanOrEqual(1);
      expect(r.steps.length).toBeGreaterThanOrEqual(2);
      expect(r.expected_artifacts.length).toBeGreaterThanOrEqual(1);
      expect(r.verification.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives every step a non-empty title, detail, and a known gate', () => {
    const known: ApprovalGate[] = ['read-only', 'dry-run', 'approval-required'];
    for (const r of RUNBOOKS) {
      for (const s of r.steps) {
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.detail.length).toBeGreaterThan(0);
        expect(known).toContain(s.gate);
      }
    }
  });

  it('gates push/PR behind approval in the coding runbook', () => {
    const coding = runbookByDomain('coding');
    expect(coding).toBeDefined();
    const pr = coding?.steps.find((s) => s.title === 'Open PR');
    expect(pr?.gate).toBe('approval-required');
  });

  it('requires approval before any mutating step in legal and finance', () => {
    for (const id of ['legal', 'finance'] as const) {
      const rb = runbookByDomain(id);
      expect(rb).toBeDefined();
      const hasApprovalGate = rb?.steps.some((s) => s.gate === 'approval-required');
      expect(hasApprovalGate).toBe(true);
      const hasApprovalConstraint = rb?.constraints.some((c) =>
        c.toLowerCase().includes('approval')
      );
      expect(hasApprovalConstraint).toBe(true);
    }
  });

  it('marks legal and finance output as not advice', () => {
    for (const id of ['legal', 'finance'] as const) {
      const rb = runbookByDomain(id);
      const disclaims = rb?.constraints.some((c) => c.toLowerCase().includes('not'));
      expect(disclaims).toBe(true);
    }
  });
});
