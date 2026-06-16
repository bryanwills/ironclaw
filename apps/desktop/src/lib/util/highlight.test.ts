import { describe, expect, it } from 'vitest';

import { highlight } from './highlight';

describe('highlight', () => {
  it('returns [] for empty/absent haystack', () => {
    expect(highlight('', 'x')).toEqual([]);
    expect(highlight(null, 'x')).toEqual([]);
    expect(highlight(undefined, 'x')).toEqual([]);
  });

  it('returns a single non-hit segment when the needle is empty', () => {
    expect(highlight('hello', '')).toEqual([{ text: 'hello', hit: false }]);
  });

  it('splits around a single match (case-insensitive, preserves casing)', () => {
    expect(highlight('Hello World', 'world')).toEqual([
      { text: 'Hello ', hit: false },
      { text: 'World', hit: true }
    ]);
  });

  it('marks a match at the start with no leading segment', () => {
    expect(highlight('abcdef', 'abc')).toEqual([
      { text: 'abc', hit: true },
      { text: 'def', hit: false }
    ]);
  });

  it('handles multiple occurrences', () => {
    expect(highlight('a-a-a', 'a')).toEqual([
      { text: 'a', hit: true },
      { text: '-', hit: false },
      { text: 'a', hit: true },
      { text: '-', hit: false },
      { text: 'a', hit: true }
    ]);
  });

  it('returns one non-hit segment when there is no match', () => {
    expect(highlight('hello', 'zzz')).toEqual([{ text: 'hello', hit: false }]);
  });

  it('reassembles to the original string for any input', () => {
    const cases: Array<[string, string]> = [
      ['The quick brown fox', 'o'],
      ['MixedCASEneedle', 'case'],
      ['edge', 'edge'],
      ['no match here', 'xyz']
    ];
    for (const [hay, needle] of cases) {
      expect(
        highlight(hay, needle)
          .map((s) => s.text)
          .join('')
      ).toBe(hay);
    }
  });
});
