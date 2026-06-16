// Render smoke tests for CronPreview.svelte (R20b — inline cron description).
// Pure presentational: delegates parsing to the (separately-tested)
// `$lib/utils/cron` `describeCron` and renders one of three branches —
// empty span / valid gold preview / red invalid alert. We assert the
// component's branch selection + a11y wiring, not the human text (that's
// covered by cron.test.ts), with one valid-text spot check.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';

import CronPreview from './CronPreview.svelte';

describe('CronPreview component', () => {
  it('renders an empty (non-alert) span for empty / nullish / blank input', async () => {
    for (const expr of ['', '   ', null, undefined]) {
      const { container } = render(CronPreview, { props: { expr } });
      await tick();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelector('[title]')).toBeNull();
      expect((container.textContent ?? '').trim()).toBe('');
    }
  });

  it('renders the valid description with a title and calendar icon', async () => {
    const { container } = render(CronPreview, { props: { expr: '0 9 * * *' } });
    await tick();
    expect(container.textContent).toContain('Every day at 9:00 AM');
    const titled = container.querySelector('span[title]');
    expect(titled?.getAttribute('title')).toBe('Every day at 9:00 AM');
    // Valid branch uses the calendar SVG (a <rect>); not an alert.
    expect(container.querySelector('rect')).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders an accessible alert for an invalid expression', async () => {
    const { container } = render(CronPreview, { props: { expr: 'bogus' } });
    await tick();
    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert?.getAttribute('aria-label')).toBe('Invalid cron expression');
    expect((container.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it('appends the optional classes onto the rendered span', async () => {
    const { container } = render(CronPreview, {
      props: { expr: '0 9 * * *', classes: 'font-mono' }
    });
    await tick();
    const titled = container.querySelector('span[title]');
    expect(titled?.classList.contains('font-mono')).toBe(true);
  });
});
