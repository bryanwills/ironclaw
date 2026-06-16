<script lang="ts">
  // Cmd+Shift+N quick-capture mini-chat. Floating overlay that drops a
  // single message into a dedicated "Quick captures" thread without
  // forcing the user to navigate away from their current surface.
  //
  // Mounted once at the layout level (`src/routes/+layout.svelte`);
  // summoned via `quickCapture.show()` from
  // `$lib/stores/quick-capture.svelte`. Sibling to the other layout-level
  // modals (CommandPalette, GlobalSearch, ThreadSwitcher, AboutDialog).
  //
  // Behaviour:
  //   - Auto-focus the textarea on open.
  //   - Cmd+Enter sends; bare Enter inserts a newline. The chat surface
  //     sends on plain Enter — for quick capture we trade that for an
  //     extra modifier so the user can refine the thought before commit.
  //   - Esc closes; if the textarea is non-empty we confirm via the
  //     shared in-app dialog so a stray Esc doesn't nuke a paragraph.
  //   - On first send we look up or create the canonical "Quick captures"
  //     thread, send the message, toast on success, then close. On error
  //     we toast the message and keep the modal open so the user can
  //     retry without retyping.
  //   - Offline / no token gates the Send button + paints a hint strip.
  //   - The bottom-bar "View thread" link uses the same lookup. If the
  //     thread doesn't exist yet (no captures made), it lands the user
  //     on the chat root, where /chat will surface threads.

  import { tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { connection } from '$lib/stores/connection.svelte';
  import { confirmDialog } from '$lib/stores/confirm.svelte';
  import { quickCapture } from '$lib/stores/quick-capture.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';

  // -- constants ------------------------------------------------------------

  /** Canonical title used to discover / create the dedicated thread. The
   *  spec is verbatim ("Quick captures") — do not pluralize, capitalize, or
   *  rename without coordinating with the lookup logic in `findOrCreate`. */
  const QUICK_CAPTURE_THREAD_TITLE = 'Quick captures';

  /** Textarea row caps — 3 rows resting, grow up to 8 as the user types. */
  const ROWS_MIN = 3;
  const ROWS_MAX = 8;

  // -- ui state -------------------------------------------------------------

  let content = $state('');
  let sending = $state(false);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  // -- derived gates --------------------------------------------------------

  /** True when we're confident a send would actually reach the gateway.
   *  Mirrors the same checks the chat composer uses; we treat "no
   *  client" (token missing / disconnected mode) and any non-connected
   *  status as offline so the offline banner + disabled Send button
   *  match the user's mental model. */
  const offline = $derived(!connection.client || connection.status !== 'connected');

  /** Trim-checked content used for the send-enable check and for the
   *  actual wire payload. We don't want to fire blank or whitespace-only
   *  captures. */
  const trimmed = $derived(content.trim());

  const sendDisabled = $derived(offline || sending || trimmed.length === 0);

  // -- lifecycle ------------------------------------------------------------

  // Reset transient state on close so each open is a blank slate — same
  // pattern as CommandPalette / GlobalSearch / ThreadSwitcher.
  $effect(() => {
    if (quickCapture.open) {
      void onOpen();
    } else {
      content = '';
      sending = false;
    }
  });

  async function onOpen() {
    // Wait a tick so the textarea is in the DOM, then focus + position
    // the cursor at the start (content is empty on open anyway, but
    // calling focus directly avoids a flash on slower mounts).
    await tick();
    textareaEl?.focus();
  }

  // -- send path ------------------------------------------------------------

  /**
   * Locate the canonical "Quick captures" thread by title; if absent,
   * create it. Returns the thread id or null when no client is wired
   * (caller should already have gated on `offline`). Errors are
   * propagated so the caller can surface a toast.
   */
  async function findOrCreateQuickCaptureThread(): Promise<string | null> {
    const client = connection.client;
    if (!client) return null;
    // listThreads is the same call the sidebar + ThreadSwitcher use; a
    // single round-trip lets us avoid a stale-cache class of bugs (the
    // user might have created or renamed the thread from another
    // window / surface since we last loaded).
    const list = await client.listThreads();
    const existing = list.find((t) => (t.title ?? '').trim() === QUICK_CAPTURE_THREAD_TITLE);
    if (existing) return existing.id;
    // Create returns `{ id }`. Title collisions are not enforced
    // server-side as of v0.29.0, but the lookup above means the only
    // way we get here is the user genuinely has no Quick captures
    // thread yet — a benign race (two windows creating at once) just
    // produces two threads, which the next discovery call will pick
    // up the older of via list order; acceptable for v1.
    const created = await client.newThread(QUICK_CAPTURE_THREAD_TITLE);
    return created.id || null;
  }

  /** End-to-end send. Closes the modal on success; leaves it open
   *  (with the content intact) on failure so the user can retry. */
  async function send() {
    if (sendDisabled) return;
    const client = connection.client;
    if (!client) {
      // Belt-and-suspenders — the disabled state should have prevented
      // this, but the rune is async-poll-driven and the user could
      // theoretically click in the gap.
      toasts.show('IronClaw is offline. Try again when connected.', 'error');
      return;
    }
    sending = true;
    try {
      const threadId = await findOrCreateQuickCaptureThread();
      if (!threadId) {
        throw new Error('Could not resolve Quick captures thread.');
      }
      await client.sendMessage(threadId, trimmed);
      // Success toast. The `toasts` store doesn't currently support
      // embedded click handlers (only `(message, kind)`), so the
      // discoverable "open thread" affordance lives on the bottom-bar
      // "View thread" link inside the modal; we mention it in the
      // toast copy so the user knows where to find the conversation.
      // The toast message is intentionally short — the surface is
      // about capture, not about confirmation chrome.
      toasts.show(`Captured to ${QUICK_CAPTURE_THREAD_TITLE}.`, 'success');
      // Stash the id on a closed-over local so the click-to-open
      // affordance below can deep-link without re-discovering. We
      // close the modal first so the navigation lands on a clean
      // chrome (matches the GlobalSearch / CommandPalette pattern).
      lastCapturedThreadId = threadId;
      quickCapture.close();
    } catch (err) {
      const msg = (err as Error).message || String(err);
      toasts.show(`Capture failed: ${msg}`, 'error');
      // Leave `content` + `sending=false` so the user can retry.
    } finally {
      sending = false;
    }
  }

  /** Remembered across sends so the "View thread" link can fall through
   *  to a known id without an extra round-trip. Reset only when the
   *  user re-opens the modal — see the open $effect. We deliberately
   *  do NOT clear this on close; the link is also reachable from the
   *  bottom bar pre-send, where we'd want to discover the id fresh. */
  let lastCapturedThreadId: string | null = null;

  // -- handlers -------------------------------------------------------------

  /** Esc-close with a confirm guard when there's unsent text. */
  async function close() {
    if (trimmed.length > 0) {
      const ok = await confirmDialog.ask({
        title: 'Discard this quick capture?',
        body: `Discards the unsent text. It won't reach ${QUICK_CAPTURE_THREAD_TITLE}.`,
        confirmLabel: 'Discard capture',
        cancelLabel: 'Keep writing',
        tone: 'danger'
      });
      if (!ok) return;
    }
    quickCapture.close();
  }

  function onTextareaKeyDown(e: KeyboardEvent) {
    // Cmd+Enter (or Ctrl+Enter on non-Mac) sends. Bare Enter falls
    // through to the textarea's native newline-insert.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      void close();
      return;
    }
  }

  function onBackdropClick(e: MouseEvent) {
    // Only close when the click lands on the backdrop itself — matches
    // the click-outside semantics of the other layout-level modals.
    if (e.target === e.currentTarget) {
      void close();
    }
  }

  /** Footer "View thread" link. Resolves the thread id lazily so users
   *  can jump to the thread even before sending anything in this
   *  session. Falls back to `/` (chat root) if the thread doesn't
   *  exist yet or we can't reach the gateway — better than a 404. */
  async function viewThread() {
    if (lastCapturedThreadId) {
      quickCapture.close();
      void goto(`/chat?thread=${encodeURIComponent(lastCapturedThreadId)}`);
      return;
    }
    const client = connection.client;
    if (!client) {
      // Offline — just route to the chat root; the surface will show
      // the offline state and the user can come back later.
      quickCapture.close();
      void goto('/chat');
      return;
    }
    try {
      const list = await client.listThreads();
      const existing = list.find((t) => (t.title ?? '').trim() === QUICK_CAPTURE_THREAD_TITLE);
      quickCapture.close();
      if (existing) {
        void goto(`/chat?thread=${encodeURIComponent(existing.id)}`);
      } else {
        // No captures yet — land on the chat root.
        void goto('/chat');
      }
    } catch {
      // listThreads failure should not eat the click; route to chat
      // root and rely on the surface to surface the error itself.
      quickCapture.close();
      void goto('/chat');
    }
  }
</script>

{#if quickCapture.open}
  <!-- Backdrop. Click-outside closes (with the same unsent-text confirm
       as Esc). Sits at z-[75] — above CommandPalette (z-50), GlobalSearch
       (z-[70]), and ThreadSwitcher (z-[65]) so a Cmd+Shift+N press while
       another modal is open visually layers correctly. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[75] flex items-start justify-center pt-[18vh] bg-black/60 backdrop-blur-sm"
    onclick={onBackdropClick}
    role="presentation"
  >
    <div
      class="w-[500px] max-w-[92vw] min-h-[180px] flex flex-col bg-bg-deep border border-accent-cyan/40 rounded-xl shadow-2xl overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Quick capture"
    >
      <!-- Title bar. Matches the other modals' top strip but with an
           explicit close button (the spec calls for it) — the other
           modals rely on Esc + click-outside alone. -->
      <div class="flex items-center justify-between gap-3 px-5 py-3 border-b border-border-subtle">
        <div class="flex items-center gap-2">
          <svg
            viewBox="0 0 24 24"
            class="w-4 h-4 text-accent-cyan shrink-0"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <!-- Lightning glyph reads as "quick" — distinct from the
                 chat speech-bubble used by ThreadSwitcher so the user
                 can tell the two modals apart at a glance. -->
            <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
          </svg>
          <span class="text-sm text-text-primary font-mono">Quick capture</span>
        </div>
        <button
          type="button"
          onclick={close}
          class="text-text-muted hover:text-text-primary transition-colors"
          aria-label="Close quick capture"
        >
          <svg
            viewBox="0 0 24 24"
            class="w-4 h-4"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <!-- Composer. The textarea owns its own keyboard shortcuts so
           the layout-level Cmd+Shift+N toggle doesn't fight with it.
           `rows` and `style` together give us the 3-line resting size
           with a 8-line cap; the browser handles intermediate growth
           by virtue of `rows={ROWS_MIN}` + `max-height` capping. -->
      <div class="flex-1 px-5 py-3">
        <textarea
          bind:this={textareaEl}
          bind:value={content}
          onkeydown={onTextareaKeyDown}
          rows={ROWS_MIN}
          placeholder={offline ? 'IronClaw is offline' : 'Type a note…  ⌘↵ send, ↵ newline'}
          aria-label="Quick capture message"
          disabled={offline}
          class="w-full bg-bg-surface/40 border border-border-subtle rounded-md px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted/60 outline-none focus:border-accent-cyan/60 resize-none disabled:opacity-60 disabled:cursor-not-allowed"
          style:max-height="{ROWS_MAX * 1.6}em"
          spellcheck="true"
          autocomplete="off"
        ></textarea>
      </div>

      <!-- Toolbar — Send + View thread + Esc hint. The cyan Send button
           matches the v2 accent vocabulary used by the rest of the app
           (Sidebar pill, status-bar dot). -->
      <div class="flex items-center justify-between gap-3 px-5 py-3 border-t border-border-subtle">
        <div class="flex items-center gap-3 text-[10px] text-text-muted/70 font-mono">
          {#if offline}
            <span class="text-danger">IronClaw is offline.</span>
          {:else}
            <span><kbd class="text-text-muted">⌘↵</kbd> send</span>
            <span><kbd class="text-text-muted">esc</kbd> close</span>
          {/if}
        </div>
        <div class="flex items-center gap-3">
          <button
            type="button"
            onclick={viewThread}
            class="text-[11px] text-accent-cyan hover:text-accent-gold transition-colors font-mono"
          >
            View thread
          </button>
          <button
            type="button"
            onclick={() => void send()}
            disabled={sendDisabled}
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono uppercase tracking-wider bg-accent-cyan text-bg-deep border border-accent-cyan hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
