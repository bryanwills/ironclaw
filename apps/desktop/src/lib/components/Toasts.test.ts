// Tests for the Toasts.svelte renderer + the shared `toasts` store.
//
// The store is the source of truth (`toasts.show(...)` enqueues, the
// component renders the array). We assert:
//
//   - A queued toast lands in the DOM.
//   - Auto-dismiss fires after AUTO_DISMISS_MS (3500ms) — exercised via
//     `vi.useFakeTimers()` so we don't slow tests down.
//   - Clicking the per-toast dismiss button removes it.
//   - Multiple toasts render in newest-on-top order (component slices
//     the queue reversed).
//   - Each `kind` lands a class hinting at its variant (success →
//     positive, error → danger, info → gold).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';

import Toasts from './Toasts.svelte';
import { toasts } from '$lib/stores/toasts.svelte';

describe('Toasts component', () => {
  beforeEach(() => {
    toasts.clear();
  });

  afterEach(() => {
    toasts.clear();
    vi.useRealTimers();
  });

  it('renders a toast in the DOM after toasts.show()', async () => {
    const { container } = render(Toasts);
    await act(() => {
      toasts.show('hello world', 'info');
    });
    expect(container.textContent).toContain('hello world');
  });

  it('auto-dismisses after 3500ms', async () => {
    vi.useFakeTimers();
    const { container } = render(Toasts);
    await act(() => {
      toasts.show('ephemeral', 'info');
    });
    expect(container.textContent).toContain('ephemeral');
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    expect(container.textContent).not.toContain('ephemeral');
  });

  it('manual dismiss via dismiss button removes the toast', async () => {
    const { container } = render(Toasts);
    await act(() => {
      toasts.show('click me away', 'success');
    });
    const dismissBtn = container.querySelector('button[aria-label="Dismiss"]');
    expect(dismissBtn).not.toBeNull();
    await fireEvent.click(dismissBtn as HTMLButtonElement);
    expect(container.textContent).not.toContain('click me away');
  });

  it('stacks multiple toasts newest-on-top', async () => {
    const { container } = render(Toasts);
    await act(() => {
      toasts.show('first', 'info');
      toasts.show('second', 'info');
      toasts.show('third', 'info');
    });
    // The container iterates `toasts.toasts.slice().reverse()` — so the
    // newest message renders before older ones in document order.
    const rendered = Array.from(container.querySelectorAll('[role="status"]')).map(
      (el) => el.textContent?.trim() ?? ''
    );
    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toContain('third');
    expect(rendered[2]).toContain('first');
  });

  it('applies kind-specific border / text classes (info / success / error)', async () => {
    const { container } = render(Toasts);
    await act(() => {
      toasts.show('an info', 'info');
      toasts.show('a success', 'success');
      toasts.show('an error', 'error');
    });
    // Find each by its textContent.
    const cards = Array.from(container.querySelectorAll('[role="status"]')) as HTMLElement[];
    const byText = (s: string) => cards.find((c) => (c.textContent ?? '').includes(s));
    const infoEl = byText('an info');
    const successEl = byText('a success');
    const errorEl = byText('an error');
    expect(infoEl?.className ?? '').toContain('accent-gold');
    expect(successEl?.className ?? '').toContain('positive');
    expect(errorEl?.className ?? '').toContain('danger');
  });
});
