// Render smoke tests for BuildProvenanceBadge.svelte (R38 — build-kind chip).
// Like TokenSourceBadge, it exposes a `forced` prop that skips the IPC fetch
// (onMount early-returns), so we drive the three build kinds deterministically
// with no Tauri and no timer.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';

import BuildProvenanceBadge from './BuildProvenanceBadge.svelte';
import type { BuildProvenance } from '$lib/stores/settings.svelte';

function prov(over: Partial<BuildProvenance> = {}): BuildProvenance {
  return {
    build_kind: 'public',
    signing: 'developer-id',
    profile: 'release',
    ...over
  } as BuildProvenance;
}

const badge = (c: HTMLElement) => c.querySelector('[data-testid="build-provenance-badge"]');

describe('BuildProvenanceBadge component', () => {
  it('renders the public-release state with its label + a11y wiring', async () => {
    const { container } = render(BuildProvenanceBadge, { props: { forced: prov() } });
    await tick();
    const el = badge(container);
    expect(el?.getAttribute('data-build-kind')).toBe('public');
    expect(el?.getAttribute('data-signing')).toBe('developer-id');
    expect(el?.getAttribute('aria-label')).toBe('Build kind: Public release');
    expect(container.textContent).toContain('Public release');
  });

  it('renders the support-build state', async () => {
    const { container } = render(BuildProvenanceBadge, {
      props: { forced: prov({ build_kind: 'support' }) }
    });
    await tick();
    expect(badge(container)?.getAttribute('data-build-kind')).toBe('support');
    expect(container.textContent).toContain('Support build');
  });

  it('renders the dev state', async () => {
    const { container } = render(BuildProvenanceBadge, {
      props: { forced: prov({ build_kind: 'dev' }) }
    });
    await tick();
    expect(badge(container)?.getAttribute('data-build-kind')).toBe('dev');
    expect(container.textContent).toContain('Dev');
  });

  it('includes the signing + profile in the chip title', async () => {
    const { container } = render(BuildProvenanceBadge, {
      props: { forced: prov({ signing: 'adhoc', profile: 'debug' }) }
    });
    await tick();
    const title = badge(container)?.getAttribute('title') ?? '';
    expect(title).toContain('signing: adhoc');
    expect(title).toContain('profile: debug');
  });
});
