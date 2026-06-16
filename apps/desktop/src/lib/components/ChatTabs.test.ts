// Render smoke tests for ChatTabs.svelte (R52 — Chrome-style chat tabs).
// Pure renderer over the chatTabs store; emits onSelect/onNew/onClose. We
// drive the chatTabs + threads store $state directly and spy the methods
// (importing sibling stores is fine; never vi.mock the .svelte.ts under test).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

import ChatTabs from './ChatTabs.svelte';
import { chatTabs } from '$lib/stores/chat-tabs.svelte';
import { threads as threadsStore } from '$lib/stores/threads.svelte';
import { threadRename } from '$lib/stores/thread-rename.svelte';

function reset(): void {
  chatTabs.openTabs = [];
  chatTabs.activeTabId = null;
  threadsStore.threads = [
    { id: 't1', title: 'First' },
    { id: 't2', title: 'Second' }
  ] as never;
}

beforeEach(() => {
  reset();
  vi.spyOn(chatTabs, 'setActive').mockImplementation(() => {});
  vi.spyOn(chatTabs, 'close').mockReturnValue('t2');
  vi.spyOn(threadRename, 'displayTitle').mockImplementation(
    (_id: string, base: string | null | undefined) => base ?? ''
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  reset();
});

const tabs = (c: HTMLElement) => [...c.querySelectorAll('[role="tab"]')];

describe('ChatTabs component', () => {
  it('renders nothing when no tabs are open', async () => {
    const { container } = render(ChatTabs, {
      props: { onSelect: vi.fn(), onNew: vi.fn(), onClose: vi.fn() }
    });
    await tick();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });

  it('renders a tab per open id with titles, marking the active one', async () => {
    chatTabs.openTabs = ['t1', 't2'];
    chatTabs.activeTabId = 't2';
    const { container } = render(ChatTabs, {
      props: { onSelect: vi.fn(), onNew: vi.fn(), onClose: vi.fn() }
    });
    await tick();
    expect(tabs(container)).toHaveLength(2);
    expect(container.textContent).toContain('First');
    expect(container.textContent).toContain('Second');
    const active = tabs(container).find((t) => t.getAttribute('aria-selected') === 'true');
    expect(active?.textContent).toContain('Second');
    expect(container.querySelector('button[aria-label="New chat tab"]')).toBeTruthy();
  });

  it('clicking a tab sets it active and emits onSelect', async () => {
    chatTabs.openTabs = ['t1', 't2'];
    chatTabs.activeTabId = 't1';
    const onSelect = vi.fn();
    const { container } = render(ChatTabs, {
      props: { onSelect, onNew: vi.fn(), onClose: vi.fn() }
    });
    await tick();
    const secondTab = tabs(container)[1];
    await act(async () => {
      await fireEvent.click(secondTab);
    });
    expect(chatTabs.setActive).toHaveBeenCalledWith('t2');
    expect(onSelect).toHaveBeenCalledWith('t2');
  });

  it('clicking close drops the tab and emits onClose with the next active', async () => {
    chatTabs.openTabs = ['t1', 't2'];
    chatTabs.activeTabId = 't1';
    const onClose = vi.fn();
    const { container } = render(ChatTabs, {
      props: { onSelect: vi.fn(), onNew: vi.fn(), onClose }
    });
    await tick();
    const closeFirst = container.querySelector('button[aria-label="Close tab \\"First\\""]')!;
    await act(async () => {
      await fireEvent.click(closeFirst);
    });
    expect(chatTabs.close).toHaveBeenCalledWith('t1');
    expect(onClose).toHaveBeenCalledWith('t1', 't2');
  });

  it('the + button emits onNew', async () => {
    chatTabs.openTabs = ['t1'];
    chatTabs.activeTabId = 't1';
    const onNew = vi.fn();
    const { container } = render(ChatTabs, {
      props: { onSelect: vi.fn(), onNew, onClose: vi.fn() }
    });
    await tick();
    await act(async () => {
      await fireEvent.click(container.querySelector('button[aria-label="New chat tab"]')!);
    });
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});
