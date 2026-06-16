// Unit tests for the window-focus tracker (gates OS-notification firing so
// alerts only fire when the user isn't looking at the app). Real event-driven
// logic: idempotent init() that seeds from document.hasFocus(), focus/blur/
// visibilitychange listeners, and a dispose() that detaches them. We drive it
// with real DOM events and spy document.hasFocus / visibilityState.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { windowFocus } from './window-focus.svelte';

let dispose: () => void = () => {};

function setVisibility(state: DocumentVisibilityState): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
}

beforeEach(() => {
  windowFocus.focused = true;
});

afterEach(() => {
  dispose();
  dispose = () => {};
  vi.restoreAllMocks();
});

describe('windowFocus store', () => {
  it('seeds focused from document.hasFocus() on init', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    dispose = windowFocus.init();
    expect(windowFocus.focused).toBe(false);
  });

  it('flips focused on window blur and focus events', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    dispose = windowFocus.init();
    expect(windowFocus.focused).toBe(true);

    window.dispatchEvent(new Event('blur'));
    expect(windowFocus.focused).toBe(false);

    window.dispatchEvent(new Event('focus'));
    expect(windowFocus.focused).toBe(true);
  });

  it('treats a hidden document as unfocused on visibilitychange', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    dispose = windowFocus.init();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(windowFocus.focused).toBe(false);
  });

  it('restores focused when the document becomes visible again and has focus', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    dispose = windowFocus.init();
    window.dispatchEvent(new Event('blur'));
    expect(windowFocus.focused).toBe(false);

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(windowFocus.focused).toBe(true);
  });

  it('dispose() detaches the listeners', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const off = windowFocus.init();
    off();
    // After teardown a blur event must no longer mutate the state.
    window.dispatchEvent(new Event('blur'));
    expect(windowFocus.focused).toBe(true);
  });

  it('init() is idempotent — a second call does not re-seed', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    dispose = windowFocus.init();
    // Mutate after the first install; a second init() must be a no-op and
    // leave our value untouched (rather than re-seeding from hasFocus()).
    windowFocus.focused = false;
    windowFocus.init();
    expect(windowFocus.focused).toBe(false);
  });
});
