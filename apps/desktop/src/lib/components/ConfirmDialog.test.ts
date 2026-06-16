import { afterEach, describe, expect, it } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

import ConfirmDialog from './ConfirmDialog.svelte';
import { confirmDialog } from '$lib/stores/confirm.svelte';

async function flushFocus(): Promise<void> {
  await tick();
  await Promise.resolve();
}

afterEach(async () => {
  confirmDialog.cancel();
  await flushFocus();
  cleanup();
});

describe('ConfirmDialog component', () => {
  it('opens with the requested title and body', async () => {
    const { container } = render(ConfirmDialog);

    void confirmDialog.ask({
      title: 'Remove Slack?',
      body: 'This will uninstall Slack from IronClaw.',
      confirmLabel: 'Remove extension',
      cancelLabel: 'Keep extension'
    });
    await tick();

    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.textContent).toContain('Remove Slack?');
    expect(container.textContent).toContain('This will uninstall Slack from IronClaw.');
    expect(container.textContent).toContain('Remove extension');
    expect(container.textContent).toContain('Keep extension');
  });

  it('focus starts on the safer cancel button', async () => {
    const { container } = render(ConfirmDialog);

    void confirmDialog.ask({
      title: 'Discard document?',
      body: 'Unsaved content will be lost.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing'
    });
    await flushFocus();

    const cancel = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Keep editing'
    );
    expect(document.activeElement).toBe(cancel);
  });

  it('clicking confirm resolves true', async () => {
    const { container } = render(ConfirmDialog);
    const result = confirmDialog.ask({
      title: 'Reset tools?',
      body: 'This resets tools to defaults.',
      confirmLabel: 'Reset tools',
      cancelLabel: 'Keep current policy'
    });
    await tick();

    const confirm = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Reset tools'
    )!;
    await act(async () => {
      await fireEvent.click(confirm);
    });

    await expect(result).resolves.toBe(true);
  });

  it('Escape resolves false and restores focus', async () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = 'Open confirm';
    document.body.appendChild(opener);
    opener.focus();

    render(ConfirmDialog);
    const result = confirmDialog.ask({
      title: 'Discard changes?',
      body: 'This will throw away unsaved edits.',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing'
    });
    await flushFocus();
    expect(document.activeElement).not.toBe(opener);

    await act(async () => {
      await fireEvent.keyDown(window, { key: 'Escape' });
    });

    await expect(result).resolves.toBe(false);
    await flushFocus();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
