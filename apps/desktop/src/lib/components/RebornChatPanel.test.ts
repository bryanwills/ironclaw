// Render smoke tests for the IronClaw Reborn (WebChat v2) chat panel. A
// mock-client controller (no I/O) is injected and pre-seeded so the
// initial-mount effect (which never resets on first bind) preserves the
// state; we assert the message branches, the gate banner + its actions, and
// the composer's send/stop affordances. MarkdownView is mocked out so we
// don't pull the marked/DOMPurify/highlight pipeline into a unit test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';

import RebornChatPanel from './RebornChatPanel.svelte';
import { RebornChatController } from '$lib/stores/reborn-chat.svelte';
import { RebornThreadStore } from '$lib/stores/reborn-threads.svelte';
import { toasts } from '$lib/stores/toasts.svelte';
import { workItems } from '$lib/stores/work-items.svelte';
import { initialChatState, type RebornChatState } from '$lib/api/reborn';

vi.mock('./MarkdownView.svelte', () => ({ default: () => null }));

function controllerWith(state: Partial<RebornChatState>): RebornChatController {
  const c = new RebornChatController(() => null);
  c.state = { ...initialChatState(), ...state };
  return c;
}

/** A fresh, isolated thread store with a null client (load no-ops). */
function freshThreads(): RebornThreadStore {
  return new RebornThreadStore(() => null);
}

function installLocalStorageShim(): void {
  const store = new Map<string, string>();
  const shim = {
    get length() {
      return store.size;
    },
    key(i: number) {
      return Array.from(store.keys())[i] ?? null;
    },
    getItem(k: string) {
      return store.has(k) ? (store.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      store.set(String(k), String(v));
    },
    removeItem(k: string) {
      store.delete(k);
    },
    clear() {
      store.clear();
    }
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: shim });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: shim });
}

function resetWorkItems(): void {
  workItems.items = [];
  (workItems as unknown as { hydrated: boolean }).hydrated = false;
}

describe('RebornChatPanel', () => {
  beforeEach(() => {
    installLocalStorageShim();
    resetWorkItems();
    toasts.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetWorkItems();
    toasts.clear();
    window.localStorage.clear();
  });

  it('renders the empty state and composer when there are no messages', () => {
    const { getByPlaceholderText, getByText } = render(RebornChatPanel, {
      props: { controller: controllerWith({}), threads: freshThreads() }
    });
    expect(getByPlaceholderText('Message IronClaw…')).toBeTruthy();
    expect(
      getByText('Your Chief of Staff for briefs, triage, drafts, and approval-gated work.')
    ).toBeTruthy();
  });

  it('sends a chief-of-staff starter prompt when an empty-state suggestion chip is clicked', async () => {
    const controller = controllerWith({});
    // No active thread → handleSend creates one first; stub the I/O so we can
    // assert the chip routes its full prompt through the normal send path.
    const ensureSpy = vi.spyOn(controller, 'ensureThread').mockResolvedValue(null);
    const sendSpy = vi.spyOn(controller, 'send').mockResolvedValue();
    const { getByText } = render(RebornChatPanel, {
      props: { controller, threads: freshThreads() }
    });
    await fireEvent.click(getByText('Brief me on today'));
    expect(sendSpy).toHaveBeenCalledWith(
      expect.stringContaining('Brief me on what matters today.'),
      undefined,
      []
    );
  });

  it('disables Send for an empty draft and enables it once text is entered', async () => {
    const { getByText, getByLabelText } = render(RebornChatPanel, {
      props: { controller: controllerWith({}), threads: freshThreads() }
    });
    const send = getByText('Send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await fireEvent.input(getByLabelText('Message input'), { target: { value: 'hello' } });
    expect(send.disabled).toBe(false);
  });

  it('leaves low-risk chat content unchanged', async () => {
    const controller = controllerWith({});
    vi.spyOn(controller, 'ensureThread').mockResolvedValue(null);
    const sendSpy = vi.spyOn(controller, 'send').mockResolvedValue(undefined);
    const { getByLabelText, getByText } = render(RebornChatPanel, {
      props: { controller, threads: freshThreads() }
    });
    await fireEvent.input(getByLabelText('Message input'), { target: { value: 'Hello agent' } });
    await fireEvent.click(getByText('Send'));
    expect(sendSpy).toHaveBeenCalledWith('Hello agent', undefined, []);
    expect(workItems.items).toHaveLength(0);
  });

  it('blocks risky chat behind a durable Work Item approval before sending', async () => {
    const controller = controllerWith({});
    vi.spyOn(controller, 'ensureThread').mockResolvedValue('thread-risk');
    const sendSpy = vi.spyOn(controller, 'send').mockResolvedValue(undefined);
    const { getByLabelText, getByTestId, getByText } = render(RebornChatPanel, {
      props: { controller, threads: freshThreads() }
    });
    await fireEvent.input(getByLabelText('Message input'), {
      target: { value: 'Draft an email reply and send the client update.' }
    });
    await fireEvent.click(getByText('Send'));
    expect(getByTestId('local-approval-gate')).toBeTruthy();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(workItems.items[0]).toEqual(
      expect.objectContaining({
        domain: 'operations',
        runbookIds: ['operations'],
        status: 'blocked'
      })
    );
    expect(workItems.items[0]?.approvalBoundaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'send' }),
        expect.objectContaining({ action: 'Send' })
      ])
    );
    await fireEvent.click(getByText('Approve and send'));
    expect(sendSpy).toHaveBeenCalledWith(
      expect.stringContaining('Approval: Send message or reply approved by user.'),
      'thread-risk',
      []
    );
    expect(workItems.items[0]?.approvalBoundaries).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'send', status: 'approved' })])
    );
  });

  it('keeps draft-from-attachment requests in chat with the original prompt', async () => {
    const controller = controllerWith({});
    vi.spyOn(controller, 'ensureThread').mockResolvedValue(null);
    const sendSpy = vi.spyOn(controller, 'send').mockResolvedValue(undefined);
    const { container, getByLabelText, getByText, queryByTestId } = render(RebornChatPanel, {
      props: { controller, threads: freshThreads() }
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['Vendor will provide implementation services.'], 'services.md', {
      type: 'text/markdown'
    });
    await fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(getByText('services.md')).toBeTruthy());
    await fireEvent.input(getByLabelText('Message input'), {
      target: { value: 'draft me a services agreement based on this' }
    });
    await fireEvent.click(getByText('Send'));

    await waitFor(() =>
      expect(sendSpy).toHaveBeenCalledWith(
        'draft me a services agreement based on this',
        undefined,
        [
          {
            name: 'services.md',
            mime_type: 'text/markdown',
            data_base64: 'VmVuZG9yIHdpbGwgcHJvdmlkZSBpbXBsZW1lbnRhdGlvbiBzZXJ2aWNlcy4='
          }
        ]
      )
    );
    expect(sendSpy.mock.calls[0]?.[0]).not.toContain('Work item:');
    expect(queryByTestId('local-approval-gate')).toBeNull();
    expect(workItems.items).toHaveLength(0);
  });

  it('accepts a file attachment and sends it through the Reborn v2 path', async () => {
    const controller = controllerWith({});
    vi.spyOn(controller, 'ensureThread').mockResolvedValue(null);
    const sendSpy = vi.spyOn(controller, 'send').mockResolvedValue(undefined);
    const { container, getByText } = render(RebornChatPanel, {
      props: { controller, threads: freshThreads() }
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
    await fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(getByText('notes.md')).toBeTruthy());
    const send = getByText('Send') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await fireEvent.click(send);
    await waitFor(() =>
      expect(sendSpy).toHaveBeenCalledWith('Attached notes.md', undefined, [
        { name: 'notes.md', mime_type: 'text/markdown', data_base64: 'aGVsbG8=' }
      ])
    );
  });

  it('blocks risky instructions found inside attached text before sending', async () => {
    const controller = controllerWith({});
    vi.spyOn(controller, 'ensureThread').mockResolvedValue('thread-attachment-risk');
    const sendSpy = vi.spyOn(controller, 'send').mockResolvedValue(undefined);
    const { container, getByLabelText, getByTestId, getByText } = render(RebornChatPanel, {
      props: { controller, threads: freshThreads() }
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['send the client email'], 'instructions.md', {
      type: 'text/markdown'
    });
    await fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(getByText('instructions.md')).toBeTruthy());
    await fireEvent.input(getByLabelText('Message input'), {
      target: { value: 'Review the attached note.' }
    });
    await fireEvent.click(getByText('Send'));

    expect(getByTestId('local-approval-gate')).toBeTruthy();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(workItems.items[0]?.approvalBoundaries).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'send' })])
    );
  });

  it('renders user, error, and tool bubbles from controller state', () => {
    const { getByText } = render(RebornChatPanel, {
      props: {
        threads: freshThreads(),
        controller: controllerWith({
          messages: [
            { id: 'u1', role: 'user', content: 'hi there' },
            { id: 'e1', role: 'error', content: 'The run failed before producing a reply.' },
            {
              id: 'tool-1',
              role: 'tool_activity',
              toolName: 'builtin.http',
              toolStatus: 'success'
            }
          ]
        })
      }
    });
    expect(getByText('hi there')).toBeTruthy();
    expect(getByText('The run failed before producing a reply.')).toBeTruthy();
    expect(getByText('builtin.http')).toBeTruthy();
  });

  it('shows a retryable timeline error instead of the starter empty state', async () => {
    const controller = controllerWith({});
    controller.timelineError = 'Could not load messages for this conversation.';
    const retry = vi.spyOn(controller, 'retryTimeline').mockResolvedValue(undefined);
    const { getByText, queryByText } = render(RebornChatPanel, {
      props: { controller, threads: freshThreads() }
    });
    expect(getByText('Could not load messages for this conversation.')).toBeTruthy();
    expect(
      queryByText('Your Chief of Staff for briefs, triage, drafts, and approval-gated work.')
    ).toBeNull();
    await fireEvent.click(getByText('Retry'));
    expect(retry).toHaveBeenCalled();
  });

  it('collapses a tool card by default and expands its detail on click', async () => {
    const { getByText, queryByText } = render(RebornChatPanel, {
      props: {
        threads: freshThreads(),
        controller: controllerWith({
          messages: [
            {
              id: 'tool-2',
              role: 'tool_activity',
              toolName: 'builtin.fetch',
              toolStatus: 'success',
              toolDetail: 'GET https://example.com -> 200'
            }
          ]
        })
      }
    });
    // Progressive disclosure: detail hidden until the card is expanded.
    expect(queryByText('GET https://example.com -> 200')).toBeNull();
    await fireEvent.click(getByText('builtin.fetch'));
    expect(getByText('GET https://example.com -> 200')).toBeTruthy();
  });

  it('shows a "Jump to latest" pill when scrolled up and hides it after jumping', async () => {
    const { container, getByText, queryByText } = render(RebornChatPanel, {
      props: {
        threads: freshThreads(),
        controller: controllerWith({ messages: [{ id: 'u1', role: 'user', content: 'hi' }] })
      }
    });
    const scroll = container.querySelector('.reborn-chat__scroll') as HTMLElement;
    // jsdom has no layout — fake a scrolled-up viewport so atBottom turns false.
    Object.defineProperty(scroll, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scroll, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(scroll, 'scrollTop', { value: 0, writable: true, configurable: true });
    await fireEvent.scroll(scroll);
    expect(getByText(/Jump to latest/)).toBeTruthy();
    await fireEvent.click(getByText(/Jump to latest/));
    expect(queryByText(/Jump to latest/)).toBeNull();
  });

  it('shows the gate banner and routes Approve to the controller', async () => {
    const controller = controllerWith({
      pendingGate: {
        kind: 'gate',
        runId: 'r1',
        gateRef: 'g1',
        headline: 'Approve shell?',
        body: ''
      }
    });
    const resolve = vi.spyOn(controller, 'resolveGate').mockResolvedValue(undefined);
    const { getByText, getByRole } = render(RebornChatPanel, {
      props: { controller, threads: freshThreads() }
    });
    expect(getByText('Approve shell?')).toBeTruthy();
    // Button now carries a ⌘⏎ key hint, so match by role/name, not exact text.
    await fireEvent.click(getByRole('button', { name: /Approve/ }));
    expect(resolve).toHaveBeenCalledWith('approved');
  });

  it('approves the gate on ⌘⏎ and denies on Esc from the keyboard', async () => {
    const controller = controllerWith({
      pendingGate: {
        kind: 'gate',
        runId: 'r1',
        gateRef: 'g1',
        headline: 'Approve shell?',
        body: ''
      }
    });
    const resolve = vi.spyOn(controller, 'resolveGate').mockResolvedValue(undefined);
    render(RebornChatPanel, { props: { controller, threads: freshThreads() } });
    await fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    expect(resolve).toHaveBeenCalledWith('approved');
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(resolve).toHaveBeenCalledWith('denied');
  });

  it('swaps Send for Stop while processing and routes Stop to cancel', async () => {
    const controller = controllerWith({ isProcessing: true });
    const cancel = vi.spyOn(controller, 'cancel').mockResolvedValue(undefined);
    const { getByText, queryByText, getByLabelText } = render(RebornChatPanel, {
      props: { controller, threads: freshThreads() }
    });
    expect(queryByText('Send')).toBeNull();
    // The streaming caret row renders while a turn is in flight.
    expect(getByLabelText('Assistant is responding')).toBeTruthy();
    await fireEvent.click(getByText('Stop'));
    expect(cancel).toHaveBeenCalled();
  });

  it('lists threads in the rail, selects on click, and New chat clears selection', async () => {
    const threads = freshThreads();
    threads.threads = [{ thread_id: 't1', title: 'Quarterly review' }];
    const { getByText } = render(RebornChatPanel, {
      props: { controller: controllerWith({}), threads }
    });
    expect(getByText('Quarterly review')).toBeTruthy();
    // No timestamp → bucketed under the "Older" recency group header.
    expect(getByText('Older')).toBeTruthy();
    await fireEvent.click(getByText('Quarterly review'));
    expect(threads.currentId).toBe('t1');
    await fireEvent.click(getByText('New chat'));
    expect(threads.currentId).toBeNull();
  });

  it('auto-selects the freshest existing thread so its timeline can load', async () => {
    const threads = freshThreads();
    threads.threads = [
      { thread_id: 't1', title: 'Freshest', updated_at: new Date().toISOString() },
      { thread_id: 't2', title: 'Older' }
    ];
    const controller = controllerWith({});
    const loadTimeline = vi.spyOn(controller, 'loadTimeline').mockResolvedValue(undefined);
    const openStream = vi.spyOn(controller, 'openStream').mockResolvedValue(undefined);
    render(RebornChatPanel, { props: { controller, threads } });
    await waitFor(() => expect(threads.currentId).toBe('t1'));
    expect(loadTimeline).toHaveBeenCalledWith('t1');
    expect(openStream).toHaveBeenCalledWith('t1');
  });

  it('moves focus between rail rows with ArrowDown / ArrowUp', async () => {
    const threads = freshThreads();
    threads.threads = [
      { thread_id: 't1', title: 'Alpha' },
      { thread_id: 't2', title: 'Beta' }
    ];
    const { container } = render(RebornChatPanel, {
      props: { controller: controllerWith({}), threads }
    });
    const items = container.querySelectorAll<HTMLButtonElement>('.reborn-rail__item');
    expect(items.length).toBe(2);
    items[0].focus();
    await fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    await fireEvent.keyDown(items[1], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('shows skeleton rows while loading with no threads yet (no empty text)', () => {
    const threads = freshThreads();
    threads.isLoading = true; // null-client load() no-ops, so this survives mount
    const { container, queryByText } = render(RebornChatPanel, {
      props: { controller: controllerWith({}), threads }
    });
    expect(container.querySelector('[data-testid="reborn-rail-skeleton"]')).toBeTruthy();
    expect(queryByText('No conversations yet.')).toBeNull();
  });

  it('renders a relative timestamp for a thread that carries one', () => {
    const threads = freshThreads();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    threads.threads = [{ thread_id: 't1', title: 'Budget review', updated_at: twoHoursAgo }];
    const { getByText } = render(RebornChatPanel, {
      props: { controller: controllerWith({}), threads }
    });
    expect(getByText('Budget review')).toBeTruthy();
    expect(getByText('2h ago')).toBeTruthy();
  });

  it('auto-grows the composer textarea with content, capped at the max', async () => {
    const { getByLabelText } = render(RebornChatPanel, {
      props: { controller: controllerWith({}), threads: freshThreads() }
    });
    const ta = getByLabelText('Message input') as HTMLTextAreaElement;
    // jsdom has no layout — fake scrollHeight to drive the grow logic.
    Object.defineProperty(ta, 'scrollHeight', { value: 60, configurable: true });
    await fireEvent.input(ta, { target: { value: 'a\nb\nc' } });
    expect(ta.style.height).toBe('60px');
    // Beyond the cap → clamped to 144px (the ~9rem max).
    Object.defineProperty(ta, 'scrollHeight', { value: 999, configurable: true });
    await fireEvent.input(ta, { target: { value: 'a\nb\nc\nd\ne\nf\ng' } });
    expect(ta.style.height).toBe('144px');
  });

  it('opens the stream before sending on a new conversation (no missed events)', async () => {
    const controller = controllerWith({});
    const order: string[] = [];
    vi.spyOn(controller, 'ensureThread').mockImplementation(async () => {
      order.push('ensure');
      return 't-new';
    });
    vi.spyOn(controller, 'openStream').mockImplementation(async () => {
      order.push('open');
    });
    vi.spyOn(controller, 'send').mockImplementation(async () => {
      order.push('send');
    });
    const threads = freshThreads();
    const { getByText, getByLabelText } = render(RebornChatPanel, {
      props: { controller, threads }
    });
    await fireEvent.input(getByLabelText('Message input'), { target: { value: 'hello' } });
    await fireEvent.click(getByText('Send'));
    await new Promise((r) => setTimeout(r, 0)); // flush handleSend's awaits
    // The stream is subscribed before the message is posted.
    expect(order).toEqual(['ensure', 'open', 'send']);
    expect(threads.currentId).toBe('t-new');
  });
});
