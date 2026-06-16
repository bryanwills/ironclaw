// Render smoke tests for TokenSourceBadge.svelte (v0.2.9 — token-source
// provenance chip). The component exposes a `forcedSource` prop that
// bypasses the IPC fetch + poll timer entirely (onMount early-returns), so
// we drive the three present states deterministically with no async, no
// Tauri, and no timer to clean up.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';

import TokenSourceBadge from './TokenSourceBadge.svelte';

const badge = (c: HTMLElement) => c.querySelector('[data-testid="token-source-badge"]');

describe('TokenSourceBadge component', () => {
  it('renders the keychain state with its label + a11y wiring', async () => {
    const { container } = render(TokenSourceBadge, { props: { forcedSource: 'keychain' } });
    await tick();
    const el = badge(container);
    expect(el).toBeTruthy();
    expect(el?.getAttribute('data-source')).toBe('keychain');
    expect(el?.getAttribute('aria-label')).toBe('Token source: Keychain');
    expect(el?.getAttribute('title')).toBeTruthy();
    expect(container.textContent).toContain('Keychain');
  });

  it('renders the file-fallback state', async () => {
    const { container } = render(TokenSourceBadge, { props: { forcedSource: 'file' } });
    await tick();
    expect(badge(container)?.getAttribute('data-source')).toBe('file');
    expect(container.textContent).toContain('File fallback');
  });

  it('renders the absent state', async () => {
    const { container } = render(TokenSourceBadge, { props: { forcedSource: 'absent' } });
    await tick();
    expect(badge(container)?.getAttribute('data-source')).toBe('absent');
    expect(container.textContent).toContain('No token');
  });

  it('forcedSource fully drives the rendered label (no IPC/loading flash)', async () => {
    const { container } = render(TokenSourceBadge, {
      props: { forcedSource: 'keychain', pollMs: 0 }
    });
    await tick();
    // Never shows the loading ellipsis when forcedSource is provided.
    expect(badge(container)).toBeTruthy();
    expect(container.querySelector('[aria-label="Token source: loading"]')).toBeNull();
  });
});
