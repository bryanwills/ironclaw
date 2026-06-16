// Render smoke tests for LightboxModal.svelte (R19b — chat image lightbox).
// Props-driven (src / alt / onClose), no store deps. Locks the image
// wiring, the alt fallback, the dismissal paths (backdrop click, close
// button, Escape) and that clicking the image does NOT dismiss.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

import LightboxModal from './LightboxModal.svelte';

afterEach(() => vi.restoreAllMocks());

const backdrop = (c: HTMLElement) => c.querySelector('[aria-label="Close image preview"]')!;
const closeButton = (c: HTMLElement) => c.querySelector('button[aria-label="Close"]')!;

describe('LightboxModal component', () => {
  it('renders the image with the given src and alt', async () => {
    const { container } = render(LightboxModal, {
      props: { src: 'data:image/png;base64,AAAA', alt: 'A cat', onClose: vi.fn() }
    });
    await tick();
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(img.getAttribute('alt')).toBe('A cat');
  });

  it('falls back to a generic alt label', async () => {
    const { container } = render(LightboxModal, {
      props: { src: 'blob:abc', onClose: vi.fn() }
    });
    await tick();
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('Preview');
  });

  it('clicking the backdrop calls onClose', async () => {
    const onClose = vi.fn();
    const { container } = render(LightboxModal, { props: { src: 'x', onClose } });
    await tick();
    await act(async () => {
      await fireEvent.click(backdrop(container));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the close button calls onClose', async () => {
    const onClose = vi.fn();
    const { container } = render(LightboxModal, { props: { src: 'x', onClose } });
    await tick();
    await act(async () => {
      await fireEvent.click(closeButton(container));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking the image does NOT dismiss (stopPropagation)', async () => {
    const onClose = vi.fn();
    const { container } = render(LightboxModal, { props: { src: 'x', onClose } });
    await tick();
    await act(async () => {
      await fireEvent.click(container.querySelector('img') as HTMLImageElement);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('pressing Escape calls onClose', async () => {
    const onClose = vi.fn();
    render(LightboxModal, { props: { src: 'x', onClose } });
    await tick();
    await act(async () => {
      await fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
