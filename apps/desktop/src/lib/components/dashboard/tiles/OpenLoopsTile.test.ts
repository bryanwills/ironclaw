// Render tests for OpenLoopsTile — the dashboard commitment tracker (R103).
// The tile reads the openLoops store synchronously; we reset + seed its `loops`
// $state directly for determinism. $app/navigation is mocked because the
// "Brief me" button calls goto.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

import OpenLoopsTile from './OpenLoopsTile.svelte';
import { openLoops, type OpenLoop } from '$lib/stores/open-loops.svelte';

function loop(id: string, text: string, done = false): OpenLoop {
  return { id, text, done, createdAt: 0 };
}

beforeEach(() => {
  openLoops.loops = [];
});

describe('OpenLoopsTile', () => {
  it('shows the empty state and the add affordance when there are no active loops', () => {
    const { getByText, getByLabelText, queryByTestId } = render(OpenLoopsTile);
    expect(getByText(/No open loops/)).toBeTruthy();
    expect(getByLabelText('Add a commitment')).toBeTruthy();
    expect(queryByTestId('open-loops-list')).toBeNull();
  });

  it('lists active loops and excludes done ones', () => {
    openLoops.loops = [
      loop('a', 'Send the budget'),
      loop('b', 'Follow up with design', true),
      loop('c', 'Book the venue')
    ];
    const { getByText, queryByText, getByTestId } = render(OpenLoopsTile);
    expect(getByTestId('open-loops-list')).toBeTruthy();
    expect(getByText('Send the budget')).toBeTruthy();
    expect(getByText('Book the venue')).toBeTruthy();
    expect(queryByText('Follow up with design')).toBeNull(); // done → excluded
  });

  it('renders complete + remove controls for each active loop', () => {
    openLoops.loops = [loop('a', 'Send the budget')];
    const { getByLabelText } = render(OpenLoopsTile);
    expect(getByLabelText('Complete: Send the budget')).toBeTruthy();
    expect(getByLabelText('Remove: Send the budget')).toBeTruthy();
  });
});
