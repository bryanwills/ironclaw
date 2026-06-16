<script lang="ts">
  // Self-contained IronClaw Reborn (WebChat v2) chat surface — a two-pane
  // layout: a thread rail (browse/resume/new) + the conversation. Mounted by
  // the chat route when the active profile speaks v2. Deliberately isolated
  // from the large v1 chat body in `+page.svelte`.
  //
  // The active thread is owned by the injected `RebornThreadStore`
  // (`threads.currentId`) — the single source of truth — and the conversation
  // is driven by the `RebornChatController` (send / timeline / SSE stream /
  // gate / cancel). Both stores are injected (defaulting to the app-wide
  // singletons) so the render tests can drive them with mock-client instances
  // and pre-seeded state without standing up the connection store.

  import { onDestroy, onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import ChatModelSelector from './ChatModelSelector.svelte';
  import MarkdownView from './LazyMarkdownView.svelte';
  import WorkProductActions from './WorkProductActions.svelte';
  import { connection } from '$lib/stores/connection.svelte';
  import { composerInsert } from '$lib/stores/templates.svelte';
  import { rebornChat, RebornChatController } from '$lib/stores/reborn-chat.svelte';
  import { rebornThreads, RebornThreadStore } from '$lib/stores/reborn-threads.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { workItems } from '$lib/stores/work-items.svelte';
  import type { RebornMessage, ThreadSummary } from '$lib/api/reborn';
  import type { AttachmentInput, GatewayStatus } from '$lib/api/types';
  import type { WorkItem, WorkItemApprovalBoundary } from '$lib/data/work-item';
  import { evaluateApprovalBoundary, requiresApproval } from '$lib/util/approval-enforcement';
  import { relativeTime } from '$lib/util/format-time';
  import { groupThreadsByRecency } from '$lib/util/thread-groups';
  import { modelExecutionReadiness } from '$lib/util/model-readiness';
  import {
    createWorkDispatchResume,
    getWorkDispatchResume,
    removeWorkDispatchResume,
    updateWorkDispatchResumeBoundary,
    upsertWorkDispatchResume,
    workDispatchReviewHref,
    WORK_DISPATCH_RESUME_PARAM,
    type WorkDispatchResume
  } from '$lib/util/work-dispatch-resume';
  import { orchestrateChiefOfStaffAsk } from '$lib/util/workflow-orchestrator';
  import { attachmentRiskSource } from '$lib/util/attachment-risk';
  import { shouldKeepRoutedWorkInChat } from '$lib/util/chat-work-routing';

  interface Props {
    /** Injectable for tests; default to the app-wide singletons. */
    controller?: RebornChatController;
    threads?: RebornThreadStore;
  }
  let { controller = rebornChat, threads = rebornThreads }: Props = $props();

  let draft = $state('');
  let attachments = $state<PendingAttachment[]>([]);
  let attachmentInputEl = $state<HTMLInputElement>();
  let dragDepth = $state(0);
  let pendingLocalApproval = $state<PendingLocalApproval | null>(null);
  let gatewayStatus = $state<GatewayStatus | null>(null);
  let gatewayStatusError = $state<string | null>(null);
  let gatewayStatusRequestSeq = 0;
  let userRequestedNewChat = false;
  let autoSelectedInitialThread = false;

  // Skill launch / template insertion: drain the one-shot composer bus into
  // this v2 composer. Skills "Run", the drawer's "Open in chat", and the
  // command palette push the invocation here (the v1 page guards its own
  // drain on apiVersion, so only the mounted surface consumes the payload).
  $effect(() => {
    const pending = composerInsert.pending;
    if (pending === null) return;
    untrack(() => {
      const payload = composerInsert.consume();
      if (!payload) return;
      draft = draft.trim().length > 0 ? `${draft}\n${payload.text}` : payload.text;
    });
  });

  // Chief-of-staff starter prompts for the empty conversation. Clicking one
  // sends it through the normal path (creates the thread, opens its stream,
  // posts) — a warm, on-thesis entry point that mirrors the Desk's "what needs
  // you" framing instead of dropping the user onto a blank canvas.
  const SUGGESTED_PROMPTS: ReadonlyArray<{ label: string; prompt: string }> = [
    { label: 'Brief me on today', prompt: 'Brief me on what matters today.' },
    { label: 'Triage my threads', prompt: 'Triage my open threads and tell me what needs action.' },
    { label: 'What needs my decision?', prompt: 'What is waiting on my decision right now?' },
    { label: 'Draft a reply', prompt: 'Draft a reply to my most recent message.' }
  ];

  const ALLOWED_MIME = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/rtf',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/tab-separated-values',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
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

  const MAX_ATTACHMENTS = 5;
  const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

  interface PendingAttachment {
    id: string;
    name: string;
    mime: string;
    size: number;
    dataBase64: string;
  }

  type PendingLocalApproval = {
    workItemId: string;
    boundaryId: string;
    content: string;
    attachments: AttachmentInput[];
    threadId?: string;
    resumeId?: string;
  };

  type RoutedMessage =
    | { status: 'send'; content: string; workItemId?: string }
    | {
        status: 'blocked';
        workItem: WorkItem;
        boundary: WorkItemApprovalBoundary;
        content: string;
      }
    | { status: 'needs_clarification'; reason: string };

  // Which tool/capability cards are expanded (progressive disclosure —
  // collapsed by default; keyed by message id).
  let expandedTools = $state<Record<string, boolean>>({});
  function toggleTool(id: string) {
    expandedTools = { ...expandedTools, [id]: !expandedTools[id] };
  }

  // Scroll-pin: keep the conversation pinned to the newest turn unless the
  // user scrolls up, in which case a "Jump to latest" pill appears.
  let scrollEl = $state<HTMLDivElement>();
  let atBottom = $state(true);
  const BOTTOM_THRESHOLD_PX = 80;
  function onScroll() {
    if (!scrollEl) return;
    atBottom =
      scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < BOTTOM_THRESHOLD_PX;
  }
  function jumpToLatest() {
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
    atBottom = true;
  }

  // Composer auto-grow: the textarea grows with content up to a cap, then
  // scrolls. Bound so we can measure scrollHeight on input; reset to one row
  // after a send clears the draft.
  let composerEl = $state<HTMLTextAreaElement>();
  const COMPOSER_MAX_PX = 144; // ~9rem cap (matches the CSS max-height)
  function autoGrowComposer() {
    if (!composerEl) return;
    composerEl.style.height = 'auto';
    composerEl.style.height = `${Math.min(composerEl.scrollHeight, COMPOSER_MAX_PX)}px`;
  }
  function resetComposerHeight() {
    if (composerEl) composerEl.style.height = 'auto';
  }

  const attachmentAccept = Array.from(ALLOWED_MIME).join(',');

  function inferMime(file: File): string {
    if (file.type) return file.type;
    const ext = file.name.split('.').pop()?.toLowerCase();
    return ext ? (EXT_TO_MIME[ext] ?? '') : '';
  }

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
    if (mime.startsWith('image/')) return 'IMG';
    if (map[mime]) return map[mime];
    return name.split('.').pop()?.toUpperCase() || 'FILE';
  }

  function fmtBytes(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
    return `${Math.round(size / (1024 * 102.4)) / 10} MB`;
  }

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
        accepted.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name || 'attachment',
          mime,
          size: file.size,
          dataBase64: await readAsBase64(file)
        });
      } catch (err) {
        toasts.show(`Failed to read ${file.name}: ${(err as Error).message}`, 'error');
      }
    }

    if (rejectedType > 0) {
      toasts.show(
        `${rejectedType} file(s) rejected. Allowed: images, PDF, DOCX, XLSX, PPTX, CSV, TXT, MD, JSON.`,
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

  function appendAttachments(next: PendingAttachment[]): void {
    if (next.length > 0) attachments = [...attachments, ...next];
  }

  function removeAttachment(id: string): void {
    attachments = attachments.filter((a) => a.id !== id);
  }

  function clearAttachments(): void {
    attachments = [];
  }

  function openFilePicker(): void {
    if (!attachmentInputEl) return;
    attachmentInputEl.value = '';
    attachmentInputEl.click();
  }

  async function onFileInputChange(e: Event): Promise<void> {
    const target = e.currentTarget as HTMLInputElement | null;
    if (!target?.files) return;
    appendAttachments(await intakeFiles(target.files));
  }

  async function onComposerPaste(e: ClipboardEvent): Promise<void> {
    if (!e.clipboardData) return;
    const files = Array.from(e.clipboardData.files || []);
    if (files.length === 0) return;
    e.preventDefault();
    appendAttachments(await intakeFiles(files));
  }

  function hasDraggedFiles(e: DragEvent): boolean {
    const types = Array.from(e.dataTransfer?.types || []);
    return types.includes('Files');
  }

  function onComposerDragEnter(e: DragEvent): void {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
  }

  function onComposerDragOver(e: DragEvent): void {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
  }

  function onComposerDragLeave(e: DragEvent): void {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
  }

  async function onComposerDrop(e: DragEvent): Promise<void> {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    appendAttachments(await intakeFiles(e.dataTransfer?.files || []));
  }

  function attachmentsForWire(): AttachmentInput[] {
    return attachments.map((a) => ({
      name: a.name,
      mime_type: a.mime,
      data_base64: a.dataBase64
    }));
  }

  function attachmentOnlyContent(): string {
    return attachments.map((a) => `Attached ${a.name}`).join('\n');
  }

  // Conversation state, derived off the controller's reactive state. (Avoid a
  // local `state` alias — that name collides with the `$state` rune.)
  const messages = $derived(controller.state.messages);
  const isProcessing = $derived(controller.state.isProcessing);
  const pendingGate = $derived(controller.state.pendingGate);
  const streamError = $derived(controller.streamError);
  const timelineError = $derived(controller.timelineError);
  const modelReadiness = $derived(modelExecutionReadiness(gatewayStatus));
  const modelVerificationBlocked = $derived(
    connection.client !== null && modelReadiness.sendBlocked === true
  );
  const modelBlockReason = $derived(
    gatewayStatusError ?? modelReadiness.sendBlockReason ?? 'The selected model is not ready.'
  );
  const canSend = $derived(
    (draft.trim().length > 0 || attachments.length > 0) &&
      !isProcessing &&
      !modelVerificationBlocked
  );
  const threadExportTitle = 'IronClaw chat thread';
  const threadExportContent = $derived(formatThreadMessages(messages));

  // Thread rail state.
  const threadList = $derived(threads.threads);
  const threadGroups = $derived(groupThreadsByRecency(threadList));
  const activeThreadId = $derived(threads.currentId);
  const activeThreadSummary = $derived(
    activeThreadId
      ? (threadList.find((thread) => thread.thread_id === activeThreadId) ?? null)
      : null
  );
  const threadExportJson = $derived(
    formatThreadJson(messages, activeThreadSummary, activeThreadId)
  );
  const isLoading = $derived(threads.isLoading);
  const pendingApprovalItem = $derived(
    pendingLocalApproval ? (workItems.get(pendingLocalApproval.workItemId) ?? null) : null
  );
  const pendingApprovalBoundary = $derived(
    pendingLocalApproval && pendingApprovalItem
      ? (pendingApprovalItem.approvalBoundaries.find(
          (boundary) => boundary.id === pendingLocalApproval?.boundaryId
        ) ?? null)
      : null
  );
  const requestedWorkDispatchResumeId = $derived(
    page.url?.searchParams?.get(WORK_DISPATCH_RESUME_PARAM) ?? null
  );
  const routedWorkItems = new Map<string, string>();
  const handledResumeIds = new Set<string>();

  /** Relative "last active" label for a thread row, or null when the
   *  server omitted both timestamps (don't fabricate a "just now"). */
  function rowTime(t: ThreadSummary): string | null {
    const ts = t.updated_at || t.created_at;
    return ts ? relativeTime(ts) : null;
  }

  function currentThreadParam(): string | null {
    if (typeof window === 'undefined') return null;
    return new URL(window.location.href).searchParams.get('thread');
  }

  function clearThreadParam(): void {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('thread')) return;
    url.searchParams.delete('thread');
    const target = url.pathname + (url.search ? url.search : '') + url.hash;
    void goto(target, { replaceState: true, noScroll: true, keepFocus: true });
  }

  function clearWorkDispatchResumeParam(): void {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has(WORK_DISPATCH_RESUME_PARAM)) return;
    url.searchParams.delete(WORK_DISPATCH_RESUME_PARAM);
    const target = url.pathname + (url.search ? url.search : '') + url.hash;
    void goto(target, { replaceState: true, noScroll: true, keepFocus: true });
  }

  onMount(() => {
    // Populate the rail. On the app-wide store, cold/deep-link loads may reach
    // this panel before the sidebar has hydrated the connection.
    void (async () => {
      if (threads === rebornThreads && !connection.client) {
        try {
          await connection.init();
        } catch {
          // Non-fatal here; the rail load below already degrades to empty.
        }
      }
      await threads.load();
    })();
  });

  async function refreshGatewayStatusForModelGate(client = connection.client): Promise<void> {
    const seq = ++gatewayStatusRequestSeq;
    if (!client) {
      gatewayStatus = null;
      gatewayStatusError = null;
      return;
    }
    gatewayStatusError = null;
    try {
      const status = await client.gatewayStatus();
      if (seq !== gatewayStatusRequestSeq) return;
      gatewayStatus = status;
    } catch (err) {
      if (seq !== gatewayStatusRequestSeq) return;
      console.warn('[reborn-chat] gateway model readiness check failed', err);
      gatewayStatus = null;
      gatewayStatusError =
        'IronClaw could not verify that the selected model can run. Check the runner or choose a verified model before sending.';
    }
  }

  $effect(() => {
    const client = connection.client;
    void refreshGatewayStatusForModelGate(client);
  });

  // Honor `/?thread=<id>` before the default first-thread selection. Global
  // search, omnibar, and related surfaces use that deep link; in Reborn mode
  // the v1 route no longer owns thread selection.
  $effect(() => {
    const list = threadList;
    const active = activeThreadId;
    const requested = currentThreadParam();
    const loading = isLoading;
    if (requested && !active) {
      const match = list.find((t) => t.thread_id === requested);
      if (match) {
        autoSelectedInitialThread = true;
        untrack(() => {
          threads.select(requested);
          clearThreadParam();
        });
        return;
      }
      if (!loading && list.length > 0) {
        toasts.show('Conversation not found', 'error');
        untrack(clearThreadParam);
      }
    }

    // If the rail already has history, open the freshest thread by default.
    // Otherwise a user can see existing conversations/message counts but land
    // on an empty chat canvas until they manually click the first row.
    if (
      autoSelectedInitialThread ||
      userRequestedNewChat ||
      active ||
      requested ||
      list.length === 0
    ) {
      return;
    }
    const first = list.find((t) => t.thread_id)?.thread_id;
    if (!first) return;
    autoSelectedInitialThread = true;
    untrack(() => threads.select(first));
  });

  // Bind the controller to the selected thread. `boundThread` is a plain
  // (non-reactive) instance field so the effect only re-runs on a real
  // selection change — not on its own writes. Initial mount loads+streams the
  // current selection without a reset (so injected test state survives); a
  // later switch resets first. `undefined` = "never bound yet".
  let boundThread: string | null | undefined = undefined;
  $effect(() => {
    const tid = activeThreadId ?? null;
    if (tid === boundThread) return;
    const isInitial = boundThread === undefined;
    boundThread = tid;
    if (!isInitial) controller.reset();
    if (tid) {
      void controller.loadTimeline(tid);
      void controller.openStream(tid);
    }
  });

  $effect(() => {
    const resumeId = requestedWorkDispatchResumeId;
    const client = connection.client;
    if (!resumeId || !client || handledResumeIds.has(resumeId)) return;
    handledResumeIds.add(resumeId);
    void resumeApprovedWorkDispatch(resumeId);
  });

  onDestroy(() => {
    clearAttachments();
    controller.closeStream();
  });

  // Keep the selected thread visible: when the active id changes, scroll its
  // row into view inside the rail (no-op in jsdom / when off-screen logic is
  // unavailable). Runs after the DOM applies `.is-active`.
  let listEl: HTMLElement | undefined = $state();
  $effect(() => {
    const id = activeThreadId;
    if (!id || !listEl) return;
    const row = listEl.querySelector('.is-active');
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  });

  // Auto-pin to the newest content — but only while the user is already at the
  // bottom, so reading scrollback isn't yanked away by an incoming token.
  $effect(() => {
    messages.length; // track new turns
    isProcessing; // and the streaming indicator appearing/leaving
    if (atBottom && scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  });

  /** Start a fresh conversation (the bind effect resets the controller). */
  function newChat() {
    userRequestedNewChat = true;
    threads.select(null);
  }

  function selectThread(id: string) {
    userRequestedNewChat = false;
    if (id !== activeThreadId) threads.select(id);
  }

  function visibleThreadTitle(): string | undefined {
    if (!activeThreadId) return undefined;
    return (
      threads.threads.find((thread) => thread.thread_id === activeThreadId)?.title ?? undefined
    );
  }

  function formatThreadMessages(items: RebornMessage[]): string {
    return items
      .filter((msg) => msg.role !== 'tool_activity' && msg.content?.trim())
      .map((msg) => {
        const label =
          msg.role === 'assistant'
            ? 'Assistant'
            : msg.role === 'user'
              ? 'User'
              : msg.role === 'system'
                ? 'System'
                : 'Error';
        return `## ${label}\n\n${msg.content?.trim() ?? ''}`;
      })
      .join('\n\n');
  }

  function formatThreadJson(
    items: RebornMessage[],
    thread: ThreadSummary | null,
    threadId: string | null
  ): string {
    return JSON.stringify(
      {
        thread: {
          id: thread?.thread_id ?? threadId,
          title: thread?.title ?? 'IronClaw chat thread',
          created_at: thread?.created_at ?? null,
          updated_at: thread?.updated_at ?? null
        },
        messages: items.map((msg) => ({
          id: msg.id,
          role: msg.role,
          content: msg.content ?? '',
          created_at: msg.timestamp ?? null,
          sequence: msg.sequence ?? null,
          status: msg.status ?? null,
          kind: msg.kind ?? null,
          turn_run_id: msg.turnRunId ?? null,
          tool:
            msg.role === 'tool_activity'
              ? {
                  invocation_id: msg.invocationId ?? null,
                  call_id: msg.callId ?? null,
                  name: msg.toolName ?? null,
                  status: msg.toolStatus ?? null,
                  detail: msg.toolDetail ?? null,
                  parameters: msg.toolParameters ?? null,
                  result_preview: msg.toolResultPreview ?? null,
                  error: msg.toolError ?? null,
                  duration_ms: msg.toolDurationMs ?? null,
                  updated_at: msg.updatedAt ?? null,
                  result_ref: msg.resultRef ?? null,
                  truncated: msg.truncated ?? null,
                  output_bytes: msg.outputBytes ?? null,
                  output_kind: msg.outputKind ?? null
                }
              : null
        })),
        exported_at: new Date().toISOString()
      },
      null,
      2
    );
  }

  function workProductTitle(content: string): string {
    const heading = /^#{1,6}\s+(.+)$/m.exec(content);
    if (heading?.[1]?.trim()) return heading[1].trim().slice(0, 80);
    const first = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return (first ?? 'Assistant response').slice(0, 80);
  }

  function newLocalId(prefix: string): string {
    const cryptoId = globalThis.crypto?.randomUUID?.();
    return cryptoId ? `${prefix}-${cryptoId}` : `${prefix}-${Date.now().toString(36)}`;
  }

  function saveChatWorkProduct(content: string, title: string): void {
    const artifactId = newLocalId('artifact');
    const threadId = activeThreadId ?? undefined;
    const label = visibleThreadTitle() ?? 'Chat thread';
    workItems.hydrate();
    const created = workItems.create({
      title,
      objective: 'Saved work product from chat.',
      domain: 'general',
      runbookIds: ['general'],
      status: 'active',
      links: threadId ? [{ kind: 'thread', ref: threadId, label }] : [],
      artifacts: [
        {
          id: artifactId,
          type: 'document',
          title,
          status: 'ready',
          provenance: threadId ? [`thread:${threadId}`] : ['chat'],
          content,
          content_format: 'markdown'
        }
      ],
      nextAction: 'Review saved work product.'
    });
    if (!created) {
      toasts.show('Could not save work product.', 'error');
      return;
    }
    toasts.show('Saved to Work.', 'success');
    void goto(
      `/work?item=${encodeURIComponent(created.id)}&artifact=${encodeURIComponent(artifactId)}`
    );
  }

  function firstPendingRequiredBoundary(item: WorkItem): WorkItemApprovalBoundary | null {
    return (
      item.approvalBoundaries.find(
        (boundary) => boundary.status === 'pending' && requiresApproval(boundary.kind)
      ) ?? null
    );
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

  function workItemMessagePrefix(
    item: WorkItem,
    content: string,
    approvedBoundary?: WorkItemApprovalBoundary
  ): string {
    const approvalLine = approvedBoundary
      ? `Approval: ${approvedBoundary.action} approved by user.`
      : `Next action: ${item.nextAction ?? 'Review in Work.'}`;
    return `Work item: ${item.title}
Runbook: ${item.runbookIds.join(', ') || 'none'}
${approvalLine}

${content}`;
  }

  function approvedDispatchBoundary(item: WorkItem): WorkItemApprovalBoundary | undefined {
    return (
      item.approvalBoundaries.find(
        (boundary) => requiresApproval(boundary.kind) && boundary.status === 'approved'
      ) ?? item.approvalBoundaries.find((boundary) => boundary.status === 'approved')
    );
  }

  function pendingFromResume(record: WorkDispatchResume, boundaryId: string): PendingLocalApproval {
    return {
      workItemId: record.workItemId,
      boundaryId,
      content: record.content,
      attachments: record.attachments,
      ...(record.threadId ? { threadId: record.threadId } : {}),
      resumeId: record.id
    };
  }

  async function resumeApprovedWorkDispatch(resumeId: string): Promise<void> {
    const record = getWorkDispatchResume(resumeId);
    if (!record) {
      clearWorkDispatchResumeParam();
      return;
    }
    workItems.hydrate();
    const item = workItems.get(record.workItemId);
    if (!item) {
      removeWorkDispatchResume(record.id);
      clearWorkDispatchResumeParam();
      toasts.show('Work item not found. Nothing sent.', 'error');
      return;
    }

    const denied = item.approvalBoundaries.find((boundary) => boundary.status === 'denied');
    if (denied) {
      removeWorkDispatchResume(record.id);
      clearWorkDispatchResumeParam();
      toasts.show(`Denied: ${denied.action}. Nothing sent.`, 'info');
      return;
    }

    const nextBoundary = firstPendingRequiredBoundary(item);
    if (nextBoundary) {
      pendingLocalApproval = pendingFromResume(record, nextBoundary.id);
      updateWorkDispatchResumeBoundary(record.id, nextBoundary.id);
      toasts.show(`Still needs approval: ${nextBoundary.action}`, 'info');
      return;
    }

    const dispatchBoundary = approvedDispatchBoundary(item);
    if (dispatchBoundary && requiresApproval(dispatchBoundary.kind)) {
      const check = evaluateApprovalBoundary({
        kind: dispatchBoundary.kind,
        workItem: item,
        boundaryId: dispatchBoundary.id
      });
      if (!check.allowed) {
        pendingLocalApproval = pendingFromResume(record, dispatchBoundary.id);
        toasts.show('Approval not verified. Nothing sent.', 'error');
        return;
      }
    }

    if (record.threadId) {
      threads.select(record.threadId);
    } else {
      userRequestedNewChat = true;
      threads.select(null);
      controller.reset();
      boundThread = null;
    }
    removeWorkDispatchResume(record.id);
    pendingLocalApproval = null;
    try {
      await sendDirect(
        workItemMessagePrefix(item, record.content, dispatchBoundary),
        record.threadId,
        record.attachments,
        item.id
      );
      clearWorkDispatchResumeParam();
      toasts.show('Approved work sent to chat.', 'success');
    } catch {
      upsertWorkDispatchResume(record);
      handledResumeIds.delete(resumeId);
      pendingLocalApproval = pendingFromResume(record, record.boundaryId);
    }
  }

  function routeMessageThroughWork(
    content: string,
    threadId: string | undefined,
    pendingAttachments: PendingAttachment[]
  ): RoutedMessage {
    const attachmentSource = attachmentRiskSource(pendingAttachments);
    const workflow = orchestrateChiefOfStaffAsk({
      ask: content,
      surface: 'chat',
      title: visibleThreadTitle(),
      source: [threadId ? `thread:${threadId}` : 'new-thread', attachmentSource]
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

    const routeKey = `${threadId ?? 'new'}:${content}`;
    const existing = routedWorkItems.get(routeKey);
    if (existing) {
      const item = workItems.get(existing);
      if (item) {
        const boundary = firstPendingRequiredBoundary(item);
        if (boundary) return { status: 'blocked', workItem: item, boundary, content };
        return {
          status: 'send',
          content: workItemMessagePrefix(item, content),
          workItemId: item.id
        };
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
    routedWorkItems.set(routeKey, created.id);

    toasts.show(`Work item created: ${created.title}`, 'success');
    const boundary = firstPendingRequiredBoundary(created);
    if (boundary) {
      return { status: 'blocked', workItem: created, boundary, content };
    }
    return {
      status: 'send',
      content: workItemMessagePrefix(created, content),
      workItemId: created.id
    };
  }

  function updateBoundaryStatus(
    item: WorkItem,
    boundaryId: string,
    status: WorkItemApprovalBoundary['status']
  ): WorkItem | undefined {
    return workItems.updateApprovalBoundary(item.id, boundaryId, status);
  }

  async function sendDirect(
    content: string,
    threadId: string | undefined,
    wireAttachments: AttachmentInput[],
    workItemId?: string
  ): Promise<void> {
    if (threadId) {
      await controller.send(content, threadId, wireAttachments);
      return;
    }

    const tid = await controller.ensureThread();
    if (tid) {
      boundThread = tid;
      threads.upsert({ thread_id: tid });
      threads.select(tid);
      linkWorkItemToThread(workItemId, tid);
      void controller.openStream(tid);
    }
    await controller.send(content, tid ?? undefined, wireAttachments);
  }

  async function approvePendingLocalApproval(): Promise<void> {
    const pending = pendingLocalApproval;
    const item = pendingApprovalItem;
    const boundary = pendingApprovalBoundary;
    if (!pending || !item || !boundary) return;

    const updated = updateBoundaryStatus(item, boundary.id, 'approved');
    const approvedBoundary = updated?.approvalBoundaries.find((gate) => gate.id === boundary.id);
    const nextBoundary = updated ? firstPendingRequiredBoundary(updated) : null;
    if (!updated || !approvedBoundary || approvedBoundary.status !== 'approved') {
      toasts.show('Approval not verified. Nothing sent.', 'error');
      return;
    }
    if (nextBoundary) {
      pendingLocalApproval = { ...pending, workItemId: updated.id, boundaryId: nextBoundary.id };
      updateWorkDispatchResumeBoundary(pending.resumeId, nextBoundary.id);
      toasts.show(`Still needs approval: ${nextBoundary.action}`, 'info');
      return;
    }

    let dispatchBoundary = approvedBoundary;
    if (requiresApproval(boundary.kind)) {
      const check = evaluateApprovalBoundary({
        kind: boundary.kind,
        workItem: updated,
        boundaryId: boundary.id
      });
      if (!check.allowed) {
        toasts.show('Approval not verified. Nothing sent.', 'error');
        return;
      }
      dispatchBoundary = check.boundary;
    }

    pendingLocalApproval = null;
    removeWorkDispatchResume(pending.resumeId);
    try {
      await sendDirect(
        workItemMessagePrefix(updated, pending.content, dispatchBoundary),
        pending.threadId,
        pending.attachments,
        updated.id
      );
    } catch {
      if (pending.resumeId) {
        upsertWorkDispatchResume({
          id: pending.resumeId,
          source: 'reborn-chat',
          workItemId: pending.workItemId,
          boundaryId: pending.boundaryId,
          content: pending.content,
          attachments: pending.attachments,
          ...(pending.threadId ? { threadId: pending.threadId } : {}),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }
      pendingLocalApproval = pending;
    }
  }

  function denyPendingLocalApproval(): void {
    const pending = pendingLocalApproval;
    const item = pendingApprovalItem;
    const boundary = pendingApprovalBoundary;
    if (!pending || !item || !boundary) return;
    updateBoundaryStatus(item, boundary.id, 'denied');
    removeWorkDispatchResume(pending.resumeId);
    pendingLocalApproval = null;
    toasts.show(`Denied: ${boundary.action}`, 'info');
  }

  async function handleSend() {
    const typedContent = draft.trim();
    if ((!typedContent && attachments.length === 0) || isProcessing) return;
    if (modelVerificationBlocked) {
      toasts.show(modelBlockReason, 'error');
      return;
    }
    const pendingAttachments = attachments;
    const wireAttachments = attachmentsForWire();
    const content = typedContent || attachmentOnlyContent();
    try {
      const routed = routeMessageThroughWork(
        content,
        activeThreadId ?? undefined,
        pendingAttachments
      );
      if (routed.status === 'needs_clarification') {
        toasts.show(`${routed.reason} Add the missing context before I dispatch it.`, 'info');
        return;
      }

      draft = '';
      clearAttachments();
      dragDepth = 0;
      resetComposerHeight();

      if (routed.status === 'blocked') {
        const resumeRecord = createWorkDispatchResume({
          source: 'reborn-chat',
          workItemId: routed.workItem.id,
          boundaryId: routed.boundary.id,
          content: routed.content,
          attachments: wireAttachments,
          threadId: activeThreadId ?? undefined
        });
        pendingLocalApproval = {
          workItemId: routed.workItem.id,
          boundaryId: routed.boundary.id,
          content: routed.content,
          attachments: wireAttachments,
          threadId: activeThreadId ?? undefined,
          resumeId: resumeRecord?.id
        };
        toasts.show(`Approval required: ${routed.boundary.action}`, 'info');
        return;
      }

      await sendDirect(
        routed.content,
        activeThreadId ?? undefined,
        wireAttachments,
        routed.workItemId
      );
    } catch {
      draft = content;
      attachments = pendingAttachments;
      // The controller already surfaced the failure as an error bubble.
    }
  }

  /** Send a starter prompt from the empty-state suggestions through the normal
   *  send path, so it creates + streams the thread exactly like a typed
   *  message (no special-casing). No-op while a run is already in flight. */
  function sendPrompt(prompt: string) {
    if (isProcessing) return;
    draft = prompt;
    void handleSend();
  }

  function onComposerKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  function isTextInputContext(target: EventTarget | Element | null): boolean {
    if (!(target instanceof Element)) return false;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return true;
    }
    let el: Element | null = target;
    while (el) {
      const editable = el.getAttribute('contenteditable');
      if (editable !== null && editable.toLowerCase() !== 'false') return true;
      el = el.parentElement;
    }
    return false;
  }

  /** Keyboard-accelerated approval while a gate is pending: ⌘⏎ (or Ctrl+Enter)
   *  approves, Esc denies — the elite inline-approval pattern. No-op when no
   *  gate is open so it never steals keys from the composer. */
  function onGateKeydown(e: KeyboardEvent) {
    if (!pendingGate) return;
    // Gate shortcuts are global chrome actions, but typed composer/editor keys
    // must remain local while the user is editing text.
    if (isTextInputContext(e.target) || isTextInputContext(document.activeElement)) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void controller.resolveGate('approved');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void controller.resolveGate('denied');
    }
  }

  /** Roving keyboard nav in the thread rail: ↑/↓ moves DOM focus between
   *  thread rows (in flat visible order, across date groups). Enter selects
   *  natively (focused row is a <button>). Scoped to the rail — the handler
   *  only fires while focus is inside the list, so it never hijacks arrows
   *  from the composer or conversation. */
  function onRailKeydown(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!listEl) return;
    const items = Array.from(listEl.querySelectorAll<HTMLButtonElement>('.reborn-rail__item'));
    if (items.length === 0) return;
    e.preventDefault();
    const cur = items.findIndex((b) => b === document.activeElement);
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const next =
      cur < 0
        ? delta === 1
          ? 0
          : items.length - 1
        : Math.min(items.length - 1, Math.max(0, cur + delta));
    items[next]?.focus();
  }
</script>

<svelte:window onkeydown={onGateKeydown} />

<div class="reborn-shell" data-testid="reborn-chat-panel">
  <aside class="reborn-rail" aria-label="Conversations">
    <div class="reborn-rail__head">
      <button type="button" class="reborn-btn reborn-rail__new" onclick={newChat}>
        New chat
      </button>
    </div>
    {#if isLoading && threadList.length === 0}
      <div class="reborn-rail__skeleton" aria-hidden="true" data-testid="reborn-rail-skeleton">
        <div class="reborn-skel-row"></div>
        <div class="reborn-skel-row"></div>
        <div class="reborn-skel-row"></div>
        <div class="reborn-skel-row"></div>
        <div class="reborn-skel-row"></div>
      </div>
    {:else if threadList.length === 0}
      <p class="reborn-rail__empty">No conversations yet.</p>
    {:else}
      <div class="reborn-rail__list" bind:this={listEl}>
        {#each threadGroups as group (group.label)}
          <div class="reborn-rail__group">
            <div class="reborn-rail__group-head">{group.label}</div>
            <ul class="reborn-rail__group-items">
              {#each group.threads as t (t.thread_id)}
                {@const time = rowTime(t)}
                <li>
                  <button
                    type="button"
                    class="reborn-rail__item"
                    class:is-active={t.thread_id === activeThreadId}
                    aria-current={t.thread_id === activeThreadId ? 'true' : undefined}
                    onclick={() => selectThread(t.thread_id)}
                    onkeydown={onRailKeydown}
                    title={t.title || 'Untitled conversation'}
                  >
                    <span class="reborn-rail__item-title">{t.title || 'Untitled conversation'}</span
                    >
                    {#if time}<span class="reborn-rail__item-time">{time}</span>{/if}
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      </div>
    {/if}
    {#if threads.hasMore}
      <button type="button" class="reborn-rail__more" onclick={() => threads.loadMore()}>
        Load more
      </button>
    {/if}
  </aside>

  <div class="reborn-chat">
    <ChatModelSelector />
    {#if threadExportContent.trim()}
      <div class="reborn-chat__thread-actions">
        <WorkProductActions
          title={threadExportTitle}
          content={threadExportContent}
          jsonContent={threadExportJson}
          compact
        />
      </div>
    {/if}
    <div class="reborn-chat__scroll" bind:this={scrollEl} onscroll={onScroll}>
      {#if timelineError}
        <div class="reborn-msg reborn-msg--error reborn-timeline-error" role="alert">
          <span>{timelineError}</span>
          <button
            type="button"
            class="reborn-stream-error__retry"
            onclick={() => controller.retryTimeline()}
          >
            Retry
          </button>
        </div>
      {:else if messages.length === 0}
        <div class="reborn-chat__empty">
          <p class="reborn-chat__empty-title">IronClaw</p>
          <p class="reborn-chat__empty-sub">
            Your Chief of Staff for briefs, triage, drafts, and approval-gated work.
          </p>
          <div class="reborn-chat__proof" aria-label="Chief of Staff operating guarantees">
            <span>Workspace context</span>
            <span>Work Items</span>
            <span>Approvals before sends</span>
          </div>
          <div class="reborn-chat__suggestions">
            {#each SUGGESTED_PROMPTS as s (s.label)}
              <button
                type="button"
                class="reborn-suggestion"
                onclick={() => sendPrompt(s.prompt)}
                disabled={isProcessing}
              >
                {s.label}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#each messages as msg (msg.id)}
        {#if msg.role === 'tool_activity'}
          {@const toolHasDetail = !!(msg.toolDetail || msg.toolError)}
          {@const toolOpen = !!expandedTools[msg.id]}
          <div class="reborn-tool" class:is-error={msg.toolStatus === 'error'}>
            <button
              type="button"
              class="reborn-tool__head"
              class:is-static={!toolHasDetail}
              disabled={!toolHasDetail}
              aria-expanded={toolHasDetail ? toolOpen : undefined}
              onclick={() => toolHasDetail && toggleTool(msg.id)}
            >
              <span class="reborn-tool__dot" data-status={msg.toolStatus}></span>
              <span class="reborn-tool__name">{msg.toolName || 'tool'}</span>
              <span class="reborn-tool__status">{msg.toolStatus}</span>
              {#if toolHasDetail}
                <span class="reborn-tool__chevron" class:is-open={toolOpen} aria-hidden="true"
                  >▸</span
                >
              {/if}
            </button>
            {#if toolHasDetail && toolOpen}
              <div class="reborn-tool__detail">
                {#if msg.toolDetail}<p class="reborn-tool__detail-line">{msg.toolDetail}</p>{/if}
                {#if msg.toolError}
                  <p class="reborn-tool__detail-line is-error">{msg.toolError}</p>
                {/if}
              </div>
            {/if}
          </div>
        {:else if msg.role === 'error'}
          <div class="reborn-msg reborn-msg--error">{msg.content}</div>
        {:else if msg.role === 'system'}
          <div class="reborn-msg reborn-msg--system">{msg.content}</div>
        {:else if msg.role === 'user'}
          <div class="reborn-msg reborn-msg--user" class:is-optimistic={msg.isOptimistic}>
            {msg.content}
            {#if msg.status === 'error'}
              <span class="reborn-msg__send-error" title={msg.error}>failed to send</span>
            {/if}
          </div>
        {:else}
          <div class="reborn-msg reborn-msg--assistant">
            {#if msg.content?.trim()}
              <WorkProductActions
                title="Assistant response"
                content={msg.content}
                compact
                onSaveToWork={(content) => saveChatWorkProduct(content, workProductTitle(content))}
              />
            {/if}
            <MarkdownView markdown={msg.content ?? ''} />
          </div>
        {/if}
      {/each}

      {#if streamError}
        <div class="reborn-msg reborn-msg--error reborn-stream-error" role="alert">
          <span>{streamError}</span>
          <button
            type="button"
            class="reborn-stream-error__retry"
            onclick={() => controller.retryStream()}
          >
            Retry
          </button>
        </div>
      {/if}

      {#if isProcessing}
        <div
          class="reborn-msg reborn-msg--assistant reborn-streaming"
          aria-label="Assistant is responding"
        >
          <span class="reborn-caret" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </span>
        </div>
      {/if}

      {#if !atBottom}
        <button type="button" class="reborn-jump" onclick={jumpToLatest}>↓ Jump to latest</button>
      {/if}
    </div>

    {#if pendingGate}
      <div class="reborn-gate" role="alertdialog" aria-label="Approval required">
        <div class="reborn-gate__text">
          <strong>{pendingGate.headline || 'Approval required'}</strong>
          {#if pendingGate.body}<p>{pendingGate.body}</p>{/if}
        </div>
        <div class="reborn-gate__actions">
          <button
            type="button"
            class="reborn-btn reborn-btn--primary"
            onclick={() => controller.resolveGate('approved')}
          >
            Approve <kbd class="reborn-gate__hint">⌘⏎</kbd>
          </button>
          <button type="button" class="reborn-btn" onclick={() => controller.resolveGate('denied')}>
            Deny <kbd class="reborn-gate__hint">Esc</kbd>
          </button>
        </div>
      </div>
    {/if}

    {#if pendingLocalApproval && pendingApprovalItem && pendingApprovalBoundary}
      <div
        class="reborn-gate reborn-gate--local"
        role="alertdialog"
        aria-label="Local approval required"
        data-testid="local-approval-gate"
      >
        <div class="reborn-gate__text">
          <strong>Approve before dispatch</strong>
          <p>
            {pendingApprovalBoundary.action} is waiting on
            {pendingApprovalItem.title}. Nothing sent yet.
          </p>
        </div>
        <div class="reborn-gate__actions">
          <a
            class="reborn-btn"
            href={workDispatchReviewHref(
              pendingLocalApproval.resumeId
                ? getWorkDispatchResume(pendingLocalApproval.resumeId)
                : null,
              pendingApprovalItem.id
            )}
          >
            Review in Work
          </a>
          <button
            type="button"
            class="reborn-btn reborn-btn--primary"
            onclick={approvePendingLocalApproval}
          >
            Approve and send
          </button>
          <button type="button" class="reborn-btn" onclick={denyPendingLocalApproval}>Deny</button>
        </div>
      </div>
    {/if}

    <div
      class="reborn-composer"
      class:is-dragging={dragDepth > 0}
      role="group"
      aria-label="Message composer"
      ondragenter={onComposerDragEnter}
      ondragover={onComposerDragOver}
      ondragleave={onComposerDragLeave}
      ondrop={onComposerDrop}
    >
      <input
        class="reborn-composer__file"
        bind:this={attachmentInputEl}
        type="file"
        multiple
        accept={attachmentAccept}
        aria-label="Attach files input"
        onchange={onFileInputChange}
      />
      {#if attachments.length > 0}
        <div class="reborn-attachments" aria-label="Pending attachments">
          {#each attachments as file (file.id)}
            <div class="reborn-attachment">
              <span class="reborn-attachment__type">{shortType(file.mime, file.name)}</span>
              <span class="reborn-attachment__name">{file.name}</span>
              <span class="reborn-attachment__size">{fmtBytes(file.size)}</span>
              <button
                type="button"
                class="reborn-attachment__remove"
                aria-label={`Remove ${file.name}`}
                onclick={() => removeAttachment(file.id)}
              >
                ×
              </button>
            </div>
          {/each}
        </div>
      {/if}
      {#if modelVerificationBlocked}
        <div class="reborn-model-warning" role="status">
          {modelBlockReason}
        </div>
      {/if}
      <div class="reborn-composer__row">
        <button
          type="button"
          class="reborn-btn reborn-btn--icon"
          onclick={openFilePicker}
          disabled={attachments.length >= MAX_ATTACHMENTS || isProcessing}
          aria-label="Attach files"
          title={attachments.length >= MAX_ATTACHMENTS
            ? `Max ${MAX_ATTACHMENTS} attachments per message`
            : 'Attach files'}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2.25"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <textarea
          class="reborn-composer__input"
          bind:this={composerEl}
          bind:value={draft}
          onkeydown={onComposerKeydown}
          oninput={autoGrowComposer}
          onpaste={onComposerPaste}
          placeholder="Message IronClaw…"
          rows="1"
          aria-label="Message input"
        ></textarea>
        {#if isProcessing}
          <button
            type="button"
            class="reborn-btn reborn-btn--danger"
            onclick={() => controller.cancel()}
          >
            Stop
          </button>
        {:else}
          <button
            type="button"
            class="reborn-btn reborn-btn--primary"
            disabled={!canSend}
            onclick={handleSend}
          >
            Send
          </button>
        {/if}
      </div>
      {#if dragDepth > 0}
        <div class="reborn-composer__drop" aria-hidden="true">
          <strong>Drop files here</strong>
          <span>Images, docs, sheets, decks, PDFs, and text files</span>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .reborn-shell {
    display: flex;
    height: 100%;
    min-height: 0;
    background: var(--v2-canvas-strong);
    color: var(--v2-text);
  }
  .reborn-rail {
    flex: 0 0 15rem;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--v2-border);
    background: var(--v2-rail);
  }
  .reborn-rail__head {
    padding: 0.875rem;
    border-bottom: 1px solid var(--v2-border);
  }
  .reborn-rail__new {
    width: 100%;
  }
  .reborn-rail__empty {
    padding: 1rem 0.875rem;
    font-size: 0.8rem;
    color: var(--v2-text-muted);
  }
  .reborn-rail__list {
    flex: 1 1 auto;
    overflow-y: auto;
    margin: 0;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .reborn-rail__group-head {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 0.55rem 0.625rem 0.3rem;
    background: var(--v2-rail);
    font-size: 0.66rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--v2-text-faint);
  }
  .reborn-rail__group-items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .reborn-rail__item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    width: 100%;
    min-height: 2.75rem;
    text-align: left;
    padding: 0.55rem 0.65rem;
    border: 1px solid transparent;
    border-radius: 0.55rem;
    background: transparent;
    color: var(--v2-text-muted);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    transition:
      background var(--v2-dur-fast) var(--v2-ease-out),
      border-color var(--v2-dur-fast) var(--v2-ease-out),
      color var(--v2-dur-fast) var(--v2-ease-out),
      transform var(--v2-dur-fast) var(--v2-ease-out);
  }
  .reborn-rail__item-title {
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .reborn-rail__item-time {
    font-size: 0.7rem;
    color: var(--v2-text-faint);
  }
  .reborn-rail__item:hover {
    background: var(--v2-surface-soft);
    color: var(--v2-text);
    transform: translateX(1px);
  }
  .reborn-rail__item.is-active {
    background: var(--v2-accent-soft);
    border-color: var(--v2-accent);
    color: var(--v2-accent-text);
  }
  .reborn-rail__skeleton {
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .reborn-skel-row {
    height: 1.9rem;
    border-radius: 0.45rem;
    background: var(--v2-surface-2);
  }
  .reborn-skel-row:nth-child(2) {
    width: 82%;
  }
  .reborn-skel-row:nth-child(3) {
    width: 90%;
  }
  .reborn-skel-row:nth-child(4) {
    width: 74%;
  }
  .reborn-skel-row:nth-child(5) {
    width: 86%;
  }
  .reborn-rail__more {
    min-height: 2.75rem;
    margin: 0.5rem;
    padding: 0.55rem;
    border: 1px solid var(--v2-border);
    border-radius: 0.55rem;
    background: transparent;
    color: var(--v2-text-muted);
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    transition:
      background var(--v2-dur-fast) var(--v2-ease-out),
      color var(--v2-dur-fast) var(--v2-ease-out);
  }
  .reborn-rail__more:hover {
    background: var(--v2-surface-soft);
    color: var(--v2-text);
  }
  .reborn-chat {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--v2-canvas);
  }
  .reborn-chat__thread-actions {
    border-bottom: 1px solid var(--v2-panel-border);
    padding: 0.45rem 1rem 0.35rem;
    background: color-mix(in srgb, var(--v2-surface) 84%, transparent);
  }
  .reborn-chat__scroll {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 2rem clamp(1.25rem, 4vw, 3.5rem);
    display: flex;
    flex-direction: column;
    gap: 1.125rem;
  }
  .reborn-chat__empty {
    margin: auto;
    width: min(100%, 42rem);
    padding: 3rem 1rem;
    display: grid;
    justify-items: center;
    gap: 0.85rem;
    text-align: center;
    color: var(--v2-text-muted);
    animation: reborn-fade-up var(--v2-dur-fast) var(--v2-ease-out);
  }
  .reborn-chat__empty-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: clamp(1.85rem, 4vw, 3rem);
    line-height: 1;
    font-weight: 700;
    letter-spacing: 0;
    color: var(--v2-text-strong);
  }
  .reborn-chat__empty-sub {
    margin: 0;
    max-width: 28rem;
    font-size: 0.95rem;
    line-height: 1.6;
    color: var(--v2-text-muted);
  }
  .reborn-chat__proof {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.45rem;
    max-width: 35rem;
  }
  .reborn-chat__proof span {
    display: inline-flex;
    min-height: 1.7rem;
    align-items: center;
    padding: 0 0.55rem;
    border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius-control);
    background: var(--v2-surface-soft);
    color: var(--v2-text-muted);
    font-size: 0.72rem;
    font-weight: 650;
  }
  .reborn-chat__suggestions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.625rem;
    max-width: 34rem;
    margin: 0.5rem auto 0;
  }
  .reborn-suggestion {
    min-height: 2.75rem;
    padding: 0.65rem 1rem;
    border-radius: 999px;
    border: 1px solid var(--v2-border);
    background: var(--v2-surface);
    color: var(--v2-text);
    font-size: 0.8125rem;
    line-height: 1.1;
    cursor: pointer;
    transition:
      border-color var(--v2-dur-fast) var(--v2-ease-out),
      color var(--v2-dur-fast) var(--v2-ease-out),
      background var(--v2-dur-fast) var(--v2-ease-out),
      transform var(--v2-dur-fast) var(--v2-ease-out);
  }
  .reborn-suggestion:hover {
    border-color: var(--v2-accent);
    color: var(--v2-text-strong);
    background: var(--v2-surface-2);
    transform: translateY(-1px);
  }
  .reborn-suggestion:focus-visible {
    outline: 2px solid var(--v2-accent);
    outline-offset: 2px;
  }
  .reborn-suggestion:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  @media (prefers-reduced-motion: reduce) {
    .reborn-suggestion {
      transition: none;
    }
  }
  /* "Jump to latest" pill — sticks to the bottom of the scrollport while the
     user is reading scrollback; clicking pins back to the newest turn. */
  .reborn-jump {
    position: sticky;
    bottom: 0.75rem;
    align-self: center;
    margin-top: -0.5rem;
    min-height: 2.75rem;
    padding: 0.55rem 1rem;
    border: 1px solid var(--v2-border);
    border-radius: 999px;
    background: var(--v2-surface);
    color: var(--v2-accent-text);
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition:
      background var(--v2-dur-fast) var(--v2-ease-out),
      transform var(--v2-dur-fast) var(--v2-ease-out);
  }
  .reborn-jump:hover {
    background: var(--v2-surface-muted);
    transform: translateY(-1px);
  }
  .reborn-msg {
    max-width: min(100%, 70ch);
    padding: 0.75rem 0.95rem;
    border-radius: 0.85rem;
    border: 1px solid var(--v2-border);
    font-size: 0.94rem;
    line-height: 1.58;
    animation: reborn-fade-up var(--v2-dur-fast) var(--v2-ease-out);
    white-space: normal;
    word-break: break-word;
  }
  .reborn-msg--user {
    align-self: flex-end;
    max-width: min(78%, 38rem);
    background: var(--v2-accent-soft);
    color: var(--v2-text-strong);
    border-color: var(--v2-panel-border);
    border-bottom-right-radius: 0.35rem;
    white-space: pre-wrap;
  }
  .reborn-msg--user.is-optimistic {
    opacity: 0.68;
  }
  .reborn-msg__send-error {
    display: block;
    margin-top: 0.35rem;
    font-size: 0.75rem;
    color: var(--v2-danger-text);
  }
  .reborn-msg--assistant {
    align-self: flex-start;
    max-width: min(100%, 72ch);
    background: var(--v2-surface-soft);
    color: var(--v2-text);
    border-color: var(--v2-panel-border);
    border-bottom-left-radius: 0.35rem;
  }
  .reborn-msg--system {
    align-self: center;
    max-width: min(100%, 42rem);
    padding: 0.5rem 0.75rem;
    border-color: transparent;
    background: transparent;
    color: var(--v2-text-muted);
    font-size: 0.8rem;
    text-align: center;
  }
  .reborn-msg--error {
    align-self: center;
    max-width: min(100%, 48rem);
    background: var(--v2-danger-soft);
    color: var(--v2-danger-text);
    border-color: var(--v2-danger-text);
    font-size: 0.85rem;
  }
  .reborn-stream-error,
  .reborn-timeline-error {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .reborn-stream-error__retry {
    flex: 0 0 auto;
    min-height: 2rem;
    padding: 0.3rem 0.65rem;
    border: 1px solid currentColor;
    border-radius: 0.5rem;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.78rem;
    font-weight: 650;
    cursor: pointer;
  }
  .reborn-stream-error__retry:hover {
    background: var(--v2-danger-soft);
  }
  .reborn-stream-error__retry:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
  .reborn-tool {
    align-self: flex-start;
    width: 100%;
    max-width: min(100%, 72ch);
    border: 1px solid var(--v2-border);
    border-radius: 0.75rem;
    background: var(--v2-surface);
    overflow: hidden;
    font-size: 0.8rem;
    animation: reborn-fade-up var(--v2-dur-fast) var(--v2-ease-out);
  }
  .reborn-tool.is-error {
    border-color: var(--v2-danger-text);
    background: var(--v2-danger-soft);
  }
  .reborn-tool__head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-height: 2.75rem;
    padding: 0.55rem 0.7rem;
    border: none;
    background: transparent;
    color: var(--v2-text);
    font: inherit;
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
    transition: background var(--v2-dur-fast) var(--v2-ease-out);
  }
  .reborn-tool__head:not(.is-static):hover {
    background: var(--v2-surface-muted);
  }
  .reborn-tool__head.is-static {
    cursor: default;
  }
  .reborn-tool__dot {
    flex: 0 0 auto;
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    background: var(--v2-text-faint);
  }
  .reborn-tool__dot[data-status='running'] {
    background: var(--v2-accent);
  }
  .reborn-tool__dot[data-status='success'] {
    background: var(--v2-positive-text);
  }
  .reborn-tool__dot[data-status='error'] {
    background: var(--v2-danger-text);
  }
  .reborn-tool__name {
    font-family: var(--v2-mono);
    color: var(--v2-text-strong);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .reborn-tool__status {
    color: var(--v2-text-faint);
    text-transform: capitalize;
  }
  .reborn-tool__chevron {
    margin-left: auto;
    color: var(--v2-text-faint);
    transition: transform var(--v2-dur-fast) var(--v2-ease-out);
  }
  .reborn-tool__chevron.is-open {
    transform: rotate(90deg);
  }
  .reborn-tool__detail {
    padding: 0.1rem 0.7rem 0.65rem 1.6rem;
    border-top: 1px solid var(--v2-border);
  }
  .reborn-tool__detail-line {
    margin: 0.4rem 0 0;
    color: var(--v2-text-muted);
    font-family: var(--v2-mono);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .reborn-tool__detail-line.is-error {
    color: var(--v2-danger-text);
  }
  .reborn-streaming {
    width: auto;
    min-width: 4rem;
    max-width: 8rem;
    padding: 0.7rem 0.9rem;
    background: var(--v2-surface-soft);
  }
  .reborn-caret {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--v2-accent-text);
  }
  .reborn-caret span {
    width: 0.38rem;
    height: 0.38rem;
    background: var(--v2-accent);
    border-radius: 50%;
    opacity: 0.55;
  }
  .reborn-caret span:nth-child(2) {
    opacity: 0.75;
  }
  .reborn-caret span:nth-child(3) {
    opacity: 1;
  }
  .reborn-gate {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin: 0 1.25rem 0.75rem;
    padding: 0.8rem 0.95rem;
    border: 1px solid var(--v2-warning);
    border-radius: 0.75rem;
    background: var(--v2-warning-soft);
  }
  .reborn-gate--local {
    border-color: var(--v2-accent);
    background: color-mix(in srgb, var(--v2-accent) 12%, var(--v2-rail));
  }
  .reborn-gate__text strong {
    color: var(--v2-text-strong);
  }
  .reborn-gate__text p {
    margin: 0.25rem 0 0;
    font-size: 0.85rem;
    color: var(--v2-text-muted);
  }
  .reborn-gate__actions {
    display: flex;
    gap: 0.5rem;
    flex: 0 0 auto;
  }
  .reborn-gate__hint {
    margin-left: 0.4rem;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    background: var(--v2-surface-muted);
    font-family: var(--v2-mono);
    font-size: 0.7rem;
  }
  .reborn-composer {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 0.875rem clamp(1.25rem, 4vw, 3.5rem) 1rem;
    border-top: 1px solid var(--v2-border);
    background: var(--v2-rail);
  }
  .reborn-composer.is-dragging {
    border-top-color: var(--v2-accent);
  }
  .reborn-composer__file {
    display: none;
  }
  .reborn-composer__row {
    display: flex;
    align-items: flex-end;
    gap: 0.625rem;
    width: 100%;
  }
  .reborn-composer__input {
    flex: 1 1 auto;
    resize: none;
    max-height: 9rem;
    min-height: 2.75rem;
    overflow-y: auto;
    transition:
      border-color var(--v2-dur-fast) var(--v2-ease-out),
      background var(--v2-dur-fast) var(--v2-ease-out),
      height var(--v2-dur-fast) var(--v2-ease-out);
    padding: 0.72rem 0.85rem;
    border-radius: 0.75rem;
    border: 1px solid var(--v2-border);
    background: var(--v2-input-bg);
    color: var(--v2-text);
    font: inherit;
    line-height: 1.35;
  }
  .reborn-composer__input::placeholder {
    color: var(--v2-text-faint);
  }
  .reborn-composer__input:focus {
    border-color: var(--v2-accent);
    background: var(--v2-surface);
    outline: none;
  }
  .reborn-composer__input:focus-visible {
    outline: 2px solid var(--v2-accent);
    outline-offset: 2px;
  }
  .reborn-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    max-width: min(100%, 58rem);
  }
  .reborn-model-warning {
    max-width: min(100%, 58rem);
    border: 1px solid color-mix(in srgb, var(--v2-warning) 42%, var(--v2-border));
    border-radius: 0.7rem;
    background: color-mix(in srgb, var(--v2-warning) 13%, transparent);
    color: var(--v2-warning);
    padding: 0.65rem 0.8rem;
    font-size: 0.83rem;
    font-weight: 650;
    line-height: 1.35;
  }
  .reborn-attachment {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    max-width: min(100%, 24rem);
    min-height: 2.15rem;
    padding: 0.3rem 0.35rem 0.3rem 0.45rem;
    border: 1px solid var(--v2-border);
    border-radius: 0.55rem;
    background: var(--v2-surface);
    color: var(--v2-text-muted);
    font-size: 0.78rem;
  }
  .reborn-attachment__type {
    flex: 0 0 auto;
    min-width: 2.2rem;
    padding: 0.18rem 0.32rem;
    border-radius: 0.35rem;
    background: var(--v2-accent-soft);
    color: var(--v2-accent-text);
    font-size: 0.68rem;
    font-weight: 750;
    text-align: center;
  }
  .reborn-attachment__name {
    min-width: 0;
    max-width: 13rem;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--v2-text);
  }
  .reborn-attachment__size {
    flex: 0 0 auto;
    color: var(--v2-text-faint);
  }
  .reborn-attachment__remove {
    flex: 0 0 auto;
    width: 1.45rem;
    height: 1.45rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: 0.35rem;
    background: transparent;
    color: var(--v2-text-faint);
    font: inherit;
    line-height: 1;
    cursor: pointer;
  }
  .reborn-attachment__remove:hover {
    border-color: var(--v2-danger-text);
    color: var(--v2-danger-text);
    background: var(--v2-danger-soft);
  }
  .reborn-composer__drop {
    position: absolute;
    inset: 0.5rem clamp(0.85rem, 3vw, 2.6rem);
    z-index: 4;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    border: 2px dashed var(--v2-accent);
    border-radius: 0.85rem;
    background: color-mix(in srgb, var(--v2-rail) 88%, transparent);
    color: var(--v2-accent-text);
    pointer-events: none;
  }
  .reborn-composer__drop span {
    font-size: 0.78rem;
    color: var(--v2-text-muted);
  }
  .reborn-btn {
    flex: 0 0 auto;
    min-height: 2.75rem;
    min-width: 2.75rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.65rem 1rem;
    border-radius: 0.75rem;
    border: 1px solid var(--v2-border);
    background: var(--v2-surface-2);
    color: var(--v2-text);
    font: inherit;
    font-size: 0.875rem;
    font-weight: 650;
    text-decoration: none;
    cursor: pointer;
    transition:
      background var(--v2-dur-fast) var(--v2-ease-out),
      border-color var(--v2-dur-fast) var(--v2-ease-out),
      color var(--v2-dur-fast) var(--v2-ease-out),
      transform var(--v2-dur-fast) var(--v2-ease-out);
  }
  .reborn-btn:hover:not(:disabled) {
    background: var(--v2-surface-muted);
    transform: translateY(-1px);
  }
  .reborn-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .reborn-btn--icon {
    padding: 0;
  }
  .reborn-btn--primary {
    background: var(--v2-accent);
    border-color: var(--v2-accent);
    color: var(--v2-inverse);
  }
  .reborn-btn--primary:hover:not(:disabled) {
    background: var(--v2-accent-strong);
    border-color: var(--v2-accent-strong);
  }
  .reborn-btn--danger {
    background: var(--v2-danger-soft);
    border-color: var(--v2-danger-text);
    color: var(--v2-danger-text);
  }
  @keyframes reborn-fade-up {
    from {
      opacity: 0;
      transform: translateY(0.25rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
