import { beforeEach, describe, expect, it } from 'vitest';

import { triage, type TriageClient } from './triage.svelte';
import type { ChatEvent } from '$lib/api/types';

interface Captured {
  prompt: string;
  threadId: string | null;
  systemPrompt: string | undefined;
}

function capturingClient(events: ChatEvent[]): { client: TriageClient; calls: Captured[] } {
  const calls: Captured[] = [];
  const client: TriageClient = {
    async *streamResponse(prompt, threadId, _signal, systemPrompt) {
      calls.push({ prompt, threadId, systemPrompt });
      for (const e of events) yield e;
    }
  };
  return { client, calls };
}

beforeEach(() => {
  triage.close();
  triage.result = '';
  triage.error = null;
  triage.generatedAt = null;
});

describe('triage store', () => {
  it('streams the triage, opens the panel, and stamps generatedAt', async () => {
    const { client } = capturingClient([
      { type: 'content_delta', delta: 'Decision needed: ' },
      { type: 'content_delta', delta: 'approve the budget.' },
      { type: 'message_end', finish_reason: 'stop' }
    ]);
    await triage.generate(
      [{ id: 't1', title: 'Budget approval', updatedAt: '2026-05-28T10:00:00Z' }],
      client
    );
    expect(triage.open).toBe(true);
    expect(triage.result).toBe('Decision needed: approve the budget.');
    expect(triage.loading).toBe(false);
    expect(triage.error).toBeNull();
    expect(triage.generatedAt).toBeTypeOf('number');
  });

  it('runs as the Chief of Staff persona and embeds the threads + buckets', async () => {
    const { client, calls } = capturingClient([{ type: 'message_end', finish_reason: 'stop' }]);
    await triage.generate(
      [{ id: 't1', title: 'Vendor contract', updatedAt: '2026-05-28T10:00:00Z' }],
      client
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].systemPrompt?.toLowerCase()).toContain('chief of staff');
    expect(calls[0].threadId).toBeNull();
    expect(calls[0].prompt).toContain('Vendor contract');
    expect(calls[0].prompt).toContain('Decision needed');
    expect(calls[0].prompt).toContain('Can handle');
  });

  it('still produces a valid nothing-to-triage prompt with no threads', async () => {
    const { client, calls } = capturingClient([
      { type: 'content_delta', delta: 'Nothing to triage.' },
      { type: 'message_end', finish_reason: 'stop' }
    ]);
    await triage.generate([], client);
    expect(triage.error).toBeNull();
    expect(calls[0].prompt).toContain('nothing to triage');
  });

  it('surfaces a streamed error event as the panel error', async () => {
    const { client } = capturingClient([
      { type: 'content_delta', delta: 'partial' },
      { type: 'error', message: 'model unavailable' }
    ]);
    await triage.generate([], client);
    expect(triage.error).toBe('model unavailable');
    expect(triage.loading).toBe(false);
  });

  it('falls back to a placeholder when the model returns nothing', async () => {
    const { client } = capturingClient([{ type: 'message_end', finish_reason: 'stop' }]);
    await triage.generate([], client);
    expect(triage.result).toBe('(the model returned an empty triage)');
  });

  it('close() hides the panel and clears loading', () => {
    triage.open = true;
    triage.loading = true;
    triage.close();
    expect(triage.open).toBe(false);
    expect(triage.loading).toBe(false);
  });

  // R106 P1 guard: an aborted (closed / superseded) run must stop writing.
  it('a stale stream stops writing after close() aborts it', async () => {
    let firstYielded!: () => void;
    const firstSeen = new Promise<void>((r) => {
      firstYielded = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const client: TriageClient = {
      async *streamResponse() {
        yield { type: 'content_delta', delta: 'first' };
        firstYielded();
        await gate;
        yield { type: 'content_delta', delta: 'SECOND-should-not-land' };
        yield { type: 'message_end', finish_reason: 'stop' };
      }
    };

    const run = triage.generate([], client);
    await firstSeen;
    expect(triage.result).toBe('first');
    triage.close();
    release();
    await run;

    expect(triage.result).toBe('first');
    expect(triage.open).toBe(false);
    expect(triage.loading).toBe(false);
  });
});
