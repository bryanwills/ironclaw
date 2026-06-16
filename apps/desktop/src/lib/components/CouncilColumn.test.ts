// Render smoke tests for CouncilColumn.svelte (R40). A pure props-driven
// presentational column — one per provider in the Council grid. Drives it
// with hand-built CouncilRun fixtures across all four lifecycle states and
// asserts the status pip, body, latency footer, and promote-button gating.
// MarkdownView is stubbed (the content branch only needs to be reachable;
// the promote gate is what we assert there).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('$lib/components/MarkdownView.svelte', () => ({ default: () => null }));

import CouncilColumn from './CouncilColumn.svelte';
import type { CouncilRun } from '$lib/stores/council.svelte';

function makeRun(over: Partial<CouncilRun> = {}): CouncilRun {
  return {
    providerId: 'openai',
    prompt: 'hi',
    content: '',
    latencyMs: null,
    status: 'pending',
    ...over
  };
}

function renderColumn(run: CouncilRun, onPromote = vi.fn()) {
  return render(CouncilColumn, {
    props: { run, providerName: 'OpenAI GPT-4', accentClass: 'text-accent-cyan', onPromote }
  });
}

const promoteButton = (c: HTMLElement) =>
  [...c.querySelectorAll('button')].find((b) => b.textContent?.includes('Promote')) as
    | HTMLButtonElement
    | undefined;

describe('CouncilColumn component', () => {
  afterEach(() => vi.clearAllMocks());

  it('renders the provider name in the header chip', async () => {
    const { container } = renderColumn(makeRun());
    await tick();
    expect(container.textContent).toContain('OpenAI GPT-4');
  });

  it('pending: spinner + waiting pip, promote disabled', async () => {
    const { container } = renderColumn(makeRun({ status: 'pending' }));
    await tick();
    expect(container.textContent).toContain('Waiting for OpenAI GPT-4');
    expect(container.textContent).toContain('waiting');
    expect(promoteButton(container)?.disabled).toBe(true);
  });

  it('streaming with no content yet: shows the first-tokens placeholder and live footer', async () => {
    const { container } = renderColumn(makeRun({ status: 'streaming', content: '' }));
    await tick();
    expect(container.textContent).toContain('Receiving first tokens…');
    expect(container.textContent).toContain('live');
    expect(container.textContent).toContain('Streaming…');
  });

  it('error: surfaces the error message + error pip, promote disabled', async () => {
    const { container } = renderColumn(makeRun({ status: 'error', error: 'provider exploded' }));
    await tick();
    expect(container.textContent).toContain('provider exploded');
    expect(container.textContent).toContain('error');
    expect(promoteButton(container)?.disabled).toBe(true);
  });

  it('error with no message falls back to "Unknown error"', async () => {
    const { container } = renderColumn(makeRun({ status: 'error' }));
    await tick();
    expect(container.textContent).toContain('Unknown error');
  });

  it('done but empty: shows the empty-response placeholder, promote disabled', async () => {
    const { container } = renderColumn(makeRun({ status: 'done', content: '   ' }));
    await tick();
    expect(container.textContent).toContain('(empty response)');
    expect(promoteButton(container)?.disabled).toBe(true);
  });

  it('done with content: promote enabled and fires the callback', async () => {
    const onPromote = vi.fn();
    const { container } = renderColumn(
      makeRun({ status: 'done', content: 'a real answer', latencyMs: 850 }),
      onPromote
    );
    await tick();
    const btn = promoteButton(container);
    expect(btn?.disabled).toBe(false);
    expect(container.textContent).toContain('Took 850 ms');
    await act(async () => {
      await fireEvent.click(btn as HTMLButtonElement);
    });
    expect(onPromote).toHaveBeenCalledTimes(1);
  });

  it('formats sub-second vs multi-second latency', async () => {
    const sub = renderColumn(makeRun({ status: 'done', content: 'x', latencyMs: 850 }));
    await tick();
    expect(sub.container.textContent).toContain('Took 850 ms');

    const multi = renderColumn(makeRun({ status: 'done', content: 'x', latencyMs: 2500 }));
    await tick();
    expect(multi.container.textContent).toContain('Took 2.5s');
  });
});
