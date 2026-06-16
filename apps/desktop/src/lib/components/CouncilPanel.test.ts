// Render smoke tests for CouncilPanel.svelte (R40 / R91 — Council fanout
// summoned from the chat composer). A self-gating overlay (renders nothing
// unless council.open), modelled on RecapPanel. Drives the real council
// singleton; connection.client is null in the test env (no token), so the
// on-open catalog load takes the not-connected branch — these assertions
// hold regardless of catalog state.
//
// The panel lazy-loads CouncilColumn via a dynamic import on open; we stub
// it so the test doesn't pull MarkdownView/highlight.js. It only renders
// when runs.length > 0 (never here), but the import still fires.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('./CouncilColumn.svelte', () => ({ default: () => null }));

import CouncilPanel from './CouncilPanel.svelte';
import { council } from '$lib/stores/council.svelte';

function reset(): void {
  // vitest.setup.ts clears localStorage before each test, so resetting the
  // in-memory selection here is enough — on-open hydrate() finds nothing and
  // leaves selectedProviderIds empty (Convene stays disabled).
  council.open = false;
  council.runs = [];
  council.convening = false;
  council.initialPrompt = '';
  council.selectedProviderIds = [];
}

function conveneButton(c: HTMLElement): HTMLButtonElement | undefined {
  return [...c.querySelectorAll('button')].find((b) =>
    b.textContent?.trim().startsWith('Convene')
  ) as HTMLButtonElement | undefined;
}

describe('CouncilPanel component', () => {
  beforeEach(reset);
  afterEach(reset);

  it('renders nothing when closed', async () => {
    const { container } = render(CouncilPanel);
    await tick();
    expect(container.textContent ?? '').not.toContain('Council');
  });

  it('open: shows the header, model-count hint, and prompt textarea', async () => {
    council.open = true;
    const { container } = render(CouncilPanel);
    await tick();
    expect(container.textContent).toContain('Council');
    expect(container.textContent).toContain('models at once');
    expect(container.querySelector('textarea[placeholder="Ask the council…"]')).toBeTruthy();
  });

  it('seeds the prompt textarea from council.initialPrompt on open', async () => {
    council.open = true;
    council.initialPrompt = 'compare these two designs';
    const { container } = render(CouncilPanel);
    await tick();
    await tick();
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('compare these two designs');
  });

  it('Convene is disabled with no prompt and no providers selected', async () => {
    council.open = true;
    const { container } = render(CouncilPanel);
    await tick();
    expect(conveneButton(container)?.disabled).toBe(true);
  });

  it('the close button dismisses the panel', async () => {
    council.open = true;
    const { container } = render(CouncilPanel);
    await tick();
    const closeBtn = container.querySelector(
      'button[aria-label="Close council"]'
    ) as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    await act(async () => {
      await fireEvent.click(closeBtn);
    });
    expect(council.open).toBe(false);
  });
});
