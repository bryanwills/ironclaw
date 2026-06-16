import { describe, expect, it } from 'vitest';

import { attachmentRiskSource, decodeBase64Utf8, isTextLikeAttachment } from './attachment-risk';

describe('attachment risk source', () => {
  it('extracts searchable text from text-like attachments', () => {
    expect(decodeBase64Utf8('c2VuZCB0aGUgY2xpZW50IGVtYWls')).toBe('send the client email');
    const source = attachmentRiskSource([
      { name: 'instructions.md', mime: 'text/markdown', dataBase64: 'c2VuZCB0aGUgY2xpZW50IGVtYWls' }
    ]);
    expect(source).toContain('attachment:instructions.md');
    expect(source).toContain('send the client email');
  });

  it('keeps binary attachments searchable by name and type only', () => {
    const attachment = { name: 'term-sheet.pdf', mime_type: 'application/pdf' };
    expect(isTextLikeAttachment(attachment)).toBe(false);
    expect(attachmentRiskSource([attachment])).toBe(
      'attachment:term-sheet.pdf type:application/pdf'
    );
  });
});
