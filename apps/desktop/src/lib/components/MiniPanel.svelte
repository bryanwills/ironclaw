<script lang="ts">
  // LANE B7 (R64) — Mini-mode floating panel.
  //
  // 320×400 always-on-top child window that strips IronClaw down to the
  // essentials: model-name banner, last 5 messages of the current thread,
  // a one-line composer, send button. The window itself is opened from
  // the main window via `miniMode.toggle()` → `open_mini_window` Tauri
  // command; this component is the entire UI inside it (mounted at
  // `src/routes/mini/+page.svelte`).
  //
  // The mini window opens a fresh SvelteKit context, so the
  // singleton stores (`connection`, `threads`, `messages`) all run
  // their own copies here — same shape as the main window, just
  // isolated. We boot `connection.init()` on mount to hydrate the
  // gateway config + token, then read the active thread from the
  // `threads` store. If no thread is selected we render an empty state
  // and the composer is disabled — the user picks a thread from the
  // main window first.
  //
  // Send pipeline is intentionally a SLIM version of the chat surface's
  // `runSendAndStream` (text-only, no attachments, no Responses-API
  // fallback path). We append the user bubble optimistically, open the
  // SSE stream via `streamResponse`, drain `content_delta` events into
  // the messages store, then commit and reconcile via `loadHistory`.
  // Tool calls and errors short-circuit the stream the same way the
  // chat surface does (see `handleEvent` below).

  import { onMount, tick } from 'svelte';
  import { connection } from '$lib/stores/connection.svelte';
  import { threads } from '$lib/stores/threads.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import type { ChatEvent } from '$lib/api/types';
  import MarkdownView from '$lib/components/MarkdownView.svelte';
  // In-flight assistant text renders through the lightweight
  // StreamingText renderer (plain text + caret) so the live path doesn't
  // re-parse the whole buffer per token — same renderer the main chat
  // surface uses for its streaming bubble (see +page.svelte). MarkdownView
  // takes over for committed/history messages below once the turn lands.
  import StreamingText from '$lib/components/StreamingText.svelte';

  // ---- ui state -----------------------------------------------------------

  let input = $state('');
  let sending = $state(false);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);
  let abortController: AbortController | null = null;

  // ---- derived gates ------------------------------------------------------

  const currentThread = $derived(threads.current);
  const currentId = $derived(threads.currentId);
  const isStreaming = $derived(currentId ? messages.isStreaming(currentId) : false);
  const streamingBuffer = $derived(currentId ? messages.getStreaming(currentId) : '');
  const history = $derived(currentId ? messages.get(currentId) : []);
  /** Last 5 messages of the current thread, in chronological order. The
   *  mini-mode brief is explicit about the cap — anything older lives in
   *  the main window. The slice is computed against the in-memory store
   *  so streaming + commit both stay reflected here. */
  const lastFive = $derived(history.slice(-5));

  /** Active provider's human-readable name, used in the model banner.
   *  Falls back to the raw provider id, then to "IronClaw" when no
   *  profile is bound yet (fresh sidecar, mid-onboarding). */
  const modelLabel = $derived.by(() => {
    const profile = connection.activeProfile;
    if (!profile) return 'IronClaw';
    const id = profile.llmProviderId ?? profile.llmBackend ?? null;
    if (!id) return 'IronClaw';
    return id;
  });

  /** True when send would actually hit the gateway. Mirrors the chat
   *  composer's offline check. */
  const offline = $derived(!connection.client || connection.status !== 'connected');

  const sendDisabled = $derived(
    offline || sending || isStreaming || !currentId || input.trim().length === 0
  );

  // ---- lifecycle ----------------------------------------------------------

  onMount(() => {
    // Hydrate the connection store + reload the active thread's history
    // so the bubble area paints with real content instead of an empty
    // shell while the user is staring at it. The connection store
    // dedupes concurrent init() callers (initPromise cache), so this is
    // cheap even if a sibling surface has already booted.
    void connection.init().then(async () => {
      if (threads.currentId) {
        await messages.loadHistory(threads.currentId);
      } else {
        // No thread selected — load the list so the user can switch
        // from the main window and have it reflect here. We don't
        // auto-pick one; mini-mode is for "I have an active context,
        // let me dash off a follow-up", not for thread management.
        await threads.refresh();
      }
    });
    // Defer focus a tick so the textarea is in the DOM.
    void tick().then(() => textareaEl?.focus());

    return () => {
      // Abort any in-flight stream on unmount. The window itself can
      // close while a stream is open (Cmd+W on the mini window) — we
      // don't want a zombie fetch hanging around in the gateway.
      abortController?.abort();
      abortController = null;
    };
  });

  // ---- send pipeline ------------------------------------------------------

  function handleEvent(threadId: string, ev: ChatEvent): void {
    // Slim variant of the chat surface's handler. Mini-mode drops
    // tool-flow surfacing (no right rail to populate) and treats tool
    // calls as inert — they still complete server-side, we just don't
    // render them. Errors short-circuit via `messages.setError`, which
    // the bubble area below reads to render a small inline strip.
    switch (ev.type) {
      case 'content_delta':
        messages.appendStreamingChunk(threadId, ev.delta);
        break;
      case 'tool_call':
      case 'tool_call_delta':
      case 'tool_result':
      case 'message_start':
      case 'message_end':
        // No surfaces to update; intentional no-op.
        break;
      case 'error':
        messages.setError(threadId, ev.message);
        break;
    }
  }

  async function send(): Promise<void> {
    if (sendDisabled) return;
    const client = connection.client;
    const tid = threads.currentId;
    if (!client || !tid) return;
    const content = input.trim();
    if (!content) return;
    input = '';
    sending = true;
    const localId = messages.appendUserMessage(tid, content);
    abortController = new AbortController();
    const signal = abortController.signal;
    messages.beginStream(tid);
    try {
      for await (const ev of client.streamResponse(content, tid, signal)) {
        handleEvent(tid, ev);
      }
    } catch (err) {
      if (!signal.aborted) {
        const msg = (err as Error).message;
        messages.setError(tid, msg);
        messages.markFailed(localId, content);
      }
    } finally {
      messages.commitAssistantMessage(tid);
      abortController = null;
      // Reconcile with the canonical server history so the optimistic
      // local row is replaced by the persisted one. Best-effort: a
      // failed history call leaves the optimistic row in place rather
      // than blanking the bubble area.
      try {
        await messages.loadHistory(tid);
      } catch {
        // Already surfaced via setError; nothing to do here.
      }
      sending = false;
    }
  }

  function close(): void {
    abortController?.abort();
    // Closing the mini-mode window returns the user to the main window.
    // We close via `window.close()` rather than a Tauri IPC so we don't
    // need to mock another command in browser preview — the webview
    // close semantics are the same in both.
    if (typeof window !== 'undefined') {
      window.close();
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    // Cmd/Ctrl+Enter sends. Bare Enter inserts a newline so the user can
    // refine a short multi-line prompt before commit — same trade as
    // the QuickCapture modal.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
</script>

<!-- The mini-mode child window opens this route under the main app's
     root `+layout.svelte`, which paints sidebar + statusbar + drag strip
     around the page. The 320×400 floating window has no room for that
     chrome, so we cover it with a fixed-position panel that fills the
     viewport. The layout's effects (connection.init, broadcast wiring,
     toast viewport mount) still run — which is exactly what we want
     for the mini window's own gateway/auth state. -->
<div
  class="mini-panel fixed inset-0 z-50 flex flex-col overflow-hidden bg-bg-deep text-text-primary"
  data-testid="mini-panel"
>
  <!-- Header: model banner + close X. The drag region lets the user
       move the floating panel by grabbing the title strip. -->
  <header
    class="flex items-center justify-between gap-2 px-3 py-2 border-b border-border-subtle bg-bg-deep/90 backdrop-blur"
    data-tauri-drag-region
  >
    <div class="flex flex-col min-w-0">
      <span class="text-[10px] uppercase tracking-wider text-text-muted">{modelLabel}</span>
      <span class="text-xs text-text-primary truncate" title={currentThread?.title ?? ''}>
        {currentThread?.title ?? 'Quick chat'}
      </span>
    </div>
    <button
      type="button"
      onclick={close}
      class="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-bg-elevated transition-colors"
      aria-label="Close mini panel"
      title="Close (Esc)"
    >
      <svg
        viewBox="0 0 24 24"
        class="w-3.5 h-3.5"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </header>

  <!-- Body: last 5 messages, scrollable. Mini-mode only ever shows the
       tail of the thread; the user can switch to the main window for
       full history. -->
  <main class="flex-1 overflow-y-auto px-3 py-2 space-y-2 text-xs">
    {#if !currentId}
      <div class="flex h-full items-center justify-center text-center text-text-muted">
        <span>Pick a thread in the main window to start.</span>
      </div>
    {:else if lastFive.length === 0 && !isStreaming && !streamingBuffer}
      <div class="flex h-full items-center justify-center text-center text-text-muted">
        <span>No messages yet. Send one below.</span>
      </div>
    {:else}
      {#each lastFive as msg (msg.id)}
        {#if msg.role === 'user'}
          <div class="flex justify-end" data-role="user">
            <div
              class="max-w-[85%] rounded-md border border-border-subtle px-2.5 py-1.5 whitespace-pre-wrap"
              style="background:rgba(76,167,230,0.10);border-color:rgba(251,191,36,0.4);"
            >
              {msg.content}
            </div>
          </div>
        {:else if msg.role === 'assistant'}
          <div class="flex justify-start" data-role="assistant">
            <div class="max-w-[85%] rounded-md border surface px-2.5 py-1.5">
              <MarkdownView markdown={msg.content} />
            </div>
          </div>
        {:else}
          <div class="flex justify-start" data-role="tool">
            <div
              class="max-w-[85%] rounded-md border border-border-subtle bg-bg-deep px-2 py-1 font-mono text-[11px] text-text-muted"
            >
              tool · {msg.content}
            </div>
          </div>
        {/if}
      {/each}
      {#if isStreaming || streamingBuffer}
        <div class="flex justify-start" data-role="assistant-streaming">
          <div class="max-w-[85%] rounded-md border surface px-2.5 py-1.5">
            {#if streamingBuffer}
              <StreamingText text={streamingBuffer} />
            {:else}
              <span class="inline-flex items-center gap-1.5 text-text-muted">
                <span
                  class="w-1.5 h-1.5 rounded-full bg-accent-cyan animate-pulse"
                  aria-hidden="true"
                ></span>
                <span>Thinking…</span>
              </span>
            {/if}
          </div>
        </div>
      {/if}
    {/if}
  </main>

  <!-- Footer: composer + send button. Cmd+Enter sends. Bare Enter
       inserts newline so a short multi-line prompt can be drafted
       before commit — same trade as the QuickCapture modal. -->
  <footer class="flex items-end gap-2 px-3 py-2 border-t border-border-subtle bg-bg-deep/90">
    <textarea
      bind:this={textareaEl}
      bind:value={input}
      onkeydown={onKeyDown}
      placeholder={offline ? 'Offline — open main window' : 'Quick question…'}
      disabled={offline || !currentId}
      rows={1}
      class="flex-1 resize-none rounded border border-border-subtle bg-bg-elevated px-2 py-1 text-xs text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-cyan disabled:opacity-50 disabled:cursor-not-allowed"
      data-testid="mini-input"
    ></textarea>
    <button
      type="button"
      onclick={() => void send()}
      disabled={sendDisabled}
      class="shrink-0 inline-flex items-center justify-center px-2.5 py-1 rounded border border-accent-cyan/50 bg-accent-cyan/10 text-accent-cyan text-xs hover:bg-accent-cyan/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      aria-label="Send message"
      data-testid="mini-send"
    >
      Send
    </button>
  </footer>
</div>

<style>
  /* The bg-bg-deep / text-text-primary / surface utilities come from the
     app's design tokens (see app.css). Nothing custom here — kept this
     style block so future window-chrome tweaks (e.g. a 1px ring around
     the panel to make the always-on-top frame readable on bright
     backgrounds) have a home. */
  .mini-panel {
    /* Soft outer ring so the floating panel reads as a card against
       whatever's behind it. Cheap, single-paint, no JS state needed. */
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.06),
      0 10px 30px rgba(0, 0, 0, 0.45);
  }
</style>
