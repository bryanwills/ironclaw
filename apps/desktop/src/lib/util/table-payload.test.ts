import { describe, expect, it } from 'vitest';

import { cellText, normalizeTablePayload } from './table-payload';

describe('cellText', () => {
  it('passes strings through and maps null/undefined to empty', () => {
    expect(cellText('hi')).toBe('hi');
    expect(cellText(null)).toBe('');
    expect(cellText(undefined)).toBe('');
  });

  it('JSON-stringifies non-string values', () => {
    expect(cellText(42)).toBe('42');
    expect(cellText(true)).toBe('true');
    expect(cellText({ a: 1 })).toBe('{"a":1}');
  });
});

describe('normalizeTablePayload', () => {
  it('coerces headers + rows to string matrices', () => {
    const out = normalizeTablePayload({
      headers: ['Name', 1, null],
      rows: [
        ['a', 2],
        ['b', { x: 1 }]
      ]
    });
    expect(out.headers).toEqual(['Name', '1', '']);
    expect(out.rows).toEqual([
      ['a', '2'],
      ['b', '{"x":1}']
    ]);
  });

  it('is defensive against any shape and never throws', () => {
    expect(normalizeTablePayload(null)).toEqual({ headers: [], rows: [] });
    expect(normalizeTablePayload(undefined)).toEqual({ headers: [], rows: [] });
    expect(normalizeTablePayload({})).toEqual({ headers: [], rows: [] });
    // Non-array headers / rows collapse to empty rather than throwing.
    expect(normalizeTablePayload({ headers: 'nope', rows: 5 })).toEqual({ headers: [], rows: [] });
    // A non-array row collapses to an empty row.
    expect(normalizeTablePayload({ rows: ['notarow', ['ok']] }).rows).toEqual([[], ['ok']]);
  });
});
