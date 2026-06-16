import { describe, expect, it } from 'vitest';

import { computeThreadStats, type StatMessage } from './thread-stats';

function message(
  role: StatMessage['role'],
  content: string,
  createdAt = '2026-05-28T00:00:00Z'
): StatMessage {
  return {
    role,
    content,
    created_at: createdAt
  };
}

describe('thread-stats', () => {
  it('returns zero and null stats for an empty list', () => {
    expect(computeThreadStats([])).toEqual({
      messageCount: 0,
      byRole: { user: 0, assistant: 0, tool: 0 },
      estimatedTokens: 0,
      totalChars: 0,
      firstAt: null,
      lastAt: null,
      spanMs: 0
    });
  });

  it('counts messages by role for a mixed list', () => {
    const stats = computeThreadStats([
      message('user', 'one'),
      message('assistant', 'two'),
      message('tool', 'three'),
      message('assistant', 'four'),
      message('user', 'five')
    ]);

    expect(stats.messageCount).toBe(5);
    expect(stats.byRole).toEqual({ user: 2, assistant: 2, tool: 1 });
  });

  it('estimates tokens from total content length', () => {
    const stats = computeThreadStats([
      message('user', '12345'),
      message('assistant', '1234567'),
      message('tool', '')
    ]);

    expect(stats.totalChars).toBe(12);
    expect(stats.estimatedTokens).toBe(3);
  });

  it('uses chronological min and max timestamps for span regardless of array order', () => {
    const stats = computeThreadStats([
      message('assistant', 'latest', '2026-05-28T00:01:30Z'),
      message('user', 'earliest', '2026-05-28T00:00:00Z'),
      message('tool', 'middle', '2026-05-28T00:00:30Z')
    ]);

    expect(stats.firstAt).toBe('2026-05-28T00:00:00Z');
    expect(stats.lastAt).toBe('2026-05-28T00:01:30Z');
    expect(stats.spanMs).toBe(90_000);
  });

  it('excludes unparseable timestamps from time stats but counts the message elsewhere', () => {
    const stats = computeThreadStats([
      message('user', 'hello', 'not-a-date'),
      message('assistant', 'world', '2026-05-28T00:00:05Z'),
      message('tool', '!', '2026-05-28T00:00:09Z')
    ]);

    expect(stats.messageCount).toBe(3);
    expect(stats.byRole).toEqual({ user: 1, assistant: 1, tool: 1 });
    expect(stats.totalChars).toBe(11);
    expect(stats.estimatedTokens).toBe(3);
    expect(stats.firstAt).toBe('2026-05-28T00:00:05Z');
    expect(stats.lastAt).toBe('2026-05-28T00:00:09Z');
    expect(stats.spanMs).toBe(4_000);
  });

  it('uses a zero span when fewer than two timestamps are parseable', () => {
    const stats = computeThreadStats([
      message('user', 'hello', 'not-a-date'),
      message('assistant', 'world', '2026-05-28T00:00:05Z')
    ]);

    expect(stats.firstAt).toBe('2026-05-28T00:00:05Z');
    expect(stats.lastAt).toBe('2026-05-28T00:00:05Z');
    expect(stats.spanMs).toBe(0);
  });
});
