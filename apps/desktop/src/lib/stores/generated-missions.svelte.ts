// Generative missions store — the live half of the chief-of-staff core.
//
// Feeds whatever context the user has in front of them (dropped documents,
// pasted call notes, recent activity) to the connected agent and turns the
// reply into grounded, ready-to-run proposed actions. This is the dynamic
// replacement for the static mission catalog: the agent decides what's worth
// doing from what's actually happening, instead of the user picking a generic
// verb off a menu.
//
// Running a proposal creates a durable Work Item and attaches the expected
// artifact there. Chat remains available for conversation, but generated work
// products must not disappear into a composer draft or expose internal prompts.

import { connection } from './connection.svelte';
import { workItems } from './work-items.svelte';
import type {
  WorkItem,
  WorkItemApprovalBoundary,
  WorkItemArtifact,
  WorkItemDossierEntry,
  WorkItemDomain,
  WorkItemReceipt,
  WorkItemStatus,
  WorkItemWatch
} from '$lib/data/work-item';
import {
  buildWorkProductPrompt,
  buildProposalPrompt,
  parseProposedMissions,
  type ContextItem,
  type GeneratedMission
} from '$lib/util/mission-generator';
import { type WorkRouteClassification } from '$lib/util/work-router';
import { orchestrateChiefOfStaffAsk } from '$lib/util/workflow-orchestrator';

type GenStatus = 'idle' | 'generating' | 'ready' | 'error' | 'empty';

export type GeneratedMissionRunResult =
  | {
      status: 'created';
      workItemId: string;
      title: string;
      artifactId: string | null;
      artifactTitle: string | null;
      draftStatus: 'drafted' | 'planned' | 'failed';
    }
  | {
      status: 'failed';
      reason: string;
    };

const WORK_DOMAINS = new Set<WorkItemDomain>([
  'coding',
  'legal',
  'finance',
  'research',
  'operations',
  'multi',
  'general'
]);

function clean(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stableId(prefix: string, seed: string, index: number): string {
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${prefix}-${slug || 'item'}-${index + 1}`;
}

function workDomainForMission(mission: GeneratedMission): WorkItemDomain {
  if (mission.domain === 'unknown') return 'general';
  return WORK_DOMAINS.has(mission.domain as WorkItemDomain)
    ? (mission.domain as WorkItemDomain)
    : 'general';
}

function dossierForMission(mission: GeneratedMission): WorkItemDossierEntry[] {
  if (mission.context.length > 0) return mission.context;
  return [
    {
      label: 'Source item',
      state: 'available',
      provenance: mission.item || 'generated mission'
    }
  ];
}

function approvalBoundariesForMission(mission: GeneratedMission): WorkItemApprovalBoundary[] {
  return mission.risky_actions
    .map((risk, index) => {
      const action = clean(risk.action);
      const payload = clean(risk.payload);
      if (!action || !payload) return null;
      const boundary: WorkItemApprovalBoundary = {
        id: stableId('approval', `${mission.id}-${action}`, index),
        action,
        kind: risk.kind ?? 'other',
        payload,
        reason: clean(risk.reason) || 'External or mutating action requires approval.',
        status: 'pending'
      };
      return boundary;
    })
    .filter((risk): risk is WorkItemApprovalBoundary => risk !== null);
}

function watchesForMission(mission: GeneratedMission): WorkItemWatch[] {
  return mission.watches
    .map((watch, index) => {
      const trigger = clean(watch.trigger);
      const cadence = clean(watch.cadence);
      const source = clean(watch.source);
      const escalation = clean(watch.escalation);
      if (!trigger || !cadence || !source || !escalation) return null;
      const item: WorkItemWatch = {
        id: stableId('watch', `${mission.id}-${trigger}`, index),
        trigger,
        cadence,
        source,
        next_check: watch.next_check ?? null,
        escalation,
        status: 'active'
      };
      return item;
    })
    .filter((watch): watch is WorkItemWatch => watch !== null);
}

function missionArtifacts(
  mission: GeneratedMission,
  base: WorkItemArtifact[] = []
): WorkItemArtifact[] {
  const out = [...base];
  const seenTitles = new Set(out.map((artifact) => artifact.title.trim().toLowerCase()));
  const seenIds = new Set(out.map((artifact) => artifact.id));

  for (const artifact of mission.expected_artifacts) {
    const title = clean(artifact.title);
    const type = clean(artifact.type);
    if (!title || !type || seenTitles.has(title.toLowerCase())) continue;
    let id = stableId('artifact', `${mission.id}-${title}`, out.length);
    while (seenIds.has(id)) id = `${id}-${out.length + 1}`;
    out.push({
      id,
      type,
      title,
      status: 'planned',
      provenance: artifact.provenance?.length
        ? artifact.provenance
        : [mission.item || 'generated mission']
    });
    seenTitles.add(title.toLowerCase());
    seenIds.add(id);
  }

  const deliverable = clean(mission.deliverable);
  if (deliverable && !seenTitles.has(deliverable.toLowerCase())) {
    let id = stableId('artifact', `${mission.id}-${deliverable}`, out.length);
    while (seenIds.has(id)) id = `${id}-${out.length + 1}`;
    out.push({
      id,
      type: mission.expected_artifacts[0]?.type || 'work-product',
      title: deliverable,
      status: 'planned',
      provenance: [mission.item || 'generated mission']
    });
  }

  if (out.length === 0) {
    const title = deliverable || `${mission.title} work product`;
    out.push({
      id: stableId('artifact', `${mission.id}-${title}`, 0),
      type: 'work-product',
      title,
      status: 'planned',
      provenance: [mission.item || 'generated mission']
    });
  }

  return out;
}

function primaryArtifactForMission(
  mission: GeneratedMission,
  artifacts: WorkItemArtifact[]
): WorkItemArtifact | null {
  const deliverable = clean(mission.deliverable).toLowerCase();
  if (deliverable) {
    const exact = artifacts.find((artifact) => artifact.title.trim().toLowerCase() === deliverable);
    if (exact) return exact;
  }
  return artifacts[0] ?? null;
}

function outputLooksLikeInternalPrompt(value: string): boolean {
  return /Return STRICT JSON only|--- WORKSPACE CONTEXT ---|You are the user's Chief of Staff inside IronClaw/i.test(
    value
  );
}

function receipt(
  mission: GeneratedMission,
  kind: 'created' | 'drafted' | 'failed',
  detail: string
): WorkItemReceipt {
  return {
    id: `receipt-${mission.id}-${kind}-${Date.now().toString(36)}`,
    kind: 'system',
    title:
      kind === 'drafted'
        ? 'Drafted work product'
        : kind === 'failed'
          ? 'Work product draft failed'
          : 'Created work product',
    detail,
    source: `generated-mission:${mission.id}`,
    status: kind === 'failed' ? 'failed' : 'handled',
    created_at: new Date().toISOString(),
    reversible: kind !== 'drafted'
  };
}

class GeneratedMissionsStore {
  status = $state<GenStatus>('idle');
  missions = $state<GeneratedMission[]>([]);
  error = $state<string | null>(null);
  /** Echoed back so the panel can show what the proposals were drawn from. */
  lastContext = $state<ContextItem[]>([]);

  private seq = 0;

  /** True when a gateway client is available to generate against. */
  get available(): boolean {
    return !!connection.client;
  }

  /**
   * Ask the connected agent to propose actions from the given context.
   * Late/stale responses are ignored via a sequence guard so rapid
   * re-generates can't clobber each other.
   */
  async generateFrom(items: ContextItem[]): Promise<void> {
    const client = connection.client;
    if (!client) {
      this.status = 'error';
      this.error = 'Not connected to a gateway. Connect in Settings, then try again.';
      return;
    }
    const usable = items.filter((i) => i.body.trim().length > 0);
    if (usable.length === 0) {
      this.status = 'error';
      this.error = 'Add something for the agent to work from (paste notes, a doc, an email).';
      return;
    }
    const mine = ++this.seq;
    this.status = 'generating';
    this.error = null;
    this.lastContext = usable;
    try {
      const raw = await client.createResponse(buildProposalPrompt(usable));
      if (mine !== this.seq) return; // superseded
      const parsed = parseProposedMissions(raw);
      this.missions = parsed;
      this.status = parsed.length > 0 ? 'ready' : 'empty';
    } catch (err) {
      if (mine !== this.seq) return;
      this.status = 'error';
      this.error = err instanceof Error ? err.message : 'Generation failed.';
    }
  }

  /**
   * Run a proposed mission by creating an accessible Work Item and drafting the
   * primary artifact there. Approval-first by design: any external/mutating
   * action remains a pending approval boundary on the Work Item.
   */
  async run(mission: GeneratedMission): Promise<GeneratedMissionRunResult> {
    const classification: WorkRouteClassification = {
      domain: mission.domain,
      confidence: mission.domain === 'unknown' ? 0.3 : 0.82,
      title: mission.title,
      domains: mission.domains,
      context: mission.context,
      riskyActions: mission.risky_actions,
      expectedArtifacts: mission.expected_artifacts,
      watches: mission.watches,
      nextAction: mission.run_instruction
    };
    const route = orchestrateChiefOfStaffAsk({
      ask: mission.run_instruction,
      title: mission.title,
      surface: 'generated-mission',
      source: `generated-mission:${mission.id}`,
      classification
    });

    const links = [
      { kind: 'mission' as const, ref: mission.id, label: mission.title },
      {
        kind: 'source' as const,
        ref: mission.item || mission.id,
        label: mission.item || mission.title
      }
    ];

    const nowReceipts = [
      receipt(mission, 'created', 'Created from a generated Desk action; no chat prompt was sent.')
    ];

    let created: WorkItem | null = null;
    if (route.status === 'routed') {
      const planned = route.route.workItem;
      created = workItems.create({
        ...planned,
        links,
        artifacts: missionArtifacts(mission, planned.artifacts),
        receipts: nowReceipts,
        nextAction:
          planned.nextAction ||
          `Review work product: ${clean(mission.deliverable) || mission.title}`
      });
    } else if (route.status === 'needs_clarification') {
      const approvals = approvalBoundariesForMission(mission);
      if (route.decision.mustNotExecute && approvals.length === 0) {
        approvals.push({
          id: stableId('approval', `${mission.id}-clarify-before-acting`, 0),
          action: 'Clarify before acting',
          kind: 'other',
          payload: mission.run_instruction,
          reason: route.decision.reason,
          status: 'pending'
        });
      }
      const watches = watchesForMission(mission);
      created = workItems.create({
        title: mission.title,
        objective: mission.run_instruction,
        domain: workDomainForMission(mission),
        runbookIds: [],
        status: 'blocked' satisfies WorkItemStatus,
        links,
        dossier: dossierForMission(mission),
        approvalBoundaries: approvals,
        artifacts: missionArtifacts(mission),
        watches,
        receipts: [
          ...nowReceipts,
          receipt(mission, 'failed', `Routing needs clarification: ${route.route.reason}`)
        ],
        openApprovals: approvals.map((approval) => approval.action),
        followUps: watches.map((watch) => watch.escalation),
        nextAction: `${route.route.question} (${route.route.reason})`
      });
    }

    if (!created) {
      return {
        status: 'failed',
        reason: 'Could not create a Work item for this generated action.'
      };
    }

    const primary = primaryArtifactForMission(mission, created.artifacts);
    let draftStatus: 'drafted' | 'planned' | 'failed' = 'planned';
    if (route.status === 'routed' && primary) {
      void this.draftPrimaryArtifact(mission, created.id, primary.id);
    }

    return {
      status: 'created',
      workItemId: created.id,
      title: created.title,
      artifactId: primary?.id ?? null,
      artifactTitle: primary?.title ?? null,
      draftStatus
    };
  }

  private async draftPrimaryArtifact(
    mission: GeneratedMission,
    workItemId: string,
    artifactId: string
  ): Promise<void> {
    const client = connection.client;
    if (!client) return;
    const item = workItems.get(workItemId);
    const primary = item?.artifacts.find((artifact) => artifact.id === artifactId);
    if (!item || !primary) return;

    try {
      const draft = await client.createResponse(buildWorkProductPrompt(mission, this.lastContext));
      const content = draft.trim();
      const latest = workItems.get(workItemId);
      if (!latest) return;
      if (!content || outputLooksLikeInternalPrompt(content)) {
        workItems.update(workItemId, {
          receipts: [
            receipt(
              mission,
              'failed',
              'The model did not return a safe user-visible draft. The Work item remains available.'
            ),
            ...latest.receipts
          ]
        });
        return;
      }

      workItems.update(workItemId, {
        artifacts: latest.artifacts.map((artifact) =>
          artifact.id === artifactId
            ? {
                ...artifact,
                status: 'draft' as const,
                content,
                content_format: 'markdown' as const
              }
            : artifact
        ),
        receipts: [receipt(mission, 'drafted', `Drafted ${primary.title}.`), ...latest.receipts],
        nextAction: `Review draft: ${primary.title}`
      });
    } catch (err) {
      const latest = workItems.get(workItemId);
      if (!latest) return;
      const message = err instanceof Error ? err.message : 'Gateway draft failed.';
      workItems.update(workItemId, {
        receipts: [receipt(mission, 'failed', message), ...latest.receipts],
        nextAction: `Draft failed; review planned artifact: ${primary.title}`
      });
    }
  }

  dismiss(id: string): void {
    this.missions = this.missions.filter((m) => m.id !== id);
    if (this.missions.length === 0 && this.status === 'ready') this.status = 'empty';
  }

  reset(): void {
    this.seq++;
    this.status = 'idle';
    this.missions = [];
    this.error = null;
    this.lastContext = [];
  }
}

export const generatedMissions = new GeneratedMissionsStore();
