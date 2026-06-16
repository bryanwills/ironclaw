import { beforeEach, describe, expect, it } from 'vitest';
import { recap, type RecapClient } from './recap.svelte';
import type { ChatEvent } from '$lib/api/types';

// A fake client whose streamResponse yields the given events.
function clientYielding(events: ChatEvent[]): RecapClient {
  return {
    async *streamResponse() {
      for (const e of events) yield e;
    }
  };
}

function msgs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `message ${i} body`
  }));
}

beforeEach(() => {
  recap.close();
  recap.summary = '';
  recap.error = null;
});

describe('recap store', () => {
  it('accumulates content_delta into the summary and opens the panel', async () => {
    const client = clientYielding([
      { type: 'content_delta', delta: 'Recap: ' },
      { type: 'content_delta', delta: 'they discussed X' },
      { type: 'message_end', finish_reason: 'stop' }
    ]);
    await recap.generate('thr-1', msgs(4), client);
    expect(recap.open).toBe(true);
    expect(recap.threadId).toBe('thr-1');
    expect(recap.summary).toBe('Recap: they discussed X');
    expect(recap.loading).toBe(false);
    expect(recap.error).toBeNull();
  });

  it('sets an error and skips the call when there are no messages', async () => {
    const client = clientYielding([{ type: 'content_delta', delta: 'nope' }]);
    // Mirror the real caller (onRecap), which flips loading on before
    // calling generate to show a spinner during the history fetch. The
    // empty-thread early-return must still clear it (review P1 regression).
    recap.loading = true;
    await recap.generate('thr-2', [], client);
    expect(recap.error).toBe('Nothing to recap yet.');
    expect(recap.summary).toBe('');
    expect(recap.loading).toBe(false);
  });

  it('surfaces a streamed error event as the panel error', async () => {
    const client = clientYielding([
      { type: 'content_delta', delta: 'partial' },
      { type: 'error', message: 'model unavailable' }
    ]);
    await recap.generate('thr-3', msgs(2), client);
    expect(recap.error).toBe('model unavailable');
    expect(recap.loading).toBe(false);
  });

  it('falls back to a placeholder when the model returns nothing', async () => {
    const client = clientYielding([{ type: 'message_end', finish_reason: 'stop' }]);
    await recap.generate('thr-4', msgs(2), client);
    expect(recap.summary).toBe('(the model returned an empty summary)');
  });

  it('close() hides the panel and clears loading', () => {
    recap.open = true;
    recap.loading = true;
    recap.close();
    expect(recap.open).toBe(false);
    expect(recap.loading).toBe(false);
  });
});
