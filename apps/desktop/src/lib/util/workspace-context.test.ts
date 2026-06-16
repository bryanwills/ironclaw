import { describe, expect, it } from 'vitest';
import {
  connectedWorkspaceSources,
  workspaceContextItems,
  workspaceContextSources
} from './workspace-context';
import type { Extension } from '$lib/api/types';

const READY_GOOGLE: Extension[] = [
  { name: 'gmail', installed: true, ready: true, readiness_message: 'ready' },
  { name: 'google_calendar', installed: true, ready: true, readiness_message: 'ready' },
  { name: 'google_docs', installed: true, ready: false, readiness_message: 'needs_setup' }
];

describe('workspaceContextSources', () => {
  it('marks Google connected when core Gmail and Calendar are ready', () => {
    const sources = workspaceContextSources(READY_GOOGLE);
    expect(sources.find((source) => source.id === 'google')?.status).toBe('connected');
    expect(sources.find((source) => source.id === 'slack')?.status).toBe('not-installed');
  });

  it('builds honest read-only context requests for selected connected sources', () => {
    const connected = connectedWorkspaceSources(READY_GOOGLE, ['google']);
    const items = workspaceContextItems(connected);
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'activity',
        label: 'Connected source: Google Workspace',
        body: expect.stringContaining('Read-only collection request')
      })
    ]);
    expect(items[0].body).toContain('Gmail');
    expect(items[0].body).toContain('Do not send');
  });
});
