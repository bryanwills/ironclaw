// "The Desk" — the proactive chief-of-staff home surface for IronClaw Reborn.
//
// Rather than a reactive chat log, the Desk is a priority-sorted channel of
// cards the user acts on. Its lead section — "Needs you" — surfaces the
// agent's APPROVAL GATES as first-class cards: the run paused and is waiting
// for a human decision. This is the differentiated, Reborn-unique moment (the
// agent waited for me), and it has had no dedicated home until now (gates only
// resolved inline mid-chat).
//
// The gate cards derive from the live `RebornChatController` (which already
// tracks the active thread's `pendingGate` off the projection stream) and
// resolve through the same `resolveGate` path. "Handled" cards derive from the
// jobs API. Cross-thread gate aggregation and richer activity feeds layer on in
// later increments. The controller is injected (defaulting to the app-wide
// singleton) so this is unit-testable without the connection store.

import { rebornChat, RebornChatController } from './reborn-chat.svelte';
import { openLoops } from './open-loops.svelte';
import { connection } from './connection.svelte';
import type { Job, JobDetail, JobEvent, JobFile } from '$lib/api/types';

/** A pending approval rendered as a "Needs you" Desk card. */
export interface DeskGateCard {
  /** Stable id (`runId:gateRef`) for keyed rendering + dedup. */
  id: string;
  kind: 'gate' | 'auth_required';
  runId: string;
  gateRef: string;
  headline: string;
  body: string;
}

/** A tracked commitment rendered as an "Open loops" Desk card. */
export interface DeskLoopCard {
  id: string;
  text: string;
  createdAt: number;
}

/** A recent background run rendered as a read-only "Handled" Desk card. */
export interface DeskHandledCard {
  id: string;
  title: string;
  status: 'done' | 'running' | 'failed';
  detail?: string;
  at?: string;
}

/** Compact result receipt for an expanded Handled row. */
export interface DeskReceipt {
  state: string;
  summary: string;
  fileCount: number;
}

export interface DeskJobsReader {
  listJobs(): Promise<Job[]>;
  getJob(id: string): Promise<JobDetail>;
  getJobEvents(id: string): Promise<JobEvent[]>;
  getJobFiles(id: string): Promise<JobFile[]>;
}

type LegacyJobsReader = () => Promise<Job[]>;

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}...` : id;
}

function jobStatus(job: Job): DeskHandledCard['status'] {
  if (job.state === 'completed') return 'done';
  if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'stuck') return 'failed';
  return 'running';
}

function jobDetail(job: Job): string {
  switch (job.state) {
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'stuck':
      return 'Stuck';
    case 'in_progress':
    case 'running':
      return 'Running';
    case 'pending':
      return 'Pending';
    default:
      return job.state || 'Job';
  }
}

function handledCardFromJob(job: Job): DeskHandledCard {
  return {
    id: job.id,
    title: job.title || `Job ${shortId(job.id)}`,
    status: jobStatus(job),
    detail: jobDetail(job),
    at: job.started_at || job.created_at || undefined
  };
}

function isJobsReader(reader: DeskJobsReader | LegacyJobsReader): reader is DeskJobsReader {
  return typeof reader === 'object' && reader !== null && 'listJobs' in reader;
}

function fallbackReceipt(state = 'unknown'): DeskReceipt {
  return {
    state,
    summary: 'No result detail.',
    fileCount: 0
  };
}

function compactText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 180 ? oneLine : `${oneLine.slice(0, 177)}...`;
}

function stringFromEventData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    for (const key of ['message', 'summary', 'result', 'text', 'output', 'content', 'reason']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  if (data === undefined || data === null) return '';
  try {
    return JSON.stringify(data) ?? '';
  } catch {
    return String(data);
  }
}

function summaryFromEvents(events: JobEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const text = compactText(stringFromEventData(event.data));
    if (text) return `${event.event_type}: ${text}`;
    if (event.event_type) return event.event_type;
  }
  return '';
}

export class RebornDesk {
  handledCardsState = $state<DeskHandledCard[]>([]);
  expandedHandledId = $state<string | null>(null);
  receiptsById = $state<Record<string, DeskReceipt>>({});
  receiptLoadingById = $state<Record<string, boolean>>({});

  constructor(
    private chat: RebornChatController = rebornChat,
    private loops: typeof openLoops = openLoops,
    private jobsReader: DeskJobsReader | LegacyJobsReader | null = null
  ) {}

  /**
   * "Needs you" — pending approval gates as cards. Today this reflects the
   * active thread's gate (Reborn streams gates per-thread); a later increment
   * aggregates across threads. A getter (not a `$derived` field) so it tracks
   * the controller's `$state.pendingGate` reactively wherever it's read.
   */
  get gateCards(): DeskGateCard[] {
    const g = this.chat.state.pendingGate;
    if (!g || !g.runId || !g.gateRef) return [];
    return [
      {
        id: `${g.runId}:${g.gateRef}`,
        kind: g.kind,
        runId: g.runId,
        gateRef: g.gateRef,
        headline:
          g.headline ||
          (g.kind === 'auth_required' ? 'Authorization required' : 'Approval required'),
        body: g.body || ''
      }
    ];
  }

  /** True when there's nothing awaiting the user — drives the calm "all caught up" state. */
  get caughtUp(): boolean {
    return this.gateCards.length === 0;
  }

  /** Approve the pending gate (fires the paused run). */
  async approve(): Promise<void> {
    await this.chat.resolveGate('approved');
  }

  /** Deny the pending gate. */
  async deny(): Promise<void> {
    await this.chat.resolveGate('denied');
  }

  /**
   * "Open loops" — tracked commitments the agent (or user) hasn't closed yet,
   * surfaced from the existing open-loops store (localStorage-backed, so this
   * works on any backend). A getter so it tracks the store's `active` $derived
   * reactively wherever it's read.
   */
  get loopCards(): DeskLoopCard[] {
    return this.loops.active.map((l) => ({ id: l.id, text: l.text, createdAt: l.createdAt }));
  }

  /**
   * "Handled" — recent background jobs the agent has run. The read path is
   * injectable for tests; the app-wide store falls back to the live connection
   * client. Any missing client or failed request degrades to an empty list so
   * the Desk stays honest instead of inventing outcomes.
   */
  get handledCards(): DeskHandledCard[] {
    return this.handledCardsState;
  }

  async loadHandled(): Promise<void> {
    const reader = this.jobsReader;
    try {
      const jobs =
        reader === null
          ? await (connection.client?.listJobs({ limit: 5 }) ?? [])
          : isJobsReader(reader)
            ? await reader.listJobs()
            : await reader();
      this.handledCardsState = jobs.map(handledCardFromJob);
    } catch {
      this.handledCardsState = [];
    }
  }

  async loadReceipt(jobId: string): Promise<void> {
    if (this.receiptsById[jobId]) return;
    this.receiptLoadingById[jobId] = true;
    const reader = this.jobsReader;
    try {
      if (reader && !isJobsReader(reader)) {
        this.receiptsById[jobId] = fallbackReceipt(
          this.handledCardsState.find((card) => card.id === jobId)?.detail ?? 'unknown'
        );
        return;
      }
      const client = reader ?? connection.client;
      if (!client) {
        this.receiptsById[jobId] = fallbackReceipt();
        return;
      }
      let detail: JobDetail | null = null;
      let events: JobEvent[] = [];
      let fileCount = 0;
      try {
        detail = await client.getJob(jobId);
      } catch {
        detail = null;
      }
      try {
        events = await client.getJobEvents(jobId);
      } catch {
        events = [];
      }
      try {
        fileCount = (await client.getJobFiles(jobId)).length;
      } catch {
        fileCount = 0;
      }
      if (!detail && events.length === 0 && fileCount === 0) {
        this.receiptsById[jobId] = fallbackReceipt();
        return;
      }
      const summary = summaryFromEvents(events) || compactText(detail?.description ?? '') || '';
      this.receiptsById[jobId] = {
        state: detail?.state || 'unknown',
        summary: summary || 'No result detail.',
        fileCount
      };
    } catch {
      this.receiptsById[jobId] = fallbackReceipt();
    } finally {
      this.receiptLoadingById[jobId] = false;
    }
  }

  async toggleHandled(jobId: string): Promise<void> {
    if (this.expandedHandledId === jobId) {
      this.expandedHandledId = null;
      return;
    }
    this.expandedHandledId = jobId;
    if (!this.receiptsById[jobId]) {
      await this.loadReceipt(jobId);
    }
  }

  /** Capture a new commitment on the Desk. Trimming/empty-guarding is handled
   *  by the store; returns nothing (the reactive `loopCards` updates). */
  addLoop(text: string): void {
    this.loops.add(text);
  }

  /** Mark a commitment resolved (toggles its done flag in the store). */
  resolveLoop(id: string): void {
    this.loops.toggleDone(id);
  }

  /** Drop a commitment entirely. */
  dismissLoop(id: string): void {
    this.loops.remove(id);
  }
}

/** App-wide singleton bound to the live chat controller. */
export const rebornDesk = new RebornDesk();
