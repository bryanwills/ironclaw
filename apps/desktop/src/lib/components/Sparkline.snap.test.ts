// Snapshot tests for Sparkline — one per supported variant on the same
// fixed data series. These act as a smoke test for "did the SVG output
// shift unexpectedly?" rather than asserting on individual primitives
// (the interaction-level coverage already lives in Sparkline.test.ts).
//
// Data is intentionally a small, hand-picked series so the serialized
// `<polyline>` / `<polygon>` / `<rect>` coordinates land on round-ish
// values — keeps the snapshot small and review-friendly.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';

import Sparkline from './Sparkline.svelte';

const DATA = [1, 3, 2, 5, 4];

describe('Sparkline snapshots', () => {
  it('matches the line variant snapshot', () => {
    const { container } = render(Sparkline, {
      props: { data: DATA, variant: 'line', width: 120, height: 32 }
    });
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('matches the bars variant snapshot', () => {
    const { container } = render(Sparkline, {
      props: { data: DATA, variant: 'bars', width: 120, height: 32 }
    });
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('matches the area variant snapshot', () => {
    const { container } = render(Sparkline, {
      props: { data: DATA, variant: 'area', width: 120, height: 32 }
    });
    expect(container.innerHTML).toMatchSnapshot();
  });
});
