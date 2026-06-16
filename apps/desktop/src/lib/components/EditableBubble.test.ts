// Tests for the per-bubble Wikipedia-style edit affordance.
//
// View-mode is the default; the pencil button is mounted next to the
// rendered MarkdownView (mocked out so we don't pull the full pipeline
// into a unit test). Edit-mode swaps in a textarea bound to a draft,
// with keyboard contract: Esc cancels, Cmd+Enter submits.
//
// The save button only enables when the draft both differs from the
// original AND has non-whitespace content — guards against a no-op
// resend that would just truncate the thread for nothing.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';

import EditableBubble from './EditableBubble.svelte';
import type { Message } from '$lib/api/types';

// Mock MarkdownView + Icon so the test doesn't pull the marked /
// DOMPurify / highlight.js pipeline (or the icon glyph set) into a
// component-level smoke spec. We only care about the wrapper behavior.
vi.mock('./MarkdownView.svelte', () => ({ default: () => null }));
vi.mock('./Icon.svelte', () => ({ default: () => null }));

const baseMsg: Message = {
  id: 'msg-1',
  role: 'user',
  content: 'original content',
  created_at: '2026-05-28T00:00:00Z'
};

// Explicit signature so svelte-check matches the component's prop type
// (the bare `ReturnType<typeof vi.fn>` resolves to a generic Procedure
// mock that doesn't unify with the `(msgId, newContent) => void | Promise<void>`
// shape EditableBubble declares).
type SubmitFn = (msgId: string, newContent: string) => void | Promise<void>;

describe('EditableBubble', () => {
  let onEditSubmit: SubmitFn & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onEditSubmit = vi.fn<SubmitFn>().mockResolvedValue(undefined) as SubmitFn &
      ReturnType<typeof vi.fn>;
  });

  it('renders in view mode by default (no textarea)', () => {
    const { container } = render(EditableBubble, {
      props: { msg: baseMsg, onEditSubmit }
    });
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('exposes the edit button with aria-label "Edit message"', () => {
    const { container } = render(EditableBubble, {
      props: { msg: baseMsg, onEditSubmit }
    });
    const btn = container.querySelector('button[aria-label="Edit message"]');
    expect(btn).not.toBeNull();
  });

  it('swaps to a textarea when the edit button is clicked', async () => {
    const { container } = render(EditableBubble, {
      props: { msg: baseMsg, onEditSubmit }
    });
    const btn = container.querySelector('button[aria-label="Edit message"]') as HTMLButtonElement;
    await fireEvent.click(btn);
    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect((textarea as HTMLTextAreaElement).value).toBe('original content');
  });

  it('Esc inside the textarea reverts to view mode', async () => {
    const { container } = render(EditableBubble, {
      props: { msg: baseMsg, onEditSubmit }
    });
    const btn = container.querySelector('button[aria-label="Edit message"]') as HTMLButtonElement;
    await fireEvent.click(btn);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(container.querySelector('textarea')).toBeNull();
    // Pencil is back in the DOM.
    expect(container.querySelector('button[aria-label="Edit message"]')).not.toBeNull();
  });

  it('Cmd+Enter on a changed draft fires onEditSubmit(msgId, newContent)', async () => {
    const { container } = render(EditableBubble, {
      props: { msg: baseMsg, onEditSubmit }
    });
    const btn = container.querySelector('button[aria-label="Edit message"]') as HTMLButtonElement;
    await fireEvent.click(btn);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await fireEvent.input(textarea, { target: { value: 'edited content' } });
    await fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(onEditSubmit).toHaveBeenCalledTimes(1);
    expect(onEditSubmit).toHaveBeenCalledWith('msg-1', 'edited content');
  });

  it('Save button is disabled when the draft equals the original', async () => {
    const { container } = render(EditableBubble, {
      props: { msg: baseMsg, onEditSubmit }
    });
    const editBtn = container.querySelector(
      'button[aria-label="Edit message"]'
    ) as HTMLButtonElement;
    await fireEvent.click(editBtn);
    const saveBtn = container.querySelector(
      'button[aria-label="Save edit and resend"]'
    ) as HTMLButtonElement;
    // Draft is identical to msg.content on entry — save must be disabled.
    expect(saveBtn.disabled).toBe(true);
  });

  it('Save button enables once the draft diverges from the original', async () => {
    const { container } = render(EditableBubble, {
      props: { msg: baseMsg, onEditSubmit }
    });
    const editBtn = container.querySelector(
      'button[aria-label="Edit message"]'
    ) as HTMLButtonElement;
    await fireEvent.click(editBtn);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await fireEvent.input(textarea, { target: { value: 'something different' } });
    const saveBtn = container.querySelector(
      'button[aria-label="Save edit and resend"]'
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
  });

  it('hides the edit button when `disabled` is true', () => {
    const { container } = render(EditableBubble, {
      props: { msg: baseMsg, onEditSubmit, disabled: true }
    });
    expect(container.querySelector('button[aria-label="Edit message"]')).toBeNull();
  });
});
