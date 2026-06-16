// Work Item / Matter — the durable "work object" that unifies an objective
// across the surfaces that otherwise fragment it: chat threads, knowledge
// docs, generated artifacts, missions, and external sources, plus the
// approvals it is waiting on, the follow-ups it spawned, and the single
// next action that moves it forward.
//
// This is the spine, not a replacement: a Work Item REFERENCES threads and
// missions by id, it does not own them. Chat and missions keep working
// exactly as before; a Work Item is the layer that lets the user (and the
// Chief of Staff persona) answer "what is the state of the Acme matter?"
// without reconstructing it from scattered threads.
//
// The helpers in this module are deliberately PURE and DETERMINISTIC. They
// never read the wall clock and never call randomness — the caller passes
// `id` and `now` (an ISO timestamp) as arguments. That keeps them trivially
// unit-testable (same id + now => byte-identical object) and pushes the
// non-deterministic stamping up into the store's action methods, where it
// belongs. See work-items.svelte.ts.

/** Coarse domain of the matter. Drives the chip + future routing/persona
 *  hints. `general` is the safe default when the user doesn't pick one. */
export type WorkItemDomain =
  | 'coding'
  | 'legal'
  | 'finance'
  | 'research'
  | 'operations'
  | 'multi'
  | 'general';

/** Lifecycle status. `waiting-approval` and `blocked` are distinct on
 *  purpose: the first is "the user must approve something", the second is
 *  "something external is in the way". */
export type WorkItemStatus = 'active' | 'waiting-approval' | 'blocked' | 'done' | 'archived';

/** A serializable reference to something the matter touches. Never the live
 *  object — just enough to address and label it, so it survives reloads and
 *  never holds a torn copy of data that lives elsewhere. */
export interface WorkItemLink {
  kind: 'thread' | 'knowledge' | 'artifact' | 'mission' | 'source';
  /** Surface-specific reference (thread id, doc path, mission id, URL, …). */
  ref: string;
  /** Human label shown in the detail list. */
  label: string;
}

export type WorkItemDossierState = 'used' | 'available' | 'missing';

export interface WorkItemDossierEntry {
  label: string;
  state: WorkItemDossierState;
  provenance: string;
  detail?: string;
}

export type WorkItemApprovalStatus = 'pending' | 'approved' | 'denied';

export interface WorkItemApprovalBoundary {
  id: string;
  action: string;
  kind: 'send' | 'trade' | 'push' | 'pr' | 'export' | 'delete' | 'write' | 'other';
  payload: string;
  reason: string;
  status: WorkItemApprovalStatus;
}

export type WorkItemArtifactStatus = 'planned' | 'draft' | 'ready' | 'approved';

export interface WorkItemArtifact {
  id: string;
  type: string;
  title: string;
  status: WorkItemArtifactStatus;
  provenance: string[];
  /** Optional markdown draft/body for the artifact when a surface has rendered it. */
  content?: string;
  content_format?: 'markdown';
}

export interface WorkItemWatch {
  id: string;
  trigger: string;
  cadence: string;
  source: string;
  next_check: string | null;
  escalation: string;
  status: 'active' | 'paused' | 'done';
}

export type WorkItemReceiptKind = 'approval' | 'watch' | 'routine' | 'system';
export type WorkItemReceiptStatus = 'handled' | 'failed';

export interface WorkItemReceipt {
  id: string;
  kind: WorkItemReceiptKind;
  title: string;
  detail: string;
  source: string;
  status: WorkItemReceiptStatus;
  created_at: string;
  reversible: boolean;
}

export interface WorkItem {
  /** Stable id. The store assigns it (uuid when available). */
  id: string;
  /** Short title — what the matter is called. */
  title: string;
  /** The objective: what "done" means for this matter, in the user's words. */
  objective: string;
  domain: WorkItemDomain;
  /** Runbooks selected by the router/planner. Empty means no runbook yet. */
  runbookIds: WorkItemDomain[];
  status: WorkItemStatus;
  /** ISO timestamps. Stamped by the store, never by the pure helpers. */
  created_at: string;
  updated_at: string;
  /** References to threads / docs / artifacts / missions / sources. */
  links: WorkItemLink[];
  /** Context used, available, and missing, always with provenance. */
  dossier: WorkItemDossierEntry[];
  /** Payload-specific approval boundaries before any risky action. */
  approvalBoundaries: WorkItemApprovalBoundary[];
  /** Expected output objects, not just prose buried in chat. */
  artifacts: WorkItemArtifact[];
  /** Monitoring/watch intents linked to this matter. */
  watches: WorkItemWatch[];
  /** Quiet ledger of work the agent handled or attempted. */
  receipts: WorkItemReceipt[];
  /** Free-text descriptions of approvals the matter is waiting on. */
  openApprovals: string[];
  /** Free-text follow-ups the matter has spawned. */
  followUps: string[];
  /** The single next action that moves it forward, or null if none set. */
  nextAction: string | null;
}

/** All domains, in display order. Drives the route's domain picker so the
 *  UI never hard-codes the union members in two places. */
export const WORK_ITEM_DOMAINS: readonly WorkItemDomain[] = [
  'general',
  'coding',
  'legal',
  'finance',
  'research',
  'operations',
  'multi'
] as const;

/** All statuses, in lifecycle order. */
export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  'active',
  'waiting-approval',
  'blocked',
  'done',
  'archived'
] as const;

/** Human label for a domain chip. */
export function domainLabel(domain: WorkItemDomain): string {
  switch (domain) {
    case 'coding':
      return 'Coding';
    case 'legal':
      return 'Legal';
    case 'finance':
      return 'Finance';
    case 'research':
      return 'Research';
    case 'operations':
      return 'Operations';
    case 'multi':
      return 'Multi-domain';
    case 'general':
      return 'General';
  }
}

/** Human label for a status pill. */
export function statusLabel(status: WorkItemStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'waiting-approval':
      return 'Waiting on approval';
    case 'blocked':
      return 'Blocked';
    case 'done':
      return 'Done';
    case 'archived':
      return 'Archived';
  }
}

/**
 * Build a fresh WorkItem from minimal input. PURE: the caller supplies `id`
 * and `now` (ISO string), so two calls with the same arguments return
 * structurally identical objects. The store is responsible for generating a
 * real id and stamping the real time.
 *
 * Defaults: empty objective, `general` domain, `active` status, empty link /
 * approval / follow-up lists, and no next action. `created_at` and
 * `updated_at` are both set to `now` so a brand-new item reads as
 * just-touched.
 */
export function createWorkItem(input: {
  title: string;
  objective?: string;
  domain?: WorkItemDomain;
  runbookIds?: WorkItemDomain[];
  status?: WorkItemStatus;
  links?: WorkItemLink[];
  dossier?: WorkItemDossierEntry[];
  approvalBoundaries?: WorkItemApprovalBoundary[];
  artifacts?: WorkItemArtifact[];
  watches?: WorkItemWatch[];
  receipts?: WorkItemReceipt[];
  openApprovals?: string[];
  followUps?: string[];
  nextAction?: string | null;
  id: string;
  now: string;
}): WorkItem {
  return {
    id: input.id,
    title: input.title,
    objective: input.objective ?? '',
    domain: input.domain ?? 'general',
    runbookIds: input.runbookIds ?? [],
    status: input.status ?? 'active',
    created_at: input.now,
    updated_at: input.now,
    links: input.links ?? [],
    dossier: input.dossier ?? [],
    approvalBoundaries: input.approvalBoundaries ?? [],
    artifacts: input.artifacts ?? [],
    watches: input.watches ?? [],
    receipts: input.receipts ?? [],
    openApprovals: input.openApprovals ?? [],
    followUps: input.followUps ?? [],
    nextAction: input.nextAction ?? null
  };
}

/**
 * One-line status summary for the matter. PURE + DETERMINISTIC: derived only
 * from the item's own fields. Leads with the lifecycle state, then folds in
 * the most decision-relevant detail (a pending approval, the next action, or
 * an outstanding follow-up). Used in list rows and any future briefing.
 */
export function summarizeStatus(w: WorkItem): string {
  const approvals = w.openApprovals.length;
  const followUps = w.followUps.length;
  switch (w.status) {
    case 'waiting-approval':
      return approvals === 1
        ? 'Waiting on 1 approval'
        : approvals > 1
          ? `Waiting on ${approvals} approvals`
          : 'Waiting on approval';
    case 'blocked':
      return w.nextAction ? `Blocked — next: ${w.nextAction}` : 'Blocked';
    case 'done':
      return 'Done';
    case 'archived':
      return 'Archived';
    case 'active':
      if (w.nextAction) return `Active — next: ${w.nextAction}`;
      if (followUps > 0) {
        return followUps === 1 ? 'Active — 1 follow-up' : `Active — ${followUps} follow-ups`;
      }
      return 'Active';
  }
}
