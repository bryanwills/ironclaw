// Tests for the inline-SVG sparkline primitive. Static renders only;
// no interaction. We assert the right SVG primitives land for each
// variant, that the empty / single-point / flat-series guards don't
// blow up, and that the width/height props are honored.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';

import Sparkline from './Sparkline.svelte';

describe('Sparkline component', () => {
  it('renders a faint dash and no series when data is empty', () => {
    const { container } = render(Sparkline, {
      props: { data: [] }
    });
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // The empty-state line is the only `<line>` in the empty render.
    const lines = container.querySelectorAll('line');
    expect(lines.length).toBe(1);
    // Series primitives must be absent.
    expect(container.querySelector('polyline')).toBeNull();
    expect(container.querySelector('polygon')).toBeNull();
    expect(container.querySelector('rect')).toBeNull();
  });

  it('renders a single-point series centered on the x axis', () => {
    const { container } = render(Sparkline, {
      props: { data: [42], width: 100, variant: 'line' }
    });
    const poly = container.querySelector('polyline');
    expect(poly).not.toBeNull();
    const points = poly?.getAttribute('points') ?? '';
    // Single point sits at width/2 = 50.
    expect(points.split(' ').length).toBe(1);
    expect(points.split(',')[0]).toBe('50.00');
  });

  it('does not divide by zero on an all-equal series (renders a flat polyline)', () => {
    const { container } = render(Sparkline, {
      props: { data: [5, 5, 5, 5], variant: 'line' }
    });
    const poly = container.querySelector('polyline');
    expect(poly).not.toBeNull();
    const points = poly?.getAttribute('points') ?? '';
    // 4 points, all on the same y (mid-line) — split + uniqueness check.
    const ys = points.split(' ').map((p) => p.split(',')[1]);
    expect(ys).toHaveLength(4);
    expect(new Set(ys).size).toBe(1);
  });

  it('bars variant renders one <rect> per datum', () => {
    const { container } = render(Sparkline, {
      props: { data: [1, 2, 3, 4, 5], variant: 'bars' }
    });
    const rects = container.querySelectorAll('rect');
    expect(rects.length).toBe(5);
    // bars should never render the polyline series.
    expect(container.querySelector('polyline')).toBeNull();
  });

  it('line variant renders one <polyline> and no <polygon>', () => {
    const { container } = render(Sparkline, {
      props: { data: [1, 2, 3], variant: 'line' }
    });
    expect(container.querySelector('polyline')).not.toBeNull();
    expect(container.querySelector('polygon')).toBeNull();
    expect(container.querySelector('rect')).toBeNull();
  });

  it('area variant renders both <polygon> and <polyline>', () => {
    const { container } = render(Sparkline, {
      props: { data: [1, 2, 3], variant: 'area' }
    });
    expect(container.querySelector('polygon')).not.toBeNull();
    expect(container.querySelector('polyline')).not.toBeNull();
  });

  it('handles a series with negative values without crashing', () => {
    const { container } = render(Sparkline, {
      props: { data: [-3, -1, 2, -2], variant: 'line' }
    });
    const poly = container.querySelector('polyline');
    expect(poly).not.toBeNull();
    const points = poly?.getAttribute('points') ?? '';
    expect(points.split(' ').length).toBe(4);
    // All coordinates must be finite (no NaN / Infinity leaks).
    for (const pair of points.split(' ')) {
      const [x, y] = pair.split(',').map(Number);
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('applies custom width / height to the svg element', () => {
    const { container } = render(Sparkline, {
      props: { data: [1, 2, 3], width: 200, height: 64 }
    });
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('200');
    expect(svg?.getAttribute('height')).toBe('64');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 200 64');
  });
});
