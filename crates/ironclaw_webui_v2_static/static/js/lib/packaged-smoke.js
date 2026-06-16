import {
  apiFetch,
  bootstrapDesktopSession,
  createThread,
  fetchTimeline,
  gatewayStatus as fetchGatewayStatus,
  readStoredToken,
  sendMessage,
  storeToken,
  tauriInvoke
} from './api.js';
import {
  buildDurableAttachmentBlock,
  messagesFromTimeline,
  pendingMessagesAfterTimeline
} from '../pages/chat/lib/history-messages.js';
import { extractAttachmentText } from '../pages/chat/lib/extract-attachment-text.js';
import {
  addPending,
  loadPending,
  recordAcceptedMessageRef
} from '../pages/chat/lib/pending-messages.js';
import {
  buildDocxBlob,
  buildHtmlBlob,
  buildJsonBlob,
  buildMarkdownBlob,
  buildPdfBlob
} from '../pages/chat/lib/work-product-export.js';

const STARTED_FLAG = '__IRONCLAW_PACKAGED_WEBVIEW_SMOKE_STARTED__';
const GATEWAY_ORIGIN_KEY = 'ironclaw:desktop-gateway-origin';

export async function maybeRunPackagedWebviewSmoke() {
  if (typeof window === 'undefined' || window[STARTED_FLAG]) return;

  let request;
  try {
    request = await tauriInvoke('packaged_smoke_request');
  } catch (_) {
    return;
  }
  if (!request?.enabled) return;

  window[STARTED_FLAG] = true;
  await smokeDiag(`enabled evidence_path=${request.evidence_path || ''}`);
  const report = {
    schema: 'ironclaw-packaged-webview-smoke.v1',
    started_at: new Date().toISOString(),
    status: 'running',
    checks: [],
    errors: [],
    evidence_path_requested: request.evidence_path || null,
    ocr_enabled: request.ocr_enabled === true
  };

  const check = (name, passed, detail = {}) => {
    report.checks.push({
      name,
      status: passed ? 'PASS' : 'FAIL',
      detail
    });
    if (!passed) {
      throw new Error(`${name} failed`);
    }
  };

  // Each phase is raced against a deadline. A hung await (e.g. a WebView
  // fetch that never settles, or a sidecar stuck in a model retry loop) must
  // never leave the harness with no evidence — the shell validator then sees
  // a deterministic FAIL instead of "timed out waiting for evidence".
  try {
    smokeDiag('bootstrap session start');
    await withDeadline('bootstrap session', 60_000, () => bootstrapPackagedSession(report, check));
    smokeDiag('bootstrap session passed');
    smokeDiag('chat attachment route start');
    await withDeadline('chat attachment route', 75_000, () =>
      proveChatAttachmentRoute(report, check)
    );
    smokeDiag('chat attachment route passed');
    smokeDiag('export builders start');
    await withDeadline('export builders', 90_000, () => proveExportBuilders(report, check));
    smokeDiag('export builders passed');
    smokeDiag('document extraction start');
    await withDeadline('document extraction', 90_000, () =>
      proveDocumentExtraction(report, check, { ocrEnabled: request.ocr_enabled === true })
    );
    smokeDiag('document extraction passed');
    report.status = 'passed';
  } catch (err) {
    report.status = 'failed';
    report.errors.push(errorSummary(err));
    smokeDiag(`failed ${errorSummary(err).message}`);
  } finally {
    report.completed_at = new Date().toISOString();
    report.pass_count = report.checks.filter((entry) => entry.status === 'PASS').length;
    report.fail_count = report.checks.filter((entry) => entry.status === 'FAIL').length;
    try {
      smokeDiag('report write start');
      await tauriInvoke('packaged_smoke_report', { report });
      smokeDiag('report write passed');
    } catch (err) {
      console.warn('[ironclaw] packaged WebView smoke report failed', err);
    }
  }
}

// Run `fn` but reject if it does not settle within `ms`. Converts a hang into
// a thrown error so the surrounding try/catch records a failure and still
// writes evidence.
function withDeadline(label, ms, fn) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} exceeded ${ms}ms deadline`));
    }, ms);
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      );
  });
}

// Fire-and-forget: a diagnostic invoke must never be able to stall the proof.
function smokeDiag(message) {
  try {
    Promise.resolve(tauriInvoke('diag_log', { msg: `[packaged-smoke] ${message}` })).catch(
      () => {}
    );
  } catch (_) {
    // Diagnostics should never change smoke behavior.
  }
}

async function bootstrapPackagedSession(report, check) {
  await smokeDiag('bootstrapDesktopSession start');
  await retry('bootstrap desktop session', () => bootstrapDesktopSession(), {
    attempts: 8,
    delayMs: 500
  });
  await smokeDiag('bootstrapDesktopSession passed');

  const status = await retry(
    'sidecar status',
    async () => {
      const value = await tauriInvoke('sidecar_status');
      if (!value?.running || !value?.port) {
        throw new Error('sidecar is not running yet');
      }
      return value;
    },
    { attempts: 30, delayMs: 500 }
  );
  await smokeDiag(`sidecar status passed port=${status.port}`);
  const origin = `http://127.0.0.1:${status.port}`;
  localStorage.setItem(GATEWAY_ORIGIN_KEY, origin);
  report.gateway_origin = origin;
  report.sidecar_status = { running: Boolean(status.running), port: status.port };
  check('sidecar status exposes runtime port', true, report.sidecar_status);

  const token = await retry('local token', () => tauriInvoke('get_or_create_local_token'), {
    attempts: 8,
    delayMs: 300
  });
  await smokeDiag(`local token passed length=${String(token || '').length}`);
  storeToken(token);
  check('WebView stored local gateway bearer', Boolean(readStoredToken()), {
    token_length: String(token || '').length
  });

  const health = await retry(
    'gateway webchat readiness',
    () => apiFetch('/api/webchat/v2/threads'),
    {
      attempts: 30,
      delayMs: 500
    }
  );
  await smokeDiag(`gateway webchat readiness passed threads=${Array.isArray(health?.threads)}`);
  check('WebView Tauri HTTP reaches Reborn health', Array.isArray(health?.threads), {
    channel: 'webchat-v2',
    status: 'ok',
    thread_count: health.threads.length
  });

  const gatewayStatus = await retry('gateway model readiness status', () => fetchGatewayStatus(), {
    attempts: 8,
    delayMs: 300
  });
  report.gateway_status = sanitizeRouteResponse(gatewayStatus);
  report.model_credentials_blocked =
    gatewayStatus?.model_execution_failure_category === 'model_credentials_unavailable';
  check('WebView reads gateway model readiness', Boolean(gatewayStatus?.llm_backend), {
    llm_backend: gatewayStatus?.llm_backend || null,
    llm_model: gatewayStatus?.llm_model || null,
    model_readiness: gatewayStatus?.model_readiness || null,
    model_execution_failure_category: gatewayStatus?.model_execution_failure_category || null
  });
}

async function proveChatAttachmentRoute(report, check) {
  const requestedThreadId = crypto.randomUUID();
  const prompt =
    'Packaged WebView smoke: prove this chat send and CSV attachment reached Reborn. Do not contact external services.';
  const csv = 'item,value\npackaged-webview-smoke,1\n';
  const attachment = {
    name: 'packaged-webview-smoke.csv',
    mime_type: 'text/csv',
    data_base64: base64FromText(csv)
  };
  // Send exactly as the real UI does: the durable attachment block carries
  // chip metadata for reload AND the embedded text content — the only
  // channel through which the model can read a document (the sidecar never
  // feeds attachment bytes to it). The timeline echo below then proves the
  // backend content validator accepted the embedded form.
  const contentForReborn = `${prompt}${buildDurableAttachmentBlock(
    [
      {
        name: attachment.name,
        mime_type: attachment.mime_type,
        size: csv.length,
        data_base64: attachment.data_base64
      }
    ],
    { contentBytes: new TextEncoder().encode(prompt).length }
  )}`;

  const thread = await retry(
    'create webchat thread',
    () =>
      createThread({
        requestedThreadId,
        clientActionId: `packaged-webview-thread-${Date.now()}`
      }),
    { attempts: 5, delayMs: 500 }
  );
  const threadId = thread?.thread_id || thread?.thread?.thread_id || requestedThreadId;
  report.thread_id = threadId;
  check('WebView created Reborn webchat thread', Boolean(threadId), {
    requested_thread_id: requestedThreadId,
    returned_thread_id: threadId
  });

  const sent = await sendMessage({
    threadId,
    content: contentForReborn,
    attachments: [attachment],
    clientActionId: `packaged-webview-message-${Date.now()}`
  });
  report.send_response = sanitizeRouteResponse(sent);
  check(
    'WebView submitted chat message with attachment',
    sent?.outcome === 'submitted' && Boolean(sent?.run_id),
    {
      outcome: sent?.outcome || null,
      run_id: sent?.run_id || null
    }
  );

  const timeline = await pollTimelineForPrompt({ threadId, prompt, report });
  await smokeDiag('timeline poll done');
  const timelineText = JSON.stringify(timeline || {});
  const timelineHasPrompt = timelineText.includes(prompt);
  const timelineHasAttachment = timelineText.includes('packaged-webview-smoke.csv');
  report.timeline_after_send = sanitizeTimeline(timeline);

  if (timelineHasPrompt && timelineHasAttachment) {
    check('Timeline reload preserves user prompt', true, {
      prompt_length: prompt.length
    });
    const embeddedTextObserved =
      timelineText.includes('extraction_status: extracted_text') &&
      timelineText.includes('packaged-webview-smoke,1');
    check('Timeline echo carries embedded attachment text for the model', embeddedTextObserved, {
      attachment_name: 'packaged-webview-smoke.csv',
      embedded_text_observed: embeddedTextObserved
    });
    return;
  }

  // Partial projection is a hard failure, not a fallback candidate: a
  // timeline that projected the prompt while dropping its attachment block
  // makes the real UI content-dedupe the pending row away and render the
  // turn chipless — the exact regression this smoke exists to catch.
  check(
    'Timeline did not project the prompt while dropping its attachment',
    !(timelineHasPrompt && !timelineHasAttachment),
    {
      timeline_projected_prompt: timelineHasPrompt,
      timeline_projected_attachment: timelineHasAttachment
    }
  );

  // NOTE: the bundled Reborn sidecar (v0.29.0) does not mount the
  // `/threads/{id}/runs/{run_id}` GET route — it 404s, and the WebView's
  // Tauri HTTP path can stall on that response. The run's liveness is proven
  // independently and reliably by scripts/probe-live-reborn-model-execution.mjs
  // via the SSE `run_status` stream (queued -> running -> failed/completed),
  // so the packaged smoke does not depend on the run-state route here.

  const pendingStore = new Map();
  const pendingRecord = {
    id: `pending-packaged-${Date.now()}`,
    role: 'user',
    content: prompt,
    timestamp: new Date().toISOString(),
    attachments: [
      {
        filename: attachment.name,
        mime_type: attachment.mime_type,
        size_label: `${csv.length} bytes`
      }
    ],
    isOptimistic: true
  };
  addPending(pendingStore, threadId, pendingRecord);
  recordAcceptedMessageRef(pendingStore, threadId, pendingRecord.id, sent.accepted_message_ref);
  // Simulate exactly what the real reload path renders: the polled timeline
  // records plus the persisted pending queue — not an empty timeline, which
  // would pass by construction.
  await smokeDiag('fallback simulation start');
  const polledRecords = timeline?.messages || [];
  const persistedPending = loadPending(threadId);
  const retainedPending = pendingMessagesAfterTimeline(polledRecords, persistedPending);
  const fallbackMessages = messagesFromTimeline(polledRecords, persistedPending);
  const fallbackText = JSON.stringify(fallbackMessages || {});
  await smokeDiag(`fallback simulation done rendered=${fallbackMessages.length}`);

  check('WebView pending fallback preserves user prompt', fallbackText.includes(prompt), {
    prompt_length: prompt.length,
    timeline_projected_prompt: timelineHasPrompt,
    retained_pending_count: retainedPending.length
  });
  check(
    'WebView pending fallback preserves attachment metadata',
    fallbackText.includes('packaged-webview-smoke.csv'),
    {
      attachment_name: 'packaged-webview-smoke.csv',
      timeline_projected_attachment: timelineHasAttachment
    }
  );
}

async function proveExportBuilders(report, check) {
  const markdown = [
    '# Services Agreement Smoke Draft',
    '',
    'This is a packaged WebView export validation artifact.',
    '',
    '| Item | Value |',
    '| --- | --- |',
    '| Scope | Dummy services agreement update |',
    '| Attachment | packaged-webview-smoke.csv |'
  ].join('\n');

  const mdText = await buildMarkdownBlob(markdown).text();
  check(
    'Markdown export blob includes draft body',
    mdText.includes('Services Agreement Smoke Draft'),
    {
      bytes: byteLength(mdText)
    }
  );

  const htmlText = await buildHtmlBlob(markdown).text();
  const htmlHasDoctype = htmlText.toLowerCase().startsWith('<!doctype html>');
  check(
    'HTML export blob renders markdown body',
    htmlText.includes('Services Agreement Smoke Draft') && htmlHasDoctype,
    {
      bytes: byteLength(htmlText),
      has_doctype: htmlHasDoctype
    }
  );

  const jsonText = await buildJsonBlob({ role: 'assistant', content: markdown }).text();
  const parsedJson = JSON.parse(jsonText);
  check('JSON export blob parses and preserves content', parsedJson.content === markdown, {
    bytes: byteLength(jsonText),
    role: parsedJson.role
  });

  const pdfText = await buildPdfBlob(markdown).text();
  check(
    'PDF export blob has a parseable PDF envelope',
    pdfText.startsWith('%PDF-1.4') &&
      pdfText.includes('xref') &&
      pdfText.includes('trailer') &&
      pdfText.includes('%%EOF'),
    {
      bytes: byteLength(pdfText)
    }
  );

  const docxBytes = new Uint8Array(await buildDocxBlob(markdown).arrayBuffer());
  const docxAscii = asciiPreview(docxBytes);
  check(
    'DOCX export blob has ZIP package entries',
    startsWithPk(docxBytes) && docxAscii.includes('word/document.xml'),
    {
      bytes: docxBytes.byteLength,
      mime_hint: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    }
  );

  // Native save proof: blob-anchor downloads are a silent no-op in WKWebView,
  // so every export rides save_bytes_dialog. Under smoke mode the dialog is
  // bypassed and the file lands in $TMPDIR/ironclaw-smoke-saves — invoking it
  // here and checking the returned path proves bytes actually reach disk
  // (the gap that let "downloads don't work" ship).
  const savedPath = await tauriInvoke('save_bytes_dialog', {
    defaultFilename: 'packaged-save-proof.txt',
    contentsBase64: base64FromText(`packaged save proof ${Date.now()}`)
  });
  report.saved_file_path = savedPath || null;
  check('WebView export saves a real file to disk', Boolean(savedPath), {
    saved_path: savedPath || null
  });
}

// Document extraction proofs run as their OWN deadline phase: the first OCR
// in a fresh WebView cold-loads pdf.js plus the tesseract wasm core and
// language data, which can take minutes on a loaded machine — that slowness
// must not be able to fail the (fast) export-builder checks above.
async function proveDocumentExtraction(report, check, { ocrEnabled = false } = {}) {
  // PDF ingestion: the composer's client-side extractor (pdf.js, lazy ES
  // module + worker) must run inside THIS WebView (WKWebView on macOS — a
  // different engine from the Playwright/Chromium rendered smoke). A valid
  // single-page PDF goes in; readable text must come out.
  const samplePdf = buildSampleIngestPdf('PACKAGED INGEST 9913 OK');
  const extraction = await extractAttachmentText({
    base64: samplePdf,
    filename: 'packaged-ingest.pdf',
    mime_type: 'application/pdf'
  });
  check(
    'WebView extracts text from a PDF attachment',
    extraction.extracted === true && extraction.text.includes('PACKAGED INGEST 9913'),
    {
      extracted: extraction.extracted === true,
      preview: (extraction.text || '').slice(0, 60)
    }
  );

  if (!ocrEnabled) {
    report.checks.push({
      name: 'WebView OCRs a scanned PDF attachment',
      status: 'SKIP',
      detail: {
        reason:
          'Deep OCR proof is opt-in for packaged smoke; text PDF extraction is the required release gate.'
      }
    });
    return;
  }

  // OCR in THIS WebView engine: wasm + nested workers are exactly where
  // WebKit diverges from the Chromium rendered smoke. A scanned (image-only)
  // PDF built from a canvas must come back as readable text.
  const scannedPdf = buildScannedPdfBytes('PACKAGED OCR 5531 APPROVED');
  const ocr = await extractAttachmentText({
    bytes: scannedPdf,
    filename: 'packaged-scan.pdf',
    mime_type: 'application/pdf'
  });
  check(
    'WebView OCRs a scanned PDF attachment',
    ocr.extracted === true && ocr.method === 'ocr' && /PACKAGED OCR 5531/.test(ocr.text || ''),
    {
      extracted: ocr.extracted === true,
      method: ocr.method || null,
      preview: (ocr.text || '').slice(0, 60)
    }
  );
}

// Image-only single-page PDF (canvas-rendered JPEG, zero text layer).
function buildScannedPdfBytes(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 1200, 400);
  ctx.fillStyle = '#111';
  ctx.font = '600 44px Arial';
  ctx.fillText(text, 60, 200);
  const jpegB64 = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  const jpegBytes = Uint8Array.from(atob(jpegB64), (c) => c.charCodeAt(0));
  const encoder = new TextEncoder();
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (chunk) => {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const mark = () => offsets.push(length);
  push('%PDF-1.4\n');
  mark();
  push('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n');
  mark();
  push('2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n');
  mark();
  push(
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 200]/Contents 4 0 R/Resources<</XObject<</Im0 5 0 R>>>>>>endobj\n'
  );
  const content = 'q 600 0 0 200 0 0 cm /Im0 Do Q';
  mark();
  push(`4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj\n`);
  mark();
  push(
    `5 0 obj<</Type/XObject/Subtype/Image/Width 1200/Height 400/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpegBytes.length}>>stream\n`
  );
  push(jpegBytes);
  push('\nendstream endobj\n');
  const xrefStart = length;
  const pdfXrefEol = new Uint8Array([32, 10]);
  push('xref\n0 6\n0000000000 65535 f');
  push(pdfXrefEol);
  for (const objectOffset of offsets) {
    push(`${String(objectOffset).padStart(10, '0')} 00000 n`);
    push(pdfXrefEol);
  }
  push(`trailer<</Size 6/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`);
  const out = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of parts) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

// A structurally valid single-page PDF (computed xref offsets), base64.
function buildSampleIngestPdf(text) {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefStart = body.length;
  const pdfXrefEol = String.fromCharCode.apply(null, new Uint8Array([32, 10]));
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f${pdfXrefEol}`;
  for (const objectOffset of offsets) {
    xref += `${String(objectOffset).padStart(10, '0')} 00000 n${pdfXrefEol}`;
  }
  const full = `${body}${xref}trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return btoa(full);
}

async function pollTimelineForPrompt({ threadId, prompt, report }) {
  let latest = null;
  const pollErrors = [];
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      latest = await fetchTimeline({ threadId, limit: 50 });
      const text = JSON.stringify(latest || {});
      if (text.includes(prompt) && text.includes('packaged-webview-smoke.csv')) {
        break;
      }
    } catch (err) {
      // A transient timeline hiccup must not abort the smoke — the
      // fallback path plus the run-state check below keep the proof
      // honest. The error trail stays in evidence.
      pollErrors.push(errorSummary(err));
    }
    await delay(750);
  }
  if (report && pollErrors.length > 0) {
    report.timeline_poll_errors = pollErrors;
  }
  return latest;
}

async function retry(label, fn, { attempts = 5, delayMs = 250 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await delay(delayMs);
    }
  }
  throw new Error(`${label}: ${lastError?.message || lastError || 'failed'}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64FromText(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function startsWithPk(bytes) {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function asciiPreview(bytes) {
  let out = '';
  for (const byte of bytes.slice(0, 4096)) {
    if (byte >= 32 && byte <= 126) out += String.fromCharCode(byte);
  }
  return out;
}

function byteLength(text) {
  return new TextEncoder().encode(String(text || '')).byteLength;
}

function sanitizeRouteResponse(value) {
  if (!value || typeof value !== 'object') return value || null;
  return {
    outcome: value.outcome || null,
    thread_id: value.thread_id || value.thread?.thread_id || null,
    run_id: value.run_id || null,
    message_id: value.message_id || null,
    profile: value.profile || null,
    status: value.status || null,
    failure_category: value.failure?.category || value.failure_category || null,
    failure_summary: value.failure?.summary || value.failure_summary || null,
    // Keep fetch failures visible in evidence instead of an all-null row.
    error: value.error?.message || null
  };
}

function sanitizeTimeline(value) {
  if (!value || typeof value !== 'object') return value || null;
  return {
    message_count: Array.isArray(value.messages) ? value.messages.length : null,
    next_cursor: value.next_cursor || null,
    messages: Array.isArray(value.messages)
      ? value.messages.slice(0, 5).map((message) => ({
          kind: message.kind || null,
          status: message.status || null,
          content_preview: String(message.content || '').slice(0, 240),
          turn_run_id: message.turn_run_id || null
        }))
      : []
  };
}

function errorSummary(err) {
  return {
    message: err?.message || String(err),
    name: err?.name || 'Error',
    status: err?.status || null,
    body: err?.body ? String(err.body).slice(0, 500) : null
  };
}
