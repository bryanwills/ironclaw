// Tests for MiniPanel.svelte (R64, lane B7).
//
// The component reaches into `connection`, `threads`, `messages`,
// `MarkdownView`, and `StreamingText`. We replace each with a
// deterministic stub so the render output is stable and the
// send/composer paths can be exercised without a real gateway. Same
// pattern as Sidebar.snap.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/svelte';
import { tick } from 'svelte';

// ---- Stubs (hoisted so vi.mock factories can capture them) -------------

type RendererOptions = {
  markdown?: string;
  text?: string;
};

function mountRecordingRenderer(
  anchor: Node,
  value: string,
  testid: string
): Record<string, never> {
  const el = document.createElement('span');
  el.dataset.testid = testid;
  el.textContent = value;
  anchor.parentNode?.insertBefore(el, anchor);
  return {};
}

const { connectionStub, threadsStub, messagesStub, clientStub, markdownProps, streamingProps } =
  vi.hoisted(() => {
    type Msg = { id: string; role: 'user' | 'assistant' | 'tool'; content: string };
    const state = {
      history: [] as Msg[],
      streaming: '' as string,
      streamingActive: false,
      error: null as string | null
    };
    return {
      state,
      // Records every `markdown` prop MarkdownView is rendered with, so a
      // test can assert the live streaming buffer is NOT routed through it
      // (parity gap from ICD-015) while history content still is.
      markdownProps: [] as string[],
      // Records every `text` prop StreamingText is rendered with, so a
      // test can assert the live streaming buffer IS routed through it.
      streamingProps: [] as string[],
      clientStub: {
        streamResponse: vi.fn(),
        getHistory: vi.fn().mockResolvedValue([])
      },
      connectionStub: {
        status: 'connected' as 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error',
        client: null as null | object,
        activeProfile: {
          id: 'p1',
          name: 'Default',
          llmProviderId: 'openrouter',
          llmBackend: 'openrouter'
        } as { id: string; name: string; llmProviderId?: string; llmBackend?: string } | null,
        init: vi.fn().mockResolvedValue(undefined)
      },
      threadsStub: {
        currentId: null as string | null,
        current: null as null | { id: string; title: string },
        threads: [] as Array<{ id: string; title: string }>,
        refresh: vi.fn().mockResolvedValue(undefined),
        loadThreads: vi.fn().mockResolvedValue(undefined)
      },
      messagesStub: {
        get: (id: string) => (id ? state.history : []),
        getStreaming: (_id: string) => state.streaming,
        isStreaming: (_id: string) => state.streamingActive,
        getError: (_id: string) => state.error,
        loadHistory: vi.fn().mockResolvedValue(undefined),
        appendUserMessage: vi.fn((_tid: string, _content: string) => 'local-1'),
        beginStream: vi.fn(),
        appendStreamingChunk: vi.fn(),
        commitAssistantMessage: vi.fn(),
        setError: vi.fn(),
        markFailed: vi.fn(),
        recordToolStart: vi.fn(),
        recordToolResult: vi.fn(),
        endStream: vi.fn()
      }
    };
  });

vi.mock('$lib/stores/connection.svelte', () => ({
  connection: connectionStub
}));

vi.mock('$lib/stores/threads.svelte', () => ({
  threads: threadsStub
}));

vi.mock('$lib/stores/messages.svelte', () => ({
  messages: messagesStub
}));

// MarkdownView pulls in marked + dompurify + highlight.js — heavy for a
// jsdom render and not what we're asserting on. We render a tiny marker
// element instead of null so a test can both (a) confirm history content
// flows through it and (b) confirm the live streaming buffer does NOT.
// The recorded `markdown` props back the assertions in the streaming
// parity specs below.
vi.mock('$lib/components/MarkdownView.svelte', async () => {
  return {
    default: function MarkdownViewStub(anchor: Node, props: RendererOptions) {
      markdownProps.push(props?.markdown ?? '');
      return mountRecordingRenderer(anchor, props?.markdown ?? '', 'mini-markdown');
    }
  };
});

// StreamingText is the lightweight live-buffer renderer the main chat
// surface uses (plain text + caret). ICD-015 makes mini-mode route the
// in-flight buffer through it too. We stub it with the same recording
// renderer so a test can confirm the buffer text flowed through here.
vi.mock('$lib/components/StreamingText.svelte', async () => {
  return {
    default: function StreamingTextStub(anchor: Node, props: RendererOptions) {
      streamingProps.push(props?.text ?? '');
      return mountRecordingRenderer(anchor, props?.text ?? '', 'mini-streaming');
    }
  };
});

// Import AFTER mocks so the component picks them up.
import MiniPanel from './MiniPanel.svelte';

function resetStubs(): void {
  connectionStub.status = 'connected';
  connectionStub.client = clientStub;
  threadsStub.currentId = null;
  threadsStub.current = null;
  threadsStub.threads = [];
  messagesStub.get = (id: string) => (id ? [] : []);
  messagesStub.getStreaming = (_id: string) => '';
  messagesStub.isStreaming = (_id: string) => false;
  clientStub.streamResponse.mockReset();
  clientStub.getHistory.mockReset().mockResolvedValue([]);
  messagesStub.loadHistory.mockReset().mockResolvedValue(undefined);
  messagesStub.appendUserMessage.mockReset().mockReturnValue('local-1');
  messagesStub.beginStream.mockReset();
  messagesStub.appendStreamingChunk.mockReset();
  messagesStub.commitAssistantMessage.mockReset();
  markdownProps.length = 0;
  streamingProps.length = 0;
}

describe('MiniPanel component', () => {
  beforeEach(() => {
    resetStubs();
  });

  afterEach(() => {
    resetStubs();
  });

  it('renders the fallback title when no thread is selected', async () => {
    threadsStub.currentId = null;
    threadsStub.current = null;
    const { container } = render(MiniPanel);
    await tick();
    expect(container.textContent).toContain('Quick chat');
    // The empty-state strip tells the user to pick a thread from the
    // main window.
    expect(container.textContent).toContain('Pick a thread');
  });

  it("renders the current thread's title in the header", async () => {
    threadsStub.currentId = 'thr-1';
    threadsStub.current = { id: 'thr-1', title: 'Standup notes' };
    const { container } = render(MiniPanel);
    await tick();
    expect(container.textContent).toContain('Standup notes');
  });

  it('renders only the last 5 messages of the active thread', async () => {
    threadsStub.currentId = 'thr-1';
    threadsStub.current = { id: 'thr-1', title: 'A' };
    // Seed 7 user messages — only the last 5 should land in the DOM.
    type Msg = { id: string; role: 'user' | 'assistant' | 'tool'; content: string };
    const seeded: Msg[] = Array.from({ length: 7 }, (_v, i) => ({
      id: `m${i + 1}`,
      role: 'user' as const,
      content: `msg-${i + 1}`
    }));
    messagesStub.get = (id: string) => (id === 'thr-1' ? seeded : []);

    const { container } = render(MiniPanel);
    await tick();
    expect(container.textContent).not.toContain('msg-1');
    expect(container.textContent).not.toContain('msg-2');
    expect(container.textContent).toContain('msg-3');
    expect(container.textContent).toContain('msg-7');
  });

  it('disables the Send button when the input is empty', async () => {
    threadsStub.currentId = 'thr-1';
    threadsStub.current = { id: 'thr-1', title: 'A' };
    const { container } = render(MiniPanel);
    await tick();
    const sendBtn = container.querySelector(
      '[data-testid="mini-send"]'
    ) as HTMLButtonElement | null;
    expect(sendBtn).not.toBeNull();
    expect(sendBtn!.disabled).toBe(true);
  });

  it('Cmd+Enter triggers send when input is non-empty and a thread is selected', async () => {
    threadsStub.currentId = 'thr-1';
    threadsStub.current = { id: 'thr-1', title: 'A' };
    // Async iterable that yields one content_delta then completes — same
    // shape as the real `streamResponse` generator.
    clientStub.streamResponse.mockImplementation(async function* () {
      yield { type: 'content_delta', delta: 'ok' } as const;
    });
    const { container } = render(MiniPanel);
    await tick();
    const ta = container.querySelector('[data-testid="mini-input"]') as HTMLTextAreaElement;
    await act(async () => {
      await fireEvent.input(ta, { target: { value: 'hello' } });
    });
    await act(async () => {
      await fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });
    });
    // The streamResponse mock should have been called with the trimmed
    // content + thread id, and the optimistic-append + commit pair
    // should have fired.
    expect(clientStub.streamResponse).toHaveBeenCalledTimes(1);
    expect(messagesStub.appendUserMessage).toHaveBeenCalledWith('thr-1', 'hello');
    expect(messagesStub.beginStream).toHaveBeenCalledWith('thr-1');
    // We don't assert on commitAssistantMessage timing because the
    // finally{} block is async — the call above is sufficient to
    // confirm the chord fired and the pipeline opened.
  });

  it('renders the offline placeholder when not connected', async () => {
    threadsStub.currentId = 'thr-1';
    threadsStub.current = { id: 'thr-1', title: 'A' };
    connectionStub.status = 'disconnected';
    connectionStub.client = null;
    const { container } = render(MiniPanel);
    await tick();
    const ta = container.querySelector('[data-testid="mini-input"]') as HTMLTextAreaElement;
    expect(ta.placeholder).toContain('Offline');
    expect(ta.disabled).toBe(true);
  });

  // ---- ICD-015: streaming renderer parity --------------------------------

  it('renders the in-flight streaming buffer via StreamingText, not MarkdownView', async () => {
    threadsStub.currentId = 'thr-1';
    threadsStub.current = { id: 'thr-1', title: 'A' };
    // Active stream with a partial buffer — this is the live path that
    // ICD-015 moves off MarkdownView and onto StreamingText (parity with
    // the main chat surface).
    messagesStub.isStreaming = (_id: string) => true;
    messagesStub.getStreaming = (_id: string) => 'partial streamed token';
    // No committed history, so MarkdownView should not be touched at all.
    messagesStub.get = (_id: string) => [];

    const { container } = render(MiniPanel);
    await tick();

    // The live buffer flowed through StreamingText...
    expect(streamingProps).toContain('partial streamed token');
    const streamingEl = container.querySelector('[data-testid="mini-streaming"]');
    expect(streamingEl).not.toBeNull();
    expect(streamingEl!.textContent).toContain('partial streamed token');

    // ...and was NOT routed through MarkdownView (the parity gap).
    expect(markdownProps).not.toContain('partial streamed token');
    expect(container.querySelector('[data-testid="mini-markdown"]')).toBeNull();
  });

  it('shows the Thinking… placeholder (no StreamingText) when streaming has no buffer yet', async () => {
    threadsStub.currentId = 'thr-1';
    threadsStub.current = { id: 'thr-1', title: 'A' };
    messagesStub.isStreaming = (_id: string) => true;
    messagesStub.getStreaming = (_id: string) => '';
    messagesStub.get = (_id: string) => [];

    const { container } = render(MiniPanel);
    await tick();

    expect(container.textContent).toContain('Thinking…');
    // An empty buffer must not mount the live renderer.
    expect(container.querySelector('[data-testid="mini-streaming"]')).toBeNull();
    expect(streamingProps).toHaveLength(0);
  });

  it('keeps committed assistant history rendering through MarkdownView', async () => {
    threadsStub.currentId = 'thr-1';
    threadsStub.current = { id: 'thr-1', title: 'A' };
    // A committed assistant turn (no active stream) must still go through
    // MarkdownView — ICD-015 only moves the *live* buffer.
    messagesStub.isStreaming = (_id: string) => false;
    messagesStub.getStreaming = (_id: string) => '';
    messagesStub.get = (_id: string) => [
      { id: 'a1', role: 'assistant' as const, content: 'committed answer body' }
    ];

    const { container } = render(MiniPanel);
    await tick();

    expect(markdownProps).toContain('committed answer body');
    const mdEl = container.querySelector('[data-testid="mini-markdown"]');
    expect(mdEl).not.toBeNull();
    expect(mdEl!.textContent).toContain('committed answer body');
    // Nothing should have hit the streaming renderer.
    expect(streamingProps).toHaveLength(0);
  });
});
