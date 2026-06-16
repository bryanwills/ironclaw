// Tests for the click-to-reveal masked-value renderer.
//
// The component delegates the actual masking to `redactSecrets`
// (verified separately in `utils/redact.test.ts`); these tests
// exercise the wrapper behavior: default render is masked, the
// eyeball button toggles, click again re-masks, locked / non-secret
// strings hide the toggle entirely, empty value renders an empty
// span (no synthetic mask).
//
// NOTE: The component currently has no Escape-key handler. The task
// listed "Esc closes the reveal" as a desired test; flagged in the
// final report as a TODO since adding the handler would be a source
// change which the constraints forbid.

import { describe, expect, it } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';

import MaskedValue from './MaskedValue.svelte';

describe('MaskedValue component', () => {
  it('renders a masked value by default for a secret-shaped string', () => {
    const value = 'Authorization: Bearer abc123def456';
    const { container } = render(MaskedValue, { props: { value } });
    // The raw secret never appears on screen.
    expect(container.textContent).not.toContain('abc123def456');
    // The mask glyph (U+2022 BULLET) is present in the rendered text.
    expect(container.textContent ?? '').toMatch(/•+/);
    // The label survives so the reader knows what they're looking at.
    expect(container.textContent).toContain('Bearer');
  });

  it('reveals the raw value when the eyeball button is clicked', async () => {
    const value = 'Bearer abcdef123456';
    const { container } = render(MaskedValue, { props: { value } });
    const btn = container.querySelector('button[aria-label="Reveal secret"]');
    expect(btn).not.toBeNull();
    await fireEvent.click(btn as HTMLButtonElement);
    expect(container.textContent).toContain('abcdef123456');
    // After reveal the button's aria-pressed flips.
    const pressed = container.querySelector('button[aria-pressed="true"]');
    expect(pressed).not.toBeNull();
  });

  it('re-masks when the eyeball is clicked again', async () => {
    const value = 'Bearer secret123tok';
    const { container } = render(MaskedValue, { props: { value } });
    const btn = container.querySelector('button') as HTMLButtonElement;
    // Reveal.
    await fireEvent.click(btn);
    expect(container.textContent).toContain('secret123tok');
    // Hide.
    await fireEvent.click(btn);
    expect(container.textContent).not.toContain('secret123tok');
  });

  it('renders an empty span when value is empty (no long synthetic mask)', () => {
    const { container } = render(MaskedValue, { props: { value: '' } });
    const inner = container.querySelector('span span');
    expect(inner?.textContent ?? '').toBe('');
    // And no toggle button on an empty value (nothing to reveal).
    expect(container.querySelector('button')).toBeNull();
  });

  it('hides the reveal toggle on non-secret strings (the value passes through)', () => {
    const value = 'plain text label, nothing secret here';
    const { container } = render(MaskedValue, { props: { value } });
    expect(container.textContent).toContain(value);
    // No eyeball button when containsSecret() returned false.
    expect(container.querySelector('button')).toBeNull();
  });

  it('hides the toggle when `locked` is true even for secret values', () => {
    const value = 'Bearer secret123token';
    const { container } = render(MaskedValue, {
      props: { value, locked: true }
    });
    // Value is still masked.
    expect(container.textContent).not.toContain('secret123token');
    // But the reveal button is suppressed.
    expect(container.querySelector('button')).toBeNull();
  });
});
