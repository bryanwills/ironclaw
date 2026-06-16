// Render smoke tests for BriefingPanel.svelte (R101). Drives the real
// briefing + open-loops singletons (simple stores) and stubs the heavy
// MarkdownView. Mirrors the MiniPanel.test.ts pattern.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('$lib/components/MarkdownView.svelte', () => ({ default: () => null }));

import BriefingPanel from './BriefingPanel.svelte';
import { briefing } from '$lib/stores/briefing.svelte';
import { openLoops } from '$lib/stores/open-loops.svelte';

function reset(): void {
  briefing.open = false;
  briefing.loading = false;
  briefing.error = null;
  briefing.brief = '';
  briefing.generatedAt = null;
  openLoops.loops = [];
}

describe('BriefingPanel component', () => {
  beforeEach(reset);
  afterEach(reset);

  it('renders nothing when closed', async () => {
    const { container } = render(BriefingPanel, { props: { onRegenerate: vi.fn() } });
    await tick();
    expect(container.textContent ?? '').not.toContain('Daily brief');
  });

  it('shows the preparing state while loading with no content', async () => {
    briefing.open = true;
    briefing.loading = true;
    const { container } = render(BriefingPanel, { props: { onRegenerate: vi.fn() } });
    await tick();
    expect(container.textContent).toContain('Daily brief');
    expect(container.textContent).toContain('Preparing brief');
  });

  it('surfaces an error inline', async () => {
    briefing.open = true;
    briefing.error = 'gateway down';
    const { container } = render(BriefingPanel, { props: { onRegenerate: vi.fn() } });
    await tick();
    expect(container.textContent).toContain('gateway down');
  });

  it('Regenerate calls the handler', async () => {
    briefing.open = true;
    briefing.brief = 'done';
    const onRegenerate = vi.fn();
    const { container } = render(BriefingPanel, { props: { onRegenerate } });
    await tick();
    const regen = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Regenerate')
    );
    expect(regen).toBeTruthy();
    await act(async () => {
      await fireEvent.click(regen as HTMLButtonElement);
    });
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it('adds an open loop through the inline editor', async () => {
    briefing.open = true;
    const { container } = render(BriefingPanel, { props: { onRegenerate: vi.fn() } });
    await tick();
    const input = container.querySelector(
      'input[aria-label="Add a commitment"]'
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      await fireEvent.input(input, { target: { value: 'call the vendor' } });
    });
    const addBtn = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Add commitment'
    );
    await act(async () => {
      await fireEvent.click(addBtn as HTMLButtonElement);
    });
    expect(openLoops.activeTexts()).toContain('call the vendor');
  });
});
