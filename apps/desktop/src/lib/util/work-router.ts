import { RUNBOOKS, runbookByDomain, type RunbookDomain } from '$lib/data/runbooks';
import type {
  WorkItemApprovalBoundary,
  WorkItemArtifact,
  WorkItemDossierEntry,
  WorkItemDomain,
  WorkItemStatus,
  WorkItemWatch
} from '$lib/data/work-item';

type RouteDomain = RunbookDomain | 'multi' | 'unknown';

type ContextSignal = {
  label: string;
  state: WorkItemDossierEntry['state'];
  provenance: string;
  detail?: string;
};

type RiskSignal = {
  action: string;
  kind?: WorkItemApprovalBoundary['kind'];
  payload: string;
  reason?: string;
};

type ArtifactSignal = {
  type: string;
  title: string;
  provenance?: string[];
};

type WatchSignal = {
  trigger: string;
  cadence: string;
  source: string;
  next_check?: string | null;
  escalation: string;
};

export type WorkRouteClassification = {
  domain: RouteDomain;
  confidence: number;
  title?: string;
  rationale?: string;
  domains?: RunbookDomain[];
  context?: ContextSignal[];
  riskyActions?: RiskSignal[];
  expectedArtifacts?: ArtifactSignal[];
  watches?: WatchSignal[];
  nextAction?: string;
};

export type PlannedWorkItemInput = {
  title: string;
  objective: string;
  domain: WorkItemDomain;
  runbookIds: WorkItemDomain[];
  status: WorkItemStatus;
  dossier: WorkItemDossierEntry[];
  approvalBoundaries: WorkItemApprovalBoundary[];
  artifacts: WorkItemArtifact[];
  watches: WorkItemWatch[];
  openApprovals: string[];
  followUps: string[];
  nextAction: string | null;
};

export type WorkRouteResult =
  | {
      status: 'routed';
      workItem: PlannedWorkItemInput;
      rationale: string;
    }
  | {
      status: 'needs_clarification';
      question: string;
      reason: string;
    };

const MIN_CONFIDENCE = 0.55;
const RUNBOOK_IDS = new Set(RUNBOOKS.map((r) => r.id));

function stableId(prefix: string, seed: string, index: number): string {
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${prefix}-${slug || 'item'}-${index + 1}`;
}

function clean(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const v = value.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function selectedRunbookIds(classification: WorkRouteClassification): RunbookDomain[] {
  if (classification.domain === 'multi') {
    return uniqueStrings(classification.domains ?? []).filter((id): id is RunbookDomain =>
      RUNBOOK_IDS.has(id as RunbookDomain)
    );
  }
  if (RUNBOOK_IDS.has(classification.domain as RunbookDomain)) {
    return [classification.domain as RunbookDomain];
  }
  return [];
}

function normalizeContext(
  classification: WorkRouteClassification,
  runbookIds: RunbookDomain[]
): WorkItemDossierEntry[] {
  const dossier: WorkItemDossierEntry[] = [];
  const seen = new Set<string>();
  for (const entry of classification.context ?? []) {
    const label = clean(entry.label);
    const provenance = clean(entry.provenance);
    if (!label || !provenance) continue;
    const key = `${entry.state}:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dossier.push({
      label,
      state: entry.state,
      provenance,
      ...(clean(entry.detail) ? { detail: clean(entry.detail) } : {})
    });
  }

  for (const id of runbookIds) {
    const runbook = runbookByDomain(id);
    for (const required of runbook?.required_inputs ?? []) {
      const alreadyRecorded = dossier.some((entry) => entry.label === required);
      if (alreadyRecorded) continue;
      dossier.push({
        label: required,
        state: 'missing',
        provenance: `runbook:${id}`,
        detail: 'Required by selected runbook.'
      });
    }
  }
  return dossier;
}

function approvalBoundaries(
  classification: WorkRouteClassification,
  runbookIds: RunbookDomain[]
): WorkItemApprovalBoundary[] {
  const out: WorkItemApprovalBoundary[] = [];
  for (const id of runbookIds) {
    const runbook = runbookByDomain(id);
    for (const step of runbook?.steps ?? []) {
      if (step.gate !== 'approval-required') continue;
      out.push({
        id: stableId('approval', `${id}-${step.title}`, out.length),
        action: step.title,
        kind: 'other',
        payload: step.detail,
        reason: `Runbook ${runbook?.display_name ?? id} requires approval for this step.`,
        status: 'pending'
      });
    }
  }
  for (const risk of classification.riskyActions ?? []) {
    const action = clean(risk.action);
    const payload = clean(risk.payload);
    if (!action || !payload) continue;
    out.push({
      id: stableId('approval', action, out.length),
      action,
      kind: risk.kind ?? 'other',
      payload,
      reason: clean(risk.reason) || 'Risky external or mutating action.',
      status: 'pending'
    });
  }
  return out;
}

function artifacts(
  classification: WorkRouteClassification,
  runbookIds: RunbookDomain[]
): WorkItemArtifact[] {
  const out: WorkItemArtifact[] = [];
  for (const artifact of classification.expectedArtifacts ?? []) {
    const title = clean(artifact.title);
    const type = clean(artifact.type);
    if (!title || !type) continue;
    out.push({
      id: stableId('artifact', title, out.length),
      type,
      title,
      status: 'planned',
      provenance: artifact.provenance?.length ? artifact.provenance : ['router']
    });
  }
  for (const id of runbookIds) {
    const runbook = runbookByDomain(id);
    for (const artifact of runbook?.expected_artifacts ?? []) {
      const title = artifact;
      const duplicate = out.some((entry) => entry.title === title);
      if (duplicate) continue;
      out.push({
        id: stableId('artifact', `${id}-${artifact}`, out.length),
        type: artifact,
        title,
        status: 'planned',
        provenance: [`runbook:${id}`]
      });
    }
  }
  return out;
}

function watches(classification: WorkRouteClassification): WorkItemWatch[] {
  const out: WorkItemWatch[] = [];
  for (const watch of classification.watches ?? []) {
    const trigger = clean(watch.trigger);
    const cadence = clean(watch.cadence);
    const source = clean(watch.source);
    const escalation = clean(watch.escalation);
    if (!trigger || !cadence || !source || !escalation) continue;
    out.push({
      id: stableId('watch', trigger, out.length),
      trigger,
      cadence,
      source,
      next_check: watch.next_check ?? null,
      escalation,
      status: 'active'
    });
  }
  return out;
}

function clarificationReason(classification: WorkRouteClassification): string | null {
  if (classification.domain === 'unknown') return 'No domain was selected.';
  if (classification.confidence < MIN_CONFIDENCE) return 'Router confidence is too low.';
  if (selectedRunbookIds(classification).length === 0) return 'No valid runbook matches the ask.';
  return null;
}

export function planWorkAsk(input: {
  ask: string;
  classification: WorkRouteClassification;
}): WorkRouteResult {
  const ask = clean(input.ask);
  const reason = clarificationReason(input.classification);
  if (!ask || reason) {
    return {
      status: 'needs_clarification',
      question: 'What domain should I route this through, and what source context should I use?',
      reason: reason ?? 'The ask was empty.'
    };
  }

  const runbookIds = selectedRunbookIds(input.classification);
  const dossier = normalizeContext(input.classification, runbookIds);
  const missingContext = dossier.filter((entry) => entry.state === 'missing');
  const boundaries = approvalBoundaries(input.classification, runbookIds);
  const plannedArtifacts = artifacts(input.classification, runbookIds);
  const plannedWatches = watches(input.classification);
  const workStatus: WorkItemStatus =
    missingContext.length > 0 ? 'blocked' : boundaries.length > 0 ? 'waiting-approval' : 'active';
  const domain: WorkItemDomain =
    input.classification.domain === 'multi'
      ? 'multi'
      : (input.classification.domain as WorkItemDomain);
  const title = clean(input.classification.title) || ask.slice(0, 72);

  return {
    status: 'routed',
    rationale: clean(input.classification.rationale),
    workItem: {
      title,
      objective: ask,
      domain,
      runbookIds,
      status: workStatus,
      dossier,
      approvalBoundaries: boundaries,
      artifacts: plannedArtifacts,
      watches: plannedWatches,
      openApprovals: boundaries.map((boundary) => boundary.action),
      followUps: plannedWatches.map((watch) => watch.escalation),
      nextAction:
        clean(input.classification.nextAction) ||
        (missingContext[0]
          ? `Provide ${missingContext[0].label}`
          : boundaries[0]
            ? `Review approval: ${boundaries[0].action}`
            : null)
    }
  };
}
