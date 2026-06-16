// R101 — "Brief me": the Chief of Staff daily brief.
//
// Assembles the user's recent threads (R99 `buildBriefingPrompt`) plus the
// commitments tracked in the open-loops store, then runs that prompt as a
// ONE-OFF completion with the Chief of Staff persona as the system prompt
// (the same non-thread `streamResponse(prompt, null, signal, instructions)`
// path Council and Recap use). The result is a prioritized morning agenda:
// greet by date, summarize what's active, restate open loops, propose the
// top-3 priorities with a one-line rationale each.
//
// This is a READING AID. It never creates or mutates a thread, never sends
// anything into the transcript, and never writes to the gateway. Re-invoking
// cancels any in-flight run. Shown in a dismissable panel (BriefingPanel).

import type { ChatEvent } from '$lib/api/types';
import { DEFAULT_PERSONA_ID, getPersona } from '$lib/data/personas';
import { buildBriefingPrompt, type BriefingThread } from '$lib/util/briefing';

/** The slice of the IronClaw client this store needs. Structural so tests
 *  can inject a fake (mirrors `IronClawClient.streamResponse`, including the
 *  R43 per-call `systemPrompt` override used to apply the CoS persona). */
export interface BriefingClient {
  streamResponse(
    prompt: string,
    threadId: string | null,
    signal?: AbortSignal,
    systemPrompt?: string
  ): AsyncIterable<ChatEvent>;
}

/** Everything the brief is assembled from. The caller gathers threads from
 *  the thread list and open loops from the open-loops store. */
export interface BriefingContext {
  threads: BriefingThread[];
  openLoops: string[];
}

class BriefingStore {
  /** Panel visibility. */
  open = $state<boolean>(false);
  /** True while the brief streams. */
  loading = $state<boolean>(false);
  /** Last error, surfaced inline in the panel. */
  error = $state<string | null>(null);
  /** The generated brief (markdown). */
  brief = $state<string>('');
  /** When the current brief finished generating (epoch ms), or null. */
  generatedAt = $state<number | null>(null);

  private abort: AbortController | null = null;

  /**
   * Generate the daily brief from `context`. Opens the panel, streams a
   * one-off completion under the Chief of Staff persona (no thread side
   * effects), and lands the text in `brief`. Re-invoking cancels any
   * in-flight run.
   *
   * Never throws: stream/parse errors land in `error`. The brief always
   * produces a valid prompt even with zero threads and zero open loops
   * (R99 falls back to a "plan my day from scratch" instruction).
   */
  async generate(context: BriefingContext, client: BriefingClient): Promise<void> {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;

    this.open = true;
    this.error = null;
    this.brief = '';
    this.generatedAt = null;
    this.loading = true;

    // The CoS persona is the system prompt; the assembled agenda request is
    // the user input. `getPersona` is total over the built-in ids, but guard
    // defensively so a future id rename can't throw here.
    const persona = getPersona(DEFAULT_PERSONA_ID);
    const instructions = persona?.systemPrompt;
    const prompt = buildBriefingPrompt({
      threads: context.threads,
      openLoops: context.openLoops
    });

    try {
      let out = '';
      for await (const ev of client.streamResponse(prompt, null, abort.signal, instructions)) {
        // A newer run (or close()) may have aborted this one mid-stream.
        // Stop writing immediately so a stale run can't clobber the newer
        // run's output. `finally` only owns `loading` via the abort guard;
        // this protects the visible text too. (Review P1.)
        if (abort.signal.aborted) return;
        if (ev.type === 'content_delta') {
          out += ev.delta;
          // Stream into the panel as it arrives.
          this.brief = out;
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      }
      if (abort.signal.aborted) return;
      this.brief = out || '(the model returned an empty brief)';
      this.generatedAt = Date.now();
    } catch (err) {
      if (!abort.signal.aborted) this.error = (err as Error).message;
    } finally {
      if (this.abort === abort) this.loading = false;
    }
  }

  close(): void {
    this.abort?.abort();
    this.open = false;
    this.loading = false;
  }
}

/** Global singleton. */
export const briefing = new BriefingStore();
