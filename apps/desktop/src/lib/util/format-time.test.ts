import { describe, expect, it } from 'vitest';

import { absoluteTime, formatDuration, relativeTime } from './format-time';

describe('format-time util', () => {
  const now = Date.UTC(2026, 4, 28, 17, 42, 0);

  describe('relativeTime', () => {
    it('formats recent past timestamps compactly', () => {
      expect(relativeTime(now - 10_000, now)).toBe('just now');
      expect(relativeTime(now - 45_000, now)).toBe('1m ago');
      expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
      expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
      expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
    });

    it('accepts ISO timestamp input', () => {
      expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5m ago');
    });

    it('returns just now for future and invalid inputs', () => {
      expect(relativeTime(now + 1_000, now)).toBe('just now');
      expect(relativeTime('not a date', now)).toBe('just now');
    });

    it('formats weeks, months, and years', () => {
      expect(relativeTime(now - 3 * 7 * 86_400_000, now)).toBe('3w ago');
      expect(relativeTime(now - 5 * 30 * 86_400_000, now)).toBe('5mo ago');
      expect(relativeTime(now - 2 * 365 * 86_400_000, now)).toBe('2y ago');
    });
  });

  describe('formatDuration', () => {
    it('formats durations with up to the two largest non-zero units', () => {
      expect(formatDuration(0)).toBe('0s');
      expect(formatDuration(45_000)).toBe('45s');
      expect(formatDuration(5 * 60_000)).toBe('5m');
      expect(formatDuration(65 * 60_000)).toBe('1h 5m');
      expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000 + 15 * 60_000)).toBe('2d 3h');
    });

    it('clamps negative and invalid durations to zero', () => {
      expect(formatDuration(-1)).toBe('0s');
      expect(formatDuration(Number.NaN)).toBe('0s');
    });
  });

  describe('absoluteTime', () => {
    it('formats valid input as a local timestamp shape', () => {
      expect(absoluteTime(now)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(absoluteTime(now)).toHaveLength(16);
    });

    it('returns an empty string for invalid input', () => {
      expect(absoluteTime('not a date')).toBe('');
    });
  });
});
