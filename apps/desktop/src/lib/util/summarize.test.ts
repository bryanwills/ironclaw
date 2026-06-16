import { describe, expect, it, vi } from 'vitest';

import {
  buildSummaryPrompt,
  estimateHistoryTokens,
  estimateTokens,
  shouldSummarize,
  summarizeHistory,
  type SummarizableMessage
} from './summarize';

function message(
  id: string,
  content: string,
  role: SummarizableMessage['role'] = 'user'
): SummarizableMessage {
  return { id, role, content };
}

describe('summarize util', () => {
  it('estimates empty text as 0 and longer strings higher', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBeGreaterThan(estimateTokens(''));
    expect(estimateTokens('a'.repeat(20))).toBeGreaterThan(estimateTokens('a'.repeat(8)));
  });

  it('sums estimated tokens across history content', () => {
    const messages = [message('1', 'a'.repeat(4)), message('2', 'b'.repeat(8), 'assistant')];

    expect(estimateHistoryTokens(messages)).toBe(3);
  });

  it('does not summarize tiny history', () => {
    expect(shouldSummarize([message('1', 'hello')], { thresholdTokens: 10, keepRecent: 0 })).toBe(
      false
    );
  });

  it('summarizes once foldable content exceeds the threshold', () => {
    const thresholdTokens = 20;
    const messages = Array.from({ length: 5 }, (_, index) =>
      message(String(index), 'x'.repeat(24))
    );

    expect(shouldSummarize(messages, { thresholdTokens, keepRecent: 0 })).toBe(true);
  });

  it('ignores the last keepRecent messages', () => {
    const messages = [
      message('old', 'x'.repeat(4)),
      message('recent-1', 'x'.repeat(200)),
      message('recent-2', 'x'.repeat(200))
    ];

    expect(shouldSummarize(messages, { thresholdTokens: 10, keepRecent: 2 })).toBe(false);
    expect(shouldSummarize(messages, { thresholdTokens: 10, keepRecent: 0 })).toBe(true);
  });

  it('builds a summary prompt with role markers and ordered message content', () => {
    const messages = [
      message('1', 'Need compact context.', 'user'),
      message('2', 'Decision: keep recent turns.', 'assistant'),
      message('3', 'Tool output here.', 'tool')
    ];

    const prompt = buildSummaryPrompt(messages);

    expect(prompt).toContain('dense factual summary');
    expect(prompt).toContain('No preamble and no meta-commentary');
    expect(prompt).toContain('<user>');
    expect(prompt).toContain('Need compact context.');
    expect(prompt).toContain('<assistant>');
    expect(prompt).toContain('Decision: keep recent turns.');
    expect(prompt).toContain('<tool>');
    expect(prompt).toContain('Tool output here.');
    expect(prompt.indexOf('Need compact context.')).toBeLessThan(
      prompt.indexOf('Decision: keep recent turns.')
    );
    expect(prompt.indexOf('Decision: keep recent turns.')).toBeLessThan(
      prompt.indexOf('Tool output here.')
    );
  });

  it('summarizes folded messages, trims the response, and returns replaced ids', async () => {
    const messages = [
      message('1', 'one'),
      message('2', 'two', 'assistant'),
      message('3', 'three'),
      message('4', 'four', 'assistant'),
      message('5', 'five')
    ];
    const send = vi.fn(async (_prompt: string) => '  compact summary  \n');

    await expect(summarizeHistory(send, messages, { keepRecent: 2 })).resolves.toEqual({
      summary: 'compact summary',
      replacedIds: ['1', '2', '3']
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toContain('one');
    expect(send.mock.calls[0][0]).toContain('three');
    expect(send.mock.calls[0][0]).not.toContain('four');
  });

  it('does not call send when every message fits in keepRecent', async () => {
    const send = vi.fn(async (_prompt: string) => 'unused');

    await expect(
      summarizeHistory(send, [message('1', 'one'), message('2', 'two')], { keepRecent: 2 })
    ).resolves.toEqual({
      summary: '',
      replacedIds: []
    });
    expect(send).not.toHaveBeenCalled();
  });
});
