import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildThreadExportPayload,
  buildThreadJsonExport,
  buildThreadMarkdownExport
} from './thread-export.js';

const FIXED_EXPORT_AT = '2026-06-11T12:00:00.000Z';

test('thread export payload includes thinking, tool, and image turns', () => {
  const messages = [
    {
      role: 'user',
      id: 'msg-1',
      timestamp: '2026-06-11T11:55:00.000Z',
      content: 'Draft a one-page services agreement',
      attachments: [
        {
          filename: 'template.pdf',
          mime_type: 'application/pdf',
          size_label: '12 KB'
        }
      ]
    },
    {
      role: 'assistant',
      id: 'msg-2',
      timestamp: '2026-06-11T11:56:00.000Z',
      content: 'I am gathering context now.'
    },
    {
      role: 'thinking',
      id: 'msg-3',
      timestamp: '2026-06-11T11:56:10.000Z',
      content: 'Retrieved template text and legal clauses.'
    },
    {
      role: 'tool_activity',
      id: 'msg-4',
      timestamp: '2026-06-11T11:56:20.000Z',
      toolName: 'web.search',
      toolStatus: 'completed',
      toolError: null,
      toolParameters: '{"query":"sample services agreement clause"}',
      toolResultPreview: 'Found 1 relevant precedent.'
    },
    {
      role: 'image',
      id: 'msg-5',
      timestamp: '2026-06-11T11:57:00.000Z',
      generatedImages: [{ path: 'diagram.png' }]
    }
  ];

  const payload = buildThreadExportPayload(messages, {
    title: 'Service Draft Test',
    exportedAt: FIXED_EXPORT_AT
  });

  assert.equal(payload.thread.title, 'Service Draft Test');
  assert.equal(payload.thread.exported_at, FIXED_EXPORT_AT);
  assert.equal(payload.thread.message_count, messages.length);
  assert.equal(payload.messages.length, 5);

  assert.equal(payload.messages[2].role, 'thinking');
  assert.equal(payload.messages[2].content, 'Retrieved template text and legal clauses.');

  assert.equal(payload.messages[3].role, 'tool_activity');
  assert.equal(payload.messages[3].toolName, 'web.search');
  assert.equal(payload.messages[3].toolStatus, 'completed');

  assert.equal(payload.messages[4].role, 'image');
  assert.deepEqual(payload.messages[4].generatedImages, [{ path: 'diagram.png' }]);
});

test('thread markdown export captures tool and attachment details as visible text', () => {
  const messages = [
    {
      role: 'user',
      content: 'Draft contract',
      attachments: [{ filename: 'input.md', mime_type: 'text/markdown', size_label: '4 KB' }]
    },
    { role: 'assistant', content: 'Working on draft.' },
    {
      role: 'tool_activity',
      toolName: 'notion.search',
      toolStatus: 'completed',
      toolResultPreview: 'Found 3 documents.'
    },
    {
      role: 'thinking',
      content: 'Selecting the right contract variant.'
    }
  ];

  const markdown = buildThreadMarkdownExport(messages, {
    title: 'Contract Draft',
    exportedAt: FIXED_EXPORT_AT
  });

  assert.match(markdown, /# Contract Draft/);
  assert.match(markdown, /Exported at: 2026-06-11T12:00:00.000Z/);
  assert.match(markdown, /## User/);
  assert.match(markdown, /input\.md/);
  assert.match(markdown, /## Tool activity/);
  assert.match(markdown, /Tool: notion\.search/);
  assert.match(markdown, /Status: completed/);
  assert.match(markdown, /Thinking/);
});

test('thread json export is parseable and includes every message role', () => {
  const messages = [
    { role: 'system', content: 'Model initialized' },
    { role: 'assistant', content: 'Yes, here is draft.' }
  ];

  const parsed = JSON.parse(buildThreadJsonExport(messages, { title: 'System Check' }));

  assert.equal(parsed.thread.title, 'System Check');
  assert.equal(parsed.messages[0].role, 'system');
  assert.equal(parsed.messages[1].role, 'assistant');
  assert.equal(parsed.messages[1].content, 'Yes, here is draft.');
});
