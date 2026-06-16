// Render smoke tests for ToolFlowPanel.svelte (R42 — tool-call visualizer).
// Pure renderer over toolFlow.forThread(threadId). We spy that method to
// feed ToolCall fixtures (importing a sibling store is fine; never vi.mock
// the .svelte.ts under test).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

import ToolFlowPanel from './ToolFlowPanel.svelte';
import { toolFlow, type ToolCall } from '$lib/stores/tool-flow.svelte';

function call(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'c1',
    name: 'search_web',
    status: 'pending',
    startedAt: 1000,
    args: { q: 'hi' },
    ...over
  } as ToolCall;
}

function setCalls(calls: ToolCall[]): void {
  vi.mocked(toolFlow.forThread).mockReturnValue(calls);
}

beforeEach(() => {
  vi.spyOn(toolFlow, 'forThread').mockReturnValue([]);
});

afterEach(() => vi.restoreAllMocks());

describe('ToolFlowPanel component', () => {
  it('shows the empty state when no tools were called', async () => {
    setCalls([]);
    const { container } = render(ToolFlowPanel, { props: { threadId: 't1' } });
    await tick();
    expect(container.textContent).toContain('No tool calls yet');
    expect(container.querySelector('[aria-label$="in this turn"]')).toBeNull();
  });

  it('renders a count badge + a row per call', async () => {
    setCalls([call({ id: 'a', name: 'alpha' }), call({ id: 'b', name: 'beta' })]);
    const { container } = render(ToolFlowPanel, { props: { threadId: 't1' } });
    await tick();
    expect(container.querySelector('[aria-label="2 tool calls in this turn"]')).toBeTruthy();
    expect(container.textContent).toContain('alpha');
    expect(container.textContent).toContain('beta');
  });

  it('a pending call shows the in-progress label and "…" latency', async () => {
    setCalls([call({ status: 'pending' })]);
    const { container } = render(ToolFlowPanel, { props: { threadId: 't1' } });
    await tick();
    expect(container.querySelector('button[aria-label="search_web in progress"]')).toBeTruthy();
    expect(container.textContent).toContain('…');
  });

  it('formats sub-second vs multi-second latency for done calls', async () => {
    setCalls([call({ status: 'done', startedAt: 1000, completedAt: 1023, result: 'ok' })]);
    const sub = render(ToolFlowPanel, { props: { threadId: 't1' } });
    await tick();
    expect(sub.container.textContent).toContain('23ms');

    setCalls([call({ status: 'done', startedAt: 0, completedAt: 1500, result: 'ok' })]);
    const multi = render(ToolFlowPanel, { props: { threadId: 't2' } });
    await tick();
    expect(multi.container.textContent).toContain('1.5s');
  });

  it('expanding a done call reveals Args + Result', async () => {
    setCalls([
      call({ status: 'done', completedAt: 1100, args: { q: 'hi' }, result: 'the answer' })
    ]);
    const { container } = render(ToolFlowPanel, { props: { threadId: 't1' } });
    await tick();
    expect(container.textContent).not.toContain('the answer');
    await act(async () => {
      await fireEvent.click(container.querySelector('button[aria-expanded]')!);
    });
    expect(container.textContent).toContain('Args');
    expect(container.textContent).toContain('Result');
    expect(container.textContent).toContain('the answer');
  });

  it('expanding a pending call shows "Running…"', async () => {
    setCalls([call({ status: 'pending' })]);
    const { container } = render(ToolFlowPanel, { props: { threadId: 't1' } });
    await tick();
    await act(async () => {
      await fireEvent.click(container.querySelector('button[aria-expanded]')!);
    });
    expect(container.textContent).toContain('Running…');
  });

  it('expanding an error call shows the error message', async () => {
    setCalls([call({ status: 'error', completedAt: 1100, error: 'tool blew up' })]);
    const { container } = render(ToolFlowPanel, { props: { threadId: 't1' } });
    await tick();
    await act(async () => {
      await fireEvent.click(container.querySelector('button[aria-expanded]')!);
    });
    expect(container.textContent).toContain('Error');
    expect(container.textContent).toContain('tool blew up');
  });
});
