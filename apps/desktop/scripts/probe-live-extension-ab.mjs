#!/usr/bin/env node
// A/B probe: does the Reborn agent's file tooling judge attachments by
// FILENAME EXTENSION rather than mime/content?
//
// Repro: the user attached a real PDF; the desktop app extracted its text
// client-side and shipped text/plain — but the agent replied "I don't have
// the ability to directly read PDF attachments ... my read_file tool expects
// plain text files (.txt, .md, .json, .csv)". Theory: the payload is fine,
// the `.pdf` NAME alone makes the backend refuse it.
//
// Sends the SAME extracted text to the live sidecar twice — once named
// `*.pdf`, once `*.pdf.txt` — and compares whether the model can quote it.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const artifactDir = path.join(repoRoot, 'output/live-extension-ab-probe');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactPath = path.join(artifactDir, `extension-ab-${timestamp}.json`);
const tokenPath = path.join(
  os.homedir(),
  'Library/Application Support/com.openclaw.ironclaw-desktop/tokens/local-gateway-token.token'
);

const MARKER = 'EXT_AB_QUOTE_9274';
const TEXT_PATH = process.env.AB_TEXT_PATH || '/tmp/bullion-extracted.txt';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const kindOf = (m) => String(m?.kind || m?.role || '').toLowerCase();
const contentOf = (m) => String(m?.content || m?.text || '');

async function runScenario({ origin, token, label, filename, text }) {
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
    client_action_id: `ext-ab-thread-${label}-${timestamp}`,
    requested_thread_id: requestedThreadId
  });
  const threadId = thread.body?.thread_id || thread.body?.thread?.thread_id || requestedThreadId;

  const prompt =
    `Diagnostic: read the attached file and reply with "${MARKER}: " followed by the company ` +
    'name on its first line, verbatim. If you cannot read the attachment content for any ' +
    'reason, reply with "CANNOT_READ: " followed by a one-sentence reason. Use no connectors.';
  const send = await api('POST', `/api/webchat/v2/threads/${encodeURIComponent(threadId)}/messages`, {
    client_action_id: `ext-ab-msg-${label}-${timestamp}`,
    content: prompt,
    attachments: [
      {
        name: filename,
        mime_type: 'text/plain',
        data_base64: Buffer.from(text, 'utf8').toString('base64')
      }
    ]
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
  return {
    label,
    filename,
    thread_id: threadId,
    send_status: send.res.status,
    reply_observed: reply != null,
    quoted_marker: replyText.includes(MARKER),
    quoted_company: /bullion\s+digital/i.test(replyText),
    refused: /CANNOT_READ|cannot (directly )?read|binary|don't have the ability/i.test(replyText),
    reply_preview: replyText.slice(0, 400)
  };
}

async function main() {
  const origin = process.env.IRONCLAW_LIVE_PROBE_ORIGIN || 'http://127.0.0.1:3000';
  const token = (await readFile(tokenPath, 'utf8')).trim();
  const text = await readFile(TEXT_PATH, 'utf8');
  await mkdir(artifactDir, { recursive: true });

  const scenarios = [
    { label: 'A-pdf-name', filename: 'Bullion-Digital-Legal-Onepager-v6.pdf' },
    { label: 'B-txt-name', filename: 'Bullion-Digital-Legal-Onepager-v6.pdf.txt' }
  ];
  const results = [];
  for (const s of scenarios) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runScenario({ origin, token, text, ...s }));
  }

  const evidence = { generated_at: new Date().toISOString(), origin, marker: MARKER, results };
  await writeFile(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`artifact: ${artifactPath}`);
  for (const r of results) {
    console.log(
      `- ${r.label} (${r.filename}): reply=${r.reply_observed} marker=${r.quoted_marker} ` +
        `company=${r.quoted_company} refused=${r.refused}`
    );
    console.log(`    ${r.reply_preview.replace(/\n/g, ' ').slice(0, 220)}`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
