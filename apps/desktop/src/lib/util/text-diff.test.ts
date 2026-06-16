import { describe, expect, it } from 'vitest';

import { diffLines, diffStats } from './text-diff';

describe('text-diff util', () => {
  it('returns equal lines with old and new line numbers for identical text', () => {
    expect(diffLines('alpha\nbeta\ngamma', 'alpha\nbeta\ngamma')).toEqual([
      { op: 'equal', text: 'alpha', oldLine: 1, newLine: 1 },
      { op: 'equal', text: 'beta', oldLine: 2, newLine: 2 },
      { op: 'equal', text: 'gamma', oldLine: 3, newLine: 3 }
    ]);
  });

  it('returns a delete then insert for a changed middle line', () => {
    expect(diffLines('alpha\nold middle\ngamma', 'alpha\nnew middle\ngamma')).toEqual([
      { op: 'equal', text: 'alpha', oldLine: 1, newLine: 1 },
      { op: 'delete', text: 'old middle', oldLine: 2, newLine: null },
      { op: 'insert', text: 'new middle', oldLine: null, newLine: 2 },
      { op: 'equal', text: 'gamma', oldLine: 3, newLine: 3 }
    ]);
  });

  it('returns all inserts for empty old text', () => {
    expect(diffLines('', 'alpha\nbeta')).toEqual([
      { op: 'insert', text: 'alpha', oldLine: null, newLine: 1 },
      { op: 'insert', text: 'beta', oldLine: null, newLine: 2 }
    ]);
  });

  it('returns all deletes for empty new text', () => {
    expect(diffLines('alpha\nbeta', '')).toEqual([
      { op: 'delete', text: 'alpha', oldLine: 1, newLine: null },
      { op: 'delete', text: 'beta', oldLine: 2, newLine: null }
    ]);
  });

  it('counts added, removed, and unchanged lines', () => {
    const lines = diffLines('alpha\nold middle\ngamma', 'alpha\nnew middle\ngamma\ndelta');

    expect(diffStats(lines)).toEqual({ added: 2, removed: 1, unchanged: 2 });
  });

  it('normalizes CRLF input without leaking carriage returns', () => {
    expect(diffLines('alpha\r\nbeta\r\n', 'alpha\r\nchanged\r\n')).toEqual([
      { op: 'equal', text: 'alpha', oldLine: 1, newLine: 1 },
      { op: 'delete', text: 'beta', oldLine: 2, newLine: null },
      { op: 'insert', text: 'changed', oldLine: null, newLine: 2 }
    ]);
  });
});
