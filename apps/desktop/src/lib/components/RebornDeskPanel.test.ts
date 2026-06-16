// Render smoke tests for the Desk panel's "Needs you" gate inbox. A Desk built
// on a seeded, null-client controller is injected; we assert the calm caught-up
// state, the gate card render, and that Approve/Deny route through to the
// controller's resolveGate.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';

import RebornDeskPanel from './RebornDeskPanel.svelte';
import { RebornChatController } from '$lib/stores/reborn-chat.svelte';
import { RebornDesk } from '$lib/stores/reborn-desk.svelte';
import { OpenLoopStore } from '$lib/stores/open-loops.svelte';
import { initialChatState, type RebornGate } from '$lib/api/reborn';
import type { Job, JobDetail, JobEvent, JobFile } from '$lib/api/types';
import type { DeskJobsReader } from '$lib/stores/reborn-desk.svelte';

function deskWith(
  gate: RebornGate | null,
  jobsReader?: DeskJobsReader
): {
  desk: RebornDesk;
  chat: RebornChatController;
  loops: OpenLoopStore;
} {
  const chat = new RebornChatController(() => null);
  chat.state = { ...initialChatState(), pendingGate: gate };
  const loops = new OpenLoopStore();
  return { desk: new RebornDesk(chat, loops, jobsReader ?? null), chat, loops };
}

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

describe('RebornDeskPanel', () => {
  it('shows the calm "all caught up" state when nothing is pending', () => {
    const { desk } = deskWith(null);
    const { getByTestId, getByText } = render(RebornDeskPanel, { props: { desk } });
    expect(getByTestId('desk-caught-up')).toBeTruthy();
    expect(getByText("You're all caught up")).toBeTruthy();
    // The home surface offers the primary next action rather than dead-ending.
    const startLink = getByText('Start a conversation →');
    expect(startLink.getAttribute('href')).toBe('/chat');
  });

  it('renders a Needs-you card for a pending gate', () => {
    const { desk } = deskWith({
      kind: 'gate',
      runId: 'r1',
      gateRef: 'g1',
      headline: 'Send the Q3 deck to Priya?',
      body: ''
    });
    const { getByText } = render(RebornDeskPanel, { props: { desk } });
    expect(getByText('Send the Q3 deck to Priya?')).toBeTruthy();
    expect(getByText('Approve')).toBeTruthy();
    expect(getByText('Deny')).toBeTruthy();
  });

  it('routes Approve and Deny to the controller resolveGate', async () => {
    const { desk, chat } = deskWith({ kind: 'gate', runId: 'r1', gateRef: 'g1', headline: 'OK?' });
    const resolve = vi.spyOn(chat, 'resolveGate').mockResolvedValue(undefined);
    const { getByText } = render(RebornDeskPanel, { props: { desk } });
    await fireEvent.click(getByText('Approve'));
    expect(resolve).toHaveBeenCalledWith('approved');
    await fireEvent.click(getByText('Deny'));
    expect(resolve).toHaveBeenCalledWith('denied');
  });

  it('renders open-loop cards and routes Done / Dismiss', async () => {
    const { desk, loops } = deskWith(null);
    const a = loops.add('Send the deck to Priya');
    // mockImplementation so the spies don't call through and mutate the store
    // (which would remove the card before we click the second button).
    const done = vi.spyOn(desk, 'resolveLoop').mockImplementation(() => {});
    const dismiss = vi.spyOn(desk, 'dismissLoop').mockImplementation(() => {});
    const { getByText } = render(RebornDeskPanel, { props: { desk } });
    expect(getByText('Send the deck to Priya')).toBeTruthy();
    await fireEvent.click(getByText('Done'));
    expect(done).toHaveBeenCalledWith(a!.id);
    await fireEvent.click(getByText('Dismiss'));
    expect(dismiss).toHaveBeenCalledWith(a!.id);
  });

  it('captures a new open loop via the quick-add input', async () => {
    const { desk } = deskWith(null);
    const add = vi.spyOn(desk, 'addLoop').mockImplementation(() => {});
    const { getByLabelText, getByText } = render(RebornDeskPanel, { props: { desk } });
    await fireEvent.input(getByLabelText('Track a commitment'), {
      target: { value: 'Ship the deck' }
    });
    await fireEvent.click(getByText('Add'));
    expect(add).toHaveBeenCalledWith('Ship the deck');
  });

  it('shows an honest empty state when there are no handled jobs', () => {
    const { desk } = deskWith(null, readerWith({ jobs: [] }));
    const { getByTestId, getByText } = render(RebornDeskPanel, { props: { desk } });
    expect(getByTestId('desk-handled-empty')).toBeTruthy();
    expect(getByText('Nothing handled yet')).toBeTruthy();
    expect(getByText('Run a mission and results land here.')).toBeTruthy();
  });

  it('renders populated Handled rows with status pills', async () => {
    const { desk } = deskWith(
      null,
      readerWith({
        jobs: [
          {
            id: 'job-1',
            title: 'Draft weekly investor update',
            state: 'completed',
            user_id: 'default',
            created_at: '2026-05-31T08:00:00Z'
          },
          {
            id: 'job-2',
            title: 'Research vendor renewal',
            state: 'in_progress',
            user_id: 'default',
            created_at: '2026-05-31T09:00:00Z'
          }
        ]
      })
    );
    const { findByText, getByText } = render(RebornDeskPanel, { props: { desk } });

    expect(await findByText('Draft weekly investor update')).toBeTruthy();
    expect(getByText('Research vendor renewal')).toBeTruthy();
    expect(getByText('done')).toBeTruthy();
    expect(getByText('running')).toBeTruthy();
  });

  it('expands a Handled row and shows a compact result receipt', async () => {
    const detail: JobDetail = {
      id: 'job-1',
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
        event_type: 'output_text',
        data: { message: 'Wrote a concise investor update with metrics and risks.' },
        created_at: '2026-05-31T08:03:00Z'
      }
    ];
    const files: JobFile[] = [
      { name: 'update.md', path: 'update.md', is_dir: false },
      { name: 'metrics.csv', path: 'metrics.csv', is_dir: false }
    ];
    const { desk } = deskWith(
      null,
      readerWith({
        jobs: [
          {
            id: 'job-1',
            title: 'Draft weekly investor update',
            state: 'completed',
            user_id: 'default',
            created_at: '2026-05-31T08:00:00Z'
          }
        ],
        getJob: async () => detail,
        getJobEvents: async () => events,
        getJobFiles: async () => files
      })
    );
    const { findByRole, findByText, getByText } = render(RebornDeskPanel, { props: { desk } });
    const row = await findByRole('button', { name: /Draft weekly investor update/ });

    await fireEvent.click(row);

    expect(
      await findByText('output_text: Wrote a concise investor update with metrics and risks.')
    ).toBeTruthy();
    expect(getByText('2 files')).toBeTruthy();
    const link = getByText('View full job →');
    expect(link.getAttribute('href')).toBe('/jobs?open=job-1');
  });

  it('shows an honest no-detail receipt when receipt loading fails', async () => {
    const { desk } = deskWith(
      null,
      readerWith({
        jobs: [
          {
            id: 'job-failed',
            title: 'Attempt vendor renewal research',
            state: 'failed',
            user_id: 'default',
            created_at: '2026-05-31T09:00:00Z'
          }
        ],
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
    const { findByRole, findByText } = render(RebornDeskPanel, { props: { desk } });
    const row = await findByRole('button', { name: /Attempt vendor renewal research/ });

    await fireEvent.click(row);

    expect(await findByText('No result detail.')).toBeTruthy();
  });
});
