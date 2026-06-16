// Render + behavior tests for ResizeHandle.svelte (R14c — drag-to-resize
// splitter). A pure, store-free component: props in, `onresize` out,
// localStorage for persistence, document-level mouse listeners for the drag.
// We drive it entirely through props + DOM events (no mocks needed beyond a
// vi.fn() callback). Every drag ends with a mouseup so the document
// listeners don't leak into later cases.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

import ResizeHandle from './ResizeHandle.svelte';

const baseProps = {
  min: 100,
  max: 400,
  defaultWidth: 300,
  storageKey: 'test-resize',
  onresize: () => {}
};

const handleOf = (c: HTMLElement) => c.querySelector('[role="separator"]') as HTMLElement;

// The test runtime's global `localStorage` is the node experimental one
// (no functional getItem/setItem); the component swallows that via
// try/catch, but the assertions need a real store, so install a
// Map-backed shim per test.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ResizeHandle component', () => {
  it('renders a separator with the ARIA splitter attributes', async () => {
    const { container } = render(ResizeHandle, {
      props: { ...baseProps, initialWidth: 280, onresize: vi.fn() }
    });
    await tick();
    const h = handleOf(container);
    expect(h).toBeTruthy();
    expect(h.getAttribute('aria-orientation')).toBe('vertical');
    expect(h.getAttribute('aria-label')).toBe('Resize pane');
    expect(h.getAttribute('aria-valuemin')).toBe('100');
    expect(h.getAttribute('aria-valuemax')).toBe('400');
    expect(h.getAttribute('aria-valuenow')).toBe('280');
  });

  it('reports the default width upstream on mount when nothing is stored', async () => {
    const onresize = vi.fn();
    render(ResizeHandle, { props: { ...baseProps, onresize } });
    await tick();
    expect(onresize).toHaveBeenCalledWith(300);
  });

  it('reports the persisted width on mount when present', async () => {
    localStorage.setItem('test-resize', '250');
    const onresize = vi.fn();
    render(ResizeHandle, { props: { ...baseProps, onresize } });
    await tick();
    expect(onresize).toHaveBeenCalledWith(250);
  });

  it('clamps an out-of-range persisted width on mount', async () => {
    localStorage.setItem('test-resize', '9999');
    const onresize = vi.fn();
    render(ResizeHandle, { props: { ...baseProps, onresize } });
    await tick();
    expect(onresize).toHaveBeenCalledWith(400);
  });

  it('does not report on mount when initialWidth is provided', async () => {
    const onresize = vi.fn();
    render(ResizeHandle, { props: { ...baseProps, initialWidth: 320, onresize } });
    await tick();
    expect(onresize).not.toHaveBeenCalled();
  });

  it('double-click resets to the default width and persists it', async () => {
    const onresize = vi.fn();
    const { container } = render(ResizeHandle, {
      props: { ...baseProps, initialWidth: 250, onresize }
    });
    await tick();
    await act(async () => {
      await fireEvent.dblClick(handleOf(container));
    });
    expect(onresize).toHaveBeenCalledWith(300);
    expect(localStorage.getItem('test-resize')).toBe('300');
  });

  it('reports the clamped live width during a drag and persists on mouseup', async () => {
    const onresize = vi.fn();
    const { container } = render(ResizeHandle, {
      props: { ...baseProps, initialWidth: 300, onresize }
    });
    await tick();
    const h = handleOf(container);
    await act(async () => {
      await fireEvent.mouseDown(h, { button: 0, clientX: 100 });
    });
    expect(h.classList.contains('dragging')).toBe(true);
    await act(async () => {
      await fireEvent.mouseMove(document, { clientX: 150 });
    });
    expect(onresize).toHaveBeenLastCalledWith(350);
    await act(async () => {
      await fireEvent.mouseUp(document, { clientX: 150 });
    });
    expect(h.classList.contains('dragging')).toBe(false);
    expect(localStorage.getItem('test-resize')).toBe('350');
  });

  it('clamps the drag width to the max', async () => {
    const onresize = vi.fn();
    const { container } = render(ResizeHandle, {
      props: { ...baseProps, max: 320, initialWidth: 300, onresize }
    });
    await tick();
    const h = handleOf(container);
    await act(async () => {
      await fireEvent.mouseDown(h, { button: 0, clientX: 100 });
      await fireEvent.mouseMove(document, { clientX: 300 });
      await fireEvent.mouseUp(document, { clientX: 300 });
    });
    expect(onresize).toHaveBeenLastCalledWith(320);
  });

  it('ignores a non-primary mousedown', async () => {
    const onresize = vi.fn();
    const { container } = render(ResizeHandle, {
      props: { ...baseProps, initialWidth: 300, onresize }
    });
    await tick();
    const h = handleOf(container);
    await act(async () => {
      await fireEvent.mouseDown(h, { button: 2, clientX: 100 });
      await fireEvent.mouseMove(document, { clientX: 200 });
    });
    expect(onresize).not.toHaveBeenCalled();
    expect(h.classList.contains('dragging')).toBe(false);
  });
});
