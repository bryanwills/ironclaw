// R105 — "Draft a reply": the Chief of Staff drafts to send.
//
// Sibling of the briefing/triage stores. Takes the active thread's
// transcript plus an optional instruction ("reply declining", "follow up
// asking for the timeline") and runs a ONE-OFF completion under the Chief
// of Staff persona to produce a single finished draft in the user's voice
// (R105 `buildDraftPrompt`). Principle #4 (draft to send) made concrete,
// and the natural follow-through for triage's "Can handle" bucket.
//
// Read-only with respect to the conversation: it never posts the draft into
// the thread or mutates the transcript — the user copies what they want.
// Re-invoking cancels any in-flight run. The `instruction` is store-owned so
// the panel can edit it and "Regenerate" re-runs with the same transcript.

import type { ChatEvent } from '$lib/api/types';
import { DEFAULT_PERSONA_ID, getPersona } from '$lib/data/personas';
import { buildDraftPrompt, type DraftMessage } from '$lib/util/draft';

/** Structural client slice (mirrors `IronClawClient.streamResponse`). */
export interface DraftClient {
  streamResponse(
    prompt: string,
    threadId: string | null,
    signal?: AbortSignal,
    systemPrompt?: string
  ): AsyncIterable<ChatEvent>;
}

class DraftStore {
  /** Panel visibility. */
  open = $state<boolean>(false);
  /** True while the draft streams. */
  loading = $state<boolean>(false);
  /** Last error, surfaced inline. */
  error = $state<string | null>(null);
  /** The generated draft (markdown / plain). */
  draft = $state<string>('');
  /** When the current draft finished generating (epoch ms), or null. */
  generatedAt = $state<number | null>(null);
  /** What to write — editable in the panel; persists across regenerate. */
  instruction = $state<string>('');
  /** Human label of the thread being drafted for (panel header context). */
  threadLabel = $state<string | null>(null);

  private abort: AbortController | null = null;

  /**
   * Generate a draft from `transcript`, using the current `instruction`.
   * Opens the panel, streams a one-off completion under the CoS persona (no
   * thread side effects), and lands the text in `draft`. Re-invoking cancels
   * any in-flight run. Never throws — errors land in `error`. Leaves
   * `instruction` + `threadLabel` untouched so the panel can edit + rerun.
   */
  async generate(transcript: DraftMessage[], client: DraftClient): Promise<void> {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;

    this.open = true;
    this.error = null;
    this.draft = '';
    this.generatedAt = null;
    this.loading = true;

    const persona = getPersona(DEFAULT_PERSONA_ID);
    const instructions = persona?.systemPrompt;
    const prompt = buildDraftPrompt({
      instruction: this.instruction.trim() || undefined,
      transcript
    });

    try {
      let out = '';
      for await (const ev of client.streamResponse(prompt, null, abort.signal, instructions)) {
        // A newer run (or close()) may have aborted this one mid-stream;
        // stop writing so a stale run can't clobber newer output. (Review P1.)
        if (abort.signal.aborted) return;
        if (ev.type === 'content_delta') {
          out += ev.delta;
          this.draft = out;
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      }
      if (abort.signal.aborted) return;
      this.draft = out || '(the model returned an empty draft)';
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
    // Reset the editable bits so the next Draft starts fresh.
    this.instruction = '';
    this.threadLabel = null;
    this.draft = '';
    this.error = null;
  }
}

/** Global singleton. */
export const draft = new DraftStore();
