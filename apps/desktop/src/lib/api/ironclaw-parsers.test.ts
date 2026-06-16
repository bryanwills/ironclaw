// Unit tests for the pure parsing/mapping helpers in api/ironclaw.ts — the
// SSE plumbing + small normalizers that sit under the chat stream. These were
// module-private; they're now exported (zero behavior change) so the
// deterministic logic at the heart of streaming can be covered directly.
// The larger Responses/normalizeEvent switches are intentionally left for a
// focused follow-up.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sinceToPeriod,
  normalizeLogLevel,
  mapRunStatus,
  mapExtensionKind,
  findFrameEnd,
  parseSseFrame
} from './ironclaw';

describe('sinceToPeriod', () => {
  afterEach(() => vi.useRealTimers());

  function at(now: string): void {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
  }

  it('returns undefined for missing or unparseable input', () => {
    expect(sinceToPeriod(undefined)).toBeUndefined();
    expect(sinceToPeriod('')).toBeUndefined();
    expect(sinceToPeriod('not-a-date')).toBeUndefined();
  });

  it('buckets recent timestamps into hour/day/week/month/year', () => {
    at('2026-05-29T12:00:00.000Z');
    expect(sinceToPeriod('2026-05-29T11:30:00.000Z')).toBe('hour'); // 30 min
    expect(sinceToPeriod('2026-05-29T11:00:00.000Z')).toBe('hour'); // exactly 1h
    expect(sinceToPeriod('2026-05-29T00:00:00.000Z')).toBe('day'); // 12h
    expect(sinceToPeriod('2026-05-26T12:00:00.000Z')).toBe('week'); // 3 days
    expect(sinceToPeriod('2026-05-09T12:00:00.000Z')).toBe('month'); // 20 days
    expect(sinceToPeriod('2026-03-30T12:00:00.000Z')).toBe('year'); // 60 days
  });

  it('clamps a future timestamp to "hour" (no negative age)', () => {
    at('2026-05-29T12:00:00.000Z');
    expect(sinceToPeriod('2026-05-29T13:00:00.000Z')).toBe('hour');
  });
});

describe('normalizeLogLevel', () => {
  it('passes the canonical levels through (case-insensitively)', () => {
    expect(normalizeLogLevel('trace')).toBe('trace');
    expect(normalizeLogLevel('debug')).toBe('debug');
    expect(normalizeLogLevel('info')).toBe('info');
    expect(normalizeLogLevel('warn')).toBe('warn');
    expect(normalizeLogLevel('error')).toBe('error');
    expect(normalizeLogLevel('ERROR')).toBe('error');
  });

  it('maps "warning" to "warn"', () => {
    expect(normalizeLogLevel('warning')).toBe('warn');
    expect(normalizeLogLevel('WARNING')).toBe('warn');
  });

  it('falls back to "info" for unknown / nullish / numeric levels', () => {
    expect(normalizeLogLevel('verbose')).toBe('info');
    expect(normalizeLogLevel(null)).toBe('info');
    expect(normalizeLogLevel(undefined)).toBe('info');
    expect(normalizeLogLevel(5)).toBe('info');
  });
});

describe('mapRunStatus', () => {
  it('maps completed→success and running→running', () => {
    expect(mapRunStatus('completed')).toBe('success');
    expect(mapRunStatus('running')).toBe('running');
  });

  it('treats failed/timeout/unknown as failed', () => {
    expect(mapRunStatus('failed')).toBe('failed');
    expect(mapRunStatus('timeout')).toBe('failed');
    expect(mapRunStatus('something-else')).toBe('failed');
  });
});

describe('mapExtensionKind', () => {
  it('returns undefined for empty/nullish kinds', () => {
    expect(mapExtensionKind('')).toBeUndefined();
    expect(mapExtensionKind(null)).toBeUndefined();
    expect(mapExtensionKind(undefined)).toBeUndefined();
  });

  it('collapses channel/mcp/oauth families (case-insensitively)', () => {
    expect(mapExtensionKind('wasm_channel')).toBe('channel');
    expect(mapExtensionKind('CHANNEL')).toBe('channel');
    expect(mapExtensionKind('mcp_server')).toBe('mcp');
    expect(mapExtensionKind('oauth_provider')).toBe('oauth');
  });

  it('passes other kinds through lowercased', () => {
    expect(mapExtensionKind('wasm_tool')).toBe('wasm_tool');
    expect(mapExtensionKind('Builtin')).toBe('builtin');
  });
});

describe('findFrameEnd', () => {
  it('returns -1 when no frame delimiter is buffered', () => {
    expect(findFrameEnd('data: x')).toBe(-1);
    expect(findFrameEnd('')).toBe(-1);
  });

  it('finds an LF-LF delimiter', () => {
    expect(findFrameEnd('ab\n\ncd')).toBe(2);
  });

  it('finds a CRLF-CRLF delimiter', () => {
    expect(findFrameEnd('ab\r\n\r\ncd')).toBe(2);
  });

  it('returns the earliest delimiter when both kinds are present', () => {
    expect(findFrameEnd('a\n\nb\r\n\r\nc')).toBe(1); // LF earlier
    expect(findFrameEnd('a\r\n\r\nb\n\nc')).toBe(1); // CRLF earlier
  });
});

describe('parseSseFrame', () => {
  it('parses a lone data line and strips one leading space', () => {
    expect(parseSseFrame('data: hello')).toEqual({ event: 'message', data: 'hello' });
  });

  it('reads an explicit event field', () => {
    expect(parseSseFrame('event: tool\ndata: {"x":1}')).toEqual({
      event: 'tool',
      data: '{"x":1}'
    });
  });

  it('joins multi-line data with newlines', () => {
    expect(parseSseFrame('data: line1\ndata: line2')).toEqual({
      event: 'message',
      data: 'line1\nline2'
    });
  });

  it('only strips a single leading space after the colon', () => {
    expect(parseSseFrame('data:  two')).toEqual({ event: 'message', data: ' two' });
    expect(parseSseFrame('data:nospace')).toEqual({ event: 'message', data: 'nospace' });
  });

  it('ignores comments, id, and retry fields', () => {
    expect(parseSseFrame('id: 5\ndata: x\nretry: 100')).toEqual({ event: 'message', data: 'x' });
  });

  it('returns null for a comment-only or empty frame', () => {
    expect(parseSseFrame(':heartbeat')).toBeNull();
    expect(parseSseFrame('')).toBeNull();
  });

  it('treats an empty data value as a present (empty) data line', () => {
    expect(parseSseFrame('data:')).toEqual({ event: 'message', data: '' });
  });
});
