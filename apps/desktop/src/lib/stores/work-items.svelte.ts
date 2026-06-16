// Work Items store — the persisted home for the Work Object Spine.
//
// Runtime singleton (`workItems`) backed by `$state`, persisted as a single
// localStorage blob under `ironclaw-work-items`, rewritten on every
// mutation. The persistence discipline mirrors open-loops.svelte.ts /
// pins.svelte.ts: SSR/jsdom-safe `window` guards, a defensive load that
// coerces a corrupt or hand-edited blob back to a valid shape, and a hard
// cap so a runaway create can't bloat storage without bound.
//
// Division of labour with the pure helpers in $lib/data/work-item.ts: those
// helpers never touch the clock or randomness; THIS store stamps `id`,
// `created_at`, and `updated_at` inside its action methods (create / update)
// so the data layer stays deterministic and unit-testable.
//
// TODO(gateway): persistence is local-only today. The eventual server-side
// work-item contract (a `/api/work-items` style endpoint that owns matters
// across devices and lets the agent read/write them) is NOT wired here.
// When it lands, hydrate()/persist() become the local cache in front of a
// sync layer; the public method surface should not have to change.

import {
  createWorkItem,
  type WorkItem,
  type WorkItemApprovalBoundary,
  type WorkItemApprovalStatus,
  type WorkItemArtifact,
  type WorkItemDossierEntry,
  type WorkItemDomain,
  type WorkItemLink,
  type WorkItemReceipt,
  type WorkItemStatus,
  type WorkItemWatch,
  WORK_ITEM_DOMAINS,
  WORK_ITEM_STATUSES
} from '$lib/data/work-item';
const LS_KEY = 'ironclaw-work-items';

/** Hard cap so a stuck key or scripted create can't grow the blob unbounded. */
export const MAX_WORK_ITEMS = 500;

/** Best-effort stable id. `crypto.randomUUID` in the app + modern test envs;
 *  a timestamp+random fallback keeps the store usable anywhere. */
function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the manual id
  }
  return `work-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Coerce an arbitrary value into a clean string array (trimmed, non-empty). */
function coerceStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/** Coerce an arbitrary value into a clean WorkItemLink array. */
function coerceLinks(raw: unknown): WorkItemLink[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkItemLink[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const kind = e.kind;
    const ref = typeof e.ref === 'string' ? e.ref : null;
    if (typeof kind !== 'string' || ref === null) continue;
    if (!['thread', 'knowledge', 'artifact', 'mission', 'source'].includes(kind)) continue;
    out.push({
      kind: kind as WorkItemLink['kind'],
      ref,
      label: typeof e.label === 'string' ? e.label : ref
    });
  }
  return out;
}

function coerceDomain(raw: unknown): WorkItemDomain {
  return typeof raw === 'string' && (WORK_ITEM_DOMAINS as readonly string[]).includes(raw)
    ? (raw as WorkItemDomain)
    : 'general';
}

function coerceStatus(raw: unknown): WorkItemStatus {
  return typeof raw === 'string' && (WORK_ITEM_STATUSES as readonly string[]).includes(raw)
    ? (raw as WorkItemStatus)
    : 'active';
}

function coerceDossier(raw: unknown): WorkItemDossierEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkItemDossierEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const label = typeof e.label === 'string' ? e.label.trim() : '';
    const state = typeof e.state === 'string' ? e.state : '';
    const provenance = typeof e.provenance === 'string' ? e.provenance.trim() : '';
    if (!label || !provenance) continue;
    if (!['used', 'available', 'missing'].includes(state)) continue;
    out.push({
      label,
      state: state as WorkItemDossierEntry['state'],
      provenance,
      ...(typeof e.detail === 'string' && e.detail.trim() ? { detail: e.detail.trim() } : {})
    });
  }
  return out;
}

function coerceApprovalBoundaries(raw: unknown): WorkItemApprovalBoundary[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkItemApprovalBoundary[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    const action = typeof e.action === 'string' ? e.action.trim() : '';
    const kind = typeof e.kind === 'string' ? e.kind : 'other';
    const payload = typeof e.payload === 'string' ? e.payload.trim() : '';
    const reason = typeof e.reason === 'string' ? e.reason.trim() : '';
    const status = typeof e.status === 'string' ? e.status : 'pending';
    if (!id || !action || !payload) continue;
    if (!['send', 'trade', 'push', 'pr', 'export', 'delete', 'write', 'other'].includes(kind))
      continue;
    if (!['pending', 'approved', 'denied'].includes(status)) continue;
    out.push({
      id,
      action,
      kind: kind as WorkItemApprovalBoundary['kind'],
      payload,
      reason,
      status: status as WorkItemApprovalBoundary['status']
    });
  }
  return out;
}

function coerceArtifacts(raw: unknown): WorkItemArtifact[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkItemArtifact[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    const type = typeof e.type === 'string' ? e.type.trim() : '';
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    const status = typeof e.status === 'string' ? e.status : 'planned';
    if (!id || !type || !title) continue;
    if (!['planned', 'draft', 'ready', 'approved'].includes(status)) continue;
    out.push({
      id,
      type,
      title,
      status: status as WorkItemArtifact['status'],
      provenance: coerceStringList(e.provenance),
      ...(typeof e.content === 'string' && e.content.trim()
        ? {
            content: e.content.trim(),
            content_format: 'markdown' as const
          }
        : {})
    });
  }
  return out;
}

function coerceWatches(raw: unknown): WorkItemWatch[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkItemWatch[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    const trigger = typeof e.trigger === 'string' ? e.trigger.trim() : '';
    const cadence = typeof e.cadence === 'string' ? e.cadence.trim() : '';
    const source = typeof e.source === 'string' ? e.source.trim() : '';
    const escalation = typeof e.escalation === 'string' ? e.escalation.trim() : '';
    const status = typeof e.status === 'string' ? e.status : 'active';
    if (!id || !trigger || !cadence || !source || !escalation) continue;
    if (!['active', 'paused', 'done'].includes(status)) continue;
    out.push({
      id,
      trigger,
      cadence,
      source,
      next_check: typeof e.next_check === 'string' && e.next_check.trim() ? e.next_check : null,
      escalation,
      status: status as WorkItemWatch['status']
    });
  }
  return out;
}

function coerceReceipts(raw: unknown): WorkItemReceipt[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkItemReceipt[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    const kind = typeof e.kind === 'string' ? e.kind : 'system';
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    const detail = typeof e.detail === 'string' ? e.detail.trim() : '';
    const source = typeof e.source === 'string' ? e.source.trim() : '';
    const status = typeof e.status === 'string' ? e.status : 'handled';
    const created_at = typeof e.created_at === 'string' ? e.created_at : '';
    if (!id || !title || !created_at) continue;
    if (!['approval', 'watch', 'routine', 'system'].includes(kind)) continue;
    if (!['handled', 'failed'].includes(status)) continue;
    out.push({
      id,
      kind: kind as WorkItemReceipt['kind'],
      title,
      detail,
      source,
      status: status as WorkItemReceipt['status'],
      created_at,
      reversible: e.reversible === true
    });
  }
  return out;
}

function isDue(nextCheck: string | null, now: Date): boolean {
  if (!nextCheck) return false;
  const dueAt = Date.parse(nextCheck);
  return Number.isFinite(dueAt) && dueAt <= now.getTime();
}

function nextCheckForCadence(cadence: string, now: Date): string | null {
  const normalized = cadence.trim().toLowerCase();
  if (!normalized || /\b(once|one[- ]shot|manual)\b/.test(normalized)) return null;

  const every = /\bevery\s+(\d+)\s*(minute|minutes|hour|hours|day|days|week|weeks)\b/.exec(
    normalized
  );
  if (every) {
    const amount = Number(every[1]);
    const unit = every[2];
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const ms = unit.startsWith('minute')
      ? amount * 60_000
      : unit.startsWith('hour')
        ? amount * 3_600_000
        : unit.startsWith('day')
          ? amount * 86_400_000
          : amount * 7 * 86_400_000;
    return new Date(now.getTime() + ms).toISOString();
  }

  if (/\b(hourly|hour)\b/.test(normalized))
    return new Date(now.getTime() + 3_600_000).toISOString();
  if (/\b(daily|day)\b/.test(normalized)) return new Date(now.getTime() + 86_400_000).toISOString();
  if (/\b(weekly|week)\b/.test(normalized)) {
    return new Date(now.getTime() + 7 * 86_400_000).toISOString();
  }

  return null;
}

/**
 * Defensively shape an arbitrary JSON blob into `WorkItem[]`. Drops entries
 * without a usable id or title, coerces enums/lists back to valid shapes,
 * dedups ids, and enforces the cap — so a stale or hand-edited file can
 * never put the store in an invalid state.
 */
function coerceLoaded(raw: unknown): WorkItem[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' && e.id.length > 0 ? e.id : null;
    if (id === null) continue;
    if (seen.has(id)) continue;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    if (title.length === 0) continue;
    seen.add(id);
    const created = typeof e.created_at === 'string' ? e.created_at : '';
    const updated = typeof e.updated_at === 'string' ? e.updated_at : created;
    out.push({
      id,
      title,
      objective: typeof e.objective === 'string' ? e.objective : '',
      domain: coerceDomain(e.domain),
      runbookIds: coerceStringList(e.runbookIds).filter((id): id is WorkItemDomain =>
        (WORK_ITEM_DOMAINS as readonly string[]).includes(id)
      ),
      status: coerceStatus(e.status),
      created_at: created,
      updated_at: updated,
      links: coerceLinks(e.links),
      dossier: coerceDossier(e.dossier),
      approvalBoundaries: coerceApprovalBoundaries(e.approvalBoundaries),
      artifacts: coerceArtifacts(e.artifacts),
      watches: coerceWatches(e.watches),
      receipts: coerceReceipts(e.receipts),
      openApprovals: coerceStringList(e.openApprovals),
      followUps: coerceStringList(e.followUps),
      nextAction:
        typeof e.nextAction === 'string' && e.nextAction.trim().length > 0 ? e.nextAction : null
    });
    if (out.length >= MAX_WORK_ITEMS) break;
  }
  return out;
}

/** Patch shape for `update()` — any subset of the user-editable fields. */
export type WorkItemPatch = Partial<
  Pick<
    WorkItem,
    | 'title'
    | 'objective'
    | 'domain'
    | 'status'
    | 'links'
    | 'runbookIds'
    | 'dossier'
    | 'approvalBoundaries'
    | 'artifacts'
    | 'watches'
    | 'receipts'
    | 'openApprovals'
    | 'followUps'
    | 'nextAction'
  >
>;

export class WorkItemStore {
  /** The full list, newest-first. Mutations always replace the array
   *  reference so Svelte reactivity fires. */
  items = $state<WorkItem[]>([]);

  private hydrated = false;

  /** Count of items that are neither done nor archived. */
  activeCount = $derived(
    this.items.filter((w) => w.status !== 'done' && w.status !== 'archived').length
  );

  /**
   * Hydrate from localStorage. Idempotent — safe to call repeatedly. Call
   * once when a surface that needs work items mounts.
   */
  hydrate(): void {
    if (this.hydrated || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (raw) this.items = coerceLoaded(JSON.parse(raw) as unknown);
    } catch {
      // Corrupt JSON / unavailable storage — start empty.
    }
    this.hydrated = true;
  }

  /**
   * Force a fresh read from localStorage. Used by surface refresh so callers do
   * not need to reach into the private hydration guard.
   */
  reload(): void {
    this.hydrated = false;
    this.items = [];
    this.hydrate();
  }

  /**
   * Create a new matter from minimal input. Generates a unique id, stamps
   * `created_at`/`updated_at` to now, prepends it (newest-first), and
   * persists. Returns the created item, or null when the title was empty.
   * Drops the oldest item when at the cap so the newest always lands.
   */
  create(input: {
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
  }): WorkItem | null {
    const title = input.title.trim();
    if (title.length === 0) return null;
    // Guard against an id collision (the non-crypto fallback could repeat).
    const existing = new Set(this.items.map((w) => w.id));
    let id = newId();
    while (existing.has(id)) id = newId();
    const item = createWorkItem({
      id,
      now: new Date().toISOString(),
      title,
      objective: input.objective?.trim() ? input.objective.trim() : '',
      domain: input.domain,
      runbookIds: input.runbookIds,
      status: input.status,
      links: input.links,
      dossier: input.dossier,
      approvalBoundaries: input.approvalBoundaries,
      artifacts: input.artifacts,
      watches: input.watches,
      receipts: input.receipts,
      openApprovals: input.openApprovals,
      followUps: input.followUps,
      nextAction: input.nextAction
    });
    let next = [item, ...this.items];
    if (next.length > MAX_WORK_ITEMS) next = next.slice(0, MAX_WORK_ITEMS);
    this.items = next;
    this.persist();
    return item;
  }

  runDueWatches(now: Date = new Date()): WorkItemReceipt[] {
    const nowIso = now.toISOString();
    const fired: WorkItemReceipt[] = [];
    let changed = false;

    const nextItems = this.items.map((item) => {
      let itemChanged = false;
      let lastReceiptTitle: string | null = null;
      const receipts = [...item.receipts];
      const watches = item.watches.map((watch) => {
        if (watch.status !== 'active') return watch;
        if (!isDue(watch.next_check, now)) return watch;

        const receipt: WorkItemReceipt = {
          id: `receipt-${watch.id}-${now.getTime().toString(36)}`,
          kind: 'watch',
          title: `Checked ${watch.trigger}`,
          detail: watch.escalation,
          source: watch.source,
          status: 'handled',
          created_at: nowIso,
          reversible: false
        };
        receipts.unshift(receipt);
        fired.push(receipt);
        lastReceiptTitle = receipt.title;
        itemChanged = true;

        const nextCheck = nextCheckForCadence(watch.cadence, now);
        return {
          ...watch,
          next_check: nextCheck,
          status: nextCheck ? 'active' : 'done'
        } satisfies WorkItemWatch;
      });

      if (!itemChanged) return item;
      changed = true;
      return {
        ...item,
        watches,
        receipts: receipts.slice(0, 50),
        updated_at: nowIso,
        nextAction: lastReceiptTitle ? `Review watch receipt: ${lastReceiptTitle}` : item.nextAction
      };
    });

    if (changed) {
      this.items = nextItems;
      this.persist();
    }
    return fired;
  }

  /** Look up a matter by id, or undefined when absent. */
  get(id: string): WorkItem | undefined {
    return this.items.find((w) => w.id === id);
  }

  /**
   * Apply a partial patch to a matter and re-stamp `updated_at`. No-op when
   * the id is unknown. Returns the updated item, or undefined when absent.
   */
  update(id: string, patch: WorkItemPatch): WorkItem | undefined {
    let updated: WorkItem | undefined;
    const next = this.items.map((w) => {
      if (w.id !== id) return w;
      updated = { ...w, ...patch, updated_at: new Date().toISOString() };
      return updated;
    });
    if (!updated) return undefined;
    this.items = next;
    this.persist();
    return updated;
  }

  /**
   * Resolve one approval boundary and keep the matter's lifecycle fields in
   * sync. Missing context keeps a matter blocked; otherwise any remaining
   * approval-required boundary keeps it waiting on the user.
   */
  updateApprovalBoundary(
    itemId: string,
    boundaryId: string,
    status: WorkItemApprovalStatus
  ): WorkItem | undefined {
    const item = this.get(itemId);
    if (!item) return undefined;
    if (!item.approvalBoundaries.some((boundary) => boundary.id === boundaryId)) return undefined;

    const approvalBoundaries = item.approvalBoundaries.map((boundary) =>
      boundary.id === boundaryId ? { ...boundary, status } : boundary
    );
    const pendingBoundaries = approvalBoundaries.filter(
      (boundary) => boundary.status === 'pending'
    );
    const hasMissingContext = item.dossier.some((entry) => entry.state === 'missing');
    const nextStatus: WorkItemStatus =
      status === 'denied'
        ? 'blocked'
        : hasMissingContext
          ? 'blocked'
          : pendingBoundaries.length > 0
            ? 'waiting-approval'
            : item.status === 'waiting-approval' || item.status === 'blocked'
              ? 'active'
              : item.status;

    return this.update(item.id, {
      approvalBoundaries,
      status: nextStatus,
      openApprovals: pendingBoundaries.map((boundary) => boundary.action),
      nextAction:
        status === 'denied'
          ? 'Revise the ask or approval boundary.'
          : pendingBoundaries[0]
            ? `Review approval: ${pendingBoundaries[0].action}`
            : 'Approved; continue the work.'
    });
  }

  /** Remove a matter by id. No-op when absent. */
  remove(id: string): void {
    if (!this.items.some((w) => w.id === id)) return;
    this.items = this.items.filter((w) => w.id !== id);
    this.persist();
  }

  /** Remove everything. */
  clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.persist();
  }

  /** Persist current state. Best-effort; quota / private-mode failures are
   *  non-fatal (in-memory state still works; the next mutation retries). */
  private persist(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(this.items));
    } catch {
      // Storage full or disabled — non-fatal.
    }
  }
}

/** Global singleton — import this anywhere. */
export const workItems = new WorkItemStore();
