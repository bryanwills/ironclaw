import { beforeEach, describe, expect, it } from 'vitest';

import { briefing, type BriefingClient } from './briefing.svelte';
import type { ChatEvent } from '$lib/api/types';

// Records the arguments each streamResponse call was made with, then yields
// the canned events — so tests can assert the prompt + per-call system
// prompt (the CoS persona) as well as the streamed output.
interface Captured {
  prompt: string;
  threadId: string | null;
  systemPrompt: string | undefined;
}

function capturingClient(events: ChatEvent[]): { client: BriefingClient; calls: Captured[] } {
  const calls: Captured[] = [];
  const client: BriefingClient = {
    async *streamResponse(prompt, threadId, _signal, systemPrompt) {
      calls.push({ prompt, threadId, systemPrompt });
      for (const e of events) yield e;
    }
  };
  return { client, calls };
}

beforeEach(() => {
  briefing.close();
  briefing.brief = '';
  briefing.error = null;
  briefing.generatedAt = null;
});

describe('briefing store', () => {
  it('streams the brief, opens the panel, and stamps generatedAt', async () => {
    const { client } = capturingClient([
      { type: 'content_delta', delta: 'Good morning. ' },
      { type: 'content_delta', delta: 'Top priority: ship.' },
      { type: 'message_end', finish_reason: 'stop' }
    ]);
    await briefing.generate(
      {
        threads: [{ id: 't1', title: 'Launch plan', updatedAt: '2026-05-28T10:00:00Z' }],
        openLoops: ['call the vendor']
      },
      client
    );
    expect(briefing.open).toBe(true);
    expect(briefing.brief).toBe('Good morning. Top priority: ship.');
    expect(briefing.loading).toBe(false);
    expect(briefing.error).toBeNull();
    expect(briefing.generatedAt).toBeTypeOf('number');
  });

  it('runs as the Chief of Staff persona and embeds the context in the prompt', async () => {
    const { client, calls } = capturingClient([{ type: 'message_end', finish_reason: 'stop' }]);
    await briefing.generate(
      {
        threads: [{ id: 't1', title: 'Q3 roadmap', updatedAt: '2026-05-28T10:00:00Z' }],
        openLoops: ['send the budget revision']
      },
      client
    );
    expect(calls).toHaveLength(1);
    // The CoS persona is applied as the per-call system prompt (R43).
    expect(calls[0].systemPrompt?.toLowerCase()).toContain('chief of staff');
    // One-off completion — no thread side effects.
    expect(calls[0].threadId).toBeNull();
    // The assembled prompt carries the thread + open loop through.
    expect(calls[0].prompt).toContain('Q3 roadmap');
    expect(calls[0].prompt).toContain('send the budget revision');
    expect(calls[0].prompt).toContain('top 3 priorities');
  });

  it('still produces a valid fresh-start brief with no threads + no loops', async () => {
    const { client, calls } = capturingClient([
      { type: 'content_delta', delta: "Here's a plan for the day." },
      { type: 'message_end', finish_reason: 'stop' }
    ]);
    await briefing.generate({ threads: [], openLoops: [] }, client);
    expect(briefing.error).toBeNull();
    expect(briefing.brief).toBe("Here's a plan for the day.");
    expect(calls[0].prompt).toContain('fresh-start plan for the day from scratch');
  });

  it('surfaces a streamed error event as the panel error', async () => {
    const { client } = capturingClient([
      { type: 'content_delta', delta: 'partial' },
      { type: 'error', message: 'model unavailable' }
    ]);
    await briefing.generate({ threads: [], openLoops: [] }, client);
    expect(briefing.error).toBe('model unavailable');
    expect(briefing.loading).toBe(false);
  });

  it('falls back to a placeholder when the model returns nothing', async () => {
    const { client } = capturingClient([{ type: 'message_end', finish_reason: 'stop' }]);
    await briefing.generate({ threads: [], openLoops: [] }, client);
    expect(briefing.brief).toBe('(the model returned an empty brief)');
  });

  it('close() hides the panel and clears loading', () => {
    briefing.open = true;
    briefing.loading = true;
    briefing.close();
    expect(briefing.open).toBe(false);
    expect(briefing.loading).toBe(false);
  });

  // Locks in the R106 P1 fix: once a run is aborted (close, or a newer run),
  // a stale stream must stop writing instead of clobbering the panel.
  it('a stale stream stops writing after close() aborts it', async () => {
    let firstYielded!: () => void;
    const firstSeen = new Promise<void>((r) => {
      firstYielded = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const client: BriefingClient = {
      async *streamResponse() {
        yield { type: 'content_delta', delta: 'first' };
        // By the time the consumer pulls the next value, it has already
        // processed 'first' — signal the test so it can abort deterministically.
        firstYielded();
        await gate;
        yield { type: 'content_delta', delta: 'SECOND-should-not-land' };
        yield { type: 'message_end', finish_reason: 'stop' };
      }
    };

    const run = briefing.generate({ threads: [], openLoops: [] }, client);
    await firstSeen;
    expect(briefing.brief).toBe('first');
    // Abort mid-stream, then let the generator emit its second delta.
    briefing.close();
    release();
    await run;

    // The post-abort delta must not have overwritten the panel.
    expect(briefing.brief).toBe('first');
    expect(briefing.open).toBe(false);
    expect(briefing.loading).toBe(false);
  });
});
