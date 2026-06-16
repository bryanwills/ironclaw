// Render smoke tests for ModelPresenceStrip.svelte (R83 — Council model
// presence pills). Purely presentational: one `runs[]` prop, zero imports.
// Locks the empty guard, the status-label mapping, the label→providerId
// fallback, the done-only latency, the error title, and the aria-live wiring.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';

import ModelPresenceStrip from './ModelPresenceStrip.svelte';

type Run = {
  label?: string;
  providerId: string;
  status: 'pending' | 'streaming' | 'done' | 'error';
  latencyMs?: number | null;
  error?: string;
};

function run(over: Partial<Run> = {}): Run {
  return { providerId: 'p1', status: 'pending', ...over };
}

const statuses = (c: HTMLElement) => [...c.querySelectorAll('[role="status"]')];

describe('ModelPresenceStrip component', () => {
  it('renders nothing when there are no runs', async () => {
    const { container } = render(ModelPresenceStrip, { props: { runs: [] } });
    await tick();
    expect(container.querySelector('[aria-label="Model presence"]')).toBeNull();
    expect((container.textContent ?? '').trim()).toBe('');
  });

  it('maps each status to its label', async () => {
    const { container } = render(ModelPresenceStrip, {
      props: {
        runs: [
          run({ providerId: 'a', status: 'pending' }),
          run({ providerId: 'b', status: 'streaming' }),
          run({ providerId: 'c', status: 'done' }),
          run({ providerId: 'd', status: 'error' })
        ]
      }
    });
    await tick();
    const txt = container.textContent ?? '';
    expect(txt).toContain('queued');
    expect(txt).toContain('thinking');
    expect(txt).toContain('ready');
    expect(txt).toContain('failed');
    expect(statuses(container)).toHaveLength(4);
  });

  it('prefers label but falls back to providerId', async () => {
    const { container } = render(ModelPresenceStrip, {
      props: {
        runs: [run({ providerId: 'openai', label: 'Claude 4' }), run({ providerId: 'gemini' })]
      }
    });
    await tick();
    expect(container.textContent).toContain('Claude 4');
    expect(container.textContent).toContain('gemini');
  });

  it('shows latency only for done runs', async () => {
    const done = render(ModelPresenceStrip, {
      props: { runs: [run({ providerId: 'a', status: 'done', latencyMs: 2500 })] }
    });
    await tick();
    expect(done.container.textContent).toContain('2.5s');

    const streaming = render(ModelPresenceStrip, {
      props: { runs: [run({ providerId: 'b', status: 'streaming', latencyMs: 2500 })] }
    });
    await tick();
    expect(streaming.container.textContent).not.toContain('2.5s');
  });

  it('uses aria-live=polite while streaming, off otherwise', async () => {
    const streaming = render(ModelPresenceStrip, {
      props: { runs: [run({ providerId: 'a', status: 'streaming' })] }
    });
    await tick();
    expect(statuses(streaming.container)[0].getAttribute('aria-live')).toBe('polite');

    const done = render(ModelPresenceStrip, {
      props: { runs: [run({ providerId: 'b', status: 'done' })] }
    });
    await tick();
    expect(statuses(done.container)[0].getAttribute('aria-live')).toBe('off');
  });

  it('surfaces the error message in the pill title', async () => {
    const { container } = render(ModelPresenceStrip, {
      props: { runs: [run({ providerId: 'x', status: 'error', error: 'rate limited' })] }
    });
    await tick();
    expect(statuses(container)[0].getAttribute('title')).toContain('rate limited');
  });
});
