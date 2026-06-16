// Tests for messagesFromTimeline — the pure projection from server timeline
// records to UI messages. Guards the Codex-P1 fix: records without a server
// message_id must each keep a unique id (they used to collapse to a shared
// `msg-undefined` and get dropped by dedupe), while genuine duplicate
// message_ids still dedupe.

import { describe, expect, it } from 'vitest';
import { messagesFromTimeline } from './reborn';

describe('messagesFromTimeline', () => {
  it('keeps every id-less record (no msg-undefined collision / data loss)', () => {
    const out = messagesFromTimeline([
      { kind: 'assistant_message', content: 'first' },
      { kind: 'assistant_message', content: 'second' },
      { kind: 'assistant_message', content: 'third' }
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.content)).toEqual(['first', 'second', 'third']);
    expect(new Set(out.map((m) => m.id)).size).toBe(3); // unique ids
  });

  it('still dedupes records that share a real message_id', () => {
    const out = messagesFromTimeline([
      { kind: 'assistant_message', message_id: 'm1', content: 'a' },
      { kind: 'assistant_message', message_id: 'm1', content: 'a-dupe' }
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('a');
  });

  it('merges pending messages alongside id-less server rows', () => {
    const out = messagesFromTimeline(
      [{ kind: 'user', content: 'srv' }],
      [{ id: 'local-1', role: 'user', content: 'pending' }]
    );
    const contents = out.map((m) => m.content);
    expect(contents).toContain('srv');
    expect(contents).toContain('pending');
  });

  it('handles null / empty records', () => {
    expect(messagesFromTimeline(null)).toEqual([]);
    expect(messagesFromTimeline([])).toEqual([]);
  });
});
