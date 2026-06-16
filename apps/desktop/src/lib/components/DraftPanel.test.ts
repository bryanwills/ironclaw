// Render smoke tests for DraftPanel.svelte (R105). Drives the real draft
// singleton and stubs MarkdownView. Copy (clipboard) is not exercised here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('$lib/components/MarkdownView.svelte', () => ({ default: () => null }));

import DraftPanel from './DraftPanel.svelte';
import { draft } from '$lib/stores/draft.svelte';

function reset(): void {
  draft.open = false;
  draft.loading = false;
  draft.error = null;
  draft.draft = '';
  draft.generatedAt = null;
  draft.instruction = '';
  draft.threadLabel = null;
}

describe('DraftPanel component', () => {
  beforeEach(reset);
  afterEach(reset);

  it('renders nothing when closed', async () => {
    const { container } = render(DraftPanel, { props: { onRegenerate: vi.fn() } });
    await tick();
    expect(container.textContent ?? '').not.toContain('Drafted in your voice');
  });

  it('shows the writing state and thread label when loading', async () => {
    draft.open = true;
    draft.loading = true;
    draft.threadLabel = 'Vendor contract';
    const { container } = render(DraftPanel, { props: { onRegenerate: vi.fn() } });
    await tick();
    expect(container.textContent).toContain('Draft');
    expect(container.textContent).toContain('Writing draft');
    expect(container.textContent).toContain('Vendor contract');
  });

  it('Copy is disabled until there is a draft', async () => {
    draft.open = true;
    const { container } = render(DraftPanel, { props: { onRegenerate: vi.fn() } });
    await tick();
    const copy = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Copy')
    ) as HTMLButtonElement | undefined;
    expect(copy).toBeTruthy();
    expect(copy!.disabled).toBe(true);
  });

  it('binds the instruction input to the store and rerun-on-Enter calls handler', async () => {
    draft.open = true;
    const onRegenerate = vi.fn();
    const { container } = render(DraftPanel, { props: { onRegenerate } });
    await tick();
    const input = container.querySelector(
      'input[aria-label="Draft instruction"]'
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      await fireEvent.input(input, { target: { value: 'reply proposing Friday' } });
    });
    expect(draft.instruction).toBe('reply proposing Friday');
    await act(async () => {
      await fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });
});
