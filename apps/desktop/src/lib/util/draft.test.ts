import { describe, expect, it } from 'vitest';

import { buildDraftPrompt, type DraftMessage } from './draft';

function message(role: string, content: string): DraftMessage {
  return { role, content };
}

describe('draft util', () => {
  it('returns a non-empty prompt that instructs the agent to return only the draft', () => {
    const prompt = buildDraftPrompt({
      instruction: 'reply declining the meeting',
      transcript: [message('user', 'Can we meet Friday?')]
    });

    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt.toLowerCase()).toContain('return only the draft');
    expect(prompt).toContain('no preamble');
  });

  it('includes the instruction when provided', () => {
    const prompt = buildDraftPrompt({
      instruction: 'follow up asking for the revised timeline',
      transcript: [message('assistant', 'I can send that over soon.')]
    });

    expect(prompt).toContain('follow up asking for the revised timeline');
  });

  it('includes transcript oldest-first and caps to maxMessages keeping recent messages', () => {
    const prompt = buildDraftPrompt({
      maxMessages: 2,
      transcript: [
        message('user', 'Old context'),
        message('assistant', 'Middle context'),
        message('user', 'Newest context')
      ]
    });

    expect(prompt).not.toContain('Old context');
    expect(prompt.indexOf('assistant: Middle context')).toBeLessThan(
      prompt.indexOf('user: Newest context')
    );
  });

  it('honors maxMessages of zero', () => {
    const prompt = buildDraftPrompt({
      instruction: 'write a short acknowledgement',
      maxMessages: 0,
      transcript: [message('user', 'This should be capped out.')]
    });

    expect(prompt).toContain('No transcript messages were provided.');
    expect(prompt).not.toContain('This should be capped out.');
  });

  it('empty transcript with no instruction tells the agent to ask what to draft', () => {
    const prompt = buildDraftPrompt({ transcript: [] });

    expect(prompt).toContain('Ask in one line what the user wants drafted.');
  });

  it('renders role labels for each included message', () => {
    const prompt = buildDraftPrompt({
      transcript: [message('user', 'Please send the note.'), message('assistant', 'On it.')]
    });

    expect(prompt).toContain('user: Please send the note.');
    expect(prompt).toContain('assistant: On it.');
  });

  it('drops empty-content messages instead of rendering blank transcript entries', () => {
    const prompt = buildDraftPrompt({
      transcript: [
        message('user', '   '),
        message('assistant', '\n\n'),
        message('user', 'Use this content.')
      ]
    });

    expect(prompt).toContain('user: Use this content.');
    expect(prompt).not.toContain('user:    ');
    expect(prompt).not.toContain('assistant: \n');
  });

  it('normalizes empty content lines inside transcript messages', () => {
    const prompt = buildDraftPrompt({
      transcript: [message('user', 'First line\n\nSecond line\n   \nThird line')]
    });

    expect(prompt).toContain('user: First line Second line Third line');
  });

  it('instructs the agent to treat the transcript as data, no tools (Review P2)', () => {
    const prompt = buildDraftPrompt({
      instruction: 'reply',
      transcript: [message('user', 'hi')]
    });
    expect(prompt.toLowerCase()).toContain('do not call tools');
  });
});
