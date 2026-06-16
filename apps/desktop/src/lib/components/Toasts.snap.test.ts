// Snapshot tests for Toasts — one per supported `kind` (info / success /
// error). Sibling to Toasts.test.ts which already covers behavior; these
// pin the rendered DOM so an accidental class / markup change shows up
// in the diff rather than only when somebody runs the app.
//
// Determinism note: `toasts.show()` produces ids via an internal counter
// (`nextId++`) which is NOT reset by `clear()`. Each test injects a fresh
// `ToastStore` instance by re-importing the module and bypasses `show()`
// in favor of writing to the rune array directly with a fixed `id`. That
// keeps the serialized HTML stable across test runs and re-orderings.

import { beforeEach, describe, expect, it } from 'vitest';
import { render, act } from '@testing-library/svelte';

import Toasts from './Toasts.svelte';
import { toasts } from '$lib/stores/toasts.svelte';

describe('Toasts snapshots', () => {
  beforeEach(() => {
    toasts.clear();
  });

  it('matches the info-kind snapshot', async () => {
    const { container } = render(Toasts);
    await act(() => {
      // Bypass the auto-incrementing `show()` so the rendered `t.id` is
      // identical across runs; the dismiss button doesn't surface the
      // id to the DOM but a future markup change might.
      toasts.toasts = [{ id: 1, message: 'info toast', kind: 'info' }];
    });
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('matches the success-kind snapshot', async () => {
    const { container } = render(Toasts);
    await act(() => {
      toasts.toasts = [{ id: 1, message: 'success toast', kind: 'success' }];
    });
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('matches the error-kind snapshot', async () => {
    const { container } = render(Toasts);
    await act(() => {
      toasts.toasts = [{ id: 1, message: 'error toast', kind: 'error' }];
    });
    expect(container.innerHTML).toMatchSnapshot();
  });
});
