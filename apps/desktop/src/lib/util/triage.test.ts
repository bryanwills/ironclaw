import { describe, expect, it } from 'vitest';

import { buildTriagePrompt, type TriageThread } from './triage';

function thread(
  id: string,
  title: string,
  updatedAt: string,
  opts?: { messageCount?: number; preview?: string }
): TriageThread {
  return {
    id,
    title,
    updatedAt,
    messageCount: opts?.messageCount,
    preview: opts?.preview
  };
}

describe('triage util', () => {
  const now = new Date('2026-05-28T12:00:00Z');

  it('returns a non-empty prompt naming all triage buckets', () => {
    const prompt = buildTriagePrompt({
      now,
      threads: [thread('a', 'Launch decision', '2026-05-28T10:00:00Z')]
    });

    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('Decision needed');
    expect(prompt).toContain('FYI');
    expect(prompt).toContain('Can handle');
  });

  it('sorts threads most-recently-updated first and caps to maxThreads', () => {
    const prompt = buildTriagePrompt({
      now,
      maxThreads: 2,
      threads: [
        thread('old', 'Old vendor update', '2026-05-25T09:00:00Z'),
        thread('new', 'New contract review', '2026-05-28T09:00:00Z'),
        thread('middle', 'Middle hiring plan', '2026-05-27T09:00:00Z')
      ]
    });

    expect(prompt.indexOf('New contract review')).toBeLessThan(
      prompt.indexOf('Middle hiring plan')
    );
    expect(prompt).not.toContain('Old vendor update');
  });

  it('includes each thread title and deterministic recency hint', () => {
    const prompt = buildTriagePrompt({
      now,
      threads: [
        thread('today', 'Today thread', '2026-05-28T09:00:00Z'),
        thread('earlier', 'Earlier thread', '2026-05-26T11:00:00Z')
      ]
    });

    expect(prompt).toContain('Today thread');
    expect(prompt).toContain('updated today (2026-05-28)');
    expect(prompt).toContain('Earlier thread');
    expect(prompt).toContain('updated 2 days ago (2026-05-26)');
  });

  it('includes preview when provided and omits it cleanly when not', () => {
    const prompt = buildTriagePrompt({
      now,
      threads: [
        thread('with-preview', 'With preview', '2026-05-28T09:00:00Z', {
          preview: 'Waiting on final budget approval.'
        }),
        thread('without-preview', 'Without preview', '2026-05-27T09:00:00Z')
      ]
    });

    expect(prompt).toContain('preview: Waiting on final budget approval.');
    expect(prompt).toContain('Without preview');
    expect(prompt).not.toContain('preview: )');
    expect(prompt).not.toContain('undefined');
  });

  it('includes message counts when provided', () => {
    const prompt = buildTriagePrompt({
      now,
      threads: [thread('counted', 'Thread with count', '2026-05-28T09:00:00Z', { messageCount: 7 })]
    });

    expect(prompt).toContain('7 messages');
  });

  it('empty input still yields a valid nothing-to-triage prompt', () => {
    const prompt = buildTriagePrompt({ now, threads: [] });

    expect(prompt).toContain('No recent threads were provided');
    expect(prompt).toContain('nothing to triage');
    expect(prompt).toContain('Decision needed');
    expect(prompt).toContain('FYI');
    expect(prompt).toContain('Can handle');
  });

  it('does not throw for unparseable updatedAt and sorts it last', () => {
    const build = () =>
      buildTriagePrompt({
        now,
        threads: [
          thread('bad', 'Broken timestamp', 'not-a-date'),
          thread('good', 'Valid timestamp', '2026-05-28T09:00:00Z')
        ]
      });

    expect(build).not.toThrow();

    const prompt = build();
    expect(prompt.indexOf('Valid timestamp')).toBeLessThan(prompt.indexOf('Broken timestamp'));
    expect(prompt).toContain('recency unknown; updatedAt unparseable');
  });

  it('instructs the agent to treat thread text as data, no tools (Review P2)', () => {
    const prompt = buildTriagePrompt({ now, threads: [] });
    expect(prompt.toLowerCase()).toContain('do not call tools');
  });
});
