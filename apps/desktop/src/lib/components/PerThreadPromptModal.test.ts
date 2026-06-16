// Render smoke tests for PerThreadPromptModal.svelte (R43 — per-thread
// system-prompt override editor). A props-driven modal over two sibling
// stores: `perThreadPrompts` (get/set/clear/hasOverride) and `toasts`.
// We spy those stores (never vi.mock the .svelte.ts under test) and drive
// the modal entirely through its props.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

import PerThreadPromptModal from './PerThreadPromptModal.svelte';
import { perThreadPrompts, MAX_PROMPT_CHARS } from '$lib/stores/per-thread-prompts.svelte';
import { toasts } from '$lib/stores/toasts.svelte';

const baseProps = {
  open: true,
  threadId: 't1',
  threadTitle: 'My thread',
  onClose: () => {}
};

const buttons = (c: HTMLElement) => [...c.querySelectorAll('button')];
const byText = (c: HTMLElement, text: string) =>
  buttons(c).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const byIncludes = (c: HTMLElement, text: string) =>
  buttons(c).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

beforeEach(() => {
  vi.spyOn(perThreadPrompts, 'get').mockReturnValue(null);
  vi.spyOn(perThreadPrompts, 'hasOverride').mockReturnValue(false);
  vi.spyOn(perThreadPrompts, 'set').mockImplementation(() => {});
  vi.spyOn(perThreadPrompts, 'clear').mockImplementation(() => {});
  vi.spyOn(toasts, 'show').mockReturnValue(0);
});

afterEach(() => vi.restoreAllMocks());

describe('PerThreadPromptModal component', () => {
  it('renders nothing when closed', async () => {
    const { container } = render(PerThreadPromptModal, {
      props: { ...baseProps, open: false }
    });
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders the dialog with the thread title when open', async () => {
    const { container } = render(PerThreadPromptModal, { props: { ...baseProps } });
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.textContent).toContain('Custom system prompt for this thread');
    expect(container.textContent).toContain('My thread');
  });

  it('falls back to "Untitled thread" when the title is blank', async () => {
    const { container } = render(PerThreadPromptModal, {
      props: { ...baseProps, threadTitle: '' }
    });
    await tick();
    expect(container.textContent).toContain('Untitled thread');
  });

  it('pre-fills the textarea with the existing override', async () => {
    vi.mocked(perThreadPrompts.get).mockReturnValue('be terse');
    const { container } = render(PerThreadPromptModal, { props: { ...baseProps } });
    await tick();
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('be terse');
  });

  it('shows the character count against the limit', async () => {
    vi.mocked(perThreadPrompts.get).mockReturnValue('hello');
    const { container } = render(PerThreadPromptModal, { props: { ...baseProps } });
    await tick();
    expect(container.textContent).toContain(`5 / ${MAX_PROMPT_CHARS.toLocaleString()}`);
  });

  it('warns when the draft exceeds the limit', async () => {
    vi.mocked(perThreadPrompts.get).mockReturnValue('x'.repeat(MAX_PROMPT_CHARS + 1));
    const { container } = render(PerThreadPromptModal, { props: { ...baseProps } });
    await tick();
    expect(container.textContent).toContain('Long prompts may be truncated by the gateway');
  });

  it('disables "Reset to default" when there is no override', async () => {
    vi.mocked(perThreadPrompts.hasOverride).mockReturnValue(false);
    const { container } = render(PerThreadPromptModal, { props: { ...baseProps } });
    await tick();
    expect(byIncludes(container, 'Reset to default').disabled).toBe(true);
  });

  it('enables "Reset to default" when an override exists', async () => {
    vi.mocked(perThreadPrompts.get).mockReturnValue('x');
    vi.mocked(perThreadPrompts.hasOverride).mockReturnValue(true);
    const { container } = render(PerThreadPromptModal, { props: { ...baseProps } });
    await tick();
    expect(byIncludes(container, 'Reset to default').disabled).toBe(false);
  });

  it('Save persists a non-empty draft, toasts, and closes', async () => {
    vi.mocked(perThreadPrompts.get).mockReturnValue('keep me');
    const onClose = vi.fn();
    const onChanged = vi.fn();
    const { container } = render(PerThreadPromptModal, {
      props: { ...baseProps, onClose, onChanged }
    });
    await tick();
    await act(async () => {
      await fireEvent.click(byText(container, 'Save'));
    });
    expect(perThreadPrompts.set).toHaveBeenCalledWith('t1', 'keep me');
    expect(toasts.show).toHaveBeenCalledWith('Custom prompt saved.', 'success');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Save with an empty draft clears the override instead of setting', async () => {
    vi.mocked(perThreadPrompts.get).mockReturnValue('');
    vi.mocked(perThreadPrompts.hasOverride).mockReturnValue(true);
    const { container } = render(PerThreadPromptModal, { props: { ...baseProps } });
    await tick();
    await act(async () => {
      await fireEvent.click(byText(container, 'Save'));
    });
    expect(perThreadPrompts.clear).toHaveBeenCalledWith('t1');
    expect(perThreadPrompts.set).not.toHaveBeenCalled();
    expect(toasts.show).toHaveBeenCalledWith('Reverted to the default prompt.', 'info');
  });

  it('Reset clears the override, toasts, and closes', async () => {
    vi.mocked(perThreadPrompts.get).mockReturnValue('x');
    vi.mocked(perThreadPrompts.hasOverride).mockReturnValue(true);
    const onClose = vi.fn();
    const { container } = render(PerThreadPromptModal, {
      props: { ...baseProps, onClose }
    });
    await tick();
    await act(async () => {
      await fireEvent.click(byIncludes(container, 'Reset to default'));
    });
    expect(perThreadPrompts.clear).toHaveBeenCalledWith('t1');
    expect(toasts.show).toHaveBeenCalledWith('Reverted to the default prompt.', 'info');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel and a backdrop click both close', async () => {
    const onClose = vi.fn();
    const { container } = render(PerThreadPromptModal, {
      props: { ...baseProps, onClose }
    });
    await tick();
    await act(async () => {
      await fireEvent.click(byText(container, 'Cancel'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    const backdrop = container.querySelector('[aria-label="Close custom system prompt dialog"]')!;
    await act(async () => {
      await fireEvent.click(backdrop);
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Escape closes the modal', async () => {
    const onClose = vi.fn();
    render(PerThreadPromptModal, { props: { ...baseProps, onClose } });
    await tick();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
