// R56/R57 (lane A5/B4): sub-agent task dispatch + tracking.
//
// "Delegate this to a background agent" — fire a one-shot task at the
// gateway's /api/v1/tasks family and stream its progress back into a
// per-thread chip. The gateway endpoint may not exist on older
// IronClaw builds (404 → SubAgentUnsupportedError); the store records
// that as a terminal `unsupported` flag so the UI can show a clean
// hint instead of looping.

import type { IronClawClient } from '$lib/api/ironclaw';
import {
  SubAgentUnsupportedError,
  type SubAgentDispatchInput,
  type SubAgentTask
} from '$lib/api/types';
import { connection } from './connection.svelte';

interface TaskRecord {
  task: SubAgentTask;
  abort: AbortController;
  progressText: string;
}

class SubAgentsStore {
  private byId = $state<Record<string, TaskRecord>>({});
  /** Set once the gateway answers 404/405 — the UI uses this to gray
   *  out the "Delegate" affordance + show a "needs newer IronClaw" hint. */
  unsupported = $state<boolean>(false);

  /**
   * Dispatch a task. Returns the task id, or null when the gateway
   * doesn't support sub-agents (sets `unsupported`).
   */
  async dispatch(input: SubAgentDispatchInput): Promise<string | null> {
    const client = connection.client as IronClawClient | null;
    if (!client) throw new Error('Not connected');
    try {
      const task = await client.dispatchSubAgent(input);
      const abort = new AbortController();
      this.byId[task.id] = { task, abort, progressText: '' };
      void this.attachStream(client, task.id, abort);
      return task.id;
    } catch (err) {
      if (err instanceof SubAgentUnsupportedError) {
        this.unsupported = true;
        return null;
      }
      throw err;
    }
  }

  cancel(id: string): void {
    const rec = this.byId[id];
    if (!rec) return;
    rec.abort.abort();
    void (connection.client as IronClawClient | null)?.cancelSubAgentTask(id);
    if (this.byId[id]) {
      this.byId[id].task = { ...this.byId[id].task, status: 'cancelled' };
    }
  }

  forThread(threadId: string): SubAgentTask[] {
    return Object.values(this.byId)
      .filter((r) => r.task.parent_thread_id === threadId)
      .map((r) => r.task);
  }

  progressFor(id: string): string {
    return this.byId[id]?.progressText ?? '';
  }

  all(): SubAgentTask[] {
    return Object.values(this.byId).map((r) => r.task);
  }

  private async attachStream(
    client: IronClawClient,
    id: string,
    abort: AbortController
  ): Promise<void> {
    try {
      for await (const ev of client.streamSubAgentEvents(id, abort.signal)) {
        const rec = this.byId[id];
        if (!rec) return;
        if (ev.type === 'started') {
          rec.task = { ...rec.task, status: 'running', started_at: new Date().toISOString() };
        } else if (ev.type === 'progress') {
          rec.progressText += ev.text;
        } else if (ev.type === 'completed') {
          rec.task = {
            ...rec.task,
            status: 'succeeded',
            result: ev.result,
            finished_at: new Date().toISOString()
          };
        } else if (ev.type === 'failed') {
          rec.task = {
            ...rec.task,
            status: 'failed',
            error: ev.error,
            finished_at: new Date().toISOString()
          };
        }
        this.byId[id] = rec;
      }
    } catch (err) {
      if (err instanceof SubAgentUnsupportedError) {
        this.unsupported = true;
        return;
      }
      const rec = this.byId[id];
      if (rec && rec.task.status !== 'cancelled') {
        rec.task = {
          ...rec.task,
          status: 'failed',
          error: (err as Error).message,
          finished_at: new Date().toISOString()
        };
        this.byId[id] = rec;
      }
    }
  }
}

export const subAgents = new SubAgentsStore();
