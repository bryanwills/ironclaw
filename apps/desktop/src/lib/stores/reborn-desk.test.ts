// Tests for the Desk store's "Needs you" gate-inbox derivation. A controller
// with a null client (no I/O) is seeded with a pendingGate; we assert the card
// projection, the caught-up state, and that approve/deny delegate to the
// controller's resolveGate. The reducer/transport are covered elsewhere.

import { describe, expect, it, vi } from 'vitest';

import { RebornChatController } from './reborn-chat.svelte';
import { RebornDesk } from './reborn-desk.svelte';
import { OpenLoopStore } from './open-loops.svelte';
import { connection } from './connection.svelte';
import { initialChatState, type RebornGate } from '$lib/api/reborn';
import type { Job, JobDetail, JobEvent, JobFile } from '$lib/api/types';
import type { DeskJobsReader } from './reborn-desk.svelte';

function deskWithGate(gate: RebornGate | null): { desk: RebornDesk; chat: RebornChatController } {
  const chat = new RebornChatController(() => null);
  chat.state = { ...initialChatState(), pendingGate: gate };
  // Inject a fresh empty loop store so gate tests are isolated from any
  // open-loops singleton state.
  return { desk: new RebornDesk(chat, new OpenLoopStore()), chat };
}

describe('RebornDesk gate inbox', () => {
  it('is caught up with no pending gate', () => {
    const { desk } = deskWithGate(null);
    expect(desk.gateCards).toEqual([]);
    expect(desk.caughtUp).toBe(true);
  });

  it('projects a pending gate into a Needs-you card', () => {
    const { desk } = deskWithGate({
      kind: 'gate',
      runId: 'r1',
      gateRef: 'g1',
      headline: 'Run shell `rm -rf build`?',
      body: 'Clears the build dir.'
    });
    expect(desk.caughtUp).toBe(false);
    expect(desk.gateCards).toEqual([
      {
        id: 'r1:g1',
        kind: 'gate',
        runId: 'r1',
        gateRef: 'g1',
        headline: 'Run shell `rm -rf build`?',
        body: 'Clears the build dir.'
      }
    ]);
  });

  it('defaults the headline for an auth gate with none, and tolerates empty body', () => {
    const { desk } = deskWithGate({ kind: 'auth_required', runId: 'r2', gateRef: 'a2' });
    expect(desk.gateCards[0]).toMatchObject({
      id: 'r2:a2',
      kind: 'auth_required',
      headline: 'Authorization required',
      body: ''
    });
  });

  it('ignores an unusable gate missing runId/gateRef', () => {
    const { desk } = deskWithGate({ kind: 'gate', runId: '', gateRef: '', headline: 'x' });
    expect(desk.gateCards).toEqual([]);
    expect(desk.caughtUp).toBe(true);
  });

  it('approve / deny delegate to the controller resolveGate', async () => {
    const { desk, chat } = deskWithGate({ kind: 'gate', runId: 'r1', gateRef: 'g1' });
    const resolve = vi.spyOn(chat, 'resolveGate').mockResolvedValue(undefined);
    await desk.approve();
    expect(resolve).toHaveBeenCalledWith('approved');
    await desk.deny();
    expect(resolve).toHaveBeenCalledWith('denied');
  });
});

describe('RebornDesk open loops', () => {
  function deskWithLoops(): { desk: RebornDesk; loops: OpenLoopStore } {
    const chat = new RebornChatController(() => null);
    chat.state = { ...initialChatState() };
    const loops = new OpenLoopStore();
    return { desk: new RebornDesk(chat, loops), loops };
  }

  it('projects active open loops into loop cards in order', () => {
    const { desk, loops } = deskWithLoops();
    loops.add('Send Priya the deck');
    loops.add('Reply to the board email');
    expect(desk.loopCards.map((c) => c.text)).toEqual([
      'Send Priya the deck',
      'Reply to the board email'
    ]);
  });

  it('resolveLoop drops it from active; dismissLoop removes it', () => {
    const { desk, loops } = deskWithLoops();
    const a = loops.add('one');
    const b = loops.add('two');
    desk.resolveLoop(a!.id);
    expect(desk.loopCards.map((c) => c.text)).toEqual(['two']);
    desk.dismissLoop(b!.id);
    expect(desk.loopCards).toEqual([]);
  });

  it('addLoop captures a (trimmed) commitment and ignores empty input', () => {
    const { desk } = deskWithLoops();
    desk.addLoop('  Follow up with Sam  ');
    expect(desk.loopCards.map((c) => c.text)).toEqual(['Follow up with Sam']);
    desk.addLoop('   ');
    expect(desk.loopCards).toHaveLength(1);
  });
});

describe('RebornDesk handled jobs', () => {
  function readerWith(overrides: Partial<DeskJobsReader> & { jobs?: Job[] }): DeskJobsReader {
    return {
      listJobs: async () => overrides.jobs ?? [],
      getJob: async (id: string) => {
        if (overrides.getJob) return overrides.getJob(id);
        throw new Error('no detail');
      },
      getJobEvents: async (id: string) => {
        if (overrides.getJobEvents) return overrides.getJobEvents(id);
        return [];
      },
      getJobFiles: async (id: string) => {
        if (overrides.getJobFiles) return overrides.getJobFiles(id);
        return [];
      }
    };
  }

  function deskWithJobs(jobsReader?: DeskJobsReader): RebornDesk {
    const chat = new RebornChatController(() => null);
    chat.state = { ...initialChatState() };
    return new RebornDesk(chat, new OpenLoopStore(), jobsReader ?? null);
  }

  it('stays empty when there is no connected jobs client', async () => {
    const previousToken = connection.token;
    connection.token = null;
    const desk = deskWithJobs();
    try {
      await desk.loadHandled();
      expect(desk.handledCards).toEqual([]);
    } finally {
      connection.token = previousToken;
    }
  });

  it('projects recent jobs into Handled cards', async () => {
    const desk = deskWithJobs(
      readerWith({
        jobs: [
          {
            id: 'job-completed-123456',
            title: 'Draft weekly investor update',
            state: 'completed',
            user_id: 'default',
            created_at: '2026-05-31T08:00:00Z'
          },
          {
            id: 'job-running-123456',
            title: 'Research vendor renewal',
            state: 'in_progress',
            user_id: 'default',
            created_at: '2026-05-31T09:00:00Z',
            started_at: '2026-05-31T09:01:00Z'
          },
          {
            id: 'job-failed-123456',
            title: '',
            state: 'failed',
            user_id: 'default',
            created_at: '2026-05-31T10:00:00Z'
          }
        ]
      })
    );

    await desk.loadHandled();

    expect(desk.handledCards).toEqual([
      {
        id: 'job-completed-123456',
        title: 'Draft weekly investor update',
        status: 'done',
        detail: 'Completed',
        at: '2026-05-31T08:00:00Z'
      },
      {
        id: 'job-running-123456',
        title: 'Research vendor renewal',
        status: 'running',
        detail: 'Running',
        at: '2026-05-31T09:01:00Z'
      },
      {
        id: 'job-failed-123456',
        title: 'Job job-fail...',
        status: 'failed',
        detail: 'Failed',
        at: '2026-05-31T10:00:00Z'
      }
    ]);
  });

  it('degrades to empty handled cards when the jobs request fails', async () => {
    const desk = deskWithJobs(
      readerWith({
        listJobs: async () => {
          throw new Error('gateway unavailable');
        }
      })
    );

    await desk.loadHandled();

    expect(desk.handledCards).toEqual([]);
  });

  it('lazy-loads and caches a compact receipt for the expanded handled row', async () => {
    const detail: JobDetail = {
      id: 'job-completed-123456',
      title: 'Draft weekly investor update',
      description: 'Drafted the weekly investor update.',
      state: 'completed',
      user_id: 'default',
      created_at: '2026-05-31T08:00:00Z',
      completed_at: '2026-05-31T08:04:00Z',
      transitions: [],
      can_restart: true,
      can_prompt: false
    };
    const events: JobEvent[] = [
      {
        id: 'evt-1',
        event_type: 'status_change',
        data: { message: 'Started drafting.' },
        created_at: '2026-05-31T08:01:00Z'
      },
      {
        id: 'evt-2',
        event_type: 'output_text',
        data: { message: 'Wrote a concise investor update with metrics and risks.' },
        created_at: '2026-05-31T08:03:00Z'
      }
    ];
    const files: JobFile[] = [
      { name: 'update.md', path: 'update.md', is_dir: false },
      { name: 'metrics.csv', path: 'metrics.csv', is_dir: false }
    ];
    const getJob = vi.fn(async () => detail);
    const getJobEvents = vi.fn(async () => events);
    const getJobFiles = vi.fn(async () => files);
    const desk = deskWithJobs(readerWith({ getJob, getJobEvents, getJobFiles }));

    await desk.toggleHandled('job-completed-123456');
    await desk.toggleHandled('job-completed-123456');
    await desk.toggleHandled('job-completed-123456');

    expect(desk.expandedHandledId).toBe('job-completed-123456');
    expect(desk.receiptsById['job-completed-123456']).toEqual({
      state: 'completed',
      summary: 'output_text: Wrote a concise investor update with metrics and risks.',
      fileCount: 2
    });
    expect(getJob).toHaveBeenCalledTimes(1);
    expect(getJobEvents).toHaveBeenCalledTimes(1);
    expect(getJobFiles).toHaveBeenCalledTimes(1);
  });

  it('stores a no-detail receipt when receipt readers fail', async () => {
    const desk = deskWithJobs(
      readerWith({
        getJob: async () => {
          throw new Error('detail unavailable');
        },
        getJobEvents: async () => {
          throw new Error('events unavailable');
        },
        getJobFiles: async () => {
          throw new Error('files unavailable');
        }
      })
    );

    await desk.loadReceipt('job-failed-123456');

    expect(desk.receiptsById['job-failed-123456']).toEqual({
      state: 'unknown',
      summary: 'No result detail.',
      fileCount: 0
    });
  });
});
