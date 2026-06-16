import {
  cancelRun as cancelRunRequest,
  createThread as createThreadRequest,
  fetchTimeline,
  resolveGate as resolveGateRequest,
  sendMessage,
  submitManualToken
} from '../../../lib/api.js';
import {
  listConnectableChannels,
  looksLikeChannelConnectCommand,
  resolveChannelConnectCommand,
  resolveExtensionConnectCommand,
  resolveExtensionRecoveryAction
} from '../../../lib/channel-connect.js';
import { queryClient } from '../../../lib/query-client.js';
import { toast } from '../../../lib/toast.js';
import { React } from '../../../lib/html.js';
import { useChatEvents } from '../lib/useChatEvents.js';
import { buildDurableAttachmentBlock, runReplyLandedInTimeline } from '../lib/history-messages.js';
import { upsertRunFailureMessage } from '../lib/message-upsert.js';
import { flattenCachedThreads } from '../lib/thread-cache.js';
import {
  addPending,
  loadPending,
  pendingMessageId,
  recordAcceptedMessageRef,
  removePending,
  replacePending
} from '../lib/pending-messages.js';
import { useHistory } from './useHistory.js';
import { useSSE } from './useSSE.js';

const AUTH_TOKEN_FLOW_TIMEOUT_MS = 30000;
const RUN_STATE_FALLBACK_POLL_MS = 1500;
// Long generations (e.g. drafting a full agreement) routinely run well past 30s.
// Cutting off at 20 polls surfaced a premature "no result" card while the run
// was still producing — and the thinking indicator vanished with it. Poll for
// ~90s so a slow-but-real reply still lands and the working state stays visible.
const RUN_STATE_FALLBACK_MAX_ATTEMPTS = 60;
const AUTH_GATE_CREDENTIAL_STORED_ERROR = 'credential_stored_gate_resolution_failed';
const OAUTH_CALLBACK_CHANNEL = 'ironclaw-product-auth';
const OAUTH_CALLBACK_STORAGE_KEY = 'ironclaw:product-auth:oauth-complete';
const OAUTH_CALLBACK_MESSAGE_TYPE = 'ironclaw:product-auth:oauth-complete';

async function withAuthTokenTimeout(task) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_TOKEN_FLOW_TIMEOUT_MS);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function credentialStoredGateResolutionError(cause) {
  const error = new Error('auth gate resolution failed after credential storage');
  error.safeAuthGateCode = AUTH_GATE_CREDENTIAL_STORED_ERROR;
  error.cause = cause;
  return error;
}

function threadNeedsSidebarRefresh(threadId) {
  const threads = flattenCachedThreads(queryClient.getQueryData?.(['threads']));
  if (threads.length === 0) return true;
  const thread = threads.find((item) => item.thread_id === threadId || item.id === threadId);
  return !thread?.title;
}

function submitResponseResumedTurnGate(response) {
  return response?.continuation?.type === 'turn_gate_resume';
}

function isPendingOAuthGate(gate) {
  return gate?.kind === 'auth_required' && gate?.challengeKind === 'oauth_url';
}

function isOAuthCallbackCompletion(payload) {
  return payload?.type === OAUTH_CALLBACK_MESSAGE_TYPE && payload?.status === 'completed';
}

function oauthCompletionMatchesGate(payload, gate, listeningSince) {
  if (!isOAuthCallbackCompletion(payload)) return false;
  const continuation = payload?.continuation;
  if (!continuation || continuation.type !== 'turn_gate_resume') {
    return Number(payload?.completedAt || 0) >= listeningSince;
  }
  if (continuation.turn_run_ref && continuation.turn_run_ref !== gate?.runId) return false;
  if (continuation.gate_ref && continuation.gate_ref !== gate?.gateRef) return false;
  return true;
}

function parseOAuthCallbackStoragePayload(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function connectorRecoveryText({ content, failureCategory, failureSummary } = {}) {
  return [content, failureCategory, failureSummary].filter(Boolean).join('\n');
}

async function resolveConnectAction(content) {
  if (!looksLikeChannelConnectCommand(content)) return null;
  try {
    const channelsResponse = await queryClient.fetchQuery({
      queryKey: ['connectable-channels'],
      queryFn: listConnectableChannels
    });
    const channels = channelsResponse?.channels || [];
    return (
      resolveChannelConnectCommand(content, channels) || resolveExtensionConnectCommand(content)
    );
  } catch (err) {
    console.error('Failed to resolve connectable channels:', err);
    return resolveExtensionConnectCommand(content);
  }
}

// v2 chat hook. Differences from the fork's v1 hook:
// - No /api/chat/approval — approvals fold into gate/resolve in v2.
// - resolveGate uses `runId` + `gateRef` from the live event stream, not
//   a v1-style `requestId`.
// - cancelRun is a first-class action and posts to the v2 cancel route.
export function useChat(threadId) {
  const pendingMessagesRef = React.useRef(new Map());
  const [cooldownUntil, setCooldownUntil] = React.useState(0);
  const [now, setNow] = React.useState(Date.now());
  const [activeRun, setActiveRunState] = React.useState(null);
  const activeRunRef = React.useRef(activeRun);
  const setActiveRun = React.useCallback((next) => {
    const value = typeof next === 'function' ? next(activeRunRef.current) : next;
    activeRunRef.current = value;
    setActiveRunState(value);
  }, []);
  const [channelConnectAction, setChannelConnectAction] = React.useState(null);

  const getPendingMessages = React.useCallback(() => {
    const key = threadId || '__new__';
    const memory = pendingMessagesRef.current.get(key);
    if (memory?.length) return memory;
    const persisted = loadPending(key);
    if (persisted.length > 0) pendingMessagesRef.current.set(key, persisted);
    return persisted;
  }, [threadId]);
  const setPendingMessages = React.useCallback(
    (messages) => {
      const key = threadId || '__new__';
      replacePending(pendingMessagesRef.current, key, messages);
    },
    [threadId]
  );

  const {
    messages,
    hasMore,
    nextCursor,
    isLoading: historyLoading,
    loadHistory,
    setMessages
  } = useHistory(threadId, { getPendingMessages, setPendingMessages });

  const [isProcessing, setIsProcessing] = React.useState(false);
  const [pendingGate, setPendingGate] = React.useState(null);
  const authTokenSubmitRef = React.useRef({
    gateKey: null,
    credentialRef: null,
    inFlight: false
  });

  // Per-thread transient state must not leak across thread switches.
  // Without this reset, clicking "+ New" while the previous thread is
  // still processing renders the TypingIndicator on the empty new
  // thread. The SSE subscription for the new thread will set these
  // back to non-default values if that thread actually has an active
  // run / gate. `cooldownUntil` is intentionally not reset — it's a
  // rate-limit timer that applies across threads.
  React.useEffect(() => {
    setIsProcessing(false);
    setPendingGate(null);
    setActiveRun(null);
    setChannelConnectAction(null);
  }, [threadId]);

  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const pendingAuthGateKey =
    pendingGate?.runId && pendingGate?.gateRef
      ? `${pendingGate.runId}\n${pendingGate.gateRef}`
      : null;

  React.useEffect(() => {
    if (!cooldownUntil) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [cooldownUntil]);

  React.useEffect(() => {
    if (authTokenSubmitRef.current.gateKey !== pendingAuthGateKey) {
      authTokenSubmitRef.current = {
        gateKey: pendingAuthGateKey,
        credentialRef: null,
        inFlight: false
      };
    }
  }, [pendingAuthGateKey]);

  React.useEffect(() => {
    if (!isPendingOAuthGate(pendingGate)) return;
    const listeningSince = Date.now();

    const handleCompletion = (payload) => {
      if (!oauthCompletionMatchesGate(payload, pendingGate, listeningSince)) return;
      setPendingGate((current) => (isPendingOAuthGate(current) ? null : current));
      setIsProcessing(true);
    };

    let channel = null;
    if (typeof window.BroadcastChannel === 'function') {
      channel = new window.BroadcastChannel(OAUTH_CALLBACK_CHANNEL);
      channel.onmessage = (event) => handleCompletion(event.data);
    }

    const onStorage = (event) => {
      if (event.key !== OAUTH_CALLBACK_STORAGE_KEY) return;
      handleCompletion(parseOAuthCallbackStoragePayload(event.newValue));
    };

    window.addEventListener('storage', onStorage);
    handleCompletion(
      parseOAuthCallbackStoragePayload(window.localStorage?.getItem?.(OAUTH_CALLBACK_STORAGE_KEY))
    );
    const timer = window.setInterval(() => {
      handleCompletion(
        parseOAuthCallbackStoragePayload(window.localStorage?.getItem?.(OAUTH_CALLBACK_STORAGE_KEY))
      );
    }, 500);
    return () => {
      window.clearInterval(timer);
      if (channel) channel.close();
      window.removeEventListener('storage', onStorage);
    };
  }, [pendingGate]);

  const handleEvent = useChatEvents({
    threadId,
    setMessages,
    setIsProcessing,
    setPendingGate,
    setActiveRun,
    activeRunRef,
    // Reborn's projection bridge does not yet emit `Text` items for
    // assistant replies, so the SSE stream only delivers `run_status`.
    // On terminal success, refetch the timeline so the assistant
    // message that landed in the thread becomes visible in the UI.
    // Pending rows are NOT cleared here: loadHistory reconciles them via
    // pendingMessagesAfterTimeline, which clears exactly the confirmed
    // ones. A blanket wipe would durably delete a second in-flight turn
    // whose projection hasn't landed yet.
    onRunCompleted: () => {
      loadHistory();
    },
    onRunFailed: (failure) => {
      const recovery = resolveExtensionRecoveryAction(connectorRecoveryText(failure));
      if (recovery) setChannelConnectAction(recovery);
    }
  });

  const { status: sseStatus } = useSSE({
    threadId,
    onEvent: handleEvent,
    enabled: Boolean(threadId)
  });

  React.useEffect(() => {
    if (
      !threadId ||
      !isProcessing ||
      pendingGate ||
      !activeRun?.runId ||
      activeRun.threadId !== threadId
    ) {
      return undefined;
    }

    let cancelled = false;
    let attempts = 0;
    let timer = null;
    const controller = new AbortController();

    const appendFailureMessage = (content) => {
      upsertRunFailureMessage(setMessages, {
        runId: activeRun.runId,
        content,
        source: 'fallback',
        timestamp: new Date().toISOString()
      });
    };

    // SSE-drop fallback. The gateway registers no bare GET /runs/{id}, so we
    // poll the registered timeline route and treat a finalized assistant reply
    // for this run as completion (runReplyLandedInTimeline). Run failures are
    // surfaced by the live SSE channel; a dropped-SSE run that produces nothing
    // falls through to the honest timeout below rather than a fabricated status.
    const pollRunState = async () => {
      attempts += 1;
      try {
        const timeline = await fetchTimeline({
          threadId,
          limit: 60,
          signal: controller.signal
        });
        if (cancelled) return;
        if (runReplyLandedInTimeline(timeline?.messages || [], activeRun.runId)) {
          // loadHistory reconciles pending rows against the timeline;
          // no blanket wipe (see onRunCompleted).
          setPendingGate(null);
          setIsProcessing(false);
          setActiveRun(null);
          loadHistory();
          return;
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        // Keep polling; transient timeline misses are expected while the
        // backend is still writing the run's records.
      }

      if (!cancelled && attempts < RUN_STATE_FALLBACK_MAX_ATTEMPTS) {
        timer = window.setTimeout(pollRunState, RUN_STATE_FALLBACK_POLL_MS);
      } else if (!cancelled) {
        appendFailureMessage(
          'IronClaw accepted this turn, but no assistant result arrived from Reborn yet. Your message and attachments are preserved in this thread.'
        );
        setPendingGate(null);
        setIsProcessing(false);
        setActiveRun(null);
      }
    };

    timer = window.setTimeout(pollRunState, RUN_STATE_FALLBACK_POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [
    activeRun?.runId,
    activeRun?.threadId,
    isProcessing,
    loadHistory,
    pendingGate,
    setActiveRun,
    setMessages,
    threadId
  ]);

  // Accepts the fork's call shape `{ images, attachments, threadId,
  // timezone }`. Reborn v2 accepts attachments as a first-class
  // `attachments` field; never inline base64 into `content`, or the
  // content validator will reject ordinary PDF/DOCX/XLSX workflows.
  //
  // v2 send-message requires `thread_id` as a path parameter — the
  // facade refuses to implicitly create a missing thread. When the
  // caller is on the landing screen (no active thread yet), we
  // eagerly POST `/threads` first and use the returned id. The
  // returned response carries `thread_id` so the chat.js navigation
  // hook can route to `/chat/<id>` after the first send.
  const send = React.useCallback(
    async (content, opts = {}) => {
      const connectable = await resolveConnectAction(content);
      if (connectable) {
        setChannelConnectAction(connectable);
        return { channel_connect_action: connectable };
      }
      setChannelConnectAction(null);

      const { threadId: targetThreadId, images = [], attachments = [] } = opts;
      const serializedAttachments = serializeComposerAttachments([...images, ...attachments]);
      const optimisticAttachments = [
        ...images.map((img) => ({
          filename: img.filename || 'image',
          mime_type: img.mime_type || 'image/*',
          size_label: img.size ? `${img.size} bytes` : ''
        })),
        ...composerAttachmentsForOptimisticBubble(attachments)
      ];
      // Reborn's timeline projection echoes `content` but NOT the first-class
      // `attachments` field, and the sidecar never feeds attachment bytes to
      // the model either. The durable block therefore carries BOTH the chip
      // metadata (parsed back on reload, stripped from view) and the text
      // content itself for text payloads — the only channel the model can
      // actually read. contentBytes keeps the embed inside the backend's
      // 64 KiB content ceiling.
      const durableAttachmentBlock = buildDurableAttachmentBlock(serializedAttachments, {
        contentBytes: new TextEncoder().encode(content).length
      });
      const contentForReborn = durableAttachmentBlock
        ? `${content}${durableAttachmentBlock}`
        : content;
      let sendThreadId = targetThreadId || threadId;

      if (!sendThreadId) {
        const created = await createThreadRequest();
        queryClient.invalidateQueries({ queryKey: ['threads'] });
        sendThreadId = created?.thread?.thread_id;
        if (!sendThreadId) {
          throw new Error('createThread returned no thread_id');
        }
      }

      const pendingKey = sendThreadId;
      // Image payloads stay out of the durable queue, but their metadata
      // rides in `attachments` so a reload still shows that the turn
      // carried an image, not just bare prompt text.
      const pendingRecord = {
        id: pendingMessageId(),
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
        images: images.map((img) => img.dataUrl).filter(Boolean),
        attachments: optimisticAttachments,
        isOptimistic: true
      };
      addPending(pendingMessagesRef.current, pendingKey, pendingRecord);

      const optimisticId = pendingRecord.id;
      setMessages((prev) => [
        ...prev,
        {
          id: optimisticId,
          role: 'user',
          content,
          timestamp: pendingRecord.timestamp,
          images: pendingRecord.images,
          attachments: pendingRecord.attachments,
          isOptimistic: true
        }
      ]);

      setIsProcessing(true);
      setPendingGate(null);

      try {
        const response = await sendMessage({
          threadId: sendThreadId,
          content: contentForReborn,
          // The model reads the document through the inlined durable block in
          // `content` (the only channel the sidecar feeds to it); the wire drops
          // the bytes the gateway cannot land yet. See attachmentsForWire.
          attachments: attachmentsForWire(serializedAttachments)
        });
        // Refresh the sidebar only while the cached entry is missing
        // or title-less. Once the first-message title has appeared,
        // repeated sends do not need to refetch the whole thread list.
        if (threadNeedsSidebarRefresh(sendThreadId)) {
          queryClient.invalidateQueries({ queryKey: ['threads'] });
        }
        if (response?.run_id) {
          setActiveRun({
            runId: response.run_id,
            threadId: response.thread_id || sendThreadId,
            status: response.status || null,
            source: 'local'
          });
        }
        const timelineMessageId = recordAcceptedMessageRef(
          pendingMessagesRef.current,
          pendingKey,
          optimisticId,
          response?.accepted_message_ref
        );
        if (timelineMessageId) {
          setMessages((prev) =>
            prev.map((m) => (m.id === optimisticId ? { ...m, timelineMessageId } : m))
          );
        }
        return response;
      } catch (err) {
        if (err.status === 429) {
          setCooldownUntil(Date.now() + retryAfterMs(err));
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.id === optimisticId
              ? {
                  ...m,
                  isOptimistic: false,
                  status: 'error',
                  error: err.message
                }
              : m
          )
        );
        removePending(pendingMessagesRef.current, pendingKey, optimisticId);
        setIsProcessing(false);
        throw err;
      }
    },
    [threadId, setMessages]
  );

  // v2 resolveGate signature: `(resolution, { always?, credentialRef? })`.
  // run_id and gate_ref come from the live `pendingGate` (set by the
  // gate / auth_required event) so the UI doesn't have to plumb them
  // through every approve-action call site.
  const gateResolveInFlightRef = React.useRef(false);
  const resolveGate = React.useCallback(
    async (resolution, opts = {}) => {
      if (!pendingGate) return;
      const { runId, gateRef } = pendingGate;
      if (!runId || !gateRef) {
        throw new Error('resolveGate requires a pending gate with run_id and gate_ref');
      }
      // Block double-fire: a second click while the decision is in flight would
      // submit a duplicate approve/deny for the same sacred gate.
      if (gateResolveInFlightRef.current) return;
      gateResolveInFlightRef.current = true;
      try {
        await resolveGateRequest({
          threadId,
          runId,
          gateRef,
          resolution,
          always: opts.always,
          credentialRef: opts.credentialRef
        });
      } catch (err) {
        // A failed resolution must NOT leave the gate silently stuck or throw an
        // unhandled rejection. Keep the gate mounted and actionable, tell the
        // user, and let them retry — the most safety-critical surface in the
        // product cannot fail blind.
        gateResolveInFlightRef.current = false;
        toast(
          `Couldn't submit your decision — ${err?.message || 'connection failed'}. Try again.`,
          {
            tone: 'error'
          }
        );
        return;
      }
      gateResolveInFlightRef.current = false;
      const shouldContinueProcessing =
        resolution === 'approved' || resolution === 'credential_provided';
      setPendingGate(null);
      setIsProcessing(shouldContinueProcessing);
      if (!shouldContinueProcessing) {
        setActiveRun(null);
      }
    },
    [pendingGate, threadId]
  );

  const submitAuthToken = React.useCallback(
    async (token) => {
      if (!pendingGate) {
        throw new Error('auth gate is no longer pending');
      }
      const { runId, gateRef, provider } = pendingGate;
      if (!runId || !gateRef || !provider) {
        throw new Error('auth gate is missing required credential metadata');
      }
      // `account_label` is optional on the prompt (gates.js defaults it to
      // an empty string), so don't gate submission on it — derive a sensible
      // label when the prompt didn't carry one.
      const accountLabel = pendingGate.accountLabel || `${provider} credential`;
      const gateKey = `${runId}\n${gateRef}`;
      if (authTokenSubmitRef.current.gateKey !== gateKey) {
        authTokenSubmitRef.current = {
          gateKey,
          credentialRef: null,
          inFlight: false
        };
      }
      if (authTokenSubmitRef.current.inFlight) {
        throw new Error('auth token submission already in progress');
      }
      authTokenSubmitRef.current.inFlight = true;

      try {
        let credentialRef = authTokenSubmitRef.current.credentialRef;
        let submitted = null;
        if (!credentialRef) {
          submitted = await withAuthTokenTimeout((signal) =>
            submitManualToken({
              provider,
              accountLabel,
              token,
              threadId,
              runId,
              gateRef,
              signal
            })
          );
          credentialRef = submitted?.credential_ref;
          if (!credentialRef) {
            throw new Error('manual token submit returned no credential_ref');
          }
          authTokenSubmitRef.current.credentialRef = credentialRef;
        }

        if (!submitResponseResumedTurnGate(submitted)) {
          try {
            await withAuthTokenTimeout((signal) =>
              resolveGateRequest({
                threadId,
                runId,
                gateRef,
                resolution: 'credential_provided',
                credentialRef,
                signal
              })
            );
          } catch (err) {
            throw credentialStoredGateResolutionError(err);
          }
        }

        authTokenSubmitRef.current = {
          gateKey: null,
          credentialRef: null,
          inFlight: false
        };
        setPendingGate(null);
        setIsProcessing(true);
      } catch (err) {
        if (authTokenSubmitRef.current.gateKey === gateKey) {
          authTokenSubmitRef.current.inFlight = false;
        }
        throw err;
      }
    },
    [pendingGate, threadId]
  );

  const cancelRun = React.useCallback(
    async (reason) => {
      const runId = activeRun?.runId;
      if (!runId || !threadId) return;
      setPendingGate(null);
      setIsProcessing(false);
      setActiveRun(null);
      await cancelRunRequest({ threadId, runId, reason });
    },
    [activeRun, threadId]
  );

  const loadMore = React.useCallback(() => {
    if (hasMore && nextCursor) loadHistory(nextCursor);
  }, [hasMore, nextCursor, loadHistory]);

  // Fork-shape compatibility: `approve(requestId, action, kind)` from
  // chat.js. `requestId` and `kind` are v1 concepts the v2 stream
  // doesn't surface; the live `pendingGate` already carries
  // `runId` + `gateRef`, so the args are intentionally ignored and
  // the call is rerouted to v2 resolveGate.
  const approve = React.useCallback(
    async (_requestId, action, _kind) => {
      let resolution = 'approved';
      let always = false;
      if (action === 'deny') resolution = 'denied';
      else if (action === 'cancel') resolution = 'cancelled';
      else if (action === 'always') {
        resolution = 'approved';
        always = true;
      }
      await resolveGate(resolution, { always });
    },
    [resolveGate]
  );

  // Fork chat.js expects these as stubs: v2 stream is deterministic
  // enough that retry / suggestions / recovery are not necessary in
  // local-dev. Wire them as no-ops so the chat UI renders without
  // additional branches.
  const noop = React.useCallback(() => {}, []);

  return {
    // v2-native
    messages,
    isProcessing,
    pendingGate,
    channelConnectAction,
    activeRun,
    sseStatus,
    historyLoading,
    hasMore,
    cooldownSeconds,
    send,
    resolveGate,
    submitAuthToken,
    cancelRun,
    loadMore,
    dismissChannelConnectAction: () => setChannelConnectAction(null),
    // fork-shape compatibility — see comments above
    suggestions: [],
    setSuggestions: noop,
    retryMessage: noop,
    approve,
    recoverHistory: noop,
    recoveryNotice: null
  };
}

// The Reborn byte-landing path (#4644, mid-merge as of 2026-06-14) cannot yet
// accept attachment bytes: under the DevOnly composition the host-side
// attachment_landing builds a read-only MountView, so any send carrying
// data_base64 fails the whole turn with HTTP 500 ("permission denied for
// write_file on scoped /workspace/attachments/..."). The model never reads
// attachment bytes regardless — its only channel is the inlined durable text
// block, which buildDurableAttachmentBlock decodes from the same base64 into
// `content`. So until the landing endpoint is real we ship NO bytes on the wire:
// keep the chip metadata, drop data_base64, and the api layer then omits the
// now-empty attachments field. Flip this to true (and update
// useChat-send.test.mjs) the sprint the gateway can land bytes.
const GATEWAY_LANDS_ATTACHMENT_BYTES = false;

function attachmentsForWire(serialized) {
  if (GATEWAY_LANDS_ATTACHMENT_BYTES) return serialized || [];
  return (serialized || []).map((item) => ({ ...item, data_base64: '' }));
}

function serializeComposerAttachments(items) {
  return (
    (items || [])
      .map((item) => ({
        name: item.filename || 'attachment',
        mime_type: item.mime_type || 'application/octet-stream',
        data_base64: item.base64 || '',
        size: item.size || 0
      }))
      // Chips without a payload (extraction failed / still extracting) must
      // not reach the wire — an empty data_base64 would be a silent no-op
      // attachment, the exact failure mode this composer is built to avoid.
      .filter((item) => item.data_base64)
  );
}

function composerAttachmentsForOptimisticBubble(attachments) {
  return (attachments || [])
    .filter((attachment) => attachment?.base64)
    .map((attachment) => ({
      filename: attachment.filename || 'attachment',
      mime_type: attachment.mime_type || 'application/octet-stream',
      size_label: attachment.size ? `${attachment.size} bytes` : '',
      extractedText: attachment.extractedText || '',
      embedded_text: attachment.extractedText || '',
      extraction_status:
        attachment.extraction === 'extracted'
          ? attachment.partial
            ? 'extracted_text_truncated'
            : 'extracted_text'
          : attachment.modelReadable === false
            ? 'content_omitted_message_budget'
            : '',
      modelReadable: attachment.modelReadable !== false
    }));
}

function retryAfterMs(err) {
  const raw = err.headers?.get?.('Retry-After');
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return 2000;
}
