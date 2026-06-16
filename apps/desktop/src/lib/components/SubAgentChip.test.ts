// Render smoke tests for SubAgentChip.svelte (R57 — dispatched background
// task chip). Props-driven (one SubAgentTask); reads subAgents.progressFor
// and calls subAgents.cancel. We import the real subAgents singleton and spy
// its methods (importing a sibling store is fine; only vi.mock-ing one breaks
// the rune transform).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

import SubAgentChip from './SubAgentChip.svelte';
import { subAgents } from '$lib/stores/sub-agents.svelte';
import type { SubAgentTask } from '$lib/api/types';

function makeTask(over: Partial<SubAgentTask> = {}): SubAgentTask {
  return { id: 't1', status: 'running', prompt: 'do the thing', ...over } as SubAgentTask;
}

const cancelBtn = (c: HTMLElement) =>
  c.querySelector('button[aria-label="Cancel sub-agent task"]') as HTMLButtonElement | null;

beforeEach(() => {
  // progressFor returns a string ('' = no progress yet); empty is falsy so
  // the running-progress block stays hidden by default.
  vi.spyOn(subAgents, 'progressFor').mockReturnValue('');
  vi.spyOn(subAgents, 'cancel').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('SubAgentChip component', () => {
  it('renders the running state with a cancel affordance', async () => {
    const { container } = render(SubAgentChip, {
      props: { task: makeTask({ status: 'running' }) }
    });
    await tick();
    expect(container.textContent).toContain('Sub-agent');
    expect(container.textContent).toContain('working');
    expect(container.textContent).toContain('do the thing');
    expect(cancelBtn(container)).toBeTruthy();
  });

  it('shows the cancel affordance while queued too', async () => {
    const { container } = render(SubAgentChip, { props: { task: makeTask({ status: 'queued' }) } });
    await tick();
    expect(container.textContent).toContain('queued');
    expect(cancelBtn(container)).toBeTruthy();
  });

  it('clicking cancel calls subAgents.cancel with the task id', async () => {
    const { container } = render(SubAgentChip, {
      props: { task: makeTask({ id: 'abc', status: 'running' }) }
    });
    await tick();
    await act(async () => {
      await fireEvent.click(cancelBtn(container) as HTMLButtonElement);
    });
    expect(subAgents.cancel).toHaveBeenCalledWith('abc');
  });

  it('renders streamed progress while running', async () => {
    vi.mocked(subAgents.progressFor).mockReturnValue('thinking about it…');
    const { container } = render(SubAgentChip, {
      props: { task: makeTask({ status: 'running' }) }
    });
    await tick();
    expect(container.textContent).toContain('thinking about it…');
  });

  it('succeeded: no cancel, and "View result" toggles the result body', async () => {
    const { container } = render(SubAgentChip, {
      props: { task: makeTask({ status: 'succeeded', result: 'the answer' }) }
    });
    await tick();
    expect(container.textContent).toContain('done');
    expect(cancelBtn(container)).toBeNull();

    const toggle = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('View result')
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(container.textContent).not.toContain('the answer');
    await act(async () => {
      await fireEvent.click(toggle);
    });
    expect(container.textContent).toContain('the answer');
    expect(container.textContent).toContain('Hide result');
  });

  it('failed: shows the error and no cancel', async () => {
    const { container } = render(SubAgentChip, {
      props: { task: makeTask({ status: 'failed', error: 'boom' }) }
    });
    await tick();
    expect(container.textContent).toContain('failed');
    expect(container.textContent).toContain('boom');
    expect(cancelBtn(container)).toBeNull();
  });
});
