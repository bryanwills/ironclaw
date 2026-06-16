// Render smoke tests for RecapPanel.svelte (R89). Drives the real recap
// singleton (a simple $state store) and asserts the three body states
// (loading / error / summary) plus the R92 stats strip. RecapPanel renders
// plain text (no MarkdownView), so no component stub is needed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

import RecapPanel from './RecapPanel.svelte';
import { recap } from '$lib/stores/recap.svelte';
import type { ThreadStats } from '$lib/util/thread-stats';

function reset(): void {
  recap.open = false;
  recap.loading = false;
  recap.error = null;
  recap.summary = '';
  recap.stats = null;
  recap.threadId = null;
}

const fullStats: ThreadStats = {
  messageCount: 5,
  byRole: { user: 2, assistant: 2, tool: 1 },
  estimatedTokens: 1234,
  totalChars: 4936,
  firstAt: '2026-05-29T10:00:00Z',
  lastAt: '2026-05-29T11:00:00Z',
  spanMs: 3_600_000 // 1h
};

describe('RecapPanel component', () => {
  beforeEach(reset);
  afterEach(reset);

  it('renders nothing when closed', async () => {
    const { container } = render(RecapPanel);
    await tick();
    expect(container.textContent ?? '').not.toContain('Thread recap');
  });

  it('shows the summarizing state while loading', async () => {
    recap.open = true;
    recap.loading = true;
    const { container } = render(RecapPanel);
    await tick();
    expect(container.textContent).toContain('Thread recap');
    expect(container.textContent).toContain('Summarizing…');
  });

  it('surfaces an error inline (not while loading)', async () => {
    recap.open = true;
    recap.loading = false;
    recap.error = 'gateway down';
    const { container } = render(RecapPanel);
    await tick();
    expect(container.textContent).toContain('gateway down');
    expect(container.textContent).not.toContain('Summarizing…');
  });

  it('renders the summary text once landed', async () => {
    recap.open = true;
    recap.summary = 'You debated the vendor contract and parked a decision.';
    const { container } = render(RecapPanel);
    await tick();
    expect(container.textContent).toContain('You debated the vendor contract');
  });

  it('shows the stats strip with counts, tokens, and span', async () => {
    recap.open = true;
    recap.summary = 'recap body';
    recap.stats = fullStats;
    const { container } = render(RecapPanel);
    await tick();
    expect(container.textContent).toContain('5 messages');
    expect(container.textContent).toContain('~1,234 tokens');
    expect(container.textContent).toContain('over 1h');
  });

  it('omits the time span when spanMs is 0', async () => {
    recap.open = true;
    recap.summary = 'recap body';
    recap.stats = { ...fullStats, spanMs: 0 };
    const { container } = render(RecapPanel);
    await tick();
    expect(container.textContent).toContain('5 messages');
    expect(container.textContent).not.toContain('over ');
  });

  it('hides the stats strip when there are no stats', async () => {
    recap.open = true;
    recap.summary = 'recap body';
    recap.stats = null;
    const { container } = render(RecapPanel);
    await tick();
    // The footer says "your messages are untouched", so assert on the
    // stats-strip-only phrasings instead of the bare word "messages".
    expect(container.textContent).not.toContain('5 messages');
    expect(container.textContent).not.toContain('tokens');
  });

  it('the close button dismisses the panel', async () => {
    recap.open = true;
    recap.summary = 'recap body';
    const { container } = render(RecapPanel);
    await tick();
    const closeBtn = container.querySelector(
      'button[aria-label="Close recap"]'
    ) as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    await act(async () => {
      await fireEvent.click(closeBtn);
    });
    expect(recap.open).toBe(false);
  });
});
