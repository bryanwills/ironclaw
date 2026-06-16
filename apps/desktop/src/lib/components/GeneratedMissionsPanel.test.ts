import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { Extension } from '$lib/api/types';

const gotoMock = vi.hoisted(() => vi.fn());
const generateFromMock = vi.hoisted(() => vi.fn(async () => undefined));
const resetMock = vi.hoisted(() => vi.fn());
const dismissMock = vi.hoisted(() => vi.fn());
const runMock = vi.hoisted(() =>
  vi.fn(async () => ({
    status: 'created',
    workItemId: 'work-1',
    title: 'Work item',
    artifactId: 'artifact-1',
    artifactTitle: 'Draft',
    draftStatus: 'planned'
  }))
);
const { connectionStub, gmState } = vi.hoisted(() => ({
  connectionStub: {
    client: null as null | {
      listExtensions: () => Promise<Extension[]>;
    }
  },
  gmState: {
    status: 'idle',
    missions: [] as Array<{
      id: string;
      title: string;
      why: string;
      mode: 'approval' | 'dry-run';
      deliverable: string;
    }>,
    error: null as string | null
  }
}));

vi.mock('$app/navigation', () => ({ goto: gotoMock }));

vi.mock('$lib/stores/connection.svelte', () => ({
  connection: connectionStub
}));

vi.mock('$lib/stores/generated-missions.svelte', () => ({
  generatedMissions: {
    get status() {
      return gmState.status;
    },
    get missions() {
      return gmState.missions;
    },
    get error() {
      return gmState.error;
    },
    get available() {
      return connectionStub.client !== null;
    },
    generateFrom: generateFromMock,
    reset: resetMock,
    dismiss: dismissMock,
    run: runMock
  }
}));

import GeneratedMissionsPanel from './GeneratedMissionsPanel.svelte';

function installClient(extensions: Extension[]): void {
  connectionStub.client = {
    listExtensions: vi.fn(async () => extensions)
  };
}

describe('GeneratedMissionsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gmState.status = 'idle';
    gmState.missions = [];
    gmState.error = null;
  });

  afterEach(() => {
    connectionStub.client = null;
  });

  it('can generate from connected workspace sources without pasted text', async () => {
    installClient([
      { name: 'gmail', installed: true, ready: true, readiness_message: 'ready' },
      { name: 'google_calendar', installed: true, ready: true, readiness_message: 'ready' }
    ]);

    render(GeneratedMissionsPanel);

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Google Workspace' })).toBeTruthy();
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Generate from Desk context' }));

    expect(generateFromMock).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'activity',
        label: 'Connected source: Google Workspace',
        body: expect.stringContaining('Gmail')
      })
    ]);
  });

  it('falls back to pasted context when no connected source is selected', async () => {
    installClient([]);

    render(GeneratedMissionsPanel);
    const textarea = screen.getByLabelText('Context for the agent to propose actions from');
    await fireEvent.input(textarea, { target: { value: 'Vendor sent a new MSA.' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Generate actions' }));

    expect(generateFromMock).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'note',
        label: 'Pasted into the Desk',
        body: 'Vendor sent a new MSA.'
      })
    ]);
  });

  it('creates generated actions in Work instead of navigating to chat', async () => {
    installClient([]);
    gmState.status = 'ready';
    gmState.missions = [
      {
        id: 'm1',
        title: 'Prepare the client follow-up',
        why: 'A call note needs follow-through.',
        mode: 'approval',
        deliverable: 'Follow-up draft'
      }
    ];

    render(GeneratedMissionsPanel);
    await fireEvent.click(screen.getByRole('button', { name: 'Create in Work' }));

    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
    await waitFor(() => {
      expect(gotoMock).toHaveBeenCalledWith('/work?item=work-1&artifact=artifact-1');
    });
    expect(gotoMock).not.toHaveBeenCalledWith('/chat');
  });
});
