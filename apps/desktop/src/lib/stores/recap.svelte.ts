// R89 — non-destructive thread recap.
//
// "Catch me up on this thread." Generates a dense summary of the whole
// conversation via the R85 summarize util fed by a ONE-OFF completion
// (the same non-thread `streamResponse(prompt, null)` path the Council
// uses), and shows it in a dismissable panel. This is a READING AID — it
// never mutates the transcript and never sends anything into the thread.
// (Context-window folding that replaces old turns is a separate, deeper
// feature; this is the safe, useful slice.)

import type { ChatEvent } from '$lib/api/types';
import { summarizeHistory, type SummarizableMessage } from '$lib/util/summarize';
import type { ThreadStats } from '$lib/util/thread-stats';

/** The slice of the IronClaw client this store needs. Structural so the
 *  tests can inject a fake (mirrors `IronClawClient.streamResponse`). */
export interface RecapClient {
  streamResponse(
    prompt: string,
    threadId: string | null,
    signal?: AbortSignal
  ): AsyncIterable<ChatEvent>;
}

class RecapStore {
  /** Panel visibility. */
  open = $state<boolean>(false);
  /** True while the summary completion streams. */
  loading = $state<boolean>(false);
  /** Last error, surfaced inline in the panel. */
  error = $state<string | null>(null);
  /** The generated recap text. */
  summary = $state<string>('');
  /** At-a-glance stats for the thread (R92), set by the caller from the
   *  same history it hands to generate(). Null until computed. */
  stats = $state<ThreadStats | null>(null);
  /** Which thread the current recap is for (so a stale panel can tell). */
  threadId = $state<string | null>(null);

  private abort: AbortController | null = null;

  /**
   * Generate a recap of `messages` for `threadId`. Opens the panel,
   * streams a one-off completion (no thread side effects), and lands the
   * text in `summary`. Re-invoking cancels any in-flight run.
   */
  async generate(
    threadId: string,
    messages: SummarizableMessage[],
    client: RecapClient
  ): Promise<void> {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;

    this.open = true;
    this.threadId = threadId;
    this.error = null;
    this.summary = '';

    if (messages.length === 0) {
      this.error = 'Nothing to recap yet.';
      // Clear loading on this early exit too — the caller (onRecap) sets
      // loading=true before calling us to show a spinner during the
      // history fetch, and this branch returns before the try/finally
      // that would otherwise reset it. Without this the panel spins
      // forever and never surfaces the error. (Review P1.)
      this.loading = false;
      return;
    }

    this.loading = true;
    try {
      const send = async (prompt: string): Promise<string> => {
        let out = '';
        for await (const ev of client.streamResponse(prompt, null, abort.signal)) {
          if (ev.type === 'content_delta') out += ev.delta;
          else if (ev.type === 'error') throw new Error(ev.message);
        }
        return out;
      };
      // keepRecent: 0 folds the ENTIRE thread — a recap covers everything.
      const { summary } = await summarizeHistory(send, messages, { keepRecent: 0 });
      if (abort.signal.aborted) return;
      this.summary = summary || '(the model returned an empty summary)';
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
    this.stats = null;
  }
}

/** Global singleton. */
export const recap = new RecapStore();
