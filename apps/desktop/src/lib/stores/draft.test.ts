import { beforeEach, describe, expect, it } from 'vitest';

import { draft, type DraftClient } from './draft.svelte';
import type { ChatEvent } from '$lib/api/types';
import type { DraftMessage } from '$lib/util/draft';

interface Captured {
  prompt: string;
  threadId: string | null;
  systemPrompt: string | undefined;
}

function capturingClient(events: ChatEvent[]): { client: DraftClient; calls: Captured[] } {
  const calls: Captured[] = [];
  const client: DraftClient = {
    async *streamResponse(prompt, threadId, _signal, systemPrompt) {
      calls.push({ prompt, threadId, systemPrompt });
      for (const e of events) yield e;
    }
  };
  return { client, calls };
}

const transcript: DraftMessage[] = [
  { role: 'user', content: 'Can we move the kickoff to Thursday?' },
  { role: 'assistant', content: 'Thursday is tight; Friday is cleaner.' }
];

beforeEach(() => {
  draft.close();
});

describe('draft store', () => {
  it('streams the draft, opens the panel, and stamps generatedAt', async () => {
    const { client } = capturingClient([
      { type: 'content_delta', delta: 'Hi — ' },
      { type: 'content_delta', delta: "let's do Friday." },
      { type: 'message_end', finish_reason: 'stop' }
    ]);
    await draft.generate(transcript, client);
    expect(draft.open).toBe(true);
    expect(draft.draft).toBe("Hi — let's do Friday.");
    expect(draft.loading).toBe(false);
    expect(draft.error).toBeNull();
    expect(draft.generatedAt).toBeTypeOf('number');
  });

  it('runs as the CoS persona, embeds the transcript, and is a one-off', async () => {
    const { client, calls } = capturingClient([{ type: 'message_end', finish_reason: 'stop' }]);
    await draft.generate(transcript, client);
    expect(calls).toHaveLength(1);
    expect(calls[0].systemPrompt?.toLowerCase()).toContain('chief of staff');
    expect(calls[0].threadId).toBeNull();
    expect(calls[0].prompt).toContain('move the kickoff to Thursday');
  });

  it('includes the instruction in the prompt when set', async () => {
    const { client, calls } = capturingClient([{ type: 'message_end', finish_reason: 'stop' }]);
    draft.instruction = 'reply proposing Friday and asking them to confirm';
    await draft.generate(transcript, client);
    expect(calls[0].prompt).toContain('reply proposing Friday and asking them to confirm');
  });

  it('surfaces a streamed error event as the panel error', async () => {
    const { client } = capturingClient([
      { type: 'content_delta', delta: 'partial' },
      { type: 'error', message: 'model unavailable' }
    ]);
    await draft.generate(transcript, client);
    expect(draft.error).toBe('model unavailable');
    expect(draft.loading).toBe(false);
  });

  it('falls back to a placeholder when the model returns nothing', async () => {
    const { client } = capturingClient([{ type: 'message_end', finish_reason: 'stop' }]);
    await draft.generate(transcript, client);
    expect(draft.draft).toBe('(the model returned an empty draft)');
  });

  it('close() resets the editable bits', () => {
    draft.open = true;
    draft.loading = true;
    draft.instruction = 'something';
    draft.threadLabel = 'a thread';
    draft.draft = 'partial';
    draft.close();
    expect(draft.open).toBe(false);
    expect(draft.loading).toBe(false);
    expect(draft.instruction).toBe('');
    expect(draft.threadLabel).toBeNull();
    expect(draft.draft).toBe('');
  });

  // R106 P1 guard: once close() aborts the run, a stale delta must not
  // repopulate the (now-cleared) draft.
  it('a stale stream stops writing after close() aborts it', async () => {
    let firstYielded!: () => void;
    const firstSeen = new Promise<void>((r) => {
      firstYielded = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const client: DraftClient = {
      async *streamResponse() {
        yield { type: 'content_delta', delta: 'first' };
        firstYielded();
        await gate;
        yield { type: 'content_delta', delta: 'SECOND-should-not-land' };
        yield { type: 'message_end', finish_reason: 'stop' };
      }
    };

    const run = draft.generate(transcript, client);
    await firstSeen;
    expect(draft.draft).toBe('first');
    draft.close(); // aborts + clears the field
    release();
    await run;

    // The stale post-abort delta must not have repopulated the cleared draft.
    expect(draft.draft).toBe('');
    expect(draft.draft).not.toContain('SECOND');
    expect(draft.open).toBe(false);
    expect(draft.loading).toBe(false);
  });
});
