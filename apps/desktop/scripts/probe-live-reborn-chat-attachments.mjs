#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const artifactDir = path.join(repoRoot, 'output/live-work-product-probe');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactPath = path.join(artifactDir, `reborn-live-chat-attachment-probe-${timestamp}.json`);
const defaultTokenPath = path.join(
  os.homedir(),
  'Library/Application Support/com.openclaw.ironclaw-desktop/tokens/local-gateway-token.token'
);

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|authorization|data_base64/i.test(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = sanitize(child);
    }
  }
  return result;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return { text };
  }
}

function summarizeMessages(body) {
  const rawMessages = Array.isArray(body?.messages)
    ? body.messages
    : Array.isArray(body?.timeline)
      ? body.timeline
      : Array.isArray(body?.events)
        ? body.events
        : [];
  return rawMessages.map((message) => sanitize(message)).slice(0, 20);
}

function scenarioAttachment({ name, mime_type, content }) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return {
    name,
    mime_type,
    data_base64: bytes.toString('base64'),
    byte_length: bytes.byteLength,
    base64_sha256: createHash('sha256').update(bytes.toString('base64')).digest('hex')
  };
}

async function main() {
  const origin = process.env.IRONCLAW_LIVE_PROBE_ORIGIN || 'http://127.0.0.1:3000';
  const tokenPath = process.env.IRONCLAW_LIVE_PROBE_TOKEN_FILE || defaultTokenPath;
  const token = (await readFile(tokenPath, 'utf8')).trim();
  if (!token) throw new Error(`empty token file: ${tokenPath}`);
  await mkdir(artifactDir, { recursive: true });

  const evidence = {
    generated_at: new Date().toISOString(),
    origin,
    token_path: tokenPath,
    bearer_token: '[REDACTED]',
    probes: []
  };

  async function request(label, method, pathname, body = undefined) {
    const response = await fetch(`${origin}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const responseBody = await parseJsonResponse(response);
    const record = {
      label,
      method,
      path: pathname,
      request: sanitize(body),
      status: response.status,
      ok: response.ok,
      response: sanitize(responseBody)
    };
    evidence.probes.push(record);
    return { response, body: responseBody, record };
  }

  const health = await request('health', 'GET', '/api/health');
  if (!health.response.ok) throw new Error(`health failed: ${health.response.status}`);

  const requestedThreadId = randomUUID();
  const threadClientActionId = `codex-live-thread-${timestamp}`;
  const thread = await request('create thread', 'POST', '/api/webchat/v2/threads', {
    client_action_id: threadClientActionId,
    requested_thread_id: requestedThreadId
  });
  if (!thread.response.ok) throw new Error(`create thread failed: ${thread.response.status}`);
  const threadId = thread.body?.thread_id || thread.body?.thread?.thread_id || requestedThreadId;
  evidence.thread_id = threadId;

  const scenarios = [
    scenarioAttachment({
      name: 'codex-scenario-1-ledger.csv',
      mime_type: 'text/csv',
      content: 'item,value\nalpha,12\nbeta,34\n'
    }),
    scenarioAttachment({
      name: 'codex-scenario-2-brief.md',
      mime_type: 'text/markdown',
      content: '# Launch brief\n\n- Owner: Work Product\n- Risk: attachment persistence\n'
    }),
    scenarioAttachment({
      name: 'codex-scenario-3-payload.json',
      mime_type: 'application/json',
      content: JSON.stringify({ customer: 'Northwind', amount: 4200, approved: false }, null, 2)
    }),
    scenarioAttachment({
      name: 'codex-scenario-4-report.html',
      mime_type: 'text/html',
      content: '<!doctype html><h1>Quarterly report</h1><p>Retention: 94%</p>'
    }),
    scenarioAttachment({
      name: 'codex-scenario-5-contract.pdf',
      mime_type: 'application/pdf',
      content: Buffer.from('%PDF-1.4\n% dummy contract payload for serialization probe\n%%EOF\n')
    })
  ];
  const attachments = scenarios.map(({ name, mime_type, data_base64 }) => ({
    name,
    mime_type,
    data_base64
  }));
  const prompt =
    'Codex live route probe: confirm these five varied dummy attachments reached Reborn and survive thread reload. Do not send external messages or write to connectors.';
  const message = await request(
    'send message with varied attachments',
    'POST',
    `/api/webchat/v2/threads/${encodeURIComponent(threadId)}/messages`,
    {
      client_action_id: `codex-live-message-${timestamp}`,
      content: prompt,
      attachments
    }
  );
  evidence.sent_prompt = prompt;
  evidence.sent_attachments = scenarios.map(({ name, mime_type, byte_length, base64_sha256 }) => ({
    name,
    mime_type,
    byte_length,
    base64_sha256
  }));

  // Give the gateway a short window to persist timeline/messages. This is not
  // waiting for model quality; it is checking that the user's submitted payload
  // is visible again through Reborn route reads.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const messages = await request(
    'fetch messages after send',
    'GET',
    `/api/webchat/v2/threads/${encodeURIComponent(threadId)}/messages?limit=50`
  );
  const timeline = await request(
    'fetch timeline after send',
    'GET',
    `/api/webchat/v2/threads/${encodeURIComponent(threadId)}/timeline?limit=50`
  );

  const reloadedText = JSON.stringify(sanitize([messages.body, timeline.body]));
  const attachmentNamesObserved = scenarios
    .map((scenario) => scenario.name)
    .filter((name) => reloadedText.includes(name));
  evidence.summary = {
    thread_id: threadId,
    send_status: message.record.status,
    message_ok: message.record.ok,
    messages_status: messages.record.status,
    timeline_status: timeline.record.status,
    messages: summarizeMessages(messages.body),
    timeline: summarizeMessages(timeline.body),
    attachment_names_expected: scenarios.map((scenario) => scenario.name),
    attachment_names_observed: attachmentNamesObserved,
    all_attachment_names_observed: attachmentNamesObserved.length === scenarios.length,
    prompt_observed: reloadedText.includes(prompt)
  };

  await writeFile(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`live chat attachment probe artifact: ${artifactPath}`);
  console.log(JSON.stringify(evidence.summary, null, 2));

  if (!message.record.ok) {
    throw new Error(`send message failed: ${message.record.status}`);
  }
  if (!evidence.summary.prompt_observed) {
    throw new Error('sent prompt was not observed in messages or timeline reads');
  }
  if (!evidence.summary.all_attachment_names_observed) {
    throw new Error(
      `not all attachment names survived reload: ${JSON.stringify(evidence.summary.attachment_names_observed)}`
    );
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
