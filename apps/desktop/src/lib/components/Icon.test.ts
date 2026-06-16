// Smoke test for the inline-SVG Icon component.
//
// Goal isn't pixel-perfect SVG verification — just confirm a known
// name produces the right glyph (via its first `<path>` `d` attr)
// and an unknown name falls through to the spark fallback rather
// than rendering nothing.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';

import Icon from './Icon.svelte';

const SPARK_D = 'M12 3.5 14 10l6.5 2-6.5 2-2 6.5-2-6.5-6.5-2 6.5-2 2-6.5Z';
const CHECK_D = 'm5 12.5 4.3 4.3L19.2 6.7';

function pathDs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('path'))
    .map((p) => p.getAttribute('d'))
    .filter((d): d is string => !!d);
}

describe('Icon', () => {
  it('renders the check glyph for name="check"', () => {
    const { container } = render(Icon, { props: { name: 'check' } });
    const ds = pathDs(container);
    expect(ds).toContain(CHECK_D);
  });

  it('renders an svg element with aria-hidden', () => {
    const { container } = render(Icon, { props: { name: 'check' } });
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('falls back to the spark glyph for an unknown name', () => {
    // The IconName type is a string union; the {:else} branch only
    // fires for values outside the union, so cast through `any` to
    // exercise the fallback.
    const { container } = render(Icon, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: { name: 'nope-not-real' as any }
    });
    const ds = pathDs(container);
    expect(ds).toContain(SPARK_D);
  });

  it('honours a custom class on the svg', () => {
    const { container } = render(Icon, {
      props: { name: 'check', class: 'w-4 h-4 text-signal' }
    });
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('class')).toContain('w-4');
    expect(svg?.getAttribute('class')).toContain('text-signal');
  });
});
