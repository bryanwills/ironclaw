<script lang="ts">
  // Chat surface — three-column layout: thread rail, message stream + composer,
  // optional tool-inspector rail. Wires the SSE stream from the gateway into
  // the `messages` store and reconciles with /api/chat/history once a stream
  // completes.

  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { connection } from '$lib/stores/connection.svelte';
  import { threads } from '$lib/stores/threads.svelte';
  import { messages, type ToolInvocation } from '$lib/stores/messages.svelte';
  import MarkdownView from '$lib/components/LazyMarkdownView.svelte';
  import StreamingText from '$lib/components/StreamingText.svelte';
  import RebornChatPanel from '$lib/components/RebornChatPanel.svelte';
  // LANE B9 — editable bubble swap (R69)
  import EditableBubble from '$lib/components/EditableBubble.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { notifications } from '$lib/stores/notifications.svelte';
  import { pins } from '$lib/stores/pins.svelte';
  import { threadRename } from '$lib/stores/thread-rename.svelte';
  import { threadModel } from '$lib/stores/thread-model.svelte';
  import { perThreadPrompts } from '$lib/stores/per-thread-prompts.svelte';
  import { composeInstructions } from '$lib/util/prompt-instructions';
  import PerThreadPromptModal from '$lib/components/PerThreadPromptModal.svelte';
  import SkillEditorModal from '$lib/components/SkillEditorModal.svelte';
  import { slashUsage } from '$lib/stores/slash-usage.svelte';
  import { composerInsert } from '$lib/stores/templates.svelte';
  import { telemetry } from '$lib/stores/telemetry.svelte';
  import { surfaceRefresh } from '$lib/stores/surface-refresh.svelte';
  import { windowFocus } from '$lib/stores/window-focus.svelte';
  import { loadSettings } from '$lib/stores/settings.svelte';
  import {
    buildThreadHtml,
    buildThreadJsonText,
    buildThreadMarkdown,
    sanitizeFilenameStem,
    saveTextDialog
  } from '$lib/api/files';
  import type { AttachmentInput, ChatEvent, LlmProvider, Message, Skill } from '$lib/api/types';
  import { estimateTokens } from '$lib/utils/tokens';
  import SlashAutocomplete from '../SlashAutocomplete.svelte';
  import ChatSearch from '../ChatSearch.svelte';
  import ResizeHandle from '$lib/components/ResizeHandle.svelte';
  import LightboxModal from '$lib/components/LightboxModal.svelte';
  import ToolFlowPanel from '$lib/components/ToolFlowPanel.svelte';
  import { toolFlow } from '$lib/stores/tool-flow.svelte';
  import Icon from '$lib/components/Icon.svelte';
  // LANE B2 — chat tabs (R52)
  import ChatTabs from '$lib/components/ChatTabs.svelte';
  import { chatTabs } from '$lib/stores/chat-tabs.svelte';
  // LANE B1 — voice answer (R51)
  import VoiceAnswerBar from '$lib/components/VoiceAnswerBar.svelte';
  import { voiceAnswer } from '$lib/stores/voice-answer.svelte';
  // LANE B5 — time-travel replay (R58, consumes R59 events store)
  import ReplayBar from '$lib/components/ReplayBar.svelte';
  import { replay } from '$lib/stores/replay.svelte';
  import { replayUI } from '$lib/stores/replay-ui.svelte';
  // LANE B4 — sub-agent dispatch (R56/R57)
  import SubAgentChip from '$lib/components/SubAgentChip.svelte';
  import { subAgents } from '$lib/stores/sub-agents.svelte';
  // R89 — non-destructive thread recap
  import RecapPanel from '$lib/components/RecapPanel.svelte';
  import { recap } from '$lib/stores/recap.svelte';
  import { computeThreadStats } from '$lib/util/thread-stats';
  // Council — multi-model fanout, summoned from chat via /council
  import CouncilPanel from '$lib/components/CouncilPanel.svelte';
  import { council } from '$lib/stores/council.svelte';
  // R101 — Chief of Staff daily brief ("Brief me"). Reads recent threads +
  // tracked open loops, runs a one-off completion under the CoS persona.
  import BriefingPanel from '$lib/components/BriefingPanel.svelte';
  import { briefing } from '$lib/stores/briefing.svelte';
  import { openLoops } from '$lib/stores/open-loops.svelte';
  // R104 — Chief of Staff thread triage ("Triage my threads").
  import TriagePanel from '$lib/components/TriagePanel.svelte';
  import { triage } from '$lib/stores/triage.svelte';
  // R105 — Chief of Staff "draft a reply" (draft to send).
  import DraftPanel from '$lib/components/DraftPanel.svelte';
  import { draft } from '$lib/stores/draft.svelte';
  // LANE W3 — reply-thread panel (R80, consumes R79 store)
  import ReplyThreadPanel from '$lib/components/ReplyThreadPanel.svelte';
  import { replyThreadUI } from '$lib/stores/reply-thread-ui.svelte';
  import { workItems } from '$lib/stores/work-items.svelte';
  import { type WorkItem, type WorkItemApprovalBoundary } from '$lib/data/work-item';
  import { requiresApproval } from '$lib/util/approval-enforcement';
  import { orchestrateChiefOfStaffAsk } from '$lib/util/workflow-orchestrator';
  import { attachmentRiskSource } from '$lib/util/attachment-risk';
  import { shouldKeepRoutedWorkInChat } from '$lib/util/chat-work-routing';

  // ---- Pane widths (drag-to-resize) ----------------------------------------
  //
  // Thread rail (left) + tool inspector (right) are both user-resizable via
  // a `ResizeHandle` strip. Widths persist to localStorage so the layout
  // sticks across reloads. Below `NARROW_VIEWPORT_PX` we drop the handles
  // and revert to the fixed defaults — at that width the third column is
  // already tight and a drag would just thrash the layout.
  //
  // TODO: persist a "narrow viewport collapsed" affordance once the chat
  // page grows a real mobile breakpoint. For now <900px just stops
  // honoring the persisted value; the user keeps their saved width when
  // they widen the window again.
  const THREAD_RAIL_DEFAULT = 260;
  const THREAD_RAIL_MIN = 200;
  const THREAD_RAIL_MAX = 480;
  const INSPECTOR_DEFAULT = 240;
  const INSPECTOR_MIN = 200;
  const INSPECTOR_MAX = 480;
  const NARROW_VIEWPORT_PX = 900;
  const THREAD_RAIL_STORAGE_KEY = 'ironclaw-chat-rail-width';
  const INSPECTOR_STORAGE_KEY = 'ironclaw-chat-inspector-width';

  let threadRailWidth = $state<number>(THREAD_RAIL_DEFAULT);
  let inspectorWidth = $state<number>(INSPECTOR_DEFAULT);
  /** Tracks window inner width via a `resize` listener wired in onMount.
   *  Below `NARROW_VIEWPORT_PX` the resize handles are hidden and the
   *  layout uses the fixed defaults regardless of the persisted value. */
  let viewportWidth = $state<number>(typeof window === 'undefined' ? 1280 : window.innerWidth);
  const resizeEnabled = $derived(viewportWidth >= NARROW_VIEWPORT_PX);
  /** Effective rail width — defaults when resizing is disabled, otherwise
   *  whatever the user dragged to / hydrated from localStorage. */
  const effectiveThreadRailWidth = $derived(resizeEnabled ? threadRailWidth : THREAD_RAIL_DEFAULT);
  const effectiveInspectorWidth = $derived(resizeEnabled ? inspectorWidth : INSPECTOR_DEFAULT);

  // -- local state ------------------------------------------------------------
  let composerEl = $state<HTMLTextAreaElement | null>(null);
  let scrollEl = $state<HTMLDivElement | null>(null);
  let input = $state('');
  let sending = $state(false);
  const routedLegacyWorkItems = new Map<string, string>();
  let abortController: AbortController | null = null;
  let rightRailOpen = $state(false);
  let renaming = $state(false);
  let titleDraft = $state('');
  // Right-click kebab menu next to the title — currently a single
  // "Revert to server title" action. The dropdown closes on outside
  // click and Escape via the effect below.
  let renameMenuOpen = $state(false);
  let renameMenuButtonEl = $state<HTMLButtonElement | null>(null);
  let renameMenuEl = $state<HTMLDivElement | null>(null);
  // First-use tooltip for the rename input. Hydrated from the rename
  // store's localStorage flag on mount so a dismissal in a previous
  // session sticks. Set false the moment the user dismisses it (or
  // commits a rename) and persisted via `threadRename.markTooltipSeen`.
  let showRenameTooltip = $state(false);
  let expandedTools = $state<Record<string, boolean>>({});
  let retryingIds = $state<Record<string, boolean>>({});

  // Per-thread system-prompt modal (R43). Opened from the kebab menu;
  // owns the visible state (and bumps `promptVersion` on close so the
  // header chip + the in-flight stream pick up the new override
  // without a hard reload). `promptVersion` is read inside
  // `streamResponse` via `untrack` so we don't accidentally rerun the
  // whole effect just because the user opened the modal.
  let promptModalOpen = $state(false);
  let promptVersion = $state(0);

  // Scroll-to-bottom FAB state. The threshold mirrors the prompt: any drift
  // >100px from the bottom of the stream counts as "scrolled up". We only
  // surface the FAB during streaming or when new history arrives below the
  // user's current viewport.
  const SCROLL_BOTTOM_THRESHOLD = 100;
  let isAtBottom = $state(true);
  let showScrollFab = $state(false);

  // Lazy history load: when the user scrolls within this many pixels of the
  // top of the message stream AND the thread has more pages to fetch, pull
  // the next page of older messages. 200px gives a smooth "as you approach
  // the top, the next page is already there" feel without firing the load
  // on every micro-scroll.
  const SCROLL_TOP_THRESHOLD = 200;

  // ---- Thread-rail virtualization ------------------------------------------
  // The rail renders all thread buttons in one <ul> for the common case
  // (typical user: <50 threads). Once we cross the threshold we switch to a
  // windowed render that mirrors src/routes/logs/+page.svelte: a scroll
  // viewport with two spacer divs framing the visible slice. This keeps
  // DOM nodes flat (~viewport+overscan rows) so the rail stays responsive
  // even when the user accumulates hundreds of conversations.
  //
  // Threshold rationale: under 30 threads the windowing adds DOM churn
  // (spacer divs, scroll bookkeeping, auto-scroll-into-view math) without
  // a measurable win — the un-virtualized list is already fast. Above 30
  // we flip on virtualization unconditionally.
  const THREAD_VIRTUALIZE_THRESHOLD = 30;
  /**
   * Fixed row height for each thread button. Matches the existing markup:
   * `py-2` (16px vertical padding) + `text-sm` title line (~20px) +
   * `gap-0.5` (2px) + `text-[10px]` timestamp line (~14px) +
   * `space-y-0.5` gutter (2px) ≈ 54-55px. 56 leaves a 1-2px buffer so
   * subpixel rounding never lets two rows merge into one viewport slot.
   *
   * Titles are forced to a single line via `truncate` so a long title can
   * never grow the row past this height.
   */
  const THREAD_ITEM_HEIGHT = 56;
  /**
   * Rows mounted above + below the visible window. Keeps the user from
   * seeing blank flashes during fast scrolls without ballooning the DOM.
   */
  const THREAD_OVERSCAN = 10;

  // Reactive viewport state for the rail. `threadRailEl` is the scrollable
  // container (the `.overflow-y-auto` wrapper); `threadScrollTop` and
  // `threadViewportHeight` drive the window slice. All three reset to 0
  // when virtualization isn't active so a sudden jump from <=30 to >30
  // threads renders cleanly from the top.
  let threadRailEl = $state<HTMLDivElement | null>(null);
  let threadScrollTop = $state(0);
  let threadViewportHeight = $state(0);

  // Draft persistence — sessionStorage so drafts survive thread switching
  // and page reloads in the same tab, but don't bleed across tabs/windows.
  // Key prefix mirrors the prompt; the `__new__` slot is used before a
  // real thread id exists and is promoted on first successful send.
  const DRAFT_PREFIX = 'ironclaw-draft:';
  const DRAFT_NEW_KEY = `${DRAFT_PREFIX}__new__`;
  const DRAFT_DEBOUNCE_MS = 300;
  let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let draftLoadedFor: string | null = null;
  let suppressDraftSave = false;

  // Slash-command autocomplete state. The cached `skillCatalog` is loaded
  // once on chat mount (lazily, so we don't block first paint) and reused
  // across thread switches. `caret` mirrors composerEl.selectionStart so
  // the SlashAutocomplete component can locate the active `/token`.
  let skillCatalog = $state<Skill[]>([]);
  let skillCatalogLoaded = $state(false);
  let caret = $state(0);
  // Svelte 5: `bind:this` on a component yields its export object, not a
  // class instance. Use the shape (handleKey) directly so the type-checker
  // stops trying to instantiate the new `Component<...>` type.
  let slashAutoEl = $state<{ handleKey: (e: KeyboardEvent) => boolean } | null>(null);

  // Cmd/Ctrl+F find-in-thread state. `contentVersion` is incremented on
  // every render-relevant signal so the embedded search bar knows when
  // to rebuild its <mark> overlay; that rebuild is debounced inside the
  // component to keep streaming smooth.
  let searchOpen = $state(false);
  let contentVersion = $state(0);

  // -- attachments ------------------------------------------------------------
  // v2 (R49): supports IMAGES + DOCUMENTS + SPREADSHEETS + TEXT.
  //
  // Gateway probe (verified 2026-05-28 against baremetal3 v0.29):
  // `/api/chat/send` with `{attachments: [{name, mime_type, data_base64}]}`
  // returns `{status: "accepted"}` for any mime — the gateway stores the
  // bytes at `.ironclaw/attachments/<owner>/<thread>/<date>/<msg>-<name>`
  // and rewrites the user's content to append an `<attachments>` block.
  // Whether the model actually READS the file depends on the provider —
  // images go through the vision pipeline, PDFs land via attachment-block
  // reference (Claude/GPT-4o reads them, others see the filename only).
  //
  // Per-file size cap raised to 25 MB to cover typical PDFs / xlsx / docx;
  // total-files cap stays at 5 so the in-memory base64 doesn't blow up the
  // JSON body. The strip renders ABOVE the textarea, flush against its top
  // border; non-image attachments render as a file-icon chip instead of a
  // thumbnail.
  const ALLOWED_MIME = new Set([
    // images (existing vision path)
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    // documents — PDF goes through the model's PDF reader where supported
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'application/rtf',
    // spreadsheets
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'text/csv',
    'text/tab-separated-values',
    // presentations
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
    // text / data
    'text/plain',
    'text/markdown',
    'text/x-markdown',
    'application/json',
    'application/x-yaml',
    'text/yaml',
    'application/xml',
    'text/xml',
    'text/html'
  ]);
  // Browsers report some extensions with an empty `file.type` (e.g. `.md`,
  // `.csv` on Safari). Fall back to the file extension so the user isn't
  // confused by a paste that "silently disappears."
  const EXT_TO_MIME: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    rtf: 'application/rtf',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    json: 'application/json',
    yaml: 'application/x-yaml',
    yml: 'application/x-yaml',
    xml: 'application/xml',
    html: 'text/html',
    htm: 'text/html'
  };
  function inferMime(file: File): string {
    if (file.type) return file.type;
    const ext = file.name.split('.').pop()?.toLowerCase();
    return ext ? (EXT_TO_MIME[ext] ?? '') : '';
  }
  function isImageMime(mime: string): boolean {
    return mime.startsWith('image/');
  }
  /** Short type tag for the chip when there's no thumbnail. Falls back to
   *  the extension uppercased so a `.foo.bar.baz` paste still gets a chip. */
  function shortType(mime: string, name: string): string {
    const map: Record<string, string> = {
      'application/pdf': 'PDF',
      'application/msword': 'DOC',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
      'application/rtf': 'RTF',
      'application/vnd.ms-excel': 'XLS',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
      'text/csv': 'CSV',
      'text/tab-separated-values': 'TSV',
      'application/vnd.ms-powerpoint': 'PPT',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
      'text/plain': 'TXT',
      'text/markdown': 'MD',
      'text/x-markdown': 'MD',
      'application/json': 'JSON',
      'application/x-yaml': 'YAML',
      'text/yaml': 'YAML',
      'application/xml': 'XML',
      'text/xml': 'XML',
      'text/html': 'HTML'
    };
    if (map[mime]) return map[mime];
    const ext = name.split('.').pop()?.toUpperCase();
    return ext ?? 'FILE';
  }
  const MAX_ATTACHMENTS = 5;
  const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

  /** One pending attachment held in the composer. `previewUrl` is a blob:
   *  URL we keep alive while the chip is mounted; revoked on remove/send so
   *  we don't leak memory. `dataBase64` is the raw payload (no `data:` prefix). */
  interface PendingAttachment {
    /** Stable client-side id so Svelte's keyed each block re-renders cleanly
     *  when a chip is removed mid-strip. */
    id: string;
    name: string;
    mime: string;
    size: number;
    /** blob: URL for the inline thumbnail. */
    previewUrl: string;
    /** RAW base64 (no `data:` prefix). Populated post-FileReader. */
    dataBase64: string;
  }

  let attachments = $state<PendingAttachment[]>([]);
  let dragDepth = $state(0); // counter for nested dragenter/leave noise
  let attachmentInputEl = $state<HTMLInputElement | null>(null);

  // ---- Image lightbox ------------------------------------------------------
  // Walks every <img> click inside the message stream via event delegation —
  // assistant markdown images, optimistic user-message blob: previews, and
  // pending-attachment thumbnails all open the same overlay. Capturing the
  // src is enough; the modal pulls the bytes via the same URL (no copy).
  let lightboxSrc = $state<string | null>(null);
  let lightboxAlt = $state<string>('Preview');

  // ---- Voice input (Web Speech API) ---------------------------------------
  // The spec calls the constructor `SpeechRecognition`; webkit-prefixed
  // browsers (Chromium / Safari) ship `webkitSpeechRecognition`. Firefox
  // does not implement the spec; the mic button stays disabled there.
  //
  // Cursor anchoring: when dictation starts we snapshot `selectionStart`
  // so interim transcripts only overwrite the SUFFIX past the anchor,
  // leaving anything the user already typed before the caret untouched.
  // On stop (toggle, 3s silence, or unmount) the final transcript replaces
  // the interim region and the caret advances past the inserted text.
  //
  // Auto-stop: a 3-second silence timer is rearmed on every `result` event;
  // when it fires we trigger the same stop path as the toggle button so
  // the final transcript is committed and the recognizer is torn down.
  let voiceSupported = $state(false);
  let voiceListening = $state(false);
  let voiceAnchor = 0;
  let voiceInterimText = '';
  // Use a loose type — typings for SpeechRecognition aren't in tsconfig's
  // default lib set. We dispatch through a small adapter so the rest of
  // the code stays type-safe at the call-site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let voiceRec: any = null;
  let voiceSilenceTimer: ReturnType<typeof setTimeout> | null = null;
  const VOICE_SILENCE_MS = 3000;

  // ---- Conversation branching ---------------------------------------------
  // Each assistant bubble exposes a small Branch button on hover. Clicking
  // pops a confirm dialog; on confirm we fork the thread.
  //
  // Server-side `/api/chat/threads/<id>/branch` does NOT exist on IronClaw
  // (probed 2026-05-27: 404). Fallback: create a fresh thread via
  // `client.newThread('Fork: ...')` and seed it with a first user message
  // that concatenates every user/assistant pair up to and including the
  // forked assistant turn, so the model has the same context to reason
  // from. The server-side `branchEndpointAvailable` flag is also probed
  // on first click so we can opt into a native branch route the moment
  // the gateway adds one — see `tryBranch()`.
  let branchTargetId = $state<string | null>(null);
  let branching = $state(false);
  /** Tri-state: `null` until first probe; then true/false. */
  let branchEndpointAvailable: boolean | null = null;

  // -- derived ----------------------------------------------------------------
  const currentThread = $derived(threads.current);
  const currentId = $derived(threads.currentId);
  const history = $derived<Message[]>(currentId ? messages.get(currentId) : []);
  const streamingBuffer = $derived(currentId ? messages.getStreaming(currentId) : '');
  const isStreaming = $derived(currentId ? messages.isStreaming(currentId) : false);
  const streamError = $derived(currentId ? messages.getError(currentId) : null);
  const tools = $derived<ToolInvocation[]>(currentId ? messages.getTools(currentId) : []);

  // A send is permitted when the user has typed at least one character OR
  // attached at least one file. The legacy gateway accepts an empty content
  // string (it gets rewritten to include the `<attachments>` block), so an
  // attachment-only send is fine.
  const canSend = $derived(
    !!connection.client &&
      (input.trim().length > 0 || attachments.length > 0) &&
      !sending &&
      !isStreaming
  );

  const isLoadingMore = $derived(currentId ? messages.isLoadingMore(currentId) : false);
  const hasNoMoreHistory = $derived(currentId ? messages.hasNoMoreHistory(currentId) : false);

  // ---- Provider chip cache --------------------------------------------------
  //
  // Cache the `/api/llm/providers` catalog once per connect so the header
  // chip can resolve `connection.activeProfile.llmProviderId` to a human-
  // readable name without re-hitting the gateway on every render. The
  // catalog is small (one entry per builtin provider, ~10 today) and
  // changes only when the user installs / configures a new provider —
  // refreshing on connect is plenty.
  //
  // Failures (network drop, gateway 5xx) fall back to an empty array so
  // the chip silently renders the bare provider id rather than crashing.
  let llmProviders = $state<LlmProvider[]>([]);

  /**
   * Resolved active provider for the current connection. Reads the
   * profile's `llmProviderId` (the new richer field) with a fall-back
   * to the legacy `llmBackend` binary marker for older profiles, then
   * looks the id up in the cached catalog to get a display name +
   * default model.
   *
   * `undefined` when there's no active profile or no matching entry —
   * the chip renders nothing in that case rather than a half-broken
   * "Unknown" badge.
   */
  const activeProvider = $derived.by(() => {
    const profile = connection.activeProfile;
    if (!profile) return undefined;
    const id = profile.llmProviderId ?? profile.llmBackend;
    if (!id) return undefined;
    const match = llmProviders.find((p) => p.id === id);
    if (match) return match;
    // Fallback: synthesize a minimal provider so the chip can still
    // render the id (better than no chip at all). `default_model` stays
    // undefined so the tooltip doesn't lie about a model we don't know.
    return { id, name: id } as LlmProvider;
  });

  /**
   * Estimated total token count for the currently-active thread, computed
   * by summing `estimateTokens` over every message in the thread. Memoized
   * via `$derived` so the recompute only fires when the messages array
   * actually changes — typing in the composer doesn't re-run the sum.
   *
   * Returns null when there's no active thread or the message list is
   * empty; the chip render checks for null and skips rather than
   * surfacing "~0 tokens".
   */
  const currentThreadTokens = $derived.by(() => {
    if (!currentId) return null;
    const msgs = messages.get(currentId);
    if (!msgs || msgs.length === 0) return null;
    let sum = 0;
    for (const m of msgs) sum += estimateTokens(m.content);
    return sum;
  });

  // ---- Thread-rail derived values ------------------------------------------
  /**
   * Sorted thread list — single source of truth for both render paths.
   * Pinned threads (per the cross-surface pin store) hoist to the top
   * in pin-chronological order, then the remainder follows the
   * threads-store sort (updated_at desc). This keeps the rail's visual
   * order consistent with what a user picked as "favorites" while still
   * surfacing recent activity for the rest.
   */
  const sortedThreads = $derived.by(() => {
    const base = threads.sorted;
    const pinIds = pins.pins.thread;
    if (pinIds.length === 0) return base;
    const byId = new Map(base.map((t) => [t.id, t]));
    const pinnedThreads: typeof base = [];
    const seen = new Set<string>();
    for (const id of pinIds) {
      const t = byId.get(id);
      if (t) {
        pinnedThreads.push(t);
        seen.add(id);
      }
    }
    const rest = base.filter((t) => !seen.has(t.id));
    return [...pinnedThreads, ...rest];
  });
  /** Flip into virtualized mode once the list crosses the threshold. */
  const threadsVirtualized = $derived(sortedThreads.length > THREAD_VIRTUALIZE_THRESHOLD);

  /**
   * Visible window slice. Mirrors the logs route's pattern:
   * `firstIndex = max(0, floor(scrollTop / H) - OVERSCAN)`,
   * `lastIndex = min(N-1, ceil((scrollTop + viewport) / H) + OVERSCAN)`.
   * Returns the indices + sliced rows; spacers above/below preserve total
   * scrollHeight so the native scrollbar still represents the full list.
   * When virtualization is off (or there's no viewport measurement yet),
   * the slice collapses to an empty window — the un-virtualized branch
   * in the template takes over.
   */
  const threadWindow = $derived.by(() => {
    const total = sortedThreads.length;
    if (!threadsVirtualized || total === 0 || threadViewportHeight === 0) {
      return {
        first: 0,
        last: -1,
        items: [] as Array<{ thread: (typeof sortedThreads)[number]; index: number }>
      };
    }
    const rough = Math.floor(threadScrollTop / THREAD_ITEM_HEIGHT);
    const visibleCount = Math.ceil(threadViewportHeight / THREAD_ITEM_HEIGHT);
    const first = Math.max(0, rough - THREAD_OVERSCAN);
    const last = Math.min(total - 1, rough + visibleCount + THREAD_OVERSCAN);
    const items: Array<{ thread: (typeof sortedThreads)[number]; index: number }> = [];
    for (let i = first; i <= last; i++) items.push({ thread: sortedThreads[i], index: i });
    return { first, last, items };
  });
  /** Top spacer = rows skipped above the window. */
  const threadTopSpacer = $derived(
    threadsVirtualized ? Math.max(0, threadWindow.first) * THREAD_ITEM_HEIGHT : 0
  );
  /** Bottom spacer = rows skipped below the window (last is inclusive). */
  const threadBottomSpacer = $derived(
    threadsVirtualized
      ? Math.max(0, sortedThreads.length - threadWindow.last - 1) * THREAD_ITEM_HEIGHT
      : 0
  );

  // -- draft helpers ----------------------------------------------------------
  // sessionStorage is browser-only; the SvelteKit prerender pass would crash
  // without these guards even though the route is CSR-only in prod.
  function draftKey(id: string | null): string {
    return id ? `${DRAFT_PREFIX}${id}` : DRAFT_NEW_KEY;
  }

  function loadDraft(id: string | null): string {
    if (typeof window === 'undefined') return '';
    try {
      return window.sessionStorage.getItem(draftKey(id)) ?? '';
    } catch {
      return '';
    }
  }

  function writeDraft(id: string | null, value: string): void {
    if (typeof window === 'undefined') return;
    try {
      if (value.length === 0) {
        window.sessionStorage.removeItem(draftKey(id));
      } else {
        window.sessionStorage.setItem(draftKey(id), value);
      }
    } catch {
      // Storage may be full or disabled; non-fatal — drafts are best-effort.
    }
  }

  function scheduleDraftSave(): void {
    if (suppressDraftSave) return;
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    const id = threads.currentId;
    const value = input;
    draftSaveTimer = setTimeout(() => {
      writeDraft(id, value);
      draftSaveTimer = null;
    }, DRAFT_DEBOUNCE_MS);
  }

  function flushDraftSave(): void {
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = null;
    }
    writeDraft(draftLoadedFor, input);
  }

  function openConnectionSettings(): void {
    flushDraftSave();
    void goto('/settings');
  }

  /**
   * Apply a stored draft to the textarea without scheduling another save —
   * setting `input` would otherwise re-trigger the `$effect` watching it.
   */
  function applyDraft(value: string): void {
    suppressDraftSave = true;
    input = value;
    // tick to let auto-grow size the textarea, then re-enable saves.
    void tick().then(() => {
      autoGrow();
      suppressDraftSave = false;
    });
  }

  // -- scroll helpers ---------------------------------------------------------
  function computeAtBottom(): boolean {
    if (!scrollEl) return true;
    const drift = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    return drift <= SCROLL_BOTTOM_THRESHOLD;
  }

  function onScroll(): void {
    isAtBottom = computeAtBottom();
    if (isAtBottom && showScrollFab) showScrollFab = false;
    // Fire-and-forget lazy load — guards inside maybeLoadMore() handle
    // already-loading, no-more-pages, and missing-thread cases. Async work
    // happens off this synchronous scroll callback so we don't stall paint.
    void maybeLoadMore();
  }

  /**
   * If the user has scrolled near the top and the current thread plausibly
   * has more older messages on the server, fetch the next page and prepend
   * it without jumping the viewport.
   *
   * Scroll preservation: we measure `scrollHeight` BEFORE the prepend, await
   * the store mutation + a `tick()` so the new DOM nodes lay out, then
   * advance `scrollTop` by the height delta. The user's view stays anchored
   * on the same message they were reading.
   *
   * Edge cases handled here (so the heuristic in the prompt holds without
   * a separate "modulo page size" check):
   *   - `hasNoMoreHistory` — server already returned a short page; bail.
   *   - `isLoadingMore`  — one fetch in flight at a time per thread.
   *   - `history.length === 0` — nothing to anchor against yet.
   *   - `scrollEl` cleared between threads — destructure-safe.
   */
  async function maybeLoadMore(): Promise<void> {
    if (!scrollEl) return;
    const id = currentId;
    if (!id) return;
    if (isLoadingMore || hasNoMoreHistory) return;
    if (history.length === 0) return;
    if (scrollEl.scrollTop > SCROLL_TOP_THRESHOLD) return;
    // Snapshot scrollHeight at the moment we decide to fetch. The user might
    // keep scrolling while the request is in flight; that's fine — the diff
    // we apply below still reflects "rows that were inserted above the
    // current viewport during this load".
    const prevScrollHeight = scrollEl.scrollHeight;
    const prevScrollTop = scrollEl.scrollTop;
    const added = await messages.loadMoreHistory(id);
    if (added === 0) return;
    await tick();
    if (!scrollEl) return;
    const delta = scrollEl.scrollHeight - prevScrollHeight;
    if (delta > 0) {
      scrollEl.scrollTop = prevScrollTop + delta;
    }
  }

  function scrollToBottom(smooth = true): void {
    if (!scrollEl) return;
    scrollEl.scrollTo({
      top: scrollEl.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto'
    });
    isAtBottom = true;
    showScrollFab = false;
  }

  // -- mount ------------------------------------------------------------------
  // Deep-link target captured once on mount from `?thread=<id>` (set by
  // GlobalSearch R14b / CommandPalette R6η). We grab it synchronously here
  // so a slow `boot()` doesn't race with a URL-param mutation from
  // elsewhere; the actual `selectThread` happens after the thread list
  // resolves inside `boot()`.
  let pendingThreadId: string | null = null;

  onMount(() => {
    pendingThreadId = page.url.searchParams.get('thread');
    void boot();
    // Hydrate the composer from whichever draft matches the current thread
    // (or the __new__ slot if no thread is selected yet).
    const id = threads.currentId;
    const stored = loadDraft(id);
    if (stored) applyDraft(stored);
    draftLoadedFor = id;

    // LANE B2 — chat tabs: bind to the active profile so tabs are
    // partitioned per-workspace, then seed the current thread as a
    // tab if it isn't already in the strip.
    chatTabs.bindProfile(connection.activeProfile?.id ?? null);
    if (id) chatTabs.open(id);

    // LANE B5 — time-travel replay (R58): Cmd+. toggles the replay bar
    // for the current thread. Opening triggers a one-shot fetch of the
    // event timeline via replay.loadFor(); the bar consumes the loaded
    // events.
    const onReplayShortcut = (ev: KeyboardEvent) => {
      const mod = ev.metaKey || ev.ctrlKey;
      if (!mod || ev.key !== '.') return;
      const tid = threads.currentId;
      if (!tid) return;
      ev.preventDefault();
      replayUI.toggle(tid);
      if (replayUI.isOpenFor(tid)) {
        void replay.loadFor(tid);
      }
    };
    window.addEventListener('keydown', onReplayShortcut);
    onDestroy(() => window.removeEventListener('keydown', onReplayShortcut));

    // LANE B2 — chat tabs keyboard shortcuts (R52 follow-up):
    //   Cmd+W      — close current tab (browser convention)
    //   Cmd+1..9   — switch to tab N (1-indexed)
    const onTabShortcut = (ev: KeyboardEvent) => {
      const mod = ev.metaKey || ev.ctrlKey;
      if (!mod) return;
      const t = ev.target;
      if (t instanceof HTMLElement) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) return;
      }
      if (ev.key.toLowerCase() === 'w' && !ev.shiftKey) {
        const active = chatTabs.activeTabId;
        if (!active) return;
        ev.preventDefault();
        const next = chatTabs.close(active);
        if (next && next !== threads.currentId) {
          onSelectThread(next);
        }
        return;
      }
      const digit = Number(ev.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
        const tabId = chatTabs.openTabs[digit - 1];
        if (!tabId) return;
        ev.preventDefault();
        chatTabs.setActive(tabId);
        if (tabId !== threads.currentId) onSelectThread(tabId);
      }
    };
    window.addEventListener('keydown', onTabShortcut);
    onDestroy(() => window.removeEventListener('keydown', onTabShortcut));

    // LANE B4 — sub-agent delegate (R57): Cmd+Shift+D delegates the
    // latest user turn in the current thread to a background sub-agent.
    // Gracefully no-ops + toasts when the gateway lacks /api/v1/tasks.
    const onDelegateShortcut = (ev: KeyboardEvent) => {
      const mod = ev.metaKey || ev.ctrlKey;
      if (!mod || !ev.shiftKey || ev.key.toLowerCase() !== 'd') return;
      const tid = threads.currentId;
      if (!tid) return;
      ev.preventDefault();
      const hist = messages.get(tid);
      const lastUser = [...hist].reverse().find((m) => m.role === 'user');
      if (!lastUser || !lastUser.content.trim()) {
        toasts.show('Send a message first', 'info');
        return;
      }
      void subAgents
        .dispatch({ prompt: lastUser.content, parentThreadId: tid })
        .then((id) => {
          if (id === null) {
            toasts.show('Sub-agents need a newer IronClaw gateway.', 'info');
          } else {
            toasts.show('Delegated to a sub-agent', 'success');
          }
        })
        .catch((err) => toasts.show(`Delegate failed: ${(err as Error).message}`, 'error'));
    };
    window.addEventListener('keydown', onDelegateShortcut);
    onDestroy(() => window.removeEventListener('keydown', onDelegateShortcut));

    // Hydrate pane widths from localStorage. ResizeHandle pushes the
    // hydrated value back via `onresize` on its own mount, but reading
    // here lets us render the first frame at the persisted width rather
    // than the default → flash → resize sequence.
    try {
      if (typeof localStorage !== 'undefined') {
        const railRaw = localStorage.getItem(THREAD_RAIL_STORAGE_KEY);
        const railParsed = railRaw === null ? NaN : Number.parseInt(railRaw, 10);
        if (Number.isFinite(railParsed)) {
          threadRailWidth = Math.min(Math.max(railParsed, THREAD_RAIL_MIN), THREAD_RAIL_MAX);
        }
        const insRaw = localStorage.getItem(INSPECTOR_STORAGE_KEY);
        const insParsed = insRaw === null ? NaN : Number.parseInt(insRaw, 10);
        if (Number.isFinite(insParsed)) {
          inspectorWidth = Math.min(Math.max(insParsed, INSPECTOR_MIN), INSPECTOR_MAX);
        }
      }
    } catch {
      // ignore — fall through to defaults.
    }

    // Track viewport width so the resize handles can opt out below the
    // narrow-viewport threshold. Listener is passive — no preventDefault.
    const onResize = () => {
      viewportWidth = window.innerWidth;
    };
    viewportWidth = window.innerWidth;
    window.addEventListener('resize', onResize);

    // Lazily prime the skill catalog for slash autocomplete. We don't
    // block boot on it — the dropdown simply has no candidates until
    // the catalog lands, and re-fetches are skipped via the loaded flag.
    void loadSkillCatalog();

    // Hydrate the slash-usage store so the autocomplete's "recently
    // used" ranking is in place on the first dropdown render. Cheap
    // localStorage read; the root layout hydrates other stores there,
    // but this one is only consumed inside the chat composer so we
    // keep it scoped to this mount.
    slashUsage.init();

    // Hydrate the per-thread provider tracker so the chat-header chip
    // can render the recorded provider for previously-tagged threads
    // without waiting for the next assistant turn.
    threadModel.init();

    // Surface refresh (Cmd+R): refetch the thread list and, if a thread
    // is selected, its full message history. Mirrors what `boot()` does
    // post-init minus the deep-link consumption (we're not navigating).
    // Errors surface through the existing toast paths inside
    // `threads.loadThreads()` and `messages.loadHistory()`.
    surfaceRefresh.register(async () => {
      if (!connection.client) return;
      await threads.loadThreads();
      if (threads.currentId) {
        await messages.loadHistory(threads.currentId);
      }
    });

    // Cmd/Ctrl+F → open find bar. Captured at the document level so the
    // shortcut still fires when focus is in the textarea or any sidebar
    // control. We swallow the event so the browser's native find doesn't
    // run inside the Tauri webview.
    const onGlobalKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && (e.key === 'f' || e.key === 'F') && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        searchOpen = true;
      }
    };
    document.addEventListener('keydown', onGlobalKey);

    // Detect Web Speech API availability so we can disable the mic button
    // with a tooltip on unsupported browsers (Firefox today). The reference
    // is stashed on the window object so we don't repeat the lookup each
    // time the user toggles dictation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any };
    voiceSupported = !!(w.SpeechRecognition || w.webkitSpeechRecognition);

    return () => {
      if (draftSaveTimer) clearTimeout(draftSaveTimer);
      document.removeEventListener('keydown', onGlobalKey);
      window.removeEventListener('resize', onResize);
      // Tear down any in-flight dictation so the mic isn't held open after
      // the chat surface unmounts (route change, profile switch, etc.).
      if (voiceRec) {
        try {
          voiceRec.onresult = null;
          voiceRec.onend = null;
          voiceRec.onerror = null;
          voiceRec.stop();
        } catch {
          /* ignore */
        }
        voiceRec = null;
      }
      if (voiceSilenceTimer) {
        clearTimeout(voiceSilenceTimer);
        voiceSilenceTimer = null;
      }
    };
  });

  // Release the surface-refresh registration on unmount so the layout's
  // Cmd+R falls through to a no-op until the next route registers.
  onDestroy(() => surfaceRefresh.unregister());

  async function loadSkillCatalog(): Promise<void> {
    if (skillCatalogLoaded) return;
    if (!connection.client) return;
    try {
      const skills = await connection.client.listSkills();
      skillCatalog = skills;
      skillCatalogLoaded = true;
    } catch {
      // Non-fatal — slash autocomplete just won't have candidates. We
      // intentionally don't toast here; the user hasn't asked for skills
      // yet and a noisy error on mount would be hostile.
    }
  }

  /**
   * Warm the LLM provider catalog used by the chat header chip. The chip
   * resolves `connection.activeProfile.llmProviderId` → provider display
   * name against this cache; falling through to a re-fetch on every render
   * would hammer the gateway needlessly. Best-effort: on failure the chip
   * just renders the bare provider id (still better than no chip at all).
   */
  async function loadLlmProviderCatalog(): Promise<void> {
    if (!connection.client) return;
    try {
      llmProviders = await connection.client.listLlmProviders();
    } catch {
      // Non-fatal — the chip falls through to rendering the id verbatim.
    }
  }

  async function boot() {
    // Connection store is initialized by the sidebar's onMount; if the user
    // landed here first we still want a client, so init defensively.
    await connection.init();
    if (connection.apiVersion === 'v2') {
      // RebornChatPanel owns v2 thread loading/deep-link selection. The v1
      // boot path below calls legacy thread/history endpoints and would turn
      // valid Reborn `?thread=` links into false "Conversation not found"
      // toasts before the v2 rail has a chance to select them.
      pendingThreadId = null;
      void loadSkillCatalog();
      void loadLlmProviderCatalog();
      return;
    }
    if (connection.client) {
      await threads.loadThreads();
      // Apply `?thread=<id>` deep-link AFTER the list resolves so we can
      // verify the id is still live. If the target was deleted between
      // emission and consumption (stale link), surface a toast and let
      // the existing selection stand; either way the URL param is cleared
      // so refresh/Back can't re-fire the prompt.
      if (pendingThreadId) {
        const id = pendingThreadId;
        const match = threads.threads.find((t) => t.id === id);
        if (match) {
          threads.selectThread(id);
        } else {
          toasts.show('Conversation not found', 'error');
        }
        pendingThreadId = null;
        clearThreadParam();
      }
      if (threads.currentId) {
        await messages.loadHistory(threads.currentId);
      }
      // Retry the catalog after init resolves — onMount fires before
      // `connection.client` is non-null on a cold load.
      void loadSkillCatalog();
      // Warm the provider catalog for the chat-header chip. Independent
      // of the skill catalog so a failure on one doesn't block the other.
      void loadLlmProviderCatalog();
    }
  }

  /**
   * Strip the `?thread=<id>` query param from the URL without triggering a
   * navigation reload. Mirrors the routines / knowledge pattern.
   */
  function clearThreadParam() {
    if (typeof window === 'undefined') return;
    if (!page.url.searchParams.has('thread')) return;
    const url = new URL(page.url);
    url.searchParams.delete('thread');
    const target = url.pathname + (url.search ? url.search : '') + url.hash;
    void goto(target, { replaceState: true, noScroll: true, keepFocus: true });
  }

  /**
   * Strip the `?brief=1` deep-link param (set by the "Brief me" palette
   * command when triggered from another route). Same no-reload pattern.
   */
  function clearBriefParam() {
    if (typeof window === 'undefined') return;
    if (!page.url.searchParams.has('brief')) return;
    const url = new URL(page.url);
    url.searchParams.delete('brief');
    const target = url.pathname + (url.search ? url.search : '') + url.hash;
    void goto(target, { replaceState: true, noScroll: true, keepFocus: true });
  }

  // R101: honor `?brief=1`. The palette's "Brief me" action navigates here
  // (the BriefingPanel only mounts on the chat route), then this fires once
  // the client is ready and strips the param so a refresh won't re-trigger.
  let briefParamFired = false;
  $effect(() => {
    const wants = page.url.searchParams.get('brief') === '1';
    if (!wants) {
      briefParamFired = false;
      return;
    }
    if (briefParamFired || !connection.client) return;
    briefParamFired = true;
    void onBrief();
    clearBriefParam();
  });

  /** Strip `?triage=1` (palette's "Triage my threads"). Same no-reload pattern. */
  function clearTriageParam() {
    if (typeof window === 'undefined') return;
    if (!page.url.searchParams.has('triage')) return;
    const url = new URL(page.url);
    url.searchParams.delete('triage');
    const target = url.pathname + (url.search ? url.search : '') + url.hash;
    void goto(target, { replaceState: true, noScroll: true, keepFocus: true });
  }

  // R104: honor `?triage=1`, mirroring the brief deep-link.
  let triageParamFired = false;
  $effect(() => {
    const wants = page.url.searchParams.get('triage') === '1';
    if (!wants) {
      triageParamFired = false;
      return;
    }
    if (triageParamFired || !connection.client) return;
    triageParamFired = true;
    void onTriage();
    clearTriageParam();
  });

  // -- effects ----------------------------------------------------------------
  // Whenever the selected thread changes, fetch its history if we don't have
  // it cached. (Avoid a clobber if we already have local optimistic content.)
  $effect(() => {
    const id = threads.currentId;
    if (!id) return;
    if (messages.get(id).length === 0) {
      void messages.loadHistory(id);
    }
  });

  // Draft hydration on thread switch. Save whatever is currently in the
  // composer back to the previous thread's slot, then load the new slot.
  $effect(() => {
    const id = threads.currentId;
    if (draftLoadedFor === id) return;
    untrack(() => {
      // Flush any pending debounced save against the OUTGOING thread first.
      if (draftSaveTimer) {
        clearTimeout(draftSaveTimer);
        draftSaveTimer = null;
        writeDraft(draftLoadedFor, input);
      }
      const next = loadDraft(id);
      applyDraft(next);
      draftLoadedFor = id;
    });
  });

  // Auto-scroll to the bottom of the stream as new content appears IFF the
  // user was already pinned to the bottom. If they've scrolled up, surface
  // the FAB instead so we don't yank them back mid-read.
  $effect(() => {
    // touch the values that should retrigger
    const histLen = history.length;
    const streamLen = streamingBuffer.length;
    const toolsLen = tools.length;
    const streaming = isStreaming;
    void histLen;
    void streamLen;
    void toolsLen;
    void tick().then(() => {
      if (!scrollEl) return;
      if (isAtBottom) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
        showScrollFab = false;
      } else if (streaming || streamLen > 0 || histLen > 0) {
        // New content arrived but the user isn't at the bottom — flag it.
        showScrollFab = true;
      }
    });
  });

  // Bump the find-in-thread version counter whenever the rendered tree
  // could have changed. Gated on `searchOpen` (audit R200 P1): ChatSearch
  // is the only reader of `contentVersion` and it only mounts while the
  // find bar is open (`{#if searchOpen}`), so bumping the counter for every
  // streaming token while the bar is closed is wasted reactivity on the hot
  // path. When the bar opens this effect re-runs, re-subscribes to the
  // deps, and resumes bumping; ChatSearch also runs its own initial scan on
  // mount, so nothing is missed by skipping the bumps while it was closed.
  // We `untrack` the read side of the counter so this effect only
  // retriggers on its real deps.
  $effect(() => {
    if (!searchOpen) return;
    void history.length;
    void streamingBuffer.length;
    void isStreaming;
    untrack(() => {
      contentVersion += 1;
    });
  });

  // ---- Thread rail: scroll + viewport + active-into-view -------------------
  /** Sync `threadScrollTop` on every scroll so the windowing math re-runs. */
  function onThreadRailScroll(): void {
    if (!threadRailEl) return;
    threadScrollTop = threadRailEl.scrollTop;
  }

  /** Measure the rail's clientHeight; called on mount + via ResizeObserver. */
  function measureThreadViewport(): void {
    if (!threadRailEl) return;
    threadViewportHeight = threadRailEl.clientHeight;
  }

  /**
   * Bring the active thread into view if it's outside the currently
   * rendered window. Fired whenever `currentId` changes (user picks a
   * thread, or a programmatic switch lands). Only runs in virtualized
   * mode — the un-virtualized list lets the browser handle focus-style
   * scroll automatically.
   *
   * Algorithm: compute the target row's top + bottom in container space,
   * compare against the current scroll window, and nudge `scrollTop` just
   * enough to land the row inside the visible area (snap to top if above,
   * snap to bottom if below). No scroll if already visible — avoids a
   * jitter loop when the user is mid-scroll and clicks a thread.
   */
  async function scrollActiveThreadIntoView(): Promise<void> {
    if (!threadsVirtualized) return;
    if (!threadRailEl) return;
    const id = threads.currentId;
    if (!id) return;
    const idx = sortedThreads.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const top = idx * THREAD_ITEM_HEIGHT;
    const bottom = top + THREAD_ITEM_HEIGHT;
    const viewTop = threadRailEl.scrollTop;
    const viewBottom = viewTop + threadRailEl.clientHeight;
    if (top < viewTop) {
      threadRailEl.scrollTop = top;
      threadScrollTop = top;
    } else if (bottom > viewBottom) {
      const next = bottom - threadRailEl.clientHeight;
      threadRailEl.scrollTop = next;
      threadScrollTop = next;
    }
    // Let any spacer recalculation settle so the slice mounts the row.
    await tick();
  }

  /**
   * Effect: react to thread selection changes by ensuring the active row
   * is visible. `untrack` on the scroll logic so we don't pull the
   * sortedThreads array into the dependency set (which would re-run on
   * every refresh and fight the user's scroll).
   */
  $effect(() => {
    const id = threads.currentId;
    if (!id) return;
    untrack(() => {
      void scrollActiveThreadIntoView();
    });
  });

  /**
   * Effect: install a ResizeObserver on the rail so the visible-row count
   * stays in sync with sidebar/window resizing. Re-runs if `threadRailEl`
   * changes (mount / unmount of the rail wrapper).
   */
  $effect(() => {
    const el = threadRailEl;
    if (!el) return;
    measureThreadViewport();
    const ro = new ResizeObserver(measureThreadViewport);
    ro.observe(el);
    return () => ro.disconnect();
  });

  // -- handlers ---------------------------------------------------------------
  async function onNewChat() {
    if (!connection.client) return;
    const id = await threads.createThread();
    if (id) {
      // Hydrate the composer from the new thread's draft slot (if any was
      // previously stashed). The effect above also handles this, but we set
      // it explicitly so focus lands with the right content already in place.
      const stored = loadDraft(id);
      applyDraft(stored);
      draftLoadedFor = id;
      // No history yet — clear any stale stream state on a fresh thread.
      composerEl?.focus();
    }
  }

  function onSelectThread(id: string) {
    if (id === threads.currentId) return;
    // Don't yank an in-progress stream out from under itself.
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    threads.selectThread(id);
    // Reset scroll state — the new thread starts pinned to the bottom.
    isAtBottom = true;
    showScrollFab = false;
  }

  // TODO(2026-05-27): wire up per-thread delete affordance once the gateway
  // implements `DELETE /api/chat/threads/{id}`. Live-server probe today
  // returns 404 — no matching route in `src/channels/web/platform/router.rs`.
  // The client method `client.deleteThread(id)` is pre-wired in
  // `src/lib/api/ironclaw.ts`. UI plan: trash icon on hover in each thread
  // row in the left rail (red on hover), styled confirm dialog ("Delete
  // this conversation? This can't be undone."), then `toasts.show()`,
  // `void threads.refresh()`, and navigate to the next-most-recent thread
  // (or clear `threads.currentId` for the empty state).

  function onKeyDown(e: KeyboardEvent) {
    // Slash autocomplete consumes arrow keys / Enter / Tab / Esc when its
    // dropdown is open and has candidates. If it claims the event, we
    // bail before the send-on-Enter path runs.
    if (slashAutoEl && slashAutoEl.handleKey(e)) {
      // Keep caret in sync after the component splices in a pick — the
      // pick callback already wrote the new value + repositioned the
      // caret via a microtask.
      return;
    }
    if (e.key === 'Enter') {
      if (e.shiftKey) {
        return; // newline
      }
      // Enter or Cmd/Ctrl+Enter both send.
      e.preventDefault();
      if (canSend) void onSend();
    }
  }

  // Mirror the textarea's caret position into reactive state. Called on
  // every relevant event — keyup catches arrow-key navigation, input
  // catches typing, click handles a manual caret reposition.
  function syncCaret() {
    if (!composerEl) return;
    caret = composerEl.selectionStart ?? input.length;
  }

  /**
   * Splice in a slash-command pick. Called by SlashAutocomplete with the
   * span of `input` to replace (the active `/token`) and the new text.
   * We update both the bound model and the textarea's caret/selection so
   * the user keeps typing from immediately after the inserted command.
   */
  function applySlashPick(start: number, end: number, text: string) {
    const next = `${input.slice(0, start)}${text}${input.slice(end)}`;
    input = next;
    const pos = start + text.length;
    // Run after the bind:value write propagates so the textarea's value
    // is in sync before we move the caret.
    void tick().then(() => {
      if (!composerEl) return;
      composerEl.focus();
      composerEl.setSelectionRange(pos, pos);
      caret = pos;
      autoGrow();
      scheduleDraftSave();
    });
  }

  /**
   * Replace the composer's current input with a fully-rendered prompt
   * template body. Distinct from `applySlashPick` because templates
   * are meant to *replace* whatever scratch text is in the composer
   * (the user explicitly picked a template — they don't want to
   * splice it into a mid-typed sentence). Caret lands at the end so
   * the user can keep editing after the insertion. Auto-grows the
   * textarea and triggers the draft save so the inserted text
   * survives a thread switch.
   */
  function applyTemplateInsert(text: string) {
    input = text;
    const pos = text.length;
    void tick().then(() => {
      if (!composerEl) return;
      composerEl.focus();
      composerEl.setSelectionRange(pos, pos);
      caret = pos;
      autoGrow();
      scheduleDraftSave();
    });
  }

  /**
   * Drain the composer-insert bus whenever the templates modal pushes
   * a payload. Same shape across mount + later pushes: read the
   * pending text, replace the composer input via `applyTemplateInsert`,
   * and (if a template id was attached) bump its use stats. Bus is
   * drained atomically — `consume()` clears the rune so the next
   * read sees null and this effect doesn't re-fire on its own.
   *
   * Why an effect (not just onMount): the user can press
   * Cmd+Shift+T → Insert while already on the chat route, in which
   * case there's no remount to anchor the consume against. The
   * effect re-runs every time `composerInsert.pending` flips, so
   * same-route inserts land too.
   *
   * The `untrack` on `composerEl` keeps the effect from re-running
   * when the textarea reference changes (HMR / first mount) — only
   * the bus payload should drive it.
   */
  // LANE B2 — chat tabs: when the user switches threads via any
  // path (thread rail, quick switcher, deep-link), open the new
  // thread as a tab so the strip mirrors the active conversation.
  // The store dedupes; opening an already-open tab just focuses it.
  $effect(() => {
    const cid = threads.currentId;
    if (cid) untrack(() => chatTabs.open(cid));
  });

  // LANE B2 — chat tabs: rebind the store when the user switches
  // profiles, so each profile keeps its own tab set.
  $effect(() => {
    const pid = connection.activeProfile?.id ?? null;
    untrack(() => chatTabs.bindProfile(pid));
  });

  $effect(() => {
    // Touch the reactive field so this effect re-runs on every push.
    const pending = composerInsert.pending;
    if (pending === null) return;
    // On the v2 (Reborn) surface the v2 composer owns the bus payload —
    // RebornChatPanel drains it. Don't splice it into the hidden v1 composer.
    if (connection.apiVersion === 'v2') return;
    untrack(() => {
      const payload = composerInsert.consume();
      if (!payload) return;
      applyTemplateInsert(payload.text);
    });
  });

  function autoGrow() {
    if (!composerEl) return;
    composerEl.style.height = 'auto';
    const max = 8 * 24; // ~8 rows at 24px line-height
    composerEl.style.height = `${Math.min(composerEl.scrollHeight, max)}px`;
  }

  // -- attachment helpers -----------------------------------------------------
  /**
   * Read a Blob into a base64 string (no `data:` prefix).
   *
   * FileReader's `readAsDataURL` returns `data:<mime>;base64,<payload>`; we
   * strip the prefix to align with the wire's `data_base64` field. The
   * IronClaw gateway tolerates both forms but the doc'd wire is the raw
   * payload — staying explicit here makes the request bytes smaller and the
   * server-side decode unambiguous.
   */
  function readAsBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('FileReader returned a non-string result'));
          return;
        }
        const comma = result.indexOf(',');
        resolve(comma === -1 ? result : result.slice(comma + 1));
      };
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Convert a list of `File`-likes into PendingAttachment rows.
   *
   * Enforces the v1 caps (mime allowlist, 25 MB / file, 5 attachments total
   * across the current strip + the new batch). Surfacing one toast per
   * rejection class keeps the noise reasonable on a bulk drop.
   *
   * Returns the accepted entries; rejected ones are toasted inline. The
   * caller is responsible for appending the result onto `attachments`.
   */
  async function intakeFiles(files: FileList | File[]): Promise<PendingAttachment[]> {
    const incoming = Array.from(files);
    if (incoming.length === 0) return [];

    const accepted: PendingAttachment[] = [];
    let rejectedType = 0;
    let rejectedSize = 0;
    let rejectedSlot = 0;

    const remainingSlots = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (remainingSlots === 0) {
      toasts.show(`Max ${MAX_ATTACHMENTS} attachments per message`, 'error');
      return [];
    }

    for (const file of incoming) {
      if (accepted.length >= remainingSlots) {
        rejectedSlot++;
        continue;
      }
      // Resolve mime via the browser-provided type with an extension-based
      // fallback for cases where the OS reports `''` (Safari + `.md`/`.csv`
      // are the usual offenders).
      const mime = inferMime(file);
      if (!mime || !ALLOWED_MIME.has(mime)) {
        rejectedType++;
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        rejectedSize++;
        continue;
      }
      try {
        const dataBase64 = await readAsBase64(file);
        accepted.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name || 'attachment',
          mime,
          size: file.size,
          // Only generate a blob URL for image previews — non-images render
          // an icon chip and never touch the URL, so we skip the alloc.
          previewUrl: isImageMime(mime) ? URL.createObjectURL(file) : '',
          dataBase64
        });
      } catch (err) {
        toasts.show(`Failed to read ${file.name}: ${(err as Error).message}`, 'error');
      }
    }

    if (rejectedType > 0) {
      toasts.show(
        `${rejectedType} file(s) rejected — unsupported type. Allowed: images, PDF, DOCX, XLSX, PPTX, CSV, TXT, MD, JSON.`,
        'error'
      );
    }
    if (rejectedSize > 0) {
      toasts.show(`${rejectedSize} file(s) exceed the 25 MB limit`, 'error');
    }
    if (rejectedSlot > 0) {
      toasts.show(`Max ${MAX_ATTACHMENTS} attachments per message`, 'error');
    }
    return accepted;
  }

  function removeAttachment(id: string): void {
    const next = attachments.filter((a) => {
      if (a.id === id) {
        // Revoke the blob URL so the browser can release the underlying
        // bytes. Safe to call even if the URL has already been revoked.
        try {
          URL.revokeObjectURL(a.previewUrl);
        } catch {
          /* ignore */
        }
        return false;
      }
      return true;
    });
    attachments = next;
  }

  function clearAttachments(): void {
    for (const a of attachments) {
      try {
        URL.revokeObjectURL(a.previewUrl);
      } catch {
        /* ignore */
      }
    }
    attachments = [];
  }

  /** Trigger the hidden file input. Reset its value first so picking the
   *  same file twice in a row still fires `change`. */
  function openFilePicker(): void {
    if (!attachmentInputEl) return;
    attachmentInputEl.value = '';
    attachmentInputEl.click();
  }

  async function onFileInputChange(e: Event): Promise<void> {
    const target = e.currentTarget as HTMLInputElement | null;
    if (!target || !target.files) return;
    const accepted = await intakeFiles(target.files);
    if (accepted.length > 0) attachments = [...attachments, ...accepted];
  }

  /** Composer-level paste handler. Pulls image bytes off the clipboard and
   *  inserts them as attachments WITHOUT also pasting the textual representation
   *  the OS may attach (e.g. a Finder file URL). We only `preventDefault`
   *  when at least one image is found so plain-text paste keeps working. */
  async function onComposerPaste(e: ClipboardEvent): Promise<void> {
    if (!e.clipboardData) return;
    const items = Array.from(e.clipboardData.items);
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.kind !== 'file') continue;
      if (!item.type.startsWith('image/')) continue;
      const f = item.getAsFile();
      if (f) imageFiles.push(f);
    }
    if (imageFiles.length === 0) return;
    e.preventDefault();
    const accepted = await intakeFiles(imageFiles);
    if (accepted.length > 0) attachments = [...attachments, ...accepted];
  }

  /** dragenter handler — increment the depth counter and surface the overlay.
   *  We track depth (not a boolean) because dragenter/leave fire on each
   *  child node the cursor crosses, and a naive boolean flickers as the
   *  cursor moves over inner elements (textarea, buttons, etc.). */
  function onComposerDragEnter(e: DragEvent): void {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth += 1;
  }

  function onComposerDragOver(e: DragEvent): void {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function onComposerDragLeave(e: DragEvent): void {
    if (!hasFiles(e.dataTransfer)) return;
    dragDepth = Math.max(0, dragDepth - 1);
  }

  async function onComposerDrop(e: DragEvent): Promise<void> {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth = 0;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const accepted = await intakeFiles(files);
    if (accepted.length > 0) attachments = [...attachments, ...accepted];
  }

  function hasFiles(dt: DataTransfer | null): boolean {
    if (!dt) return false;
    if (!dt.types) return false;
    // Type list contains "Files" when the user is dragging real files from
    // the OS; text drags surface "text/plain" instead and we want to ignore
    // them so the textarea's native paste-by-drop still works.
    return Array.from(dt.types).includes('Files');
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Clean up a user-message body for display.
   *
   * The gateway rewrites the user's content to append an `<attachments>`
   * block listing each saved file (verbose XML-ish prose intended for the
   * model, NOT for the user to read). We strip that block from the chat
   * bubble so the user sees their own prose and any attached images, but
   * not the bookkeeping prelude.
   *
   * The block always begins with `\n\n<attachments>` and ends with the
   * closing `</attachments>` tag; a tolerant regex covers both the exact
   * server format and any single-attachment variant.
   */
  function cleanUserDisplay(text: string): string {
    if (!text) return text;
    return text.replace(/\n*<attachments>[\s\S]*?<\/attachments>\s*/u, '').trim();
  }

  /** True when the cleaned user content contains markdown image syntax —
   *  used to switch the user bubble from plain text to MarkdownView so the
   *  optimistic blob: previews render. */
  function userHasInlineImage(text: string): boolean {
    return /!\[[^\]]*\]\([^)]+\)/u.test(text);
  }

  type LegacyRoutedMessage =
    | { status: 'send'; content: string; workItemId?: string }
    | { status: 'blocked'; workItem: WorkItem; boundary: WorkItemApprovalBoundary; content: string }
    | { status: 'needs_clarification'; reason: string };

  function firstPendingRequiredBoundary(item: WorkItem): WorkItemApprovalBoundary | null {
    return (
      item.approvalBoundaries.find(
        (boundary) => boundary.status === 'pending' && requiresApproval(boundary.kind)
      ) ?? null
    );
  }

  function visibleThreadTitle(): string | undefined {
    const id = threads.currentId;
    if (!id) return undefined;
    return threads.threads.find((thread) => thread.id === id)?.title ?? undefined;
  }

  function linkWorkItemToThread(
    workItemId: string | undefined,
    threadId: string | undefined
  ): void {
    if (!workItemId || !threadId) return;
    const item = workItems.get(workItemId);
    if (!item) return;
    if (item.links.some((link) => link.kind === 'thread' && link.ref === threadId)) return;
    workItems.update(item.id, {
      links: [
        ...item.links,
        { kind: 'thread', ref: threadId, label: visibleThreadTitle() ?? 'Chat thread' }
      ]
    });
  }

  function routeLegacyMessageThroughWork(
    content: string,
    threadId: string | undefined,
    pendingAttachments: PendingAttachment[]
  ): LegacyRoutedMessage {
    const attachmentSource = attachmentRiskSource(pendingAttachments);
    const workflow = orchestrateChiefOfStaffAsk({
      ask: content,
      surface: 'chat',
      title: visibleThreadTitle(),
      source: [threadId ? `thread:${threadId}` : 'legacy-chat', attachmentSource]
        .filter(Boolean)
        .join('\n'),
      hasAttachments: pendingAttachments.length > 0
    });
    if (workflow.status === 'chat_allowed') return { status: 'send', content };

    if (workflow.status === 'needs_clarification') {
      return { status: 'needs_clarification', reason: workflow.route.reason };
    }

    const route = workflow.route.workItem;
    if (shouldKeepRoutedWorkInChat(route)) {
      return { status: 'send', content };
    }

    const routeKey = `legacy:${threadId ?? 'new'}:${content}`;
    const existing = routedLegacyWorkItems.get(routeKey);
    if (existing) {
      const item = workItems.get(existing);
      if (item) {
        const boundary = firstPendingRequiredBoundary(item);
        if (boundary) return { status: 'blocked', workItem: item, boundary, content };
        return { status: 'send', content, workItemId: item.id };
      }
    }

    workItems.hydrate();
    const created = workItems.create({
      ...route,
      links: threadId
        ? [{ kind: 'thread', ref: threadId, label: visibleThreadTitle() ?? 'Chat thread' }]
        : []
    });
    if (!created) return { status: 'send', content };
    routedLegacyWorkItems.set(routeKey, created.id);

    toasts.show(`Work item created: ${created.title}`, 'success');
    const boundary = firstPendingRequiredBoundary(created);
    if (boundary) return { status: 'blocked', workItem: created, boundary, content };
    return { status: 'send', content, workItemId: created.id };
  }

  async function onSend() {
    if (!connection.client) return;
    const content = input.trim();
    // Snapshot attachments before we clear the strip — the user-bubble preview
    // and the wire payload both read off this array. An attachment-only send
    // (empty content + ≥1 file) is permitted; the gateway rewrites `content`
    // to include the `<attachments>` block server-side.
    const pendingAttachments = attachments;
    if (!content && pendingAttachments.length === 0) return;

    // `/council <prompt>` — open the multi-model council overlay instead of
    // sending a normal turn. Council is an in-chat panel, not a route.
    {
      const councilMatch = /^\/council\b\s*([\s\S]*)$/i.exec(content);
      if (councilMatch) {
        council.openWith(councilMatch[1].trim());
        input = '';
        return;
      }
    }

    // `/brief [note]` — open the Chief of Staff daily-brief panel instead of
    // sending a normal turn. An optional trailing note is captured as a new
    // open loop first, so "remind me and brief me" is one gesture.
    {
      const briefMatch = /^\/brief\b\s*([\s\S]*)$/i.exec(content);
      if (briefMatch) {
        const note = briefMatch[1].trim();
        if (note) openLoops.add(note);
        input = '';
        void onBrief();
        return;
      }
    }

    // `/draft [instruction]` — open the Chief of Staff draft panel for the
    // active thread. The optional trailing text seeds the instruction; empty
    // lets the CoS infer the likely reply. Needs a selected thread.
    {
      const draftMatch = /^\/draft\b\s*([\s\S]*)$/i.exec(content);
      if (draftMatch) {
        if (!currentThread) {
          toasts.show('Open a conversation first', 'info');
          return;
        }
        draft.instruction = draftMatch[1].trim();
        input = '';
        void onDraft();
        return;
      }
    }

    // Record slash-command usage so the autocomplete's ranking floats
    // frequently-run skills upward. We match a leading `/<token>` and
    // only record when the captured name resolves against the cached
    // skill catalog — a stray `/draft` typed for prose shouldn't count
    // as a skill invocation. Best-effort: failures are swallowed so a
    // store error can't block the actual send.
    if (content) {
      const slashMatch = /^\/(\S+)/u.exec(content);
      if (slashMatch) {
        const skillName = slashMatch[1];
        const known = skillCatalog.some((s) => s.name === skillName);
        if (known) {
          try {
            slashUsage.record(skillName);
          } catch {
            // Non-fatal — usage ranking is a UX nicety, not a send blocker.
          }
        }
      }
    }

    const routed = routeLegacyMessageThroughWork(
      content,
      threads.currentId ?? undefined,
      pendingAttachments
    );
    if (routed.status === 'needs_clarification') {
      toasts.show(`${routed.reason} Add the missing context before I dispatch it.`, 'info');
      return;
    }
    if (routed.status === 'blocked') {
      suppressDraftSave = true;
      input = '';
      autoGrow();
      writeDraft(threads.currentId, '');
      writeDraft(null, '');
      suppressDraftSave = false;
      clearAttachments();
      toasts.show(`Approval required: ${routed.boundary.action}`, 'info');
      void goto(`/work?item=${encodeURIComponent(routed.workItem.id)}`);
      return;
    }

    sending = true;
    try {
      // Auto-create a thread if none is selected.
      let threadId = threads.currentId;
      const fromNewSlot = !threadId;
      if (!threadId) {
        threadId = await threads.createThread();
        if (!threadId) {
          sending = false;
          toasts.show('Failed to create thread', 'error');
          return;
        }
      }
      linkWorkItemToThread(routed.workItemId, threadId);

      // Build an optimistic user-bubble preview. The actual server-side
      // content gets `<attachments>` blocks appended; for the local bubble
      // we mirror that with inline markdown image syntax pointing at the
      // already-allocated blob: URL so the user sees the image they sent
      // before the gateway echoes it back. The blob URL is kept alive
      // until clearAttachments() runs below — by then the message has been
      // committed to the messages store so the DOM holds the reference.
      //
      // Non-image attachments (PDF / DOCX / CSV / etc.) have no usable
      // blob preview, so we render a compact text mention instead — the
      // user sees confirmation of what they attached, without a broken
      // `![alt]()` link.
      let optimisticContent = content;
      if (pendingAttachments.length > 0) {
        const previews = pendingAttachments
          .map((a) =>
            isImageMime(a.mime) && a.previewUrl
              ? `![${a.name}](${a.previewUrl})`
              : `📎 **${a.name}** \`${shortType(a.mime, a.name)}\` · ${fmtBytes(a.size)}`
          )
          .join('\n\n');
        optimisticContent = content ? `${content}\n\n${previews}` : previews;
      }

      // Reset the tool-flow ledger for this thread — each user turn
      // starts with an empty rail so the prior turn's calls don't
      // appear under the new question. `message_start` would also
      // clear inside the store, but the gateway doesn't reliably emit
      // it, so we belt-and-brace at the send call site.
      toolFlow.clear(threadId);

      // Append the optimistic user message — keep its id so we can mark it
      // failed (and offer retry) if the send/stream pair errors out.
      const localId = messages.appendUserMessage(threadId, optimisticContent);
      // Opt-in telemetry — single-line counter. No content, no thread id.
      // The `hasAttachments` flag lets us chart attachment usage
      // independently of total sends.
      telemetry.recordEvent('chat:message_sent', {
        hasAttachments: pendingAttachments.length > 0
      });

      // Clear the composer + persisted draft. Suppress the debounced save
      // that would otherwise fire from the `input = ''` write.
      suppressDraftSave = true;
      input = '';
      autoGrow();
      writeDraft(threadId, '');
      // If we promoted from the __new__ slot, drop that key too so the next
      // fresh chat doesn't pick up this content.
      if (fromNewSlot) writeDraft(null, '');
      draftLoadedFor = threadId;
      suppressDraftSave = false;

      // Pull the wire-shape attachments out before we drop the strip — the
      // blob URLs are still alive on `pendingAttachments` so the optimistic
      // bubble's <img> tags keep resolving.
      const wireAttachments: AttachmentInput[] = pendingAttachments.map((a) => ({
        name: a.name,
        mime_type: a.mime,
        data_base64: a.dataBase64
      }));
      // Clear the local strip — but DON'T revoke the blob URLs yet, the
      // optimistic bubble still references them. They're released when the
      // user navigates away or refreshes; this is a small acceptable leak
      // given attachments are capped at 5 × 25 MB per send.
      attachments = [];

      await runSendAndStream(threadId, optimisticContent, localId, wireAttachments);
    } finally {
      sending = false;
    }
  }

  /**
   * Send + stream a single user turn. Used by both the initial send path
   * and the retry button on a previously-failed user-message bubble.
   *
   * Two streaming paths are supported:
   *   1. Responses API (`POST /api/v1/responses` with `stream: true`) —
   *      preferred when the user setting `useResponsesApi` is on AND the
   *      gateway exposes the route (probed once via `getServerCapabilities`).
   *      This path delivers real incremental `response.output_text.delta`
   *      chunks, so the UI feels smooth instead of clobbering on each
   *      `text_response` event.
   *   2. Legacy `POST /api/chat/send` + `GET /api/chat/events` — fallback
   *      for older gateways or when the user has pinned the legacy path
   *      via Settings → Advanced. The server sends the full assistant
   *      content per event; the messages-store heuristic handles that.
   *
   * On failure, the optimistic user-message row (localId) is marked failed
   * via the messages store so the bubble can render the retry affordance.
   * On success the failed flag is cleared (no-op on first attempt).
   */
  async function runSendAndStream(
    threadId: string,
    content: string,
    localId: string,
    attachments: AttachmentInput[] = []
  ): Promise<void> {
    if (!connection.client) return;

    // Decide path. The setting is loaded fresh per send rather than cached
    // in a module variable so toggling the Advanced switch takes effect on
    // the very next send without a route reload. `loadSettings()` hits the
    // in-memory cache after the first call so the cost is negligible.
    let useResponsesApi = true;
    try {
      const s = await loadSettings();
      useResponsesApi = s.useResponsesApi !== false;
    } catch {
      // Defensive — fall back to the default (on) if settings can't be
      // read (would only happen outside Tauri during a dev preview).
      useResponsesApi = true;
    }

    // Attachments are wired only through the legacy `/api/chat/send`
    // endpoint — the Responses API accepts the `attachments` field at the
    // wire level but silently drops it (no `<attachments>` block lands in
    // the user turn). Force legacy whenever a send carries attachments so
    // the model actually receives them.
    const hasAttachments = attachments.length > 0;
    let responsesAvailable = false;
    if (useResponsesApi && !hasAttachments) {
      try {
        const caps = await connection.client.getServerCapabilities();
        responsesAvailable = caps.responses_api;
      } catch {
        responsesAvailable = false;
      }
    }

    abortController = new AbortController();
    const signal = abortController.signal;

    let streamErrored = false;
    let replyForNotify = '';
    let usedPath: 'responses' | 'legacy' = 'legacy';
    // Bind this send to the prompt store save signal even when the
    // attachment path forces legacy `/api/chat/send`.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _promptVer = promptVersion;
    const overrideInstructions = composeInstructions(perThreadPrompts.get(threadId), {
      hasAttachments
    });

    try {
      if (useResponsesApi && responsesAvailable) {
        usedPath = 'responses';
        messages.beginStream(threadId);
        try {
          // Per-thread system-prompt override (R43). When the user has
          // attached a custom prompt via the kebab → "Custom system
          // prompt…" modal, we forward it as the Responses-API
          // `instructions` field. Omitted entirely otherwise so the
          // wire shape matches the pre-R43 send for vanilla threads.
          for await (const ev of connection.client.streamResponse(
            content,
            threadId,
            signal,
            overrideInstructions
          )) {
            handleEvent(threadId, ev);
          }
        } catch (err) {
          // Soft-fall-back: a 404 / 405 / "not available" at the start of
          // the stream means the gateway dropped the route between probe
          // and use (or the probe was wrong about this build). Fall back
          // to the legacy path so the user's send doesn't drop on the floor.
          const msg = (err as Error).message;
          const isMissing = /\b(404|405|not[- ]?found|method not allowed|not available)\b/i.test(
            msg
          );
          if (!signal.aborted && isMissing) {
            // eslint-disable-next-line no-console
            console.info(
              '[chat] Responses API stream failed, falling back to legacy /api/chat:',
              msg
            );
            // Reset the partial stream state — the legacy path will rebegin.
            messages.commitAssistantMessage(threadId);
            await runLegacySendAndStream(
              threadId,
              content,
              localId,
              signal,
              attachments,
              overrideInstructions
            );
            usedPath = 'legacy';
            replyForNotify = messages.getStreaming(threadId);
            return; // commit + reconcile already handled in legacy path
          }
          if (!signal.aborted) {
            messages.setError(threadId, msg);
            messages.markFailed(localId, content);
            toasts.show(`Stream error: ${msg}`, 'error');
            streamErrored = true;
          }
        }
      } else {
        usedPath = 'legacy';
        await runLegacySendAndStream(
          threadId,
          content,
          localId,
          signal,
          attachments,
          overrideInstructions
        );
        // legacy helper does NOT call commit here — we still want the
        // shared finally{} to run the post-stream reconcile.
      }
    } finally {
      // For the responses path, capture + commit happens here. The legacy
      // helper opens its own beginStream → commit cycle, but we leave the
      // finally{} chain in place so reconcile + notification fire once.
      if (usedPath === 'responses') {
        replyForNotify = messages.getStreaming(threadId);
        messages.commitAssistantMessage(threadId);
      } else {
        replyForNotify = replyForNotify || messages.getStreaming(threadId);
      }
      abortController = null;
      // Reconcile with the server's canonical history.
      await messages.loadHistory(threadId);
      await threads.refresh();
      if (!streamErrored) messages.clearFailed(localId);

      // LANE B1 — voice answer (R51). If the user has voice-answer
      // mode armed, pipe the completed assistant turn through the
      // macOS `say` bridge. Best-effort: failures are logged inside
      // the store; we don't surface a toast at every speak attempt.
      if (!streamErrored && !signal.aborted && replyForNotify) {
        void voiceAnswer.speakIfEnabled(replyForNotify);
      }

      // Record the provider that produced this turn so the chat header
      // can show a "produced by X" chip. We read `activeProfile` at the
      // moment the stream completes — a mid-stream profile switch is
      // captured on the next turn rather than mis-tagging the current
      // one. Skipped on error so a failed stream doesn't stamp a thread
      // with a provider that didn't actually answer.
      if (!streamErrored && !signal.aborted) {
        const providerId =
          connection.activeProfile?.llmProviderId ?? connection.activeProfile?.llmBackend;
        if (providerId) threadModel.setProvider(threadId, providerId);
      }

      // Lightweight observability — debug-only console signal so a power
      // user can confirm which transport ran without firing a toast at
      // every send. Avoid `console.log` (noisy in prod); `debug` is
      // filtered out of the Tauri stdout by default.
      // eslint-disable-next-line no-console
      console.debug(`[chat] streaming path: ${usedPath}`);

      if (
        !streamErrored &&
        !signal.aborted &&
        replyForNotify.trim().length > 0 &&
        notifications.enabled &&
        notifications.chatReplies &&
        !windowFocus.focused
      ) {
        const body = replyForNotify.slice(0, 100).trim();
        void notifications.notify({
          title: 'IronClaw replied',
          body,
          category: 'chat'
        });
      }
    }
  }

  /**
   * Legacy send + stream pipeline. Posts to `/api/chat/send` then drains
   * `/api/chat/events`. Used directly when the user has disabled the
   * Responses API path, and as a soft-fallback when the Responses API
   * route 404s mid-send. The caller's finally{} handles reconcile and
   * notification so this helper only owns the per-attempt error surface.
   */
  async function runLegacySendAndStream(
    threadId: string,
    content: string,
    localId: string,
    signal: AbortSignal,
    attachments: AttachmentInput[] = [],
    instructions?: string
  ): Promise<void> {
    if (!connection.client) return;
    try {
      await connection.client.sendMessage(threadId, content, attachments, instructions);
    } catch (err) {
      const msg = (err as Error).message;
      messages.setError(threadId, msg);
      messages.markFailed(localId, content);
      toasts.show(`Send failed: ${msg}`, 'error');
      return;
    }

    messages.beginStream(threadId);
    try {
      for await (const ev of connection.client.streamEvents(threadId, signal)) {
        if (
          ev.type === 'approval_needed' &&
          (await maybeAutoApproveUploadedAttachmentRead(threadId, ev, attachments))
        ) {
          continue;
        }
        handleEvent(threadId, ev);
      }
    } catch (err) {
      if (!signal.aborted) {
        const msg = (err as Error).message;
        messages.setError(threadId, msg);
        messages.markFailed(localId, content);
        toasts.show(`Stream error: ${msg}`, 'error');
      }
    }
    // Commit the buffer here — the responses-path branch is the only one
    // that defers commit to the shared finally{}, because it doesn't go
    // through this helper.
    messages.commitAssistantMessage(threadId);
  }

  async function maybeAutoApproveUploadedAttachmentRead(
    threadId: string,
    ev: Extract<ChatEvent, { type: 'approval_needed' }>,
    attachments: AttachmentInput[]
  ): Promise<boolean> {
    if (!connection.client || attachments.length === 0) return false;
    if (!isUploadedAttachmentReadApproval(ev)) return false;

    messages.recordToolStart(threadId, ev.tool_name, {
      ...approvalObject(ev.parameters),
      approval: 'auto-approved read of the file attached to this chat turn'
    });
    try {
      await connection.client.resolveLegacyChatApproval({
        threadId: ev.thread_id || threadId,
        requestId: ev.request_id,
        action: 'approve'
      });
      messages.recordToolResult(threadId, ev.tool_name, {
        status: 'approved',
        scope: 'uploaded attachment read'
      });
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      messages.recordToolResult(threadId, ev.tool_name, { status: 'error', message: msg });
      messages.setError(threadId, `Attachment read approval failed: ${msg}`);
      toasts.show(`Attachment read approval failed: ${msg}`, 'error');
      return true;
    }
  }

  function isUploadedAttachmentReadApproval(
    ev: Extract<ChatEvent, { type: 'approval_needed' }>
  ): boolean {
    if (ev.tool_name !== 'read_file') return false;
    const params = approvalObject(ev.parameters);
    const keys = Object.keys(params);
    if (keys.length === 0) return true;
    return approvalStrings(params).some((value) =>
      /(^|[/\\])\.?ironclaw[/\\]attachments[/\\]/i.test(value)
    );
  }

  function approvalObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  function approvalStrings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap((entry) => approvalStrings(entry));
    if (value && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).flatMap((entry) =>
        approvalStrings(entry)
      );
    }
    return [];
  }

  /**
   * Retry a failed user message in-place. Drops the failed marker, removes
   * the old optimistic row, and re-runs the same send + stream pipeline.
   */
  async function onRetry(threadId: string, failedMessageId: string): Promise<void> {
    if (!connection.client) return;
    if (retryingIds[failedMessageId]) return;
    const meta = messages.getMeta(failedMessageId);
    const content = meta.retryContent;
    if (!content) return;
    retryingIds = { ...retryingIds, [failedMessageId]: true };
    sending = true;
    try {
      // Drop the previous failed bubble + meta so we don't render duplicates.
      messages.removeMessage(threadId, failedMessageId);
      const newId = messages.appendUserMessage(threadId, content);
      await runSendAndStream(threadId, content, newId);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [failedMessageId]: _drop, ...rest } = retryingIds;
      retryingIds = rest;
      sending = false;
    }
  }

  /**
   * LANE B9 (R69) — commit an in-place edit on a user message bubble.
   *
   * Wikipedia-style "rewrite history" semantics: every message at or after
   * `msgId` is dropped from the local thread, then the edited content is
   * pushed back through the normal send + stream pipeline. Distinct from
   * R19b Branch (which forks a fresh thread leaving the original intact).
   *
   * The messages store doesn't expose a dedicated truncate API — its
   * `byThread` rune is public-readable so we slice + write directly. The
   * edited message itself is dropped from the slice; `sendMessage()` will
   * append a fresh optimistic user row a moment later.
   *
   * Out of scope: the server doesn't currently support history truncation
   * over the wire, so the next `loadHistory()` call could resurrect the
   * older rows. That's acceptable for v1 — the edit takes effect locally
   * for the rest of the session and the resend updates server state from
   * the edit point onward.
   */
  async function handleBubbleEdit(msgId: string, newContent: string): Promise<void> {
    const tid = threads.currentId;
    if (!tid) return;
    try {
      const current = messages.get(tid);
      const idx = current.findIndex((m) => m.id === msgId);
      if (idx < 0) return;
      const truncated = current.slice(0, idx);
      // Direct write to the public `byThread` rune — no truncate API
      // exists today and the store author has marked the field
      // `$state<...>` so it's intended to be writable from callers.
      messages.byThread = { ...messages.byThread, [tid]: truncated };
      // Stop any in-flight stream against this thread — its assistant
      // turn is one of the rows we just dropped.
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      input = newContent;
      await onSend();
    } catch (err) {
      toasts.show(`Edit failed: ${(err as Error).message}`, 'error');
    }
  }

  function handleEvent(threadId: string, ev: ChatEvent) {
    // Mirror every chat event into the tool-flow ledger so the right-rail
    // visualizer (`ToolFlowPanel`) stays in sync without forking the
    // dispatch logic. The store itself drops events it doesn't care
    // about (content_delta, message_end, error, tool_call_delta) — see
    // `tool-flow.svelte.ts`.
    toolFlow.record(threadId, ev);
    switch (ev.type) {
      case 'message_start':
        // No-op today — the gateway doesn't emit these.
        break;
      case 'content_delta':
        messages.appendStreamingChunk(threadId, ev.delta);
        break;
      case 'tool_call':
        messages.recordToolStart(threadId, ev.name, ev.args);
        if (!rightRailOpen) rightRailOpen = true;
        break;
      case 'tool_call_delta':
        // Forward-compat: the Responses API may stream tool-argument deltas
        // in a future gateway build. Today's gateway packs arguments in the
        // final output_item.done envelope so this branch is never hit; left
        // as a no-op rather than throwing so the union stays exhaustive.
        break;
      case 'tool_result':
        messages.recordToolResult(threadId, ev.name, ev.result);
        break;
      case 'approval_needed':
        messages.recordToolStart(threadId, ev.tool_name, ev.parameters);
        messages.setError(threadId, `Approval required for ${ev.tool_name}.`);
        toasts.show(`Approval required: ${ev.tool_name}`, 'info');
        break;
      case 'message_end':
        // No-op — commit happens in the finally{} of onSend().
        break;
      case 'error':
        messages.setError(threadId, ev.message);
        toasts.show(`Gateway error: ${ev.message}`, 'error');
        break;
    }
  }

  function onStop() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  }

  // -- title rename ----------------------------------------------------------
  // The IronClaw gateway does not expose `PATCH /api/chat/threads/{id}`
  // as of v0.29.0 — R22a smoke confirms a 404. The rename surface here
  // is a client-side overlay: we stash custom titles in the
  // `threadRename` store (localStorage, BroadcastChannel-synced across
  // sibling windows) and render via `threadRename.displayTitle(id,
  // serverTitle)` everywhere a thread title appears.
  function startRename() {
    if (!currentThread) return;
    // Seed the input with the CURRENTLY DISPLAYED title — including any
    // existing local override — so the user can refine an earlier rename
    // instead of typing the server title from scratch.
    titleDraft = threadRename.displayTitle(currentThread.id, currentThread.title);
    renaming = true;
    renameMenuOpen = false;
    // Show the local-only tooltip on first rename ever. The seen flag
    // is persisted across windows so dismissing it once is enough.
    showRenameTooltip = threadRename.isTooltipUnseen();
  }

  function commitRename() {
    if (!currentThread) {
      renaming = false;
      return;
    }
    const next = titleDraft.trim();
    const currentDisplay = threadRename.displayTitle(currentThread.id, currentThread.title);
    if (next === '' || next === (currentThread.title ?? '').trim()) {
      // Empty input or back-to-server value → drop the override entirely
      // so the title reverts to whatever the server hands us next.
      if (threadRename.has(currentThread.id)) {
        threadRename.unset(currentThread.id);
        toasts.show('Reverted to server title', 'info');
      }
    } else if (next !== currentDisplay) {
      threadRename.set(currentThread.id, next);
      toasts.show('Renamed on this device', 'success');
    }
    renaming = false;
    dismissRenameTooltip();
  }

  function cancelRename() {
    renaming = false;
    dismissRenameTooltip();
  }

  /** Drop the local override and revert to the server's title. Wired
   *  into the kebab menu next to the chat header. No-op when there is
   *  no override to clear. */
  function revertRename() {
    renameMenuOpen = false;
    if (!currentThread) return;
    if (!threadRename.has(currentThread.id)) return;
    threadRename.unset(currentThread.id);
    toasts.show('Reverted to server title', 'info');
  }

  /**
   * Open the per-thread system-prompt modal (R43). The modal reads
   * the current override directly from the store, so we don't pass
   * it through — just close the kebab dropdown and flip `open`.
   */
  function openPerThreadPromptModal() {
    renameMenuOpen = false;
    if (!currentThread) return;
    promptModalOpen = true;
  }

  /**
   * Called by the modal whenever it persists / clears an override.
   * Bumping `promptVersion` invalidates the cached chip render and
   * — more importantly — guarantees that the next streamResponse
   * call site reads the freshest override from the store (Svelte's
   * `$derived` already does this, but we keep the bump for surfaces
   * that want a single "something changed" signal).
   */
  function onPromptChanged() {
    promptVersion += 1;
  }

  function dismissRenameTooltip() {
    if (!showRenameTooltip) return;
    showRenameTooltip = false;
    threadRename.markTooltipSeen();
  }

  // Outside-click + Esc handling for the kebab menu next to the rename
  // title. Mirrors the export popover's pattern — bind on the document
  // because the menu is anchor-positioned outside the button's subtree.
  $effect(() => {
    if (!renameMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (renameMenuEl && renameMenuEl.contains(target)) return;
      if (renameMenuButtonEl && renameMenuButtonEl.contains(target)) return;
      renameMenuOpen = false;
    };
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') renameMenuOpen = false;
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onDocKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onDocKey);
    };
  });

  // -- export ----------------------------------------------------------------
  // Per-thread export from the chat header. The popover anchors to the
  // Export button and closes on outside click or Escape. We fetch the full
  // history fresh (limit=10000) rather than relying on the in-memory store
  // so the export captures everything the server has, not just what the
  // UI has scrolled into view.
  let exportOpen = $state(false);
  let exporting = $state(false);
  let exportButtonEl = $state<HTMLButtonElement | null>(null);
  let exportPopoverEl = $state<HTMLDivElement | null>(null);

  const canExport = $derived(!!currentThread && connection.status === 'connected' && !exporting);

  function toggleExportMenu() {
    if (!canExport && !exportOpen) return;
    exportOpen = !exportOpen;
  }

  function closeExportMenu() {
    exportOpen = false;
  }

  /**
   * Pull the full history for the active thread and write it to disk in
   * the requested format. Toasts on success/cancel/error.
   */
  async function onExportThread(format: 'markdown' | 'json' | 'html'): Promise<void> {
    if (!connection.client || !currentThread) return;
    exportOpen = false;
    exporting = true;
    try {
      const all = await connection.client.getHistory(currentThread.id, 10000);
      const ext = format === 'markdown' ? 'md' : format;
      const stem = sanitizeFilenameStem(currentThread.title);
      const filename = `${stem}.${ext}`;
      const text =
        format === 'markdown'
          ? buildThreadMarkdown(currentThread, all)
          : format === 'html'
            ? buildThreadHtml(currentThread, all)
            : buildThreadJsonText(currentThread, all);
      const saved = await saveTextDialog(filename, text);
      if (saved === null) {
        toasts.show('Export cancelled', 'info');
      } else {
        toasts.show(`Exported to ${saved}`, 'success');
      }
    } catch (err) {
      toasts.show(`Export failed: ${(err as Error).message}`, 'error');
    } finally {
      exporting = false;
    }
  }

  /**
   * R89: open the recap panel and summarize the active thread. Fetches the
   * full history, then hands it to the recap store (which streams a one-off,
   * non-thread completion). Read-only — never touches the transcript.
   */
  async function onRecap(): Promise<void> {
    if (!connection.client || !currentThread) return;
    const client = connection.client;
    const thread = currentThread;
    recap.open = true;
    recap.threadId = thread.id;
    recap.loading = true;
    recap.error = null;
    recap.summary = '';
    recap.stats = null;
    try {
      const all = await client.getHistory(thread.id, 10000);
      // Compute at-a-glance stats from the same history (R92) before the
      // summary streams, so the panel shows numbers immediately.
      recap.stats = computeThreadStats(all);
      await recap.generate(thread.id, all, client);
    } catch (err) {
      recap.error = (err as Error).message;
      recap.loading = false;
    }
  }

  /**
   * R101: open the daily-brief panel and have the Chief of Staff persona
   * assemble a prioritized morning agenda. Sources the recent threads from
   * the already-loaded thread list (most-recently-updated first) and the
   * tracked commitments from the open-loops store, then runs a one-off
   * completion under the CoS persona. Read-only — creates no thread and
   * sends nothing into any conversation. Available whenever connected,
   * independent of whether a thread is currently selected.
   *
   * Also serves as the panel's "Regenerate" handler: re-gathers the current
   * threads + (possibly edited) open loops and re-runs the brief.
   */
  async function onBrief(): Promise<void> {
    if (!connection.client) return;
    const client = connection.client;
    // Hydrate commitments defensively — the layout inits this on mount, but
    // a direct deep-link into chat could reach here first.
    openLoops.init();
    const briefingThreads = threads.sorted.map((t) => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updated_at,
      messageCount: t.message_count
    }));
    await briefing.generate(
      { threads: briefingThreads, openLoops: openLoops.activeTexts() },
      client
    );
  }

  /**
   * R104: open the triage panel and have the Chief of Staff sort the recent
   * threads into Decision needed / FYI / Can handle. Sources the recent
   * threads from the already-loaded list and runs a one-off completion under
   * the CoS persona. Read-only — creates no thread, sends nothing into any
   * conversation. Also the panel's "Regenerate" handler.
   */
  async function onTriage(): Promise<void> {
    if (!connection.client) return;
    const client = connection.client;
    const triageThreads = threads.sorted.map((t) => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updated_at,
      messageCount: t.message_count
    }));
    await triage.generate(triageThreads, client);
  }

  // Monotonic token guarding onDraft()'s pre-stream getHistory await against
  // out-of-order resolution (Review P1).
  let draftRequestSeq = 0;

  /**
   * R105: open the draft panel and have the Chief of Staff write a reply in
   * the user's voice, grounded in the active thread. Fetches the full
   * history, maps it to the draft transcript, and runs a one-off completion
   * under the CoS persona using the (possibly edited) `draft.instruction`.
   * Read-only — the draft is shown for copy; nothing is posted. Also the
   * panel's "Regenerate" handler (re-fetches + re-runs with the same thread).
   */
  async function onDraft(): Promise<void> {
    if (!connection.client || !currentThread) return;
    const client = connection.client;
    const thread = currentThread;
    // Guard the pre-stream getHistory() await: a slow fetch for an older
    // request could resolve after a newer one and clobber it (wrong thread,
    // aborted newer run). Stamp a monotonic token and bail if superseded.
    // (Review P1.)
    const myReq = ++draftRequestSeq;
    draft.threadLabel = thread.title || 'this thread';
    draft.open = true;
    draft.loading = true;
    try {
      const all = await client.getHistory(thread.id, 10000);
      if (myReq !== draftRequestSeq) return;
      const transcript = all.map((m) => ({ role: m.role, content: m.content }));
      await draft.generate(transcript, client);
    } catch (err) {
      if (myReq !== draftRequestSeq) return;
      draft.error = (err as Error).message;
      draft.loading = false;
    }
  }

  // Outside-click + Esc handling for the export popover. We bind on the
  // document because the popover is anchor-positioned and not inside the
  // button's DOM subtree — a relative-position click handler on the
  // header would race against the button's own onclick.
  $effect(() => {
    if (!exportOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (exportPopoverEl && exportPopoverEl.contains(target)) return;
      if (exportButtonEl && exportButtonEl.contains(target)) return;
      closeExportMenu();
    };
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeExportMenu();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onDocKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onDocKey);
    };
  });

  // -- helpers ----------------------------------------------------------------
  function relativeTime(iso: string | undefined): string {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const diff = Date.now() - t;
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    return new Date(t).toLocaleDateString();
  }

  function toggleTool(id: string) {
    expandedTools = { ...expandedTools, [id]: !expandedTools[id] };
  }

  function fmtJson(v: unknown): string {
    if (v === undefined) return '—';
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  // -- lightbox (event delegation) -------------------------------------------
  /**
   * Click delegate for the message stream. Walks up from the click target
   * looking for an `<img>` — if found, captures its src + alt and opens the
   * lightbox. Anchors (links wrapping an image) are deliberately ignored at
   * the click level: the browser will follow the link on its own and we
   * don't want to swallow that interaction.
   *
   * The walk stops at the scroll container (`scrollEl`) so a click outside
   * the message area never triggers the lightbox.
   */
  function onStreamClick(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // Don't hijack image-link clicks — if the user wrapped an image in an
    // <a href>, they probably want the link.
    const anchor = target.closest('a');
    if (anchor && anchor.querySelector('img')) return;
    const img = target.closest('img');
    if (!img) return;
    // Skip explicit opt-outs (e.g. small icon avatars marked `data-no-lightbox`).
    if (img.dataset.noLightbox !== undefined) return;
    e.preventDefault();
    const src = img.getAttribute('src') ?? '';
    if (!src) return;
    lightboxSrc = src;
    lightboxAlt = img.getAttribute('alt') || 'Preview';
  }

  function closeLightbox(): void {
    lightboxSrc = null;
  }

  // -- voice input (Web Speech API) ------------------------------------------
  /**
   * Toggle dictation on/off. Click once to start streaming interim
   * transcripts into the composer; click again to commit the final
   * transcript and stop. Auto-stops after VOICE_SILENCE_MS of silence —
   * keeps the mic from staying open if the user walks away.
   *
   * Cursor handling: the snapshot at start (`voiceAnchor`) anchors the
   * insertion point, so anything the user already typed before the caret
   * stays put — only the text from the anchor forward is rewritten as
   * the recognizer emits new results.
   */
  function toggleVoice(): void {
    if (!voiceSupported) return;
    if (voiceListening) {
      stopVoice(true);
      return;
    }
    startVoice();
  }

  function startVoice(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      voiceSupported = false;
      return;
    }
    // Anchor at the current caret (or end-of-text) so dictation appends at
    // the user's insertion point. The existing prefix is preserved across
    // every interim/final result.
    voiceAnchor = composerEl?.selectionStart ?? input.length;
    voiceInterimText = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec: any = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (ev: any) => {
      let interim = '';
      let final = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }
      // Treat finalized chunks as additive: once a phrase becomes final,
      // bake it into the anchor so subsequent interim results are appended
      // after it (rather than overwriting). This mirrors how dictation
      // feels in macOS / iOS — the committed text stays put.
      if (final) {
        const committedPrefix = input.slice(0, voiceAnchor);
        const committedSuffix = input.slice(voiceAnchor + voiceInterimText.length);
        const nextValue = `${committedPrefix}${final}${committedSuffix}`;
        suppressDraftSave = true;
        input = nextValue;
        voiceAnchor = committedPrefix.length + final.length;
        voiceInterimText = '';
        void tick().then(() => {
          autoGrow();
          if (composerEl) composerEl.setSelectionRange(voiceAnchor, voiceAnchor);
          suppressDraftSave = false;
          scheduleDraftSave();
        });
      }
      if (interim) {
        const prefix = input.slice(0, voiceAnchor);
        const suffix = input.slice(voiceAnchor + voiceInterimText.length);
        voiceInterimText = interim;
        const nextValue = `${prefix}${interim}${suffix}`;
        suppressDraftSave = true;
        input = nextValue;
        void tick().then(() => {
          autoGrow();
          suppressDraftSave = false;
        });
      }
      // Rearm the silence timer on every result — keeps the mic open
      // while speech is flowing and trips the auto-commit otherwise.
      armVoiceSilenceTimer();
    };
    rec.onerror = () => {
      // Routine errors (`no-speech`, `aborted`) are user-driven; anything
      // else lands here without state of its own to inspect. We surface
      // the visible "Mic failed" toast on start() rejection instead.
    };
    rec.onend = () => {
      // Browser-driven stop (silence, mic released, etc.). Mirror the
      // explicit-stop path so state stays consistent.
      if (voiceListening) {
        stopVoice(false);
      }
    };

    voiceRec = rec;
    try {
      rec.start();
      voiceListening = true;
      armVoiceSilenceTimer();
    } catch (err) {
      // start() throws synchronously if called twice or if permission is
      // denied at the OS level — fall back cleanly without leaving the
      // mic icon stuck in the listening state.
      voiceListening = false;
      voiceRec = null;
      toasts.show(`Mic failed: ${(err as Error).message}`, 'error');
    }
  }

  function stopVoice(userInitiated: boolean): void {
    if (voiceSilenceTimer) {
      clearTimeout(voiceSilenceTimer);
      voiceSilenceTimer = null;
    }
    if (voiceRec) {
      try {
        voiceRec.stop();
      } catch {
        /* ignore */
      }
      voiceRec = null;
    }
    voiceListening = false;
    // Leave whatever's in the composer as-is — both interim and final
    // transcripts have already been written into `input`. Clear the
    // interim marker so the next session anchors cleanly.
    voiceInterimText = '';
    if (userInitiated) {
      // Move focus back to the textarea so the user can keep typing.
      composerEl?.focus();
    }
  }

  function armVoiceSilenceTimer(): void {
    if (voiceSilenceTimer) clearTimeout(voiceSilenceTimer);
    voiceSilenceTimer = setTimeout(() => {
      voiceSilenceTimer = null;
      stopVoice(false);
    }, VOICE_SILENCE_MS);
  }

  // -- conversation branching ------------------------------------------------
  /**
   * Open the confirm dialog for a fork. The actual fork runs inside
   * `confirmBranch()` once the user clicks the primary action.
   */
  function openBranchConfirm(messageId: string): void {
    branchTargetId = messageId;
  }

  function closeBranchConfirm(): void {
    if (branching) return;
    branchTargetId = null;
  }

  /**
   * Probe the gateway for a native branch endpoint. Result cached so we
   * only burn one request per session. Returns true on 2xx, false on 404
   * / 405. Any network / unexpected failure falls back to false so a
   * transient outage doesn't strand the user without a fork.
   */
  async function probeBranchEndpoint(threadId: string): Promise<boolean> {
    if (branchEndpointAvailable !== null) return branchEndpointAvailable;
    if (!connection.client) return false;
    try {
      // OPTIONS is the cheapest probe — tells us whether the route exists
      // without spinning up a real fork. IronClaw 0.28.2 returns 404 for
      // unknown routes (verified 2026-05-27); that's the signal we need.
      const res = await fetch(
        `${connection.client.baseUrl}/api/chat/threads/${encodeURIComponent(threadId)}/branch`,
        {
          method: 'OPTIONS',
          headers: {
            Authorization: `Bearer ${connection.client.token}`
          }
        }
      );
      branchEndpointAvailable = res.status !== 404 && res.status !== 405;
    } catch {
      branchEndpointAvailable = false;
    }
    return branchEndpointAvailable;
  }

  /**
   * Confirm the fork. Strategy:
   *   1. Probe `/api/chat/threads/<id>/branch` — if it exists, POST to it.
   *   2. Otherwise: create a fresh thread with `client.newThread('Fork: ...')`
   *      and seed it with a single user message that includes the full
   *      transcript up to and including the forked assistant turn. The
   *      model treats the seed as conversational context and continues
   *      from there.
   *
   * Either way, on success we toast and navigate to the new thread.
   */
  async function confirmBranch(): Promise<void> {
    if (!connection.client) return;
    if (!branchTargetId || !currentId || !currentThread) return;
    const messageId = branchTargetId;
    const parentThread = currentThread;
    const parentId = currentId;
    const fullHistory = messages.get(parentId);
    const idx = fullHistory.findIndex((m) => m.id === messageId);
    if (idx < 0) {
      toasts.show('Fork failed: message not found', 'error');
      branchTargetId = null;
      return;
    }
    const slice = fullHistory.slice(0, idx + 1);

    branching = true;
    try {
      // Native branch endpoint, if available.
      const native = await probeBranchEndpoint(parentId);
      if (native) {
        try {
          const res = await fetch(
            `${connection.client.baseUrl}/api/chat/threads/${encodeURIComponent(parentId)}/branch`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${connection.client.token}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                up_to_message_id: messageId,
                title: `Fork: ${parentThread.title || 'Untitled'}`
              })
            }
          );
          if (res.ok) {
            const data = (await res.json()) as { thread_id?: string; id?: string };
            const newId = data.thread_id || data.id;
            if (newId) {
              await threads.loadThreads();
              threads.selectThread(newId);
              await messages.loadHistory(newId);
              branchTargetId = null;
              toasts.show('Forked. Continue in the new thread.', 'success');
              return;
            }
          }
          // Native path returned non-2xx unexpectedly — fall through to
          // the context-prefix fallback rather than failing hard.
          branchEndpointAvailable = false;
        } catch {
          branchEndpointAvailable = false;
        }
      }

      // Fallback path: new thread + first-message context seed.
      const newId = await threads.createThread(`Fork: ${parentThread.title || 'Untitled'}`);
      if (!newId) {
        toasts.show("Couldn't create forked thread", 'error');
        return;
      }
      const seed = buildBranchSeed(parentId, slice);
      // Send through the same pipeline the user uses so the seed message
      // shows up as a real user turn and the model replies in stream.
      const localId = messages.appendUserMessage(newId, seed);
      sending = true;
      try {
        await runSendAndStream(newId, seed, localId);
      } finally {
        sending = false;
      }
      branchTargetId = null;
      toasts.show('Forked. Continue in the new thread.', 'success');
    } catch (err) {
      toasts.show(`Fork failed: ${(err as Error).message}`, 'error');
    } finally {
      branching = false;
    }
  }

  /**
   * Build the first-user-message seed for the context-prefix fallback.
   * Concatenates user/assistant turns into a labelled transcript so the
   * agent can read them as conversational context.
   *
   * Output shape:
   *   Forked from <parentId> at turn N. Original context:
   *
   *   User: ...
   *   Assistant: ...
   *   User: ...
   *   Assistant: ...
   */
  function buildBranchSeed(parentId: string, slice: Message[]): string {
    const lines: string[] = [];
    let n = 0;
    for (const m of slice) {
      if (m.role === 'user') {
        n += 1;
        lines.push(`User: ${cleanUserDisplay(m.content)}`);
      } else if (m.role === 'assistant') {
        lines.push(`Assistant: ${m.content}`);
      }
    }
    return `Forked from ${parentId} at turn ${n}. Original context:\n\n${lines.join('\n\n')}`;
  }
</script>

<section class="flex h-full w-full" aria-label="Chat">
  <!-- ============================ Left: thread rail ======================
       Width comes from `effectiveThreadRailWidth`, driven by the
       `ResizeHandle` below. Border lives on the handle's left edge so the
       hover glow doesn't sit on top of an unrelated border.
       Hidden in v2 mode — RebornChatPanel ships its own thread rail. -->
  {#if connection.apiVersion !== 'v2'}
    <aside
      class="shrink-0 h-full border-r border-border-subtle flex flex-col bg-bg-base/40"
      style="width: {effectiveThreadRailWidth}px;"
    >
      <div class="p-3 border-b border-border-subtle">
        <button
          type="button"
          onclick={onNewChat}
          disabled={!connection.client}
          title={connection.client ? 'New chat' : 'Connect in Settings first'}
          class="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-accent-cyan text-bg-deep text-sm font-semibold hover:brightness-110 transition disabled:opacity-40 disabled:cursor-not-allowed min-h-[40px]"
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
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Chat
        </button>
      </div>

      <div
        bind:this={threadRailEl}
        onscroll={onThreadRailScroll}
        class="flex-1 overflow-y-auto py-2 relative"
      >
        {#if threads.loading && threads.threads.length === 0}
          <div class="px-4 py-6 text-xs text-text-muted">Loading threads…</div>
        {:else if threads.error}
          <div class="px-4 py-6 text-xs text-red-400">{threads.error}</div>
        {:else if sortedThreads.length === 0}
          <div class="px-4 py-6 text-xs text-text-muted">
            {#if connection.client}
              No conversations yet. Start a new chat.
            {:else}
              <span class="text-text-muted">Not connected</span>
              <a
                href="/settings"
                class="text-accent-cyan underline decoration-dotted hover:decoration-solid"
                >Configure in Settings →</a
              >
            {/if}
          </div>
        {:else if !threadsVirtualized}
          <!--
          Un-virtualized path. Used when sortedThreads.length <= 30: cheaper
          DOM cost than spacer + window bookkeeping, and the row count is
          small enough that the browser hands scrolling natively. The
          virtualized path below kicks in for larger lists; rows in both
          paths share `data-thread-row` so a future selector-based hook
          (test, scroll-into-view fallback, etc.) can target both.
        -->
          <ul class="space-y-0.5 px-2">
            {#each sortedThreads as t (t.id)}
              {@const active = t.id === currentId}
              {@const isPinned = pins.isPinned('thread', t.id)}
              {@const isRenamed = threadRename.has(t.id)}
              {@const displayTitle = threadRename.displayTitle(t.id, t.title)}
              <!-- Group wrapper exposes the pin star on hover (and always
                 when pinned). Active thread gets the surface bg via
                 group-aware classes so the pin button visually inherits
                 the row's selected state. -->
              <li class="group relative">
                <button
                  type="button"
                  onclick={() => onSelectThread(t.id)}
                  data-thread-row
                  data-thread-id={t.id}
                  class="w-full text-left pl-3 pr-9 py-2 rounded-md text-sm transition-colors border-l-2 flex flex-col gap-0.5"
                  class:border-accent-cyan={active}
                  class:bg-bg-surface={active}
                  class:text-text-primary={active}
                  class:border-transparent={!active}
                  class:text-text-muted={!active}
                  class:hover:bg-bg-surface={!active}
                  class:hover:text-text-primary={!active}
                >
                  <span class="truncate block">
                    {displayTitle}
                    {#if isRenamed}<span
                        class="text-accent-gold text-[10px] ml-1"
                        title="Locally renamed">✏</span
                      >{/if}
                  </span>
                  <span class="text-[10px] text-text-muted flex items-center gap-1.5">
                    <span>{relativeTime(t.updated_at)}</span>
                    <!-- Per-thread token estimate. Only rendered for the
                       active thread to keep the rail render cheap — the
                       messages store only carries history for the
                       focused conversation. -->
                    {#if active && currentThreadTokens !== null && currentThreadTokens > 0}
                      <span
                        class="text-text-muted/70"
                        title="Estimated tokens (~4 chars each)"
                        aria-label={`Estimated ${currentThreadTokens} tokens`}
                        >· ~{currentThreadTokens.toLocaleString()} tokens</span
                      >
                    {/if}
                  </span>
                </button>
                <!-- Pin star — absolutely positioned over the row's right
                   edge so the click target sits clear of the underlying
                   button. Hidden until hover (matches the planned trash
                   icon affordance from the gateway-side TODO), but kept
                   visible when already pinned so users can always see
                   the state without hovering. -->
                <button
                  type="button"
                  onclick={(e) => {
                    e.stopPropagation();
                    pins.toggle('thread', t.id, displayTitle);
                  }}
                  title={isPinned ? 'Unpin this thread' : 'Pin this thread'}
                  aria-label={isPinned ? `Unpin ${displayTitle}` : `Pin ${displayTitle}`}
                  aria-pressed={isPinned}
                  class="absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-6 h-6 rounded transition-opacity hover:bg-bg-deep"
                  class:opacity-100={isPinned}
                  class:opacity-0={!isPinned}
                  class:group-hover:opacity-100={!isPinned}
                  class:focus:opacity-100={!isPinned}
                  class:text-accent-gold={isPinned}
                  class:text-text-muted={!isPinned}
                  class:hover:text-accent-gold={!isPinned}
                >
                  <svg
                    viewBox="0 0 24 24"
                    class="w-3.5 h-3.5"
                    fill={isPinned ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <polygon
                      points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
                    />
                  </svg>
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <!--
          Virtualized path. Mirrors src/routes/logs/+page.svelte: top spacer
          height = rows skipped above the window, bottom spacer = rows
          skipped below. The scroll viewport above (.overflow-y-auto) owns
          scrollTop; this inner block only renders the slice from the
          $derived threadWindow. Each row is forced to exactly
          THREAD_ITEM_HEIGHT via inline style so the windowing math stays
          a trivial division — no per-row measurement.
          TODO: switch to dynamic row heights if multi-line titles become
          required. For now titles are forced single-line via `truncate` so
          the height is stable.
        -->
          <div style="height: {threadTopSpacer}px;" aria-hidden="true"></div>
          <ul class="px-2">
            {#each threadWindow.items as row (row.thread.id)}
              {@const active = row.thread.id === currentId}
              {@const isPinned = pins.isPinned('thread', row.thread.id)}
              {@const isRenamed = threadRename.has(row.thread.id)}
              {@const displayTitle = threadRename.displayTitle(row.thread.id, row.thread.title)}
              <li class="group relative" style="height: {THREAD_ITEM_HEIGHT}px;">
                <button
                  type="button"
                  onclick={() => onSelectThread(row.thread.id)}
                  data-thread-row
                  data-thread-id={row.thread.id}
                  class="w-full text-left pl-3 pr-9 py-2 rounded-md text-sm transition-colors border-l-2 flex flex-col gap-0.5 h-full"
                  class:border-accent-cyan={active}
                  class:bg-bg-surface={active}
                  class:text-text-primary={active}
                  class:border-transparent={!active}
                  class:text-text-muted={!active}
                  class:hover:bg-bg-surface={!active}
                  class:hover:text-text-primary={!active}
                >
                  <span class="truncate block">
                    {displayTitle}
                    {#if isRenamed}<span
                        class="text-accent-gold text-[10px] ml-1"
                        title="Locally renamed">✏</span
                      >{/if}
                  </span>
                  <span class="text-[10px] text-text-muted flex items-center gap-1.5">
                    <span>{relativeTime(row.thread.updated_at)}</span>
                    {#if active && currentThreadTokens !== null && currentThreadTokens > 0}
                      <span
                        class="text-text-muted/70"
                        title="Estimated tokens (~4 chars each)"
                        aria-label={`Estimated ${currentThreadTokens} tokens`}
                        >· ~{currentThreadTokens.toLocaleString()} tokens</span
                      >
                    {/if}
                  </span>
                </button>
                <button
                  type="button"
                  onclick={(e) => {
                    e.stopPropagation();
                    pins.toggle('thread', row.thread.id, displayTitle);
                  }}
                  title={isPinned ? 'Unpin this thread' : 'Pin this thread'}
                  aria-label={isPinned ? `Unpin ${displayTitle}` : `Pin ${displayTitle}`}
                  aria-pressed={isPinned}
                  class="absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-6 h-6 rounded transition-opacity hover:bg-bg-deep"
                  class:opacity-100={isPinned}
                  class:opacity-0={!isPinned}
                  class:group-hover:opacity-100={!isPinned}
                  class:focus:opacity-100={!isPinned}
                  class:text-accent-gold={isPinned}
                  class:text-text-muted={!isPinned}
                  class:hover:text-accent-gold={!isPinned}
                >
                  <svg
                    viewBox="0 0 24 24"
                    class="w-3.5 h-3.5"
                    fill={isPinned ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <polygon
                      points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
                    />
                  </svg>
                </button>
              </li>
            {/each}
          </ul>
          <div style="height: {threadBottomSpacer}px;" aria-hidden="true"></div>
        {/if}
      </div>
    </aside>

    <!-- Resize handle between thread rail and message stream. Hidden when
       the viewport is narrow so we don't waste a 4px column on small
       screens (the layout already falls back to defaults via the
       `effective*` derived widths above). -->
    {#if resizeEnabled}
      <ResizeHandle
        min={THREAD_RAIL_MIN}
        max={THREAD_RAIL_MAX}
        defaultWidth={THREAD_RAIL_DEFAULT}
        storageKey={THREAD_RAIL_STORAGE_KEY}
        initialWidth={threadRailWidth}
        onresize={(w) => (threadRailWidth = w)}
      />
    {/if}
  {/if}

  <!-- =========================== Main: stream + composer ================== -->
  {#if connection.apiVersion === 'v2'}
    <!-- IronClaw Reborn WebChat v2 chat surface. Replaces the v1 stream +
         composer when the active profile speaks v2 (now the default). The
         v1 body below is preserved for any profile explicitly set to v1. -->
    <div class="flex-1 flex flex-col min-w-0 h-full">
      <RebornChatPanel />
    </div>
  {:else}
    <div class="flex-1 flex flex-col min-w-0 h-full">
      <!-- LANE B2 — chat tabs (R52). Sits above the existing thread title row;
         each tab tracks an "open" thread the user wants one click away.
         The store handles persistence per profile + ordering; this
         component is a renderer that wires clicks back to the
         existing onSelectThread / onNewChat handlers. -->
      <ChatTabs
        onSelect={(tid) => onSelectThread(tid)}
        onNew={() => void onNewChat()}
        onClose={(_closedId, nextActive) => {
          if (nextActive && nextActive !== threads.currentId) {
            onSelectThread(nextActive);
          }
        }}
      />
      <header
        class="h-12 shrink-0 px-5 flex items-center justify-between border-b border-border-subtle bg-bg-base/40"
      >
        <div class="flex items-center gap-2 min-w-0 flex-1">
          {#if currentThread}
            {#if renaming}
              <!--
              Inline rename input. Double-click on the title opens this;
              Enter commits, Esc cancels, blur commits (same UX as the
              prior single-click flow). Tooltip surface to the right
              explains the local-only constraint on first use.
            -->
              <div class="flex items-center gap-2 min-w-0 flex-1">
                <input
                  type="text"
                  bind:value={titleDraft}
                  onblur={commitRename}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === 'Escape') {
                      cancelRename();
                    }
                  }}
                  class="bg-bg-deep border border-border-subtle rounded-md px-2 py-1 text-sm text-text-primary focus:outline-none focus:border-accent-cyan w-full max-w-md"
                  aria-label="Rename thread"
                />
                {#if showRenameTooltip}
                  <div class="relative flex-shrink-0">
                    <button
                      type="button"
                      onclick={dismissRenameTooltip}
                      aria-label="Dismiss rename tooltip"
                      class="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-mono text-text-muted border border-border-subtle hover:text-accent-cyan hover:border-accent-cyan transition-colors"
                    >
                      ?
                    </button>
                    <!--
                    Anchored tooltip. We render it inline (rather than via
                    `title=`) so the copy is visible without a hover delay
                    on first use — discoverability is the whole point of
                    the affordance. Click to dismiss.
                  -->
                    <div
                      role="tooltip"
                      class="absolute right-0 top-full mt-1 z-30 w-64 rounded-md border border-border-subtle bg-bg-deep text-xs text-text-muted shadow-lg p-2"
                    >
                      Renames stay on this device; the server doesn't sync them yet.
                    </div>
                  </div>
                {/if}
              </div>
            {:else}
              <!--
              Title row: double-click opens the inline rename, right-click
              opens the kebab menu. We render a `<button>` for the title
              so keyboard users can still focus + activate it; Enter on
              the focused title also opens the rename input.
            -->
              <button
                type="button"
                ondblclick={startRename}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    startRename();
                  }
                }}
                oncontextmenu={(e) => {
                  e.preventDefault();
                  renameMenuOpen = !renameMenuOpen;
                }}
                class="text-sm font-medium text-text-primary truncate hover:text-accent-cyan transition-colors text-left min-w-0"
                title="Double-click to rename · right-click for options"
              >
                {threadRename.displayTitle(currentThread.id, currentThread.title)}
              </button>
              {#if threadRename.has(currentThread.id)}
                <!--
                "Renamed" indicator. Sits to the right of the title so the
                user can see at a glance which threads carry a local
                override. The pencil glyph matches the affordance copy
                in `title=` on the title button.
              -->
                <span
                  aria-label="Locally renamed"
                  title="Renamed on this device only"
                  class="text-[10px] text-accent-gold flex-shrink-0 select-none"
                >
                  ✏
                </span>
              {/if}
              <!--
              Provider chip — small cyan-outlined pill showing the LLM
              provider currently configured on the active profile (and
              the one that produced the most recent assistant turn on
              this thread, assuming the profile hasn't changed). The
              tooltip surfaces the underlying default model id from the
              cached `/api/llm/providers` catalog. Renders nothing when
              there's no active provider — graceful degrade rather than
              a half-broken "Unknown" badge.

              We also surface the per-thread recorded provider if it
              differs from the currently-active one, so a user who's
              switched profiles can see which provider this thread was
              previously on. The chip always reflects the most recent
              recorded provider for the active thread.
            -->
              {#if activeProvider}
                {@const recordedId = currentThread
                  ? threadModel.getProvider(currentThread.id)
                  : undefined}
                {@const recorded =
                  recordedId && recordedId !== activeProvider.id
                    ? llmProviders.find((p) => p.id === recordedId)
                    : undefined}
                {@const shown = recorded ?? activeProvider}
                <span
                  class="inline-flex items-center justify-center px-2 py-0.5 rounded-full border border-accent-cyan/40 text-[10px] font-medium text-accent-cyan flex-shrink-0 select-none truncate max-w-[80px]"
                  style="min-width: 64px;"
                  title={shown.default_model
                    ? `Model: ${shown.default_model}`
                    : `Provider: ${shown.id}`}
                  aria-label={`Provider: ${shown.name}`}
                >
                  {shown.name}
                </span>
              {/if}
              <!--
              Per-thread system-prompt indicator chip (R43). Shows ONLY
              when the user has attached a custom prompt via the kebab
              menu → "Custom system prompt…". Reading `promptVersion`
              keeps the chip reactive to Save / Reset events fired
              from the modal — the underlying $state on the store
              already drives re-renders, but having the explicit
              version reference here documents the dependency for
              future readers.
            -->
              {#if currentThread && promptVersion >= 0 && perThreadPrompts.hasOverride(currentThread.id)}
                <button
                  type="button"
                  onclick={openPerThreadPromptModal}
                  class="inline-flex items-center justify-center px-2 py-0.5 rounded-full border border-accent-gold/50 text-[10px] font-medium text-accent-gold flex-shrink-0 select-none hover:bg-accent-gold/10 transition-colors"
                  title="Custom system prompt. Edit via menu → Custom system prompt."
                  aria-label="Custom system prompt active for this thread"
                >
                  Custom prompt
                </button>
              {/if}
              <!--
              Kebab menu — single action ("Revert to server title") for
              now. Triggers via the chevron OR the right-click handler
              on the title button above. The dropdown auto-closes on
              outside click and Esc (effect wired in the script).
            -->
              <div class="relative flex-shrink-0">
                <button
                  type="button"
                  bind:this={renameMenuButtonEl}
                  onclick={() => (renameMenuOpen = !renameMenuOpen)}
                  class="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-surface transition-colors"
                  aria-haspopup="menu"
                  aria-expanded={renameMenuOpen}
                  aria-label="Thread title options"
                  title="Thread title options"
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
                    <circle cx="12" cy="5" r="1" />
                    <circle cx="12" cy="12" r="1" />
                    <circle cx="12" cy="19" r="1" />
                  </svg>
                </button>
                {#if renameMenuOpen}
                  <div
                    bind:this={renameMenuEl}
                    class="absolute left-0 top-full mt-1 z-20 min-w-[200px] rounded-md border border-border-subtle bg-bg-deep shadow-lg overflow-hidden"
                    role="menu"
                    aria-label="Thread title options"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onclick={startRename}
                      class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface transition-colors"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onclick={revertRename}
                      disabled={!threadRename.has(currentThread.id)}
                      class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface transition-colors border-t border-border-subtle disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Revert to server title
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onclick={openPerThreadPromptModal}
                      class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface transition-colors border-t border-border-subtle"
                    >
                      Custom system prompt…
                    </button>
                  </div>
                {/if}
              </div>
            {/if}
          {:else}
            <span class="text-sm text-text-muted">No conversation selected</span>
          {/if}
        </div>

        <button
          type="button"
          onclick={() => (rightRailOpen = !rightRailOpen)}
          class="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface transition-colors"
          class:text-accent-cyan={rightRailOpen}
          aria-label="Toggle tool inspector"
          title="Tool inspector"
        >
          <svg
            viewBox="0 0 24 24"
            class="w-4 h-4"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
            />
          </svg>
        </button>

        <!-- Daily brief (R101): the Chief of Staff assembles a prioritized
           agenda from recent threads + tracked open loops. Read-only;
           available whenever connected (no active thread needed). -->
        <button
          type="button"
          onclick={onBrief}
          disabled={!connection.client}
          class="p-1.5 ml-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Brief me"
          title={connection.client
            ? 'Agenda from recent threads and open loops'
            : 'Connect to generate a brief'}
        >
          <Icon name="shield" class="w-4 h-4" />
        </button>

        <!-- Triage (R104): the Chief of Staff sorts recent threads into
           Decision needed / FYI / Can handle. Read-only; available whenever
           connected (no active thread needed). -->
        <button
          type="button"
          onclick={onTriage}
          disabled={!connection.client}
          class="p-1.5 ml-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Triage my threads"
          title={connection.client
            ? 'Sort recent threads by what needs you'
            : 'Connect to triage threads'}
        >
          <Icon name="list" class="w-4 h-4" />
        </button>

        <!-- Draft a reply (R105): the Chief of Staff writes a ready-to-send
           draft in the user's voice, grounded in this thread. Read-only —
           the draft is shown for copy; nothing is posted. Needs an active
           thread (like recap). -->
        <button
          type="button"
          onclick={onDraft}
          disabled={!canExport}
          class="p-1.5 ml-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Draft a reply"
          title={canExport
            ? 'Draft a reply in your voice'
            : 'Select a conversation to draft a reply'}
        >
          <Icon name="send" class="w-4 h-4" />
        </button>

        <!-- Thread recap (R89): a non-destructive summary of the conversation
           shown in a dismissable panel. Never edits the transcript. -->
        <button
          type="button"
          onclick={onRecap}
          disabled={!canExport}
          class="p-1.5 ml-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Recap this conversation"
          title={canExport ? 'Summarize this conversation' : 'Select a conversation to recap'}
        >
          <Icon name="spark" class="w-4 h-4" />
        </button>

        <!-- Per-thread export. Sits to the right of rename + tool-rail toggle so
           those existing controls don't shift position. Disabled until we
           have an active thread and a healthy connection. -->
        <div class="relative ml-1">
          <button
            type="button"
            bind:this={exportButtonEl}
            onclick={toggleExportMenu}
            disabled={!canExport}
            class="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-surface transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            class:text-accent-cyan={exportOpen}
            aria-haspopup="menu"
            aria-expanded={exportOpen}
            aria-label="Export conversation"
            title={canExport ? 'Export conversation' : 'Select a conversation to export'}
          >
            <svg
              viewBox="0 0 24 24"
              class="w-4 h-4"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>

          {#if exportOpen}
            <div
              bind:this={exportPopoverEl}
              class="absolute right-0 top-full mt-1 z-20 min-w-[160px] rounded-md border border-border-subtle bg-bg-deep shadow-lg overflow-hidden"
              role="menu"
              aria-label="Export format"
            >
              <button
                type="button"
                role="menuitem"
                onclick={() => void onExportThread('markdown')}
                class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface transition-colors"
              >
                <svg
                  viewBox="0 0 24 24"
                  class="w-3.5 h-3.5 text-text-muted"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                Markdown
              </button>
              <button
                type="button"
                role="menuitem"
                onclick={() => void onExportThread('json')}
                class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface transition-colors border-t border-border-subtle"
              >
                <svg
                  viewBox="0 0 24 24"
                  class="w-3.5 h-3.5 text-text-muted"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <path d="M8 17v-4M12 17v-4M16 17v-4" />
                </svg>
                JSON
              </button>
              <button
                type="button"
                role="menuitem"
                onclick={() => void onExportThread('html')}
                class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface transition-colors border-t border-border-subtle"
              >
                <svg
                  viewBox="0 0 24 24"
                  class="w-3.5 h-3.5 text-text-muted"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="16 18 22 12 16 6" />
                  <polyline points="8 6 2 12 8 18" />
                </svg>
                HTML
              </button>
            </div>
          {/if}
        </div>
      </header>

      <!-- message stream (wrapper hosts the floating "new messages" FAB
         and the optional find-in-thread bar) -->
      <div class="flex-1 min-h-0 relative">
        <!-- find-in-thread bar — opens with Cmd/Ctrl+F. Positioned absolute
           at the top of the stream so it floats over the first messages
           without pushing the layout. -->
        {#if searchOpen}
          <div class="absolute top-3 left-1/2 -translate-x-1/2 z-20 w-full max-w-md px-3">
            <ChatSearch
              scrollRoot={scrollEl}
              {contentVersion}
              onClose={() => (searchOpen = false)}
            />
          </div>
        {/if}
        <!-- Event-delegated <img> click handler — opens the lightbox for any
         image inside the stream (sent attachments, optimistic blob previews,
         or markdown-rendered assistant content). svelte's a11y rule is
         relaxed because the actual interactive targets (images) are tagged
         with role + tabindex when they're rendered through MarkdownView /
         the user bubble. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          bind:this={scrollEl}
          onscroll={onScroll}
          onclick={onStreamClick}
          class="absolute inset-0 overflow-y-auto px-6 py-5"
        >
          {#if !currentThread && history.length === 0 && !streamingBuffer}
            <div class="h-full flex flex-col items-center justify-center text-center">
              <svg
                viewBox="0 0 24 24"
                class="w-12 h-12 text-accent-cyan/30 mb-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                aria-hidden="true"
              >
                <path d="M4 7l8-4 8 4-8 4-8-4z" stroke-linejoin="round" />
                <path d="M4 12l8 4 8-4" stroke-linejoin="round" />
                <path d="M4 17l8 4 8-4" stroke-linejoin="round" />
              </svg>
              {#if !connection.client}
                <p class="text-sm text-text-primary">IronClaw is offline</p>
                <p class="text-xs text-text-muted mt-1">
                  <a
                    href="/settings"
                    class="text-accent-cyan underline decoration-dotted hover:decoration-solid"
                    >Configure in Settings</a
                  > to start chatting
                </p>
              {:else}
                <p class="text-sm text-text-muted">Start a conversation</p>
                <p class="text-xs text-text-muted mt-1">Enter to send · Shift+Enter for newline</p>
              {/if}
            </div>
          {:else}
            <div class="max-w-4xl mx-auto space-y-4">
              <!--
            Lazy-history indicator. Renders only while a paginated fetch is
            in flight. The container scroll position is anchored around the
            prepend in maybeLoadMore(), so this row appears briefly, the new
            page lays out above the existing list, and the scrollTop is
            pushed down by the inserted height — the user's view stays
            fixed on the message they were reading.
          -->
              {#if isLoadingMore}
                <div class="flex justify-center py-2">
                  <span class="inline-flex items-center gap-2 text-xs text-text-muted">
                    <span
                      class="w-1.5 h-1.5 rounded-full bg-accent-cyan animate-pulse"
                      aria-hidden="true"
                    ></span>
                    Loading older messages…
                  </span>
                </div>
              {/if}
              {#each history as msg (msg.id)}
                {#if msg.role === 'user'}
                  {@const meta = messages.getMeta(msg.id)}
                  {@const failed = !!meta.failed}
                  {@const userDisplay = cleanUserDisplay(msg.content)}
                  {@const userHasImage = userHasInlineImage(userDisplay)}
                  <div class="flex flex-col items-end gap-1">
                    <div
                      class="search-target max-w-[75%] rounded-lg border px-4 py-2.5 text-sm text-text-primary"
                      class:whitespace-pre-wrap={!userHasImage}
                      style={failed
                        ? 'background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.45);'
                        : 'background:rgba(76,167,230,0.10);border-color:rgba(251,191,36,0.4);'}
                    >
                      <!-- LANE B9 (R69) — editable user bubble. We synthesize a
                         msg-like object with the cleaned content so the
                         textarea pre-fill (and the rendered MarkdownView in
                         view mode) both show the same text the user sees
                         today — the `<attachments>` tag block is purely
                         internal. The id passes through unchanged so
                         `handleBubbleEdit` can still look the row up in the
                         messages store. `userHasImage` continues to drive the
                         `whitespace-pre-wrap` class above so non-markdown
                         bubbles keep their original wrapping. -->
                      <EditableBubble
                        msg={{ ...msg, content: userDisplay }}
                        onEditSubmit={handleBubbleEdit}
                        disabled={isStreaming}
                      />
                    </div>
                    {#if failed && currentId}
                      {@const isRetrying = !!retryingIds[msg.id]}
                      <div class="flex items-center gap-2 text-[11px] text-red-300 max-w-[75%]">
                        <svg
                          viewBox="0 0 24 24"
                          class="w-3 h-3 shrink-0"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2.5"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <circle cx="12" cy="12" r="10" />
                          <line x1="12" y1="8" x2="12" y2="12" />
                          <line x1="12" y1="16" x2="12.01" y2="16" />
                        </svg>
                        <span>Failed to send</span>
                        <button
                          type="button"
                          onclick={() => void onRetry(currentId!, msg.id)}
                          disabled={isRetrying || sending || isStreaming}
                          class="px-2 py-0.5 rounded border border-red-500/50 bg-red-500/10 text-red-200 hover:bg-red-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Retry send"
                        >
                          {isRetrying ? 'Retrying…' : 'Retry'}
                        </button>
                      </div>
                    {/if}
                  </div>
                {:else if msg.role === 'assistant'}
                  <!-- Group wrapper exposes the Branch button on hover (focus-
                   visible too, for keyboard users). The fork-aware button
                   pops the confirm dialog rather than acting directly so
                   the user can back out without losing intent. -->
                  <div class="flex justify-start">
                    <div class="group relative max-w-[85%]">
                      <div
                        class="search-target rounded-lg border surface px-4 py-2.5 text-sm text-text-primary"
                      >
                        <MarkdownView markdown={msg.content} />
                      </div>
                      <button
                        type="button"
                        onclick={() => openBranchConfirm(msg.id)}
                        disabled={branching || sending || isStreaming}
                        class="absolute top-1.5 right-1.5 inline-flex items-center justify-center w-6 h-6 rounded text-text-muted bg-bg-deep/80 border border-border-subtle hover:text-accent-cyan hover:border-accent-cyan/50 transition-all opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-30 disabled:cursor-not-allowed"
                        aria-label="Fork from this message"
                        title="Fork from this message"
                      >
                        <!-- Inline branch glyph (not in Icon.svelte's set; v2
                         design vocabulary). Two parallel lines diverging
                         to suggest a split. -->
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
                          <circle cx="6" cy="6" r="2" />
                          <circle cx="18" cy="6" r="2" />
                          <circle cx="12" cy="18" r="2" />
                          <path d="M6 8v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V8" />
                          <line x1="12" y1="14" x2="12" y2="16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                {:else}
                  <!-- tool message (rare today; gateway doesn't emit these in history) -->
                  <div class="flex justify-start">
                    <div
                      class="search-target max-w-[85%] rounded-md border border-border-subtle bg-bg-deep px-3 py-2 text-xs text-text-muted font-mono"
                    >
                      tool · {msg.content}
                    </div>
                  </div>
                {/if}
              {/each}

              <!-- in-flight assistant turn -->
              {#if isStreaming || streamingBuffer}
                <div class="flex justify-start">
                  <div
                    class="search-target max-w-[85%] rounded-lg border surface px-4 py-2.5 text-sm text-text-primary"
                  >
                    {#if streamingBuffer}
                      <!-- Lightweight renderer while streaming; MarkdownView takes over once the turn commits to history (message_end). -->
                      <StreamingText text={streamingBuffer} />
                    {:else}
                      <span class="inline-flex items-center gap-1.5 text-text-muted">
                        <span class="w-1.5 h-1.5 rounded-full bg-accent-cyan animate-pulse"></span>
                        <span class="text-xs">Thinking…</span>
                      </span>
                    {/if}
                  </div>
                </div>
              {/if}

              {#if streamError}
                <div class="flex justify-start">
                  <div
                    class="max-w-[85%] rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300"
                  >
                    {streamError}
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <!-- LANE B5 — replay bar (R58): mounted only when the user has
           explicitly opened replay for this thread. The bar reads from
           the replay store; opening fetches the event timeline via the
           replay.loadFor() call wired below. -->
        {#if currentId && replayUI.isOpenFor(currentId)}
          <ReplayBar
            threadId={currentId}
            onClose={() => {
              if (currentId) replayUI.close(currentId);
            }}
          />
        {/if}
        <!-- LANE W3 — reply-thread panel (R80): anchored to the right
           edge of the chat stream as a sliding panel when the user
           opens a reply thread. Hidden when no parent is selected. -->
        {#if replyThreadUI.openParent && replyThreadUI.openThreadId}
          <div class="absolute right-0 top-0 bottom-0 z-10">
            <ReplyThreadPanel
              parentMessage={replyThreadUI.openParent}
              parentThreadId={replyThreadUI.openThreadId}
              onClose={() => replyThreadUI.close()}
            />
          </div>
        {/if}

        <!-- scroll-to-bottom FAB — shown when new content arrives off-screen -->
        {#if showScrollFab}
          <button
            type="button"
            onclick={() => scrollToBottom(true)}
            class="absolute left-1/2 -translate-x-1/2 bottom-4 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-accent-cyan text-bg-deep text-xs font-semibold shadow-lg hover:brightness-110 transition-all"
            aria-label="Scroll to newest message"
            title="Jump to bottom"
          >
            <svg
              viewBox="0 0 24 24"
              class="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <polyline points="19 12 12 19 5 12" />
            </svg>
            <span>New messages</span>
          </button>
        {/if}
      </div>

      <!-- composer -->
      <div class="shrink-0 border-t border-border-subtle bg-bg-base/40 px-6 py-4">
        <div
          class="max-w-4xl mx-auto relative"
          ondragenter={onComposerDragEnter}
          ondragover={onComposerDragOver}
          ondragleave={onComposerDragLeave}
          ondrop={onComposerDrop}
          role="presentation"
        >
          <!-- LANE B1 — voice-answer bar mount (TTS playback strip — R51) -->
          {#if voiceAnswer.enabled}
            <div class="mb-2"><VoiceAnswerBar /></div>
          {/if}
          <!-- LANE B4 — sub-agent task chips (R57): active + recent
             background tasks delegated from this thread. Cmd+Shift+D
             delegates the latest user turn. -->
          {#if currentId}
            {@const tasks = subAgents.forThread(currentId)}
            {#if tasks.length > 0}
              <div class="mb-2 flex flex-col gap-1.5">
                {#each tasks as task (task.id)}
                  <SubAgentChip {task} />
                {/each}
              </div>
            {/if}
            {#if subAgents.unsupported}
              <div class="mb-2 text-[10px] text-text-muted">
                Sub-agent delegation needs a newer IronClaw gateway.
              </div>
            {/if}
          {/if}
          <!-- LANE B8 — skill editor mount (R65) -->
          <SkillEditorModal />
          <!-- LANE B9 — editable bubble swap (per-bubble live edit toggle lands here) -->

          <!-- Hidden file input — triggered by the "+" button. `accept` is
             advisory in the OS picker; we re-validate in intakeFiles(). -->
          <input
            bind:this={attachmentInputEl}
            onchange={onFileInputChange}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/rtf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/tab-separated-values,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/markdown,application/json,application/x-yaml,application/xml,text/html,.pdf,.doc,.docx,.rtf,.xls,.xlsx,.csv,.tsv,.ppt,.pptx,.txt,.md,.markdown,.json,.yaml,.yml,.xml,.html,.htm"
            multiple
            class="hidden"
            aria-label="Attach files"
          />

          <!-- slash-command autocomplete — anchored to this wrapper so the
             dropdown grows upward from the composer's top edge. -->
          <SlashAutocomplete
            bind:this={slashAutoEl}
            anchor={composerEl}
            value={input}
            {caret}
            skills={skillCatalog}
            onPick={applySlashPick}
          />

          {#if !connection.client}
            <div
              class="mb-2 flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-deep px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div class="min-w-0" id="composer-connection-status">
                <p class="text-sm font-medium text-text-primary">Not connected</p>
                <p class="text-xs text-text-muted">
                  Offline. Connect in Settings to start chatting.
                </p>
              </div>
              <button
                type="button"
                onclick={openConnectionSettings}
                class="shrink-0 rounded-md border border-accent-cyan/40 px-3 py-1.5 text-xs font-medium text-accent-cyan hover:bg-accent-cyan/10 focus:outline-none focus:ring-2 focus:ring-accent-cyan focus:ring-offset-2 focus:ring-offset-bg-base transition-colors"
                aria-describedby="composer-connection-status"
              >
                Open Settings
              </button>
            </div>
          {/if}

          <!-- Attachment thumbnail strip — sits above the textarea border,
             tucks the previews flush against the composer chrome. The strip
             takes its own row so longer file names don't squeeze the
             textarea. Visible only when at least one attachment is staged. -->
          {#if attachments.length > 0}
            <div class="flex flex-wrap gap-2 mb-2" aria-label="Pending attachments">
              {#each attachments as a (a.id)}
                <div
                  class="group flex items-center gap-2 bg-bg-deep border border-border-subtle rounded-md pl-1 pr-2 py-1 hover:border-accent-cyan/50 transition-colors"
                  title={`${a.name} · ${fmtBytes(a.size)}`}
                >
                  {#if isImageMime(a.mime) && a.previewUrl}
                    <img
                      src={a.previewUrl}
                      alt={a.name}
                      class="w-12 h-12 object-cover rounded shrink-0"
                    />
                  {:else}
                    <!-- Non-image attachments: icon + extension tag. No
                       thumbnail so the chip stays compact and the type is
                       immediately readable. -->
                    <div
                      class="w-12 h-12 rounded shrink-0 bg-bg-base border border-border-subtle flex flex-col items-center justify-center gap-0.5"
                      aria-hidden="true"
                    >
                      <Icon name="file" class="w-4 h-4 text-accent-cyan" />
                      <span class="text-[8px] font-mono font-semibold text-text-muted leading-none">
                        {shortType(a.mime, a.name)}
                      </span>
                    </div>
                  {/if}
                  <div class="flex flex-col min-w-0 max-w-[160px]">
                    <span class="text-xs text-text-primary truncate">{a.name}</span>
                    <span class="text-[10px] text-text-muted">{fmtBytes(a.size)}</span>
                  </div>
                  <button
                    type="button"
                    onclick={() => removeAttachment(a.id)}
                    class="shrink-0 w-5 h-5 rounded text-text-muted hover:text-red-300 hover:bg-red-500/10 transition-colors flex items-center justify-center"
                    aria-label={`Remove ${a.name}`}
                    title="Remove"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      class="w-3 h-3"
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
              {/each}
            </div>
          {/if}

          <div
            class="flex items-end gap-2 bg-bg-deep border border-border-subtle rounded-lg px-3 py-2 focus-within:border-accent-cyan transition-colors"
          >
            <!-- Attach button — file picker fallback for users who don't
               drag or paste. Sits left of the textarea so the send button
               keeps its anchor on the right edge. -->
            <button
              type="button"
              onclick={openFilePicker}
              disabled={!connection.client || attachments.length >= MAX_ATTACHMENTS}
              class="shrink-0 w-9 h-9 rounded-md text-text-muted hover:text-accent-cyan hover:bg-accent-cyan/10 transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Attach file"
              title={attachments.length >= MAX_ATTACHMENTS
                ? `Max ${MAX_ATTACHMENTS} attachments`
                : 'Attach file · images, PDF, DOCX, XLSX, PPTX, CSV, TXT, MD, JSON · 25 MB each'}
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
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>

            <!-- Mic button — Web Speech API dictation. Pulses red while
               listening; disabled with a tooltip when the API isn't
               present (Firefox today). Toggle: first click starts, second
               click commits the final transcript and stops. Auto-stops
               after 3s of silence. The listening state uses inline rgba
               styles instead of Tailwind tokens so the colour stays in
               sync with the v2 design vocabulary without forcing a new
               theme entry. -->
            <button
              type="button"
              onclick={toggleVoice}
              disabled={!connection.client || !voiceSupported}
              class="shrink-0 w-9 h-9 rounded-md transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
              class:text-text-muted={!voiceListening}
              class:hover:text-accent-cyan={!voiceListening && voiceSupported}
              class:text-red-400={voiceListening}
              class:animate-pulse={voiceListening}
              style={voiceListening ? 'background:rgba(239,68,68,0.10);' : voiceSupported ? '' : ''}
              aria-label={voiceListening ? 'Stop dictation' : 'Start dictation'}
              aria-pressed={voiceListening}
              title={!voiceSupported
                ? 'Voice input not supported here'
                : voiceListening
                  ? 'Stop dictation · click or pause 3s'
                  : 'Dictate'}
            >
              <svg
                viewBox="0 0 24 24"
                class="w-4 h-4"
                fill={voiceListening ? 'currentColor' : 'none'}
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0" />
                <line x1="12" y1="18" x2="12" y2="22" />
                <line x1="8" y1="22" x2="16" y2="22" />
              </svg>
            </button>

            <!-- LANE B1 — voice answer toggle (R51). Speaker icon; cyan
               when armed, muted when off. Click flips voiceAnswer.enabled;
               persists to localStorage so the toggle survives reload. -->
            <button
              type="button"
              onclick={() => voiceAnswer.toggle()}
              disabled={!connection.client}
              class="shrink-0 w-9 h-9 rounded-md transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
              class:text-accent-cyan={voiceAnswer.enabled}
              class:text-text-muted={!voiceAnswer.enabled}
              class:hover:text-accent-cyan={!voiceAnswer.enabled}
              class:hover:bg-accent-cyan={false}
              aria-label={voiceAnswer.enabled
                ? 'Voice answer on · click to turn off'
                : 'Voice answer off · click to turn on'}
              title={voiceAnswer.enabled
                ? 'Voice answer on · click to turn off'
                : 'Voice answer off · click to turn on'}
              aria-pressed={voiceAnswer.enabled}
            >
              {#if voiceAnswer.enabled}
                <!-- Speaker icon with sound waves -->
                <svg
                  viewBox="0 0 24 24"
                  class="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              {:else}
                <!-- Speaker icon, muted -->
                <svg
                  viewBox="0 0 24 24"
                  class="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              {/if}
            </button>

            <textarea
              bind:this={composerEl}
              bind:value={input}
              oninput={() => {
                autoGrow();
                scheduleDraftSave();
                syncCaret();
              }}
              onkeyup={syncCaret}
              onclick={syncCaret}
              onkeydown={onKeyDown}
              onpaste={onComposerPaste}
              placeholder={connection.client
                ? 'Message IronClaw…'
                : 'Configure connection in Settings to start chatting'}
              disabled={!connection.client}
              rows="1"
              class="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none resize-none leading-6 max-h-48 min-h-[24px] py-1 disabled:cursor-not-allowed"
            ></textarea>

            {#if isStreaming}
              <button
                type="button"
                onclick={onStop}
                class="shrink-0 w-9 h-9 rounded-md bg-bg-surface border border-accent-gold/50 text-accent-gold hover:bg-accent-gold/10 transition-colors flex items-center justify-center"
                aria-label="Stop"
                title="Stop"
              >
                <svg viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
              </button>
            {:else}
              <button
                type="button"
                onclick={onSend}
                disabled={!canSend}
                class="shrink-0 w-9 h-9 rounded-md bg-accent-cyan text-bg-deep hover:brightness-110 transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Send"
                title="Send (Enter)"
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
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            {/if}
          </div>

          <!-- Drag-over overlay. Fades in atop the composer when the user is
             dragging files; non-interactive (pointer-events:none) so the
             drop event still hits the wrapper underneath. -->
          {#if dragDepth > 0}
            <div
              class="absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-accent-cyan bg-bg-deep/80 backdrop-blur-sm transition-opacity duration-150 pointer-events-none"
              aria-hidden="true"
            >
              <div class="flex flex-col items-center gap-1.5 text-accent-cyan">
                <svg
                  viewBox="0 0 24 24"
                  class="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span class="text-sm font-semibold">Drop files here</span>
                <span class="text-[11px] text-text-muted"
                  >Images, docs, sheets, decks, PDFs, and text · up to {MAX_ATTACHMENTS} · 25 MB each</span
                >
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <!-- ====================== Right: tool-flow visualizer ==================
       Always-on rail (hidden below Tailwind's xl breakpoint, 1280px) that
       streams the chronological tool-call ledger for the active thread.
       Distinct from the toggled inspector below — that one is opt-in and
       only renders the legacy `tools` array; this one is always visible
       on widescreens and reflects the per-event ledger maintained by the
       `toolFlow` store. Width is fixed at 320px per the v2 design
       vocabulary so we don't add a second draggable handle to the layout
       for a primarily-passive surface. -->
  {#if connection.apiVersion !== 'v2'}
    <!-- Tool-flow ledger is fed only by the v1 event handler; in v2 the tool
         cards render inline in RebornChatPanel, so this rail would be dead
         (permanently empty) chrome. Only mount it on the v1 surface. -->
    <aside
      class="hidden xl:block shrink-0 h-full w-[320px] border-l border-border-subtle bg-bg-base/40"
      aria-label="Tool flow"
    >
      <ToolFlowPanel threadId={currentId} />
    </aside>
  {/if}

  <!-- ====================== Right: tool inspector ========================
       Width driven by `effectiveInspectorWidth`. The handle sits to the
       left of the aside so the user drags the boundary between the
       message stream and the inspector. The handle is conditionally
       rendered alongside the aside so it disappears with the pane. -->
  {#if rightRailOpen && tools.length > 0}
    {#if resizeEnabled}
      <ResizeHandle
        min={INSPECTOR_MIN}
        max={INSPECTOR_MAX}
        defaultWidth={INSPECTOR_DEFAULT}
        storageKey={INSPECTOR_STORAGE_KEY}
        initialWidth={inspectorWidth}
        onresize={(w) => (inspectorWidth = w)}
      />
    {/if}
    <aside
      class="shrink-0 h-full border-l border-border-subtle bg-bg-base/40 flex flex-col"
      style="width: {effectiveInspectorWidth}px;"
    >
      <div
        class="h-12 shrink-0 px-4 flex items-center justify-between border-b border-border-subtle"
      >
        <span class="text-xs font-semibold text-text-primary uppercase tracking-wide">
          Tool Calls
        </span>
        <button
          type="button"
          onclick={() => (rightRailOpen = false)}
          class="p-1 rounded text-text-muted hover:text-text-primary"
          aria-label="Close"
        >
          <svg
            viewBox="0 0 24 24"
            class="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-3 space-y-2">
        {#each tools as t (t.id)}
          {@const open = !!expandedTools[t.id]}
          <div class="rounded-md border border-border-subtle bg-bg-deep">
            <button
              type="button"
              onclick={() => toggleTool(t.id)}
              class="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-bg-surface transition-colors"
            >
              <div class="flex items-center gap-2 min-w-0">
                <span
                  class="w-1.5 h-1.5 rounded-full shrink-0"
                  class:bg-accent-gold={!t.done}
                  class:bg-accent-cyan={t.done}
                ></span>
                <span class="text-xs font-mono text-text-primary truncate">
                  {t.name}
                </span>
              </div>
              <svg
                viewBox="0 0 24 24"
                class="w-3 h-3 text-text-muted shrink-0 transition-transform"
                class:rotate-90={open}
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
            {#if open}
              <div class="border-t border-border-subtle px-3 py-2 space-y-2">
                <div>
                  <div class="text-[10px] uppercase tracking-wider text-text-muted mb-1">Args</div>
                  <pre
                    class="text-[11px] font-mono text-text-primary whitespace-pre-wrap break-all bg-bg-base/60 rounded p-2 overflow-x-auto">{fmtJson(
                      t.args
                    )}</pre>
                </div>
                {#if t.done}
                  <div>
                    <div class="text-[10px] uppercase tracking-wider text-text-muted mb-1">
                      Result
                    </div>
                    <pre
                      class="text-[11px] font-mono text-text-primary whitespace-pre-wrap break-all bg-bg-base/60 rounded p-2 overflow-x-auto">{fmtJson(
                        t.result
                      )}</pre>
                  </div>
                {:else}
                  <div class="text-[11px] text-accent-gold">Running…</div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </aside>
  {/if}
</section>

<!-- =========================== Image lightbox =============================
     Mounted at the section's root level (not inside the message stream) so
     the fixed overlay positions cleanly against the viewport regardless of
     the surrounding flex layout. Rendered conditionally on `lightboxSrc`. -->
{#if lightboxSrc}
  <LightboxModal src={lightboxSrc} alt={lightboxAlt} onClose={closeLightbox} />
{/if}

<!-- =========================== Per-thread system-prompt modal (R43) ========
     Sibling to the lightbox so the overlay layers above the chat without
     having to plumb the modal's state through the main grid. Owns its
     own internal draft + char-count state; persists through the
     `perThreadPrompts` store. `onChanged` bumps `promptVersion` so the
     header chip and the streaming path pick up the new value without a
     hard reload. -->
<PerThreadPromptModal
  bind:open={promptModalOpen}
  threadId={currentThread?.id ?? null}
  threadTitle={currentThread
    ? threadRename.displayTitle(currentThread.id, currentThread.title)
    : ''}
  onClose={() => (promptModalOpen = false)}
  onChanged={onPromptChanged}
/>

<!-- =========================== Branch confirm dialog ======================
     Small modal — same backdrop pattern as NewProfileModal. Click the
     backdrop or Esc cancels; Enter on Fork submits. Disabled while a fork
     is mid-flight so a double-click can't kick off two threads. -->
{#if branchTargetId}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    onclick={closeBranchConfirm}
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeBranchConfirm();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void confirmBranch();
      }
    }}
    role="button"
    tabindex="-1"
    aria-label="Close fork dialog"
  >
    <div
      class="surface w-[min(440px,calc(100vw-2rem))] p-6 space-y-5 border border-border-subtle"
      role="dialog"
      aria-modal="true"
      aria-labelledby="branch-dialog-title"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      tabindex="-1"
    >
      <header class="space-y-1">
        <h2 id="branch-dialog-title" class="text-lg font-semibold text-text-primary">
          Fork this conversation?
        </h2>
        <p class="text-xs text-text-muted">
          Copies messages up to here into a new thread. The original stays intact.
        </p>
      </header>
      <div class="flex items-center justify-end gap-3">
        <button
          type="button"
          onclick={closeBranchConfirm}
          disabled={branching}
          class="text-sm text-text-muted hover:text-text-primary transition-colors disabled:opacity-50 min-h-[44px] px-3"
        >
          Cancel
        </button>
        <button
          type="button"
          onclick={() => void confirmBranch()}
          disabled={branching}
          class="px-4 py-2 rounded-md bg-accent-cyan text-bg-deep text-sm font-semibold hover:brightness-110 transition disabled:opacity-50 min-h-[44px]"
        >
          {branching ? 'Forking…' : 'Fork'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- R89: thread recap overlay (self-gates on recap.open) -->
<RecapPanel />

<!-- R101: Chief of Staff daily brief. Regenerate re-runs onBrief with the
     current threads + (possibly edited) open loops. -->
<BriefingPanel onRegenerate={onBrief} />

<!-- R104: Chief of Staff thread triage. Regenerate re-runs onTriage. -->
<TriagePanel onRegenerate={onTriage} />

<!-- R105: Chief of Staff draft-to-send. Regenerate re-runs onDraft with the
     same thread + the (edited) instruction. -->
<DraftPanel onRegenerate={onDraft} />

<!-- Council overlay — multi-model fanout, summoned via /council (self-gates) -->
<CouncilPanel />
