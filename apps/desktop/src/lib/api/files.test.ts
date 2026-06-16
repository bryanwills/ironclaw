// Unit tests for the PURE export-formatting helpers in api/files.ts (R4b /
// R61 / R87 — conversation export). The IPC-coupled functions (saveTextDialog,
// exportSettings, importSettings, exportToNotes, exportMemoryTree) are left to
// integration; here we cover the deterministic builders/sanitizers. Importing
// the module is safe — `@tauri-apps/api/core` invoke is stubbed by the global
// setup and `$lib/util/html-export` is a pure string builder.

import { describe, expect, it } from 'vitest';
import {
  sanitizeFilenameStem,
  todayStamp,
  buildThreadJsonShape,
  buildThreadJsonText,
  buildThreadMarkdown,
  buildThreadHtml
} from './files';
import type { Thread, Message } from './types';

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    title: 'My Thread',
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-02T00:00:00Z',
    message_count: 2,
    ...over
  };
}

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    role: 'user',
    content: 'hello',
    created_at: '2026-05-01T01:00:00Z',
    ...over
  };
}

describe('sanitizeFilenameStem', () => {
  it('passes a clean title through unchanged', () => {
    expect(sanitizeFilenameStem('My Chat')).toBe('My Chat');
  });

  it('collapses a run of OS-hostile characters to a single hyphen', () => {
    expect(sanitizeFilenameStem('a///b')).toBe('a-b');
    expect(sanitizeFilenameStem('a:b')).toBe('a-b');
    expect(sanitizeFilenameStem('a\n\tb')).toBe('a-b');
  });

  it('collapses internal whitespace to a single space', () => {
    expect(sanitizeFilenameStem('a   b')).toBe('a b');
  });

  it('falls back when the result is empty', () => {
    expect(sanitizeFilenameStem('')).toBe('conversation');
    expect(sanitizeFilenameStem('   ')).toBe('conversation');
    expect(sanitizeFilenameStem('', 'custom')).toBe('custom');
  });

  it('truncates to 80 characters', () => {
    expect(sanitizeFilenameStem('a'.repeat(200))).toHaveLength(80);
  });
});

describe('todayStamp', () => {
  it('formats a date as YYYY-MM-DD with zero-padding', () => {
    expect(todayStamp(new Date(2026, 4, 9))).toBe('2026-05-09');
    expect(todayStamp(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(todayStamp(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('buildThreadJsonShape', () => {
  it('emits only the canonical thread fields (drops message_count)', () => {
    const shape = buildThreadJsonShape(thread(), [msg()]);
    expect(shape.thread).toEqual({
      id: 't1',
      title: 'My Thread',
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-02T00:00:00Z'
    });
  });

  it('maps each message to the canonical fields and stamps exported_at', () => {
    const shape = buildThreadJsonShape(thread(), [
      msg({ id: 'm1', role: 'user', content: 'hi' }),
      msg({ id: 'm2', role: 'assistant', content: 'yo' })
    ]);
    expect(shape.messages).toEqual([
      { id: 'm1', role: 'user', content: 'hi', created_at: '2026-05-01T01:00:00Z' },
      { id: 'm2', role: 'assistant', content: 'yo', created_at: '2026-05-01T01:00:00Z' }
    ]);
    expect(typeof shape.exported_at).toBe('string');
  });
});

describe('buildThreadJsonText', () => {
  it('serializes the shape as pretty-printed, round-trippable JSON', () => {
    const text = buildThreadJsonText(thread(), [msg()]);
    expect(text).toContain('\n  '); // 2-space indentation
    const parsed = JSON.parse(text);
    expect(parsed.thread.id).toBe('t1');
    expect(parsed.messages).toHaveLength(1);
  });
});

describe('buildThreadMarkdown', () => {
  it('opens with the title heading and an export stamp', () => {
    const md = buildThreadMarkdown(thread({ title: 'My Thread' }), []);
    expect(md.startsWith('# My Thread')).toBe(true);
    expect(md).toContain('_Exported ');
  });

  it('falls back to "Untitled conversation" for a blank title', () => {
    expect(
      buildThreadMarkdown(thread({ title: '   ' }), []).startsWith('# Untitled conversation')
    ).toBe(true);
  });

  it('renders user, assistant, and tool turns with their headings', () => {
    const md = buildThreadMarkdown(thread(), [
      msg({ id: 'm1', role: 'user', content: 'hi there' }),
      msg({ id: 'm2', role: 'assistant', content: 'hello back' }),
      msg({ id: 'm3', role: 'tool', content: 'tool output' })
    ]);
    expect(md).toContain('## User · 2026-05-01T01:00:00Z');
    expect(md).toContain('hi there');
    expect(md).toContain('## Assistant · ');
    expect(md).toContain('hello back');
    expect(md).toContain('### Tool · ');
    expect(md).toContain('```');
    expect(md).toContain('tool output');
  });

  it('trims the trailing divider and ends with a single newline', () => {
    const md = buildThreadMarkdown(thread(), [msg({ content: 'last' })]);
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('---\n')).toBe(false);
  });
});

describe('buildThreadHtml', () => {
  it('produces a non-trivial HTML string containing the title', () => {
    const html = buildThreadHtml(thread({ title: 'My Thread' }), [msg()]);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(50);
    expect(html).toContain('My Thread');
  });

  it('falls back to "Untitled conversation" for a blank title', () => {
    expect(buildThreadHtml(thread({ title: '' }), [])).toContain('Untitled conversation');
  });
});
