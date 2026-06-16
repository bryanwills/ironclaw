/**
 * @typedef {{
 *   message_id?: string | number;
 *   kind?: string;
 *   content?: string | null;
 *   sequence?: number;
 *   status?: string | null;
 *   turn_run_id?: string | null;
 *   actor_id?: string | null;
 *   received_at?: string | null;
 *   created_at?: string | null;
 *   generatedFiles?: unknown[];
 *   generated_files?: unknown[];
 *   outputFiles?: unknown[];
 *   output_files?: unknown[];
 *   files?: unknown[];
 *   artifacts?: unknown[];
 *   attachments?: unknown[];
 * }} TimelineRecord
 *
 * @typedef {{
 *   id?: string;
 *   role?: string;
 *   content?: string | null;
 *   timestamp?: string | null;
 *   isOptimistic?: boolean;
 *   timelineMessageId?: string | number | null;
 *   attachments?: AttachmentChip[];
 *   [key: string]: unknown;
 * }} PendingMessage
 *
 * @typedef {{
 *   filename?: string;
 *   mime_type?: string;
 *   data_base64?: string;
 *   size_label?: string;
 *   extraction_status?: string;
 *   embedded_text?: string;
 * }} AttachmentChip
 *
 * @typedef {{
 *   content: string;
 *   attachments: AttachmentChip[];
 * }} ParsedContent
 *
 * @typedef {{
 *   invocation_id?: string;
 *   status?: string;
 *   title?: string;
 *   capability_id?: string;
 *   subtitle?: string | null;
 *   input_summary?: string | null;
 *   output_preview?: string | null;
 *   output_summary?: string | null;
 *   result_ref?: string | null;
 *   updated_at?: string | null;
 *   truncated?: boolean;
 *   output_bytes?: number | null;
 *   output_kind?: string | null;
 *   turn_run_id?: string | null;
 * }} CapabilityPreview
 *
 * @typedef {{
 *   invocationId: string;
 *   callId: string;
 *   toolName: string;
 *   toolStatus: string;
 *   toolDetail: string | null;
 *   toolParameters: string | null;
 *   toolResultPreview: string | null;
 *   toolError: string | null;
 *   toolDurationMs: number | null;
 *   updatedAt: string | null;
 *   resultRef: string | null;
 *   truncated: boolean;
 *   outputBytes: number | null;
 *   outputKind: string | null;
 *   turnRunId: string | null;
 * }} ToolCard
 *
 * @typedef {{
 *   invocation_id?: string;
 *   status?: string;
 *   capability_id?: string;
 *   error_kind?: string | null;
 *   updated_at?: string | null;
 *   output_bytes?: number | null;
 *   turn_run_id?: string | null;
 * }} CapabilityActivity
 */

// Map v2 `ThreadMessageRecord[]` from RebornTimelineResponse into
// the message shape the UI components render. Kept narrow: the v2
// timeline contract stores browser attachments as a durable transcript block
// in `content` until the native v2 request grows a first-class attachment
// field. Parse that block back into chips while preserving turn grouping.

// True once a run has produced a finalized assistant reply in the timeline.
// This is the SSE-drop fallback's completion signal: the gateway registers no
// bare GET /runs/{id} (only .../cancel and .../gates/.../resolve), so the old
// fetchRunState poll 404'd forever and then falsely declared "no result". The
// timeline IS registered and carries each assistant record's turn_run_id +
// status, so a landed reply is the honest, route-real proof the turn finished.
// Failure is deliberately NOT inferred here — the timeline has no reliable
// run-level failure status (a capability error_kind can precede a successful
// recovery); genuine failures arrive on the live SSE channel, and a dropped-SSE
// run that produced nothing falls through to the caller's honest timeout.
/**
 * @param {TimelineRecord[]} records
 * @param {string | null | undefined} runId
 * @returns {boolean}
 */
export function runReplyLandedInTimeline(records, runId) {
  if (!runId || !Array.isArray(records)) return false;
  return records.some((record) => {
    if (!record) return false;
    // Only a finalized assistant *message* proves the turn finished. Match on
    // kind directly (not roleForRecord, which maps tool_result → assistant) so a
    // mid-run tool result never clears 'processing' early.
    if (record.kind !== 'assistant' && record.kind !== 'assistant_message') return false;
    if ((record.turn_run_id || null) !== runId) return false;
    const status = String(record.status || '').toLowerCase();
    return status !== 'pending' && status !== 'streaming';
  });
}

/**
 * @param {TimelineRecord[]} records
 * @param {PendingMessage[]} pendingMessages
 * @returns {any[]}
 */
export function messagesFromTimeline(records, pendingMessages = []) {
  const seen = new Set();
  const messages = [];
  const contentLedger = timelineUserContentLedger(records, pendingMessages);

  for (const record of records || []) {
    if (record.kind === 'tool_result_reference') {
      // LLM-visible transcript artifact (result_ref + safe_summary).
      // Not a UI message — the matching `capability_display_preview`
      // record renders the tool card.
      continue;
    }

    if (record.kind === 'capability_display_preview') {
      const card = toolCardFromPreviewRecord(record);
      if (!card) continue;
      const id = `tool-${card.invocationId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      messages.push({
        id,
        role: 'tool_activity',
        ...card,
        timestamp: timestampForRecord(record) || card.updatedAt || null,
        sequence: record.sequence,
        turnRunId: record.turn_run_id || null
      });
      continue;
    }

    const id = `msg-${record.message_id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const role = roleForRecord(record);
    // Manifests only ever ride on user sends. Assistant text is rendered
    // verbatim — a reply that quotes or mimics the block format must not be
    // truncated into phantom attachment chips. Legacy (pre-sentinel) blocks
    // stay parseable on user records so existing threads keep their chips.
    const rendered =
      role === 'user'
        ? parseDurableAttachmentBlock(record.content || '', { allowLegacy: true })
        : { content: String(record.content || ''), attachments: [] };
    const generatedFiles = role === 'assistant' ? generatedFileCandidatesFromRecord(record) : [];
    /** @type {any} */
    const message = {
      id,
      role,
      content: rendered.content,
      attachments: rendered.attachments,
      timestamp: timestampForRecord(record),
      kind: record.kind,
      status: record.status,
      isFinalReply: isFinalAssistantRecord(record),
      sequence: record.sequence,
      turnRunId: record.turn_run_id || null
    };
    if (generatedFiles.length > 0) message.generatedFiles = generatedFiles;
    messages.push(message);
  }

  // Pending rows survive until the timeline confirms them. The id-based
  // guard handles records whose accepted ref was recorded; content-based
  // user dedupe covers the handoff gap where Reborn has accepted the turn
  // but the caller has not yet attached the server timeline id — consumed
  // one-to-one and time-aware so an older identical message cannot
  // swallow a newer unconfirmed turn.
  for (const pending of pendingMessages) {
    if (seen.has(pending.id)) continue;
    const message = pendingMessageForRender(pending);
    if (message.timelineMessageId && seen.has(`msg-${message.timelineMessageId}`)) {
      continue;
    }
    if (
      !message.timelineMessageId &&
      message.role === 'user' &&
      consumeContentConfirmation(contentLedger, message)
    ) {
      continue;
    }
    seen.add(pending.id);
    messages.push(message);
  }

  return messages;
}

/**
 * @param {TimelineRecord} record
 * @returns {unknown[]}
 */
function generatedFileCandidatesFromRecord(record = {}) {
  return [
    ...arrayValue(record.generatedFiles),
    ...arrayValue(record.generated_files),
    ...arrayValue(record.outputFiles),
    ...arrayValue(record.output_files),
    ...arrayValue(record.files),
    ...arrayValue(record.artifacts),
    ...arrayValue(record.attachments)
  ];
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Return pending messages that have not been confirmed by the timeline yet.
 * The hook uses this after a timeline refresh so stale optimistic user bubbles
 * do not duplicate the server-confirmed turn.
 *
 * @param {TimelineRecord[]} records
 * @param {PendingMessage[]} pendingMessages
 */
export function pendingMessagesAfterTimeline(records, pendingMessages = []) {
  const contentLedger = timelineUserContentLedger(records, pendingMessages);
  const timelineIds = new Set(
    (records || [])
      .filter((record) => record && record.message_id != null)
      .map((record) => `msg-${record.message_id}`)
  );

  return (pendingMessages || []).filter((pending) => {
    const message = pendingMessageForRender(pending);
    if (message.timelineMessageId && timelineIds.has(`msg-${message.timelineMessageId}`)) {
      return false;
    }
    if (
      !message.timelineMessageId &&
      message.role === 'user' &&
      consumeContentConfirmation(contentLedger, message)
    ) {
      return false;
    }
    return true;
  });
}

// Content confirmation is the only clearing path for a pending row whose
// accepted ref was never recorded (e.g. crash between persist and send
// response). It must be one-to-one — a single projected user row confirms
// at most one pending row — and time-aware, so a routine repeated prompt
// ("continue") from an earlier turn cannot confirm a newer unconfirmed one.
const CONTENT_CONFIRMATION_SKEW_MS = 5 * 60 * 1000;

/**
 * Multiset of timeline user rows available for content confirmation:
 * normalized content -> ascending record timestamps (ms; NaN when the
 * record carries no parseable timestamp). Rows already claimed by an
 * id-confirmed pending record are excluded.
 *
 * @param {TimelineRecord[]} records
 * @param {PendingMessage[]} pendingMessages
 */
function timelineUserContentLedger(records, pendingMessages = []) {
  const idConfirmed = new Set();
  for (const pending of pendingMessages || []) {
    if (pending?.timelineMessageId != null) {
      idConfirmed.add(`msg-${pending.timelineMessageId}`);
    }
  }
  const ledger = new Map();
  for (const record of records || []) {
    if (roleForRecord(record) !== 'user') continue;
    if (record.message_id != null && idConfirmed.has(`msg-${record.message_id}`)) continue;
    const key = normalizeComparableContent(record.content);
    const stamp = Date.parse(timestampForRecord(record) || '');
    if (!ledger.has(key)) ledger.set(key, []);
    ledger.get(key).push(stamp);
  }
  for (const stamps of ledger.values()) {
    stamps.sort(
      /** @param {number} a @param {number} b */
      (a, b) => (Number.isFinite(a) ? a : Infinity) - (Number.isFinite(b) ? b : Infinity)
    );
  }
  return ledger;
}

/**
 * Consume one timeline occurrence matching the pending message's content,
 * preferring the oldest row that is not older than the pending timestamp
 * (minus skew). Rows without timestamps on either side stay eligible so
 * crash-recovery clearing keeps working.
 *
 * @param {Map<string, number[]>} ledger
 * @param {PendingMessage} message
 */
function consumeContentConfirmation(ledger, message) {
  const key = normalizeComparableContent(message.content);
  const stamps = ledger.get(key);
  if (!stamps || stamps.length === 0) return false;
  const pendingStamp = Date.parse(message.timestamp || '');
  const threshold = Number.isFinite(pendingStamp)
    ? pendingStamp - CONTENT_CONFIRMATION_SKEW_MS
    : -Infinity;
  const index = stamps.findIndex((stamp) => !Number.isFinite(stamp) || stamp >= threshold);
  if (index === -1) return false;
  stamps.splice(index, 1);
  if (stamps.length === 0) ledger.delete(key);
  return true;
}

/**
 * Comparison key for user-row dedup. Strips attachment blocks (sentinel and
 * legacy) REPEATEDLY: a pending row holds the user's typed text while the
 * timeline echo holds typed text + our appended manifest, so when the typed
 * text itself ends in a block-shaped tail the two sides would otherwise
 * strip different layers and never match — leaving a duplicate bubble.
 *
 * @param {string | null | undefined} content
 */
function normalizeComparableContent(content) {
  let value = String(content || '');
  for (;;) {
    const parsed = parseDurableAttachmentBlock(value, { allowLegacy: true });
    if (parsed.content === value) return value.trim();
    value = parsed.content;
  }
}

// The bundled Reborn sidecar (v0.29.x) stores first-class attachments in the
// thread record but never delivers their CONTENT to the model — no workspace
// file, no context inlining (upstream adds inlining only in uncommitted
// work). The message `content` is therefore the ONLY channel through which
// the model can read a document, so the durable block embeds the extracted
// text itself, within the backend content validator's laws:
//   - whole content ≤ 64 KiB bytes (USER_MESSAGE_TEXT_MAX_BYTES)
//   - no control characters except \n and \t (\r is rejected)
const MESSAGE_CONTENT_MAX_BYTES = 64 * 1024;
const EMBED_TOTAL_BUDGET_BYTES = 48 * 1024;
const EMBED_SAFETY_RESERVE_BYTES = 2 * 1024;

const TEXT_EMBEDDABLE_MIMES = new Set([
  'application/json',
  'application/ld+json',
  'application/x-ndjson',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/csv',
  'application/javascript',
  'application/sql',
  'application/rtf',
  'text/rtf'
]);
const TEXT_EMBEDDABLE_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'ndjson',
  'xml',
  'yaml',
  'yml',
  'toml',
  'log',
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'ts',
  'py',
  'rs',
  'go',
  'java',
  'rb',
  'sh',
  'sql',
  'rtf'
]);

/**
 * @param {{ name?: string, filename?: string, mime_type?: string }} item
 */
function isTextEmbeddable(item) {
  const mime = String(item.mime_type || '').toLowerCase();
  if (mime.startsWith('text/')) return true;
  if (TEXT_EMBEDDABLE_MIMES.has(mime)) return true;
  const name = String(item.name || item.filename || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot !== -1 && TEXT_EMBEDDABLE_EXTENSIONS.has(name.slice(dot + 1));
}

/**
 * Public form of the embed eligibility test, for the composer: a raw
 * payload that is not text-embeddable never reaches the model, and the
 * chip must say so instead of implying success.
 *
 * @param {{ name?: string, filename?: string, mime_type?: string }} item
 */
export function isAttachmentTextEmbeddable(item) {
  return isTextEmbeddable(item || {});
}

/**
 * @param {string | null | undefined} base64
 * @returns {string | null} UTF-8 text, or null when undecodable
 */
function decodeBase64Utf8(base64) {
  try {
    const binary = atob(String(base64 || '').replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch (_) {
    return null;
  }
}

/**
 * Normalize text so the backend content validator accepts it: CRLF/CR to
 * LF, every other control character (except \n and \t) to a space.
 *
 * @param {string} text
 */
function sanitizeEmbeddedText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
}

/**
 * Truncate to at most maxBytes of UTF-8 without splitting a code point.
 *
 * @param {string} text
 * @param {number} maxBytes
 */
function truncateUtf8(text, maxBytes) {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return { text, truncated: false };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return { text: text.slice(0, low), truncated: true };
}

/**
 * Render the durable attachment manifest appended to message content.
 *
 * Two jobs in one block:
 *  1. Reload durability — Reborn's timeline echoes `content` but drops the
 *     first-class `attachments` field; the metadata lines are parsed back
 *     into chips by `parseDurableAttachmentBlock` and stripped from view.
 *  2. Model visibility — the sidecar never feeds attachment bytes to the
 *     model, so text payloads (extracted PDFs/DOCX/XLSX, plain text files)
 *     are embedded as length-prefixed fenced sections the model can read.
 *     `extracted_text_chars` lets the parser skip the content exactly, so
 *     documents containing manifest-like lines can never corrupt parsing.
 *
 * Never include raw base64 — the content validator rejects oversized
 * payloads, and binary bytes still ride the first-class field.
 *
 * @param {Array<{ name?: string, filename?: string, mime_type?: string, size?: number, data_base64?: string }>} attachments
 * @param {{ contentBytes?: number }} [opts] UTF-8 size of the user's own
 *   message text, so the embed budget never pushes the whole content past
 *   the backend's 64 KiB ceiling.
 * @returns {string} block text (leading blank line), or '' when empty
 */
export function buildDurableAttachmentBlock(attachments, opts = {}) {
  const entries = (attachments || []).filter((item) => item && (item.name || item.filename));
  if (entries.length === 0) return '';

  const encoder = new TextEncoder();
  const contentBytes = Math.max(0, Number(opts.contentBytes) || 0);
  let messageBudget = MESSAGE_CONTENT_MAX_BYTES - contentBytes - EMBED_SAFETY_RESERVE_BYTES;
  let embedBudget = EMBED_TOTAL_BUDGET_BYTES;

  const lines = ['', '<attachments ic="1">'];
  /** @param {string} line */
  const push = (line) => {
    lines.push(line);
    messageBudget -= encoder.encode(line).length + 1;
  };

  entries.forEach((item, index) => {
    push(`Attachment ${index + 1}:`);
    push(`filename: ${item.name || item.filename}`);
    push(`mime_type: ${item.mime_type || 'application/octet-stream'}`);
    if (item.size) push(`size: ${item.size}`);

    if (!isTextEmbeddable(item) || !item.data_base64) return;
    const decoded = decodeBase64Utf8(item.data_base64);
    if (decoded == null) return;
    const clean = sanitizeEmbeddedText(decoded).trim();
    if (!clean) return;

    const allowance = Math.min(embedBudget, messageBudget - 256);
    if (allowance <= 0) {
      push('extraction_status: content_omitted_message_budget');
      push('note: message too large to embed this document; ask for it in smaller parts.');
      return;
    }
    const { text, truncated } = truncateUtf8(clean, allowance);
    embedBudget -= encoder.encode(text).length;
    push(`extraction_status: ${truncated ? 'extracted_text_truncated' : 'extracted_text'}`);
    if (truncated) {
      push(`note: showing the first ${text.length} of ${clean.length} characters.`);
    }
    push(`extracted_text_chars: ${text.length}`);
    push('extracted_text:');
    push('---');
    push(text);
    push('---');
  });
  lines.push('</attachments>');
  return lines.join('\n');
}

/**
 * Capture length-prefixed embedded content out of the manifest body so chip
 * parsing only ever sees metadata lines. The char count is authoritative:
 * everything from `extracted_text_chars:` through the closing fence is
 * consumed wholesale, so document text containing `Attachment N:`,
 * `filename:`, fences, or even a fake header can never corrupt parsing —
 * the first header is always the real one and its count consumes the rest.
 *
 * Each removed segment is replaced with an `embedded_text_ref: <i>` marker
 * line; the captured texts feed reload-time attachment previews (the only
 * place document content survives, since the backend stores no attachment
 * bytes the UI can read back). The visible message content is unaffected —
 * it is sliced off before the block — so pending-row dedup keys stay stable.
 *
 * @param {string} blockBody
 * @returns {{ body: string, texts: string[] }}
 */
function captureEmbeddedExtractedText(blockBody) {
  const headerPattern = /extracted_text_chars:\s*(\d+)\nextracted_text:\n---\n/g;
  const texts = [];
  let body = '';
  let index = 0;
  for (;;) {
    headerPattern.lastIndex = index;
    const match = headerPattern.exec(blockBody);
    if (!match) {
      body += blockBody.slice(index);
      return { body, texts };
    }
    body += blockBody.slice(index, match.index);
    const contentStart = match.index + match[0].length;
    const contentEnd = contentStart + Number(match[1]);
    texts.push(blockBody.slice(contentStart, contentEnd));
    body += `embedded_text_ref: ${texts.length - 1}\n`;
    index = blockBody.startsWith('\n---', contentEnd) ? contentEnd + 4 : contentEnd;
  }
}

/**
 * @param {string | null | undefined} rawContent
 * @returns {ParsedContent}
 */
// Only blocks carrying the sentinel attribute are OURS. A bare
// `<attachments>` tail in ordinary text (a user pasting protocol docs, or
// the model — which now SEES this format in its context — mimicking it in a
// reply) must never be mistaken for a manifest: that would silently truncate
// the visible message and render phantom attachment chips. Legacy blocks
// (pre-sentinel sends already persisted in threads) parse only when the
// caller explicitly allows it, i.e. for user-authored records.
const SENTINEL_BLOCK_PATTERN = /\n{0,2}<attachments ic="1">\n([\s\S]*?)\n<\/attachments>\s*$/;
const LEGACY_BLOCK_PATTERN = /\n{0,2}<attachments>\n([\s\S]*?)\n<\/attachments>\s*$/;

/**
 * @param {string | null | undefined} rawContent
 * @param {{ allowLegacy?: boolean }} [opts]
 * @returns {ParsedContent}
 */
function parseDurableAttachmentBlock(rawContent, opts = {}) {
  const raw = String(rawContent || '');
  const blockMatch =
    raw.match(SENTINEL_BLOCK_PATTERN) ||
    (opts.allowLegacy ? raw.match(LEGACY_BLOCK_PATTERN) : null);
  if (!blockMatch) return { content: raw, attachments: [] };

  /** @type {AttachmentChip[]} */
  const attachments = [];
  const { body, texts } = captureEmbeddedExtractedText(blockMatch[1]);
  const chunks = body
    .split(/\nAttachment\s+\d+:\n/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    /** @type {AttachmentChip} */
    const attachment = {};
    for (const line of chunk.split('\n')) {
      const splitAt = line.indexOf(':');
      if (splitAt === -1) continue;
      const key = line.slice(0, splitAt).trim();
      const value = line.slice(splitAt + 1).trim();
      if (key === 'filename') attachment.filename = value;
      if (key === 'mime_type') attachment.mime_type = value;
      if (key === 'extraction_status') attachment.extraction_status = value;
      if (key === 'embedded_text_ref') {
        const ref = Number(value);
        if (Number.isInteger(ref) && texts[ref] !== undefined) {
          attachment.embedded_text = texts[ref];
        }
      }
      if (key === 'data_base64') {
        attachment.data_base64 = value;
        attachment.size_label = sizeLabelForBase64(value);
      }
      if (key === 'size' && value && !attachment.size_label) {
        attachment.size_label = sizeLabelForBytes(Number(value));
      }
    }
    if (attachment.filename || attachment.mime_type || attachment.data_base64) {
      attachments.push(attachment);
    }
  }

  return {
    content: raw.slice(0, blockMatch.index).trimEnd(),
    attachments
  };
}

/**
 * @param {string | null | undefined} value
 */
function sizeLabelForBase64(value) {
  const clean = String(value || '').replace(/\s+/g, '');
  if (!clean) return '';
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const bytes = Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
  return sizeLabelForBytes(bytes);
}

/**
 * @param {number} bytes
 */
function sizeLabelForBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {PendingMessage} pending
 */
function pendingMessageForRender(pending) {
  return {
    ...pending,
    role: pending.role || 'user',
    isOptimistic: pending.isOptimistic !== false
  };
}

/**
 * @param {TimelineRecord} record
 */
function isFinalAssistantRecord(record) {
  return (
    (record.kind === 'assistant' || record.kind === 'assistant_message') &&
    record.status === 'finalized'
  );
}

/**
 * @param {TimelineRecord} record
 */
function roleForRecord(record) {
  switch (record.kind) {
    case 'user':
    case 'user_message':
      return 'user';
    case 'assistant':
    case 'assistant_message':
    case 'tool_result':
      return 'assistant';
    case 'system':
      return 'system';
    default:
      return record.actor_id ? 'user' : 'assistant';
  }
}

/**
 * @param {TimelineRecord} record
 */
function timestampForRecord(record) {
  // ThreadMessageRecord has no top-level timestamp; surfaces use
  // the sequence ordering for now. Browsers render the wall-clock
  // when an event arrives (FinalReplyView.generated_at).
  return record.received_at || record.created_at || null;
}

/**
 * @param {TimelineRecord} record
 * @returns {ToolCard | null}
 */
function toolCardFromPreviewRecord(record) {
  if (!record.content) return null;
  /** @type {CapabilityPreview | null} */
  let envelope;
  try {
    envelope = JSON.parse(record.content);
  } catch (err) {
    console.warn('Failed to parse capability_display_preview envelope', err);
    return null;
  }
  if (!envelope || !envelope.invocation_id) return null;
  return toolCardFromPreview(envelope);
}

// Map a `CapabilityDisplayPreviewEnvelope` (timeline) or
// `CapabilityDisplayPreviewView` (SSE) into the field set
// `ToolActivityCard` destructures.
/**
 * @param {CapabilityPreview} preview
 * @returns {ToolCard}
 */
export function toolCardFromPreview(preview) {
  const failed = preview.status === 'failed' || preview.status === 'killed';
  const invocationId = preview.invocation_id || '';
  return {
    invocationId,
    callId: invocationId,
    toolName: preview.title || preview.capability_id || 'tool',
    toolStatus: toolStatusFromActivityStatus(preview.status),
    toolDetail: preview.subtitle || null,
    toolParameters: preview.input_summary || null,
    // On failure the output fields carry the error text — surface it
    // only through `toolError` so the card renders it once in red,
    // not twice (once as a teal result preview and once as the error).
    toolResultPreview: failed ? null : preview.output_preview || preview.output_summary || null,
    toolError: failed
      ? preview.output_summary || preview.output_preview || preview.result_ref || null
      : null,
    toolDurationMs: null,
    updatedAt: preview.updated_at || null,
    resultRef: preview.result_ref || null,
    truncated: Boolean(preview.truncated),
    outputBytes: preview.output_bytes ?? null,
    outputKind: preview.output_kind || null,
    turnRunId: preview.turn_run_id || null
  };
}

// Map a `CapabilityActivityView` (SSE lifecycle frame) into the same
// card shape. Activity frames carry only metadata — no title, no
// parameters, no output — so the resulting card is intentionally
// sparse and is meant to be enriched by the next preview frame.
/**
 * @param {CapabilityActivity} activity
 */
export function toolCardFromActivity(activity) {
  return {
    invocationId: activity.invocation_id || '',
    callId: activity.invocation_id || '',
    toolName: activity.capability_id || 'tool',
    toolStatus: toolStatusFromActivityStatus(activity.status),
    toolDetail: null,
    toolParameters: null,
    toolResultPreview: null,
    toolError: activity.error_kind || null,
    toolDurationMs: null,
    updatedAt: activity.updated_at || null,
    resultRef: null,
    truncated: false,
    outputBytes: activity.output_bytes ?? null,
    outputKind: null,
    turnRunId: activity.turn_run_id || null
  };
}

/**
 * @param {string | null | undefined} status
 */
export function isTerminalToolStatus(status) {
  return status === 'success' || status === 'error';
}

/**
 * @param {string | null | undefined} status
 */
function toolStatusFromActivityStatus(status) {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
    case 'killed':
      return 'error';
    case 'started':
    case 'running':
    default:
      return 'running';
  }
}
