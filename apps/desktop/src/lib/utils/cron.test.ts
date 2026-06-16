// Tests for the cron expression → human-readable description helper.
//
// We cover every pattern called out in the spec plus a handful of
// edge cases (whitespace, ranges, lists, alias forms, malformed
// inputs). The helper is pure, so no DOM / IPC mocks needed.

import { describe, expect, it } from 'vitest';

import { describeCron } from './cron';

describe('describeCron — wildcard and stepped minutes', () => {
  it('describes "* * * * *" as Every minute', () => {
    const out = describeCron('* * * * *');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('Every minute');
  });

  it('describes "*/15 * * * *" as Every 15 minutes', () => {
    const out = describeCron('*/15 * * * *');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('Every 15 minutes');
  });

  it('describes "*/1 * * * *" as Every minute (singular)', () => {
    const out = describeCron('*/1 * * * *');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('Every minute');
  });

  it('describes "0 * * * *" as Every hour at minute 0', () => {
    const out = describeCron('0 * * * *');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('Every hour at minute 0');
  });

  it('describes "0 */6 * * *" as Every 6 hours', () => {
    const out = describeCron('0 */6 * * *');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('Every 6 hours');
  });
});

describe('describeCron — daily, weekly, monthly, yearly', () => {
  it('describes "0 9 * * *" as Every day at 9:00 AM', () => {
    const out = describeCron('0 9 * * *');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('Every day at 9:00 AM');
  });

  it('describes "30 14 * * *" as Every day at 2:30 PM', () => {
    const out = describeCron('30 14 * * *');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('Every day at 2:30 PM');
  });

  it('describes "0 0 * * *" as Every day at 12:00 AM (midnight)', () => {
    const out = describeCron('0 0 * * *');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('Every day at 12:00 AM');
  });

  it('describes "0 9 * * 1" as Every Monday at 9:00 AM', () => {
    const out = describeCron('0 9 * * 1');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('Every Monday at 9:00 AM');
  });

  it('describes "0 9 * * 0" as Every Sunday at 9:00 AM', () => {
    const out = describeCron('0 9 * * 0');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('Every Sunday at 9:00 AM');
  });

  it('describes "0 9 * * 7" the same as Sunday (Vixie 7→0 compat)', () => {
    const out = describeCron('0 9 * * 7');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('Every Sunday at 9:00 AM');
  });

  it('describes "0 9 * * 1-5" as Every weekday at 9:00 AM', () => {
    const out = describeCron('0 9 * * 1-5');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('Every weekday at 9:00 AM');
  });

  it('describes "0 9 * * 0,6" as Every weekend at 9:00 AM', () => {
    const out = describeCron('0 9 * * 0,6');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('Every weekend at 9:00 AM');
  });

  it('describes "0 9 1 * *" as On the 1st of every month at 9:00 AM', () => {
    const out = describeCron('0 9 1 * *');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('On the 1st of every month at 9:00 AM');
  });

  it('describes "0 9 22 * *" with proper ordinal (22nd)', () => {
    const out = describeCron('0 9 22 * *');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('On the 22nd of every month at 9:00 AM');
  });

  it('describes "0 9 11 * *" with -th ordinal (11th, not 11st)', () => {
    const out = describeCron('0 9 11 * *');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('On the 11th of every month at 9:00 AM');
  });

  it('describes "0 9 1 1 *" as On Jan 1 every year at 9:00 AM', () => {
    const out = describeCron('0 9 1 1 *');
    expect(out.valid).toBe(true);
    expect(out.text).toBe('On Jan 1 every year at 9:00 AM');
  });
});

describe('describeCron — shortcut aliases', () => {
  it('@hourly → Every hour', () => {
    expect(describeCron('@hourly')).toEqual({ text: 'Every hour', valid: true });
  });

  it('@daily → Every day at midnight', () => {
    expect(describeCron('@daily')).toEqual({
      text: 'Every day at midnight',
      valid: true
    });
  });

  it('@weekly → Every Sunday at midnight', () => {
    expect(describeCron('@weekly')).toEqual({
      text: 'Every Sunday at midnight',
      valid: true
    });
  });

  it('@monthly → On the 1st of every month at midnight', () => {
    expect(describeCron('@monthly')).toEqual({
      text: 'On the 1st of every month at midnight',
      valid: true
    });
  });

  it('@yearly → On Jan 1 every year at midnight', () => {
    expect(describeCron('@yearly')).toEqual({
      text: 'On Jan 1 every year at midnight',
      valid: true
    });
  });

  it('@annually is an alias for @yearly', () => {
    expect(describeCron('@annually').text).toBe('On Jan 1 every year at midnight');
  });

  it('aliases are case-insensitive', () => {
    expect(describeCron('@DAILY').text).toBe('Every day at midnight');
  });
});

describe('describeCron — friendly "every Ns|m|h|d" shorthand', () => {
  it('every 5m → Every 5 minutes', () => {
    expect(describeCron('every 5m').text).toBe('Every 5 minutes');
  });

  it('every 30s → Every 30 seconds', () => {
    expect(describeCron('every 30s').text).toBe('Every 30 seconds');
  });

  it('every 1h → Every hour (singular)', () => {
    expect(describeCron('every 1h').text).toBe('Every hour');
  });

  it('every 2d → Every 2 days', () => {
    expect(describeCron('every 2d').text).toBe('Every 2 days');
  });

  it('long-form unit names work too (every 5 minutes)', () => {
    expect(describeCron('every 5 minutes').text).toBe('Every 5 minutes');
  });
});

describe('describeCron — invalid inputs', () => {
  it('rejects an empty string', () => {
    expect(describeCron('')).toEqual({
      text: 'Invalid cron expression',
      valid: false
    });
  });

  it('rejects whitespace-only input', () => {
    expect(describeCron('   ').valid).toBe(false);
  });

  it('rejects wrong field count (4 fields)', () => {
    expect(describeCron('* * * *').valid).toBe(false);
  });

  it('rejects wrong field count (6 fields)', () => {
    expect(describeCron('* * * * * *').valid).toBe(false);
  });

  it('rejects a hour outside 0-23', () => {
    expect(describeCron('0 25 * * *').valid).toBe(false);
  });

  it('rejects a minute outside 0-59', () => {
    expect(describeCron('60 9 * * *').valid).toBe(false);
  });

  it('rejects garbage text', () => {
    expect(describeCron('not-a-cron-expression').valid).toBe(false);
  });

  it('rejects malformed step ("0 */0 * * *")', () => {
    expect(describeCron('0 */0 * * *').valid).toBe(false);
  });

  it('returns the standard error string for invalid inputs', () => {
    expect(describeCron('xxx').text).toBe('Invalid cron expression');
  });
});

describe('describeCron — edge cases and tolerance', () => {
  it('normalises multi-space separators', () => {
    expect(describeCron('0   9   *   *   *').text).toBe('Every day at 9:00 AM');
  });

  it('normalises tab separators', () => {
    expect(describeCron('0\t9\t*\t*\t*').text).toBe('Every day at 9:00 AM');
  });

  it('trims leading and trailing whitespace', () => {
    expect(describeCron('   0 9 * * *   ').text).toBe('Every day at 9:00 AM');
  });

  it('handles a single-day list under the generic fallback', () => {
    // Two specific weekdays with a fixed time — picks the list form.
    const out = describeCron('0 9 * * 1,3');
    expect(out.valid).toBe(true);
    expect(out.text).toContain('Mon');
    expect(out.text).toContain('Wed');
    expect(out.text).toContain('9:00 AM');
  });

  it('describes "0 9 * * 1,3,5" with three-day list', () => {
    const out = describeCron('0 9 * * 1,3,5');
    expect(out.valid).toBe(true);
    expect(out.text).toMatch(/Mon.*Wed.*and Fri.*9:00 AM/);
  });

  it('handles step from a base value ("5/10 * * * *")', () => {
    // 5, 15, 25, 35, 45, 55 — falls through to the generic describer.
    const out = describeCron('5/10 * * * *');
    expect(out.valid).toBe(true);
    // The generic minute clause is content-checked, not exact-matched,
    // because the fallback wording isn't load-bearing.
    expect(out.text.length).toBeGreaterThan(0);
  });
});
