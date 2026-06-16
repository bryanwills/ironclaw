// Tests for the dashboard Tile base component (R77 / R78).
//
// Three load-bearing behaviors:
//   1. Renders a title (custom override OR the kind's default label).
//   2. Drag handle is `draggable="true"` and forwards the dragstart
//      event to `onDragStart(id)`.
//   3. ⋮ menu opens on click and the Remove item fires `onRemove(id)`.
//
// We don't assert on the actual reorder semantics here — TileGrid owns
// that bookkeeping. This file is the component-level smoke check.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

import Tile from './Tile.svelte';
import type { TileConfig } from '$lib/stores/dashboard.svelte';

const baseTile: TileConfig = {
  id: 'recent-threads',
  kind: 'recent-threads',
  span: 2
};

describe('Tile component', () => {
  it('renders the kind default title when no override is supplied', () => {
    const { container } = render(Tile, {
      props: { tile: baseTile }
    });
    const h2 = container.querySelector('[data-testid="tile-title"]');
    expect(h2).not.toBeNull();
    expect(h2?.textContent).toContain('Recent threads');
  });

  it('renders a custom title override when provided', () => {
    const { container } = render(Tile, {
      props: { tile: { ...baseTile, title: 'My pinned threads' } }
    });
    const h2 = container.querySelector('[data-testid="tile-title"]');
    expect(h2?.textContent).toContain('My pinned threads');
  });

  it('fires onDragStart(event, id) when the drag handle is grabbed', async () => {
    const onDragStart = vi.fn();
    const { container } = render(Tile, {
      props: { tile: baseTile, onDragStart }
    });
    const handle = container.querySelector(
      '[data-testid="tile-drag-handle"]'
    ) as HTMLElement | null;
    expect(handle).not.toBeNull();
    expect(handle?.getAttribute('draggable')).toBe('true');

    // jsdom doesn't synthesize a real DataTransfer, so the dragstart
    // event we fire has a null `dataTransfer`. The component must
    // tolerate that path (it null-checks before mutating) — assert
    // both that the handler ran AND that no exception escaped.
    await fireEvent.dragStart(handle as HTMLElement);
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragStart.mock.calls[0][1]).toBe('recent-threads');
  });

  it('opens the ⋮ menu on click and fires onRemove(id) from the Remove item', async () => {
    const onRemove = vi.fn();
    const { container } = render(Tile, {
      props: { tile: baseTile, onRemove }
    });

    // Menu is closed by default — Remove item shouldn't be in the DOM.
    expect(container.querySelector('[data-testid="tile-remove"]')).toBeNull();

    const toggle = container.querySelector('[data-testid="tile-menu-toggle"]') as HTMLButtonElement;
    await fireEvent.click(toggle);
    await tick();

    const removeBtn = container.querySelector(
      '[data-testid="tile-remove"]'
    ) as HTMLButtonElement | null;
    expect(removeBtn).not.toBeNull();

    await fireEvent.click(removeBtn as HTMLButtonElement);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith('recent-threads');
  });
});
