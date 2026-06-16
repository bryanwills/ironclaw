import assert from 'node:assert/strict';
import test from 'node:test';

import {
  messagesFromTimeline,
  pendingMessagesAfterTimeline,
  buildDurableAttachmentBlock,
  runReplyLandedInTimeline
} from './history-messages.js';

test('runReplyLandedInTimeline: finalized assistant reply for the run counts as complete', () => {
  const records = [
    { kind: 'user', content: 'hi', turn_run_id: 'run-1' },
    { kind: 'assistant', content: 'hello', status: 'finalized', turn_run_id: 'run-1' }
  ];
  assert.equal(runReplyLandedInTimeline(records, 'run-1'), true);
});

test('runReplyLandedInTimeline: streaming reply, mid-run tool result, other run, or no run id do not count', () => {
  const streaming = [{ kind: 'assistant', status: 'streaming', turn_run_id: 'run-1' }];
  const toolMidRun = [{ kind: 'tool_result', status: 'finalized', turn_run_id: 'run-1' }];
  const otherRun = [{ kind: 'assistant', status: 'finalized', turn_run_id: 'run-2' }];
  const userOnly = [{ kind: 'user', content: 'hi', turn_run_id: 'run-1' }];
  assert.equal(runReplyLandedInTimeline(streaming, 'run-1'), false);
  assert.equal(runReplyLandedInTimeline(toolMidRun, 'run-1'), false);
  assert.equal(runReplyLandedInTimeline(otherRun, 'run-1'), false);
  assert.equal(runReplyLandedInTimeline(userOnly, 'run-1'), false);
  assert.equal(runReplyLandedInTimeline([], 'run-1'), false);
  assert.equal(runReplyLandedInTimeline([{ kind: 'assistant', status: 'finalized' }], ''), false);
});

test('messagesFromTimeline: pending messages default to optimistic user messages', () => {
  const messages = messagesFromTimeline(
    [],
    [
      {
        id: 'pending-1',
        content: 'check my calendar',
        timestamp: '2026-06-02T10:00:00.000Z'
      }
    ]
  );

  assert.deepEqual(messages, [
    {
      id: 'pending-1',
      role: 'user',
      content: 'check my calendar',
      timestamp: '2026-06-02T10:00:00.000Z',
      isOptimistic: true
    }
  ]);
});

test('messagesFromTimeline: confirmed user records replace matching pending by timeline id', () => {
  const messages = messagesFromTimeline(
    [
      {
        message_id: 'message-1',
        kind: 'user',
        content: 'check my calendar',
        sequence: 1,
        status: 'accepted'
      }
    ],
    [
      {
        id: 'pending-1',
        role: 'user',
        content: 'check my calendar',
        timestamp: '2026-06-02T10:00:00.000Z',
        isOptimistic: true,
        timelineMessageId: 'message-1'
      }
    ]
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'msg-message-1');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'check my calendar');
});

test('messagesFromTimeline: assistant file artifacts are preserved for generated work chips', () => {
  const messages = messagesFromTimeline([
    {
      message_id: 'message-docx',
      kind: 'assistant',
      content: 'Draft complete.',
      sequence: 1,
      artifacts: [
        {
          filename: 'services-agreement.docx',
          mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          data_base64: 'UEsDBGRvY3g='
        }
      ]
    }
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].content, 'Draft complete.');
  assert.deepEqual(messages[0].generatedFiles, [
    {
      filename: 'services-agreement.docx',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data_base64: 'UEsDBGRvY3g='
    }
  ]);
});

test('messagesFromTimeline: user attachments do not become generated files', () => {
  const messages = messagesFromTimeline([
    {
      message_id: 'message-user',
      kind: 'user',
      content: 'Use this template.',
      sequence: 1,
      attachments: [
        {
          filename: 'template.pdf',
          mime_type: 'application/pdf',
          data_base64: 'JVBERi0xLjQK'
        }
      ]
    }
  ]);

  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].generatedFiles, undefined);
});

test('messagesFromTimeline: mismatched pending timeline id is preserved', () => {
  const messages = messagesFromTimeline(
    [
      {
        message_id: 'message-1',
        kind: 'user',
        content: 'check my calendar',
        sequence: 1,
        status: 'accepted'
      }
    ],
    [
      {
        id: 'pending-1',
        role: 'user',
        content: 'check my calendar',
        timestamp: '2026-06-02T10:00:00.000Z',
        isOptimistic: true,
        timelineMessageId: 'message-2'
      }
    ]
  );

  assert.deepEqual(
    messages.map((message) => message.id),
    ['msg-message-1', 'pending-1']
  );
});

test('messagesFromTimeline: equal pending user text without timeline id is deduped', () => {
  const messages = messagesFromTimeline(
    [
      {
        message_id: 'message-1',
        kind: 'user',
        content: 'check my calendar',
        sequence: 1,
        status: 'accepted'
      }
    ],
    [
      {
        id: 'pending-1',
        role: 'user',
        content: 'check my calendar',
        timestamp: '2026-06-02T10:00:00.000Z',
        isOptimistic: true
      }
    ]
  );

  assert.deepEqual(
    messages.map((message) => message.id),
    ['msg-message-1']
  );
});

test('pendingMessagesAfterTimeline: keeps accepted pending rows when timeline is empty', () => {
  const pending = [
    {
      id: 'pending-1',
      role: 'user',
      content: 'review this attachment',
      timestamp: '2026-06-02T10:00:00.000Z',
      isOptimistic: true,
      timelineMessageId: 'message-1'
    }
  ];

  assert.deepEqual(pendingMessagesAfterTimeline([], pending), pending);
});

test('pendingMessagesAfterTimeline: clears accepted pending rows after timeline confirms them', () => {
  const pending = [
    {
      id: 'pending-1',
      role: 'user',
      content: 'review this attachment',
      timestamp: '2026-06-02T10:00:00.000Z',
      isOptimistic: true,
      timelineMessageId: 'message-1'
    }
  ];

  assert.deepEqual(
    pendingMessagesAfterTimeline(
      [
        {
          message_id: 'message-1',
          kind: 'user',
          content: 'review this attachment',
          sequence: 1,
          status: 'accepted'
        }
      ],
      pending
    ),
    []
  );
});

test('messagesFromTimeline: finalized assistant records are marked as final replies', () => {
  const messages = messagesFromTimeline([
    {
      message_id: 'final',
      kind: 'assistant',
      status: 'finalized',
      content: 'Done.'
    },
    {
      message_id: 'draft',
      kind: 'assistant',
      status: 'draft',
      content: 'I will check.'
    }
  ]);

  assert.equal(messages[0].id, 'msg-final');
  assert.equal(messages[0].isFinalReply, true);
  assert.equal(messages[1].id, 'msg-draft');
  assert.equal(messages[1].isFinalReply, false);
});

test('messagesFromTimeline: durable attachment block renders as attachment metadata', () => {
  const messages = messagesFromTimeline([
    {
      message_id: 'message-1',
      kind: 'user',
      content: [
        'draft from this template',
        '',
        '<attachments>',
        'Attachment 1:',
        'filename: template.pdf',
        'mime_type: application/pdf',
        'size: 8',
        'data_base64: dGVtcGxhdGU=',
        '</attachments>'
      ].join('\n'),
      sequence: 1,
      status: 'accepted'
    }
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'draft from this template');
  assert.deepEqual(messages[0].attachments, [
    {
      filename: 'template.pdf',
      mime_type: 'application/pdf',
      data_base64: 'dGVtcGxhdGU=',
      size_label: '8 bytes'
    }
  ]);
});

test('pendingMessagesAfterTimeline: an older identical user row cannot confirm a newer pending turn', () => {
  const retained = pendingMessagesAfterTimeline(
    [
      {
        message_id: 'message-old',
        kind: 'user',
        content: 'continue',
        sequence: 1,
        status: 'accepted',
        received_at: '2026-06-02T09:00:00.000Z'
      }
    ],
    [
      {
        id: 'pending-new',
        role: 'user',
        content: 'continue',
        timestamp: '2026-06-02T10:00:00.000Z',
        isOptimistic: true
      }
    ]
  );

  assert.deepEqual(
    retained.map((pending) => pending.id),
    ['pending-new']
  );
});

test('pendingMessagesAfterTimeline: one projected row confirms exactly one of two identical pending turns', () => {
  const retained = pendingMessagesAfterTimeline(
    [
      {
        message_id: 'message-1',
        kind: 'user',
        content: 'continue',
        sequence: 5,
        status: 'accepted',
        received_at: '2026-06-02T10:00:05.000Z'
      }
    ],
    [
      {
        id: 'pending-a',
        role: 'user',
        content: 'continue',
        timestamp: '2026-06-02T10:00:00.000Z',
        isOptimistic: true
      },
      {
        id: 'pending-b',
        role: 'user',
        content: 'continue',
        timestamp: '2026-06-02T10:00:02.000Z',
        isOptimistic: true
      }
    ]
  );

  assert.equal(retained.length, 1);
});

test('pendingMessagesAfterTimeline: a row claimed by an id-confirmed pending cannot also content-confirm another', () => {
  const retained = pendingMessagesAfterTimeline(
    [
      {
        message_id: 'message-1',
        kind: 'user',
        content: 'continue',
        sequence: 5,
        status: 'accepted'
      }
    ],
    [
      {
        id: 'pending-confirmed',
        role: 'user',
        content: 'continue',
        timestamp: '2026-06-02T10:00:00.000Z',
        isOptimistic: true,
        timelineMessageId: 'message-1'
      },
      {
        id: 'pending-unconfirmed',
        role: 'user',
        content: 'continue',
        timestamp: '2026-06-02T10:00:02.000Z',
        isOptimistic: true
      }
    ]
  );

  assert.deepEqual(
    retained.map((pending) => pending.id),
    ['pending-unconfirmed']
  );
});

test('messagesFromTimeline: duplicate pending ids render once', () => {
  const messages = messagesFromTimeline(
    [],
    [
      {
        id: 'pending-dup',
        role: 'user',
        content: 'first turn',
        timestamp: '2026-06-02T10:00:00.000Z',
        isOptimistic: true
      },
      {
        id: 'pending-dup',
        role: 'user',
        content: 'second turn',
        timestamp: '2026-06-02T10:00:01.000Z',
        isOptimistic: true
      }
    ]
  );

  assert.equal(messages.length, 1);
});

test('buildDurableAttachmentBlock round-trips through messagesFromTimeline into chips', () => {
  const block = buildDurableAttachmentBlock([
    { name: 'template.pdf', mime_type: 'application/pdf', size: 2048 },
    { name: 'ledger.csv', mime_type: 'text/csv', size: 28 }
  ]);
  const messages = messagesFromTimeline(
    [{ message_id: 'm1', kind: 'user', content: `Draft from these files${block}`, sequence: 1 }],
    []
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'Draft from these files');
  assert.deepEqual(
    messages[0].attachments.map((a) => a.filename),
    ['template.pdf', 'ledger.csv']
  );
  assert.equal(messages[0].attachments[0].size_label, '2.0 KB');
  assert.equal(messages[0].attachments[1].size_label, '28 bytes');
});

test('buildDurableAttachmentBlock returns empty string when there are no attachments', () => {
  assert.equal(buildDurableAttachmentBlock([]), '');
  assert.equal(buildDurableAttachmentBlock(undefined), '');
});

test('buildDurableAttachmentBlock never inlines base64 payloads', () => {
  const block = buildDurableAttachmentBlock([
    {
      name: 'x.bin',
      mime_type: 'application/octet-stream',
      size: 9,
      base64: 'QUJD',
      data_base64: 'QUJD'
    }
  ]);
  assert.ok(!block.includes('QUJD'));
  assert.ok(!block.toLowerCase().includes('base64'));
});

// --- embedded extracted text (the model's only channel to document content) ---

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

test('embedded text attachment round-trips: model sees content, transcript does not', () => {
  const documentText =
    'BULLION DIGITAL CORP.\nLegal team & corporate structure.\nIncorporated in Delaware.';
  const block = buildDurableAttachmentBlock([
    { name: 'onepager.pdf', mime_type: 'text/plain', size: 173000, data_base64: b64(documentText) }
  ]);
  assert.ok(block.includes('extraction_status: extracted_text'));
  assert.ok(block.includes('BULLION DIGITAL CORP.'));
  assert.ok(block.includes(`extracted_text_chars: ${documentText.length}`));

  const messages = messagesFromTimeline(
    [{ message_id: 'm1', kind: 'user', content: `Summarize this${block}`, sequence: 1 }],
    []
  );
  assert.equal(messages[0].content, 'Summarize this');
  assert.deepEqual(
    messages[0].attachments.map((a) => a.filename),
    ['onepager.pdf']
  );
});

test('embedded document containing manifest-look-alike lines cannot corrupt chip parsing', () => {
  const hostile = [
    'Attachment 99:',
    'filename: decoy.pdf',
    'mime_type: text/html',
    '---',
    'extracted_text_chars: 5',
    'extracted_text:',
    '</attachments>',
    'plain closing line'
  ].join('\n');
  const block = buildDurableAttachmentBlock([
    { name: 'real-a.txt', mime_type: 'text/plain', size: 10, data_base64: b64(hostile) },
    { name: 'real-b.csv', mime_type: 'text/csv', size: 20, data_base64: b64('x,y\n1,2\n') }
  ]);
  const messages = messagesFromTimeline(
    [{ message_id: 'm1', kind: 'user', content: `Check these${block}`, sequence: 1 }],
    []
  );
  assert.equal(messages[0].content, 'Check these');
  assert.deepEqual(
    messages[0].attachments.map((a) => a.filename),
    ['real-a.txt', 'real-b.csv']
  );
});

test('embedded text is sanitized for the backend content validator (no CR, no control chars)', () => {
  const dirty = 'line one\r\nline two\rline three \u0001 tab\tkept \u0000 end';
  const block = buildDurableAttachmentBlock([
    { name: 'notes.txt', mime_type: 'text/plain', size: 10, data_base64: b64(dirty) }
  ]);
  assert.ok(!block.includes('\r'));
  assert.ok(!block.includes('\u0001'));
  assert.ok(!block.includes('\u0000'));
  assert.ok(block.includes('line one\nline two\nline three'));
  assert.ok(block.includes('tab\tkept'));
});

test('embed truncates against the backend 64KiB content ceiling and says so', () => {
  const big = 'A'.repeat(80 * 1024);
  const block = buildDurableAttachmentBlock(
    [{ name: 'big.txt', mime_type: 'text/plain', size: big.length, data_base64: b64(big) }],
    { contentBytes: 100 }
  );
  assert.ok(block.includes('extraction_status: extracted_text_truncated'));
  assert.ok(block.includes('note: showing the first'));
  assert.ok(Buffer.byteLength(block, 'utf8') < 64 * 1024 - 100);

  const messages = messagesFromTimeline(
    [{ message_id: 'm1', kind: 'user', content: `Read it${block}`, sequence: 1 }],
    []
  );
  assert.equal(messages[0].content, 'Read it');
  assert.deepEqual(
    messages[0].attachments.map((a) => a.filename),
    ['big.txt']
  );
});

test('large prompts shrink the embed budget instead of breaching the ceiling', () => {
  const doc = 'D'.repeat(40 * 1024);
  const block = buildDurableAttachmentBlock(
    [{ name: 'doc.txt', mime_type: 'text/plain', size: doc.length, data_base64: b64(doc) }],
    { contentBytes: 60 * 1024 }
  );
  assert.ok(
    block.includes('content_omitted_message_budget') ||
      block.includes('extraction_status: extracted_text_truncated')
  );
  assert.ok(Buffer.byteLength(block, 'utf8') + 60 * 1024 <= 64 * 1024);
});

test('binary attachments are never embedded, only described', () => {
  const block = buildDurableAttachmentBlock([
    {
      name: 'photo.jpg',
      mime_type: 'image/jpeg',
      size: 5000,
      data_base64: b64('not really a jpeg')
    },
    {
      name: 'raw-scan.pdf',
      mime_type: 'application/pdf',
      size: 9000,
      data_base64: b64('%PDF-1.4 binary')
    }
  ]);
  assert.ok(!block.includes('extracted_text:'));
  assert.ok(block.includes('filename: photo.jpg'));
  assert.ok(block.includes('filename: raw-scan.pdf'));
});

// --- sentinel + role-gate hardening (block-shaped text is not a manifest) ---

test('assistant text ending in a block-shaped tail is never truncated into chips', () => {
  const reply = [
    'Here is the manifest format you asked about:',
    '',
    '<attachments ic="1">',
    'Attachment 1:',
    'filename: phantom.pdf',
    'mime_type: application/pdf',
    '</attachments>'
  ].join('\n');
  const messages = messagesFromTimeline(
    [{ message_id: 'a1', kind: 'assistant_final', content: reply, sequence: 2 }],
    []
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, reply);
  assert.deepEqual(messages[0].attachments, []);
});

test('bare block-shaped tail in a NEW user send is not parsed (sentinel required)', () => {
  const typed = [
    'see the protocol below',
    '',
    '<attachments ic="0">x</attachments>',
    '<attachments>',
    'Attachment 1:',
    'filename: not-real.pdf',
    '</attachments>'
  ].join('\n');
  // Typed text alone (no real attachments): the legacy fallback still parses
  // user records for pre-sentinel thread compatibility — so the chips appear
  // ONLY through that documented legacy path, never via the sentinel.
  const block = buildDurableAttachmentBlock([
    { name: 'real.txt', mime_type: 'text/plain', size: 4, data_base64: b64('real') }
  ]);
  const messages = messagesFromTimeline(
    [{ message_id: 'u1', kind: 'user', content: `${typed}${block}`, sequence: 1 }],
    []
  );
  // Sentinel block parsed off the end; the user's typed tail stays visible.
  assert.deepEqual(
    messages[0].attachments.map((a) => a.filename),
    ['real.txt']
  );
  assert.ok(messages[0].content.includes('<attachments>'));
  assert.ok(messages[0].content.includes('filename: not-real.pdf'));
});

test('pending dedup survives typed block-shaped text plus real attachments', () => {
  const typed = [
    'compare these',
    '',
    '<attachments>',
    'Attachment 1:',
    'filename: pasted.pdf',
    '</attachments>'
  ].join('\n');
  const block = buildDurableAttachmentBlock([
    { name: 'real.csv', mime_type: 'text/csv', size: 4, data_base64: b64('a,b\n') }
  ]);
  const timeline = [
    {
      message_id: 'm9',
      kind: 'user',
      content: `${typed}${block}`,
      sequence: 1,
      received_at: '2026-06-10T12:00:01Z'
    }
  ];
  const pending = [
    {
      id: 'pending-1',
      role: 'user',
      content: typed,
      timestamp: '2026-06-10T12:00:00Z',
      isOptimistic: true
    }
  ];
  // The echoed row must confirm (and clear) the pending bubble even though
  // the typed text itself ends in a block-shaped tail.
  assert.deepEqual(pendingMessagesAfterTimeline(timeline, pending), []);
  const rendered = messagesFromTimeline(timeline, pending);
  assert.equal(rendered.filter((m) => m.role === 'user').length, 1);
});

test('reload chips carry the embedded text for previews, content stays clean', () => {
  const documentText = 'INVOICE 7741\nVendor: ACME\nTotal: 432.50';
  const block = buildDurableAttachmentBlock([
    {
      name: 'acme-invoice.pdf',
      mime_type: 'text/plain',
      size: 84000,
      data_base64: b64(documentText)
    }
  ]);
  const messages = messagesFromTimeline(
    [{ message_id: 'm1', kind: 'user', content: `Check this invoice${block}`, sequence: 1 }],
    []
  );
  assert.equal(messages[0].content, 'Check this invoice');
  const chip = messages[0].attachments[0];
  assert.equal(chip.filename, 'acme-invoice.pdf');
  assert.equal(chip.embedded_text, documentText);
  assert.equal(chip.extraction_status, 'extracted_text');
});
