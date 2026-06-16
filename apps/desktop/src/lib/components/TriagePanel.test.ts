// Render smoke tests for TriagePanel.svelte (R104). Drives the real triage
// singleton and stubs MarkdownView.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('$lib/components/MarkdownView.svelte', () => ({ default: () => null }));

import TriagePanel from './TriagePanel.svelte';
import { triage } from '$lib/stores/triage.svelte';

function reset(): void {
  triage.open = false;
  triage.loading = false;
  triage.error = null;
  triage.result = '';
  triage.generatedAt = null;
}

describe('TriagePanel component', () => {
  beforeEach(reset);
  afterEach(reset);

  it('renders nothing when closed', async () => {
    const { container } = render(TriagePanel, { props: { onRegenerate: vi.fn() } });
    await tick();
    expect(container.textContent ?? '').not.toContain('Decision needed');
  });

  it('shows the triaging state and bucket legend when loading', async () => {
    triage.open = true;
    triage.loading = true;
    const { container } = render(TriagePanel, { props: { onRegenerate: vi.fn() } });
    await tick();
    expect(container.textContent).toContain('Triage');
    expect(container.textContent).toContain('Triaging threads');
    // Header legend names the three buckets.
    expect(container.textContent).toContain('Decision needed');
    expect(container.textContent).toContain('Can handle');
  });

  it('surfaces an error inline', async () => {
    triage.open = true;
    triage.error = 'no model';
    const { container } = render(TriagePanel, { props: { onRegenerate: vi.fn() } });
    await tick();
    expect(container.textContent).toContain('no model');
  });

  it('Regenerate calls the handler', async () => {
    triage.open = true;
    triage.result = 'done';
    const onRegenerate = vi.fn();
    const { container } = render(TriagePanel, { props: { onRegenerate } });
    await tick();
    const regen = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Regenerate')
    );
    await act(async () => {
      await fireEvent.click(regen as HTMLButtonElement);
    });
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });
});
