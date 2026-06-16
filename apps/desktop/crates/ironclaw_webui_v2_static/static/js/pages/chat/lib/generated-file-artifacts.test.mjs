import assert from 'node:assert/strict';
import test from 'node:test';

import {
  base64ToBytes,
  buildGeneratedFileBlob,
  generatedFileArtifactsForMessage,
  generatedFileKindLabel,
  generatedFilePreviewAttachment,
  normalizeGeneratedFileArtifact,
  textPreviewForGeneratedFileArtifact
} from './generated-file-artifacts.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

test('generated file artifacts normalize assistant file payloads without user attachment leakage', async () => {
  const artifacts = generatedFileArtifactsForMessage({
    role: 'assistant',
    content: 'Draft complete.',
    generated_files: [
      {
        title: 'Services Agreement',
        filename: 'services-agreement.docx',
        mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data_base64: b64('PK docx payload')
      }
    ],
    attachments: [
      {
        filename: 'services-agreement.docx',
        mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data_base64: b64('PK docx payload')
      }
    ]
  });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].filename, 'services-agreement.docx');
  assert.equal(generatedFileKindLabel(artifacts[0]), 'DOCX');
  assert.equal((await buildGeneratedFileBlob(artifacts[0]).text()).includes('PK docx payload'), true);
  assert.deepEqual(
    generatedFileArtifactsForMessage({
      role: 'user',
      attachments: [{ filename: 'template.pdf', data_base64: b64('pdf') }]
    }),
    []
  );
});

test('generated text files produce preview text and binary files keep honest empty preview', async () => {
  const csv = normalizeGeneratedFileArtifact({
    filename: 'model.csv',
    mime_type: 'text/csv',
    data_url: `data:text/csv;base64,${b64('name,value\nRevenue,42')}`
  });
  const docx = normalizeGeneratedFileArtifact({
    filename: 'draft.docx',
    mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    data_base64: b64('PK docx payload')
  });

  assert.equal(textPreviewForGeneratedFileArtifact(csv), 'name,value\nRevenue,42');
  assert.equal(textPreviewForGeneratedFileArtifact(docx), '');
  assert.equal(Buffer.from(base64ToBytes(csv.data_base64)).toString('utf8'), 'name,value\nRevenue,42');

  const preview = generatedFilePreviewAttachment(csv);
  assert.equal(preview.filename, 'model.csv');
  assert.equal(preview.embedded_text, 'name,value\nRevenue,42');
  assert.equal(await preview.sourceFile.text(), 'name,value\nRevenue,42');
});

test('content-only markdown document metadata does not invent a binary file chip', () => {
  assert.equal(
    normalizeGeneratedFileArtifact({
      type: 'document',
      title: 'Services draft',
      content_format: 'markdown',
      content: '# Services draft'
    }),
    null
  );
});
