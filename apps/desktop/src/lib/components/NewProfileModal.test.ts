// Render + close-path tests for NewProfileModal.svelte (R4a — "+ New
// profile" modal). The create-and-switch happy path drags
// connection.switchProfile (connection internals), so per the test plan we
// cover RENDER + name validation (Create enable/disable) + the three close
// paths only, and leave submit() to the integration layer. `$app/navigation`
// is mocked so `goto` resolves; we never invoke it here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

import NewProfileModal from './NewProfileModal.svelte';

const baseProps = {
  open: true,
  onClose: () => {}
};

const buttons = (c: HTMLElement) => [...c.querySelectorAll('button')];
const byText = (c: HTMLElement, text: string) =>
  buttons(c).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const submitBtn = (c: HTMLElement) => c.querySelector('button[type="submit"]') as HTMLButtonElement;
const input = (c: HTMLElement) => c.querySelector('input#new-profile-name') as HTMLInputElement;

async function type(c: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    await fireEvent.input(input(c), { target: { value } });
  });
  await tick();
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => vi.restoreAllMocks());

describe('NewProfileModal component', () => {
  it('renders nothing when closed', async () => {
    const { container } = render(NewProfileModal, { props: { ...baseProps, open: false } });
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders the dialog with the title and description when open', async () => {
    const { container } = render(NewProfileModal, { props: { ...baseProps } });
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.textContent).toContain('New profile');
    expect(container.textContent).toContain('Profiles let you keep separate URLs');
  });

  it('disables "Create profile" when the name is empty', async () => {
    const { container } = render(NewProfileModal, { props: { ...baseProps } });
    await tick();
    const create = submitBtn(container);
    expect(create.textContent).toContain('Create profile');
    expect(create.disabled).toBe(true);
  });

  it('keeps "Create profile" disabled for a whitespace-only name', async () => {
    const { container } = render(NewProfileModal, { props: { ...baseProps } });
    await tick();
    await type(container, '   ');
    expect(submitBtn(container).disabled).toBe(true);
  });

  it('enables "Create profile" once a valid name is entered', async () => {
    const { container } = render(NewProfileModal, { props: { ...baseProps } });
    await tick();
    await type(container, 'baremetal3-remote');
    expect(submitBtn(container).disabled).toBe(false);
  });

  it('Cancel fires onClose', async () => {
    const onClose = vi.fn();
    const { container } = render(NewProfileModal, { props: { ...baseProps, onClose } });
    await tick();
    await act(async () => {
      await fireEvent.click(byText(container, 'Cancel'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a backdrop click fires onClose', async () => {
    const onClose = vi.fn();
    const { container } = render(NewProfileModal, { props: { ...baseProps, onClose } });
    await tick();
    const backdrop = container.querySelector('[aria-label="Close new profile dialog"]')!;
    await act(async () => {
      await fireEvent.click(backdrop);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape fires onClose', async () => {
    const onClose = vi.fn();
    render(NewProfileModal, { props: { ...baseProps, onClose } });
    await tick();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
