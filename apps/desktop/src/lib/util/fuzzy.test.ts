import { describe, expect, it } from 'vitest';

import { fuzzyMatch, fuzzyRank } from './fuzzy';

describe('fuzzy util', () => {
  describe('fuzzyMatch', () => {
    it('matches query characters as a case-insensitive subsequence', () => {
      const result = fuzzyMatch('gth', 'GitHub');

      expect(result.matched).toBe(true);
      expect(result.indices).toEqual([0, 2, 3]);
      expect(result.indices).toEqual([...result.indices].sort((left, right) => left - right));
      expect(result.score).toBeGreaterThan(0);
    });

    it('returns an empty miss result when the query is not a subsequence', () => {
      expect(fuzzyMatch('xyz', 'GitHub')).toEqual({
        matched: false,
        score: 0,
        indices: []
      });
    });

    it('returns a zero-score match for an empty query', () => {
      expect(fuzzyMatch('', 'GitHub')).toEqual({
        matched: true,
        score: 0,
        indices: []
      });
    });

    it('scores contiguous matches above scattered matches', () => {
      const contiguous = fuzzyMatch('git', 'github');
      const scattered = fuzzyMatch('gtb', 'github');

      expect(contiguous.matched).toBe(true);
      expect(scattered.matched).toBe(true);
      expect(contiguous.score).toBeGreaterThan(scattered.score);
    });

    it('scores start and word-boundary matches above mid-word matches', () => {
      const start = fuzzyMatch('git', 'github');
      const boundary = fuzzyMatch('hub', 'git-hub');
      const midWord = fuzzyMatch('hub', 'github');

      expect(start.score).toBeGreaterThan(fuzzyMatch('git', 'mygithub').score);
      expect(boundary.score).toBeGreaterThan(midWord.score);
    });
  });

  describe('fuzzyRank', () => {
    it('drops non-matches and sorts matches by descending score', () => {
      const ranked = fuzzyRank('git', ['mygithub', 'github', 'xyz']);

      expect(ranked.map((entry) => entry.item)).toEqual(['github', 'mygithub']);
      expect(ranked[0].result.score).toBeGreaterThan(ranked[1].result.score);
    });

    it('keeps input order for score ties', () => {
      const ranked = fuzzyRank('ab', ['ab', 'ab', 'axby']);

      expect(ranked.map((entry) => entry.item)).toEqual(['ab', 'ab', 'axby']);
    });

    it('uses a key function for non-string items', () => {
      const items = [{ label: 'GitHub' }, { label: 'Notes' }];

      expect(fuzzyRank('gth', items, (item) => item.label).map((entry) => entry.item)).toEqual([
        items[0]
      ]);
    });
  });
});
