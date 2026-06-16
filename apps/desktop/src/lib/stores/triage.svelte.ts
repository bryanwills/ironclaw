// R104 — "Triage my threads": the Chief of Staff executive filter.
//
// Sibling of the briefing store. Takes the user's recent threads (R102
// `buildTriagePrompt`) and runs them as a ONE-OFF completion under the
// Chief of Staff persona, asking the agent to sort each thread into
// "Decision needed", "FYI", or "Can handle" with a one-line reason + a
// suggested next action. The output is grouped by bucket, most urgent
// first — principle #2 (executive filter) made concrete.
//
// Read-only, like Recap and the daily brief: it never creates or mutates
// a thread, never posts into the transcript, and never writes to the
// gateway. Re-invoking cancels any in-flight run. Shown in a dismissable
// panel (TriagePanel).

import type { ChatEvent } from '$lib/api/types';
import { DEFAULT_PERSONA_ID, getPersona } from '$lib/data/personas';
import { buildTriagePrompt, type TriageThread } from '$lib/util/triage';

/** The slice of the IronClaw client this store needs. Structural so tests
 *  can inject a fake (mirrors `IronClawClient.streamResponse`, including the
 *  R43 per-call `systemPrompt` override used to apply the CoS persona). */
export interface TriageClient {
  streamResponse(
    prompt: string,
    threadId: string | null,
    signal?: AbortSignal,
    systemPrompt?: string
  ): AsyncIterable<ChatEvent>;
}

class TriageStore {
  /** Panel visibility. */
  open = $state<boolean>(false);
  /** True while the triage streams. */
  loading = $state<boolean>(false);
  /** Last error, surfaced inline in the panel. */
  error = $state<string | null>(null);
  /** The generated triage (markdown). */
  result = $state<string>('');
  /** When the current triage finished generating (epoch ms), or null. */
  generatedAt = $state<number | null>(null);

  private abort: AbortController | null = null;

  /**
   * Triage `threads`. Opens the panel, streams a one-off completion under
   * the Chief of Staff persona (no thread side effects), and lands the text
   * in `result`. Re-invoking cancels any in-flight run.
   *
   * Never throws: stream/parse errors land in `error`. An empty thread list
   * still produces a valid prompt (R102 falls back to a one-line
   * "nothing to triage" instruction).
   */
  async generate(threads: TriageThread[], client: TriageClient): Promise<void> {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;

    this.open = true;
    this.error = null;
    this.result = '';
    this.generatedAt = null;
    this.loading = true;

    const persona = getPersona(DEFAULT_PERSONA_ID);
    const instructions = persona?.systemPrompt;
    const prompt = buildTriagePrompt({ threads });

    try {
      let out = '';
      for await (const ev of client.streamResponse(prompt, null, abort.signal, instructions)) {
        // A newer run (or close()) may have aborted this one mid-stream;
        // stop writing so a stale run can't clobber newer output. (Review P1.)
        if (abort.signal.aborted) return;
        if (ev.type === 'content_delta') {
          out += ev.delta;
          this.result = out;
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      }
      if (abort.signal.aborted) return;
      this.result = out || '(the model returned an empty triage)';
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
export const triage = new TriageStore();
