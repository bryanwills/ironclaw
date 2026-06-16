import { describe, expect, it } from 'vitest';

import { scoreMatch } from './command-score';

describe('scoreMatch', () => {
  it('returns 0 for an empty haystack', () => {
    expect(scoreMatch('', 'x')).toBe(0);
  });

  it('scores an exact prefix highest, tighter prefixes higher', () => {
    expect(scoreMatch('settings', 'set')).toBe(1000 - 5);
    // A shorter trailing remainder scores higher than a longer one.
    expect(scoreMatch('set', 'set')).toBe(1000);
    expect(scoreMatch('settings', 'sett')).toBeGreaterThan(scoreMatch('settings', 'set'));
  });

  it('scores a substring in the 500 band, earlier offsets higher', () => {
    expect(scoreMatch('open settings', 'settings')).toBe(500 - 5);
    expect(scoreMatch('xsettings', 'settings')).toBeGreaterThan(
      scoreMatch('xxsettings', 'settings')
    );
  });

  it('scores a subsequence in the 100 band, fewer gaps higher', () => {
    // 'st' as a subsequence of 'settings' (s..t) — in the 100 band.
    const score = scoreMatch('settings', 'st');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
    // Tighter subsequence (adjacent) beats a gappier one.
    expect(scoreMatch('start', 'st')).toBeGreaterThan(scoreMatch('socket', 'st'));
  });

  it('orders the tiers: prefix > substring > subsequence', () => {
    const prefix = scoreMatch('format', 'for');
    const substring = scoreMatch('reformat', 'for');
    const subseq = scoreMatch('f-o-r-k', 'for');
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subseq);
    expect(subseq).toBeGreaterThan(0);
  });

  it('returns 0 when the needle is not a subsequence', () => {
    expect(scoreMatch('abc', 'xyz')).toBe(0);
    expect(scoreMatch('abc', 'cba')).toBe(0); // wrong order
  });
});
