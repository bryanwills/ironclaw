#!/usr/bin/env node
// Live end-to-end proof for the embedded-attachment fix: sends a message
// built EXACTLY like the UI now builds it (buildDurableAttachmentBlock with
// the extracted text embedded) and requires the model to quote a fact that
// exists only inside the document — not in the prompt. This is the
// non-self-confirming version of the earlier attachment probes.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDurableAttachmentBlock } from '../crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/history-messages.js';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const artifactDir = path.join(repoRoot, 'output/live-embedded-attachment-probe');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactPath = path.join(artifactDir, `embedded-attachment-${timestamp}.json`);
const tokenPath = path.join(
  os.homedir(),
  'Library/Application Support/com.openclaw.ironclaw-desktop/tokens/local-gateway-token.token'
);
const TEXT_PATH = process.env.PROBE_TEXT_PATH || '/tmp/bullion-extracted.txt';
// Parameterizable so any extracted-document scenario can be proven live:
// the EXPECT regex must match a fact that exists ONLY inside the document.
const PROBE_PROMPT = process.env.PROBE_PROMPT || '';
const PROBE_EXPECT = process.env.PROBE_EXPECT || 'bullion\\s+digital';
const PROBE_FILENAME = process.env.PROBE_FILENAME || 'Bullion-Digital-Legal-Onepager-v6.pdf';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const kindOf = (m) => String(m?.kind || m?.role || '').toLowerCase();
const contentOf = (m) => String(m?.content || m?.text || '');

async function main() {
  const origin = process.env.IRONCLAW_LIVE_PROBE_ORIGIN || 'http://127.0.0.1:3000';
  const token = (await readFile(tokenPath, 'utf8')).trim();
  const text = await readFile(TEXT_PATH, 'utf8');
  await mkdir(artifactDir, { recursive: true });

  const api = async (method, pathname, body) => {
    const res = await fetch(`${origin}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let parsed = null;
    try {
      parsed = await res.json();
    } catch (_) {
      /* empty */
    }
    return { res, body: parsed };
  };

  const requestedThreadId = randomUUID();
  const thread = await api('POST', '/api/webchat/v2/threads', {
    client_action_id: `embed-probe-thread-${timestamp}`,
    requested_thread_id: requestedThreadId
  });
  const threadId = thread.body?.thread_id || thread.body?.thread?.thread_id || requestedThreadId;

  const prompt =
    PROBE_PROMPT ||
    'Diagnostic: from the attached document, reply with one line: the company name on its ' +
      'first line, then the U.S. state of incorporation if stated. Quote only what the ' +
      'document says. If you cannot read the document content, reply CANNOT_READ and why. ' +
      'Use no connectors.';
  const attachment = {
    name: PROBE_FILENAME,
    mime_type: 'text/plain',
    data_base64: Buffer.from(text, 'utf8').toString('base64')
  };
  // Exactly the UI's send shape: prompt + durable block (with embedded
  // extracted text), plus the first-class attachment field.
  const block = buildDurableAttachmentBlock(
    [{ name: attachment.name, mime_type: attachment.mime_type, size: 173000, data_base64: attachment.data_base64 }],
    { contentBytes: Buffer.byteLength(prompt, 'utf8') }
  );
  const content = `${prompt}${block}`;

  const send = await api('POST', `/api/webchat/v2/threads/${encodeURIComponent(threadId)}/messages`, {
    client_action_id: `embed-probe-msg-${timestamp}`,
    content,
    attachments: [attachment]
  });

  let reply = null;
  for (let attempt = 0; attempt < 36 && !reply; attempt += 1) {
    await delay(2500);
    const tl = await api(
      'GET',
      `/api/webchat/v2/threads/${encodeURIComponent(threadId)}/timeline?limit=50`
    );
    const messages = Array.isArray(tl.body?.messages) ? tl.body.messages : [];
    const assistants = messages.filter((m) => kindOf(m).startsWith('assistant'));
    if (assistants.length > 0) reply = contentOf(assistants[assistants.length - 1]);
  }

  const replyText = reply || '';
  const summary = {
    send_status: send.res.status,
    send_ok: send.res.ok,
    content_bytes: Buffer.byteLength(content, 'utf8'),
    thread_id: threadId,
    reply_observed: reply != null,
    quoted_company: new RegExp(PROBE_EXPECT, 'i').test(replyText),
    refused: /CANNOT_READ/i.test(replyText),
    reply_preview: replyText.slice(0, 300)
  };
  await writeFile(
    artifactPath,
    `${JSON.stringify({ generated_at: new Date().toISOString(), origin, summary }, null, 2)}\n`
  );
  console.log(`artifact: ${artifactPath}`);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.send_ok) throw new Error(`send rejected: ${send.res.status}`);
  if (!summary.quoted_company) throw new Error('model did not quote document content');
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
