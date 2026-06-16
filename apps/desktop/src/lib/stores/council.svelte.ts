// LLM Council store.
//
// Drives the /council surface: pick 2-4 providers from the gateway's
// `/api/llm/providers` registry, fire the same prompt at each, render the
// responses side-by-side, optionally promote one into a regular chat
// thread.
//
// CRITICAL CONSTRAINT (verified 2026-05-28 against the live IronClaw
// gateway): the gateway has a SINGLE active LLM provider per-process.
// `POST /api/v1/responses` does NOT accept a per-request `provider` /
// `model` override (a 400 "Model selection is not yet supported" comes
// back), and there is no documented `setActiveProvider` /
// `/api/llm/providers/<id>/activate` endpoint either. The provider
// switcher in /settings is a profile-level config that the user picks at
// connect time; it cannot be flipped per-call.
//
// What this means for the council: the fanout runs SEQUENTIALLY against
// whatever LLM the gateway is currently bound to. Every column renders
// the SAME backend's response. The provider chip shown above each
// column is informational (which catalog entry the user picked) — until
// the gateway grows a per-call provider override, the responses are not
// actually different models. The route's banner makes this explicit.
//
// This shape lets us ship the surface today + cut over to true fanout
// the day the gateway lands the override (no client refactor needed —
// the convene() loop already iterates one provider at a time and
// records the providerId on each run).
//
// Persistence: `selectedProviderIds` round-trips through localStorage
// under the well-known key so the user's pick survives reload. We
// deliberately do NOT persist the runs themselves — a council session
// is in-memory only; reload → empty grid + the saved selection.

import type { ChatEvent } from '$lib/api/types';

import { messages } from './messages.svelte';
import { threads } from './threads.svelte';
import { toasts } from './toasts.svelte';

/** localStorage key for the selected-provider-ids round-trip. */
export const COUNCIL_LS_KEY = 'ironclaw-council-providers';

/** One column in the council grid. */
export interface CouncilRun {
  providerId: string;
  prompt: string;
  /** Accumulated assistant content from the SSE stream. */
  content: string;
  /** Latency from convene-start to message_end (ms). Populated on done. */
  latencyMs: number | null;
  status: 'pending' | 'streaming' | 'done' | 'error';
  /** Error message when status === 'error'. */
  error?: string;
}

/** Minimal subset of the IronClawClient surface that the store uses.
 *  Declared so tests can pass an in-memory stub without instantiating
 *  the real client. Mirrors method shapes from `$lib/api/ironclaw`. */
export interface CouncilClient {
  streamResponse(
    input: string,
    threadId: string | null,
    signal: AbortSignal
  ): AsyncIterable<ChatEvent>;
  newThread(title?: string): Promise<{ id: string }>;
  sendMessage(
    threadId: string | null,
    content: string
  ): Promise<{ thread_id: string; message_id: string }>;
}

class CouncilStore {
  /** Provider ids the user has currently selected. Persists to
   *  localStorage on every mutation via `setSelected`. Council runs
   *  always fanout against this set in declaration order. */
  selectedProviderIds = $state<string[]>([]);

  /** Per-call run rows. One row per provider on convene(). Cleared at
   *  the start of each convene() so the previous session's columns
   *  don't bleed into the new render. */
  runs = $state<CouncilRun[]>([]);

  /** True while convene() is iterating. UI gates the Convene button on
   *  this. We don't allow a second convene mid-flight — the fanout is
   *  sequential and a re-entry would interleave streams. */
  convening = $state<boolean>(false);

  /** Panel visibility. The council is no longer a route — it's an overlay
   *  summoned from the chat composer (`/council <prompt>`). Self-gating
   *  like the recap panel. */
  open = $state<boolean>(false);

  /** Prompt seeded from the composer when the panel opens, so the panel's
   *  composer starts pre-filled with what the user typed after /council. */
  initialPrompt = $state<string>('');

  /** AbortController for the in-flight stream. Null when idle. Wired
   *  so a future Cancel button (or route teardown) can interrupt the
   *  fanout mid-column. */
  private abortController: AbortController | null = null;

  /** Open the council panel seeded with `prompt` (from the chat
   *  composer's /council command). Clears any prior session's columns so
   *  the grid starts fresh; the saved provider selection is preserved. */
  openWith(prompt: string): void {
    this.initialPrompt = prompt;
    this.runs = [];
    this.open = true;
  }

  /** Close the panel and interrupt any in-flight fanout. */
  closePanel(): void {
    this.open = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.convening = false;
  }

  /** Hydrate `selectedProviderIds` from localStorage. Idempotent. Call
   *  once when the route mounts so the first render reflects the
   *  user's saved pick. */
  hydrate(): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(COUNCIL_LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      const cleaned: string[] = [];
      for (const v of parsed) {
        if (typeof v === 'string' && v.length > 0 && !cleaned.includes(v)) {
          cleaned.push(v);
        }
      }
      this.selectedProviderIds = cleaned;
    } catch {
      // Corrupt JSON or unavailable storage — fall back to empty.
    }
  }

  /** Replace the selected ids and persist. Pulled out of `setSelected`
   *  so other code paths (toggle, clear) can share the persist hook. */
  setSelected(ids: string[]): void {
    // Dedupe + filter empties defensively so a re-entry from a buggy
    // caller can't push duplicates into the picker.
    const cleaned: string[] = [];
    for (const v of ids) {
      if (typeof v === 'string' && v.length > 0 && !cleaned.includes(v)) {
        cleaned.push(v);
      }
    }
    this.selectedProviderIds = cleaned;
    this.persist();
  }

  /** Toggle a single provider id in the selected list. Used by the
   *  picker checkboxes. */
  toggleSelected(id: string): void {
    if (!id) return;
    if (this.selectedProviderIds.includes(id)) {
      this.setSelected(this.selectedProviderIds.filter((p) => p !== id));
    } else {
      this.setSelected([...this.selectedProviderIds, id]);
    }
  }

  /** Persist the current `selectedProviderIds` to localStorage. */
  private persist(): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      window.localStorage.setItem(COUNCIL_LS_KEY, JSON.stringify(this.selectedProviderIds));
    } catch {
      // Quota / private-mode failures are non-fatal.
    }
  }

  /**
   * Fanout `prompt` against each provider in `providerIds`, sequentially.
   *
   * Each provider runs in its own column (one `CouncilRun` row), with
   * the SSE stream draining into `runs[i].content` chunk-by-chunk so
   * the UI can render incremental tokens via Svelte's reactivity. We
   * pass `threadId: null` to `streamResponse` so the gateway opens a
   * fresh ephemeral thread per call — the prompt is independent of any
   * chat surface and we don't want it polluting thread history.
   *
   * The fanout is sequential by design: the gateway's active provider
   * is global, and we don't want two concurrent streams interleaving
   * deltas onto two columns. Once the gateway lands a per-call
   * provider override (`provider: <id>` on the body), this loop can
   * become a Promise.all without touching the per-column state shape.
   *
   * Validation:
   *  - 0 providers → throws synchronously. The route already disables
   *    the Convene button in this case, but the throw is the contract
   *    the test exercises.
   *  - convening already true → silent no-op (the button is disabled
   *    in the UI so this is a defensive guard).
   *  - empty prompt → silent no-op (button disabled in UI).
   */
  async convene(prompt: string, providerIds: string[], client: CouncilClient): Promise<void> {
    if (providerIds.length === 0) {
      throw new Error('Council requires at least one provider');
    }
    if (this.convening) return;
    if (!prompt.trim()) return;

    // Seed all runs in `pending` so the columns render immediately
    // (otherwise the user stares at an empty grid for as long as the
    // first call takes to start streaming).
    this.runs = providerIds.map((id) => ({
      providerId: id,
      prompt,
      content: '',
      latencyMs: null,
      status: 'pending'
    }));
    this.convening = true;
    this.abortController = new AbortController();

    try {
      for (let i = 0; i < providerIds.length; i += 1) {
        if (this.abortController.signal.aborted) break;
        await this.runOne(i, prompt, client);
      }
    } finally {
      this.convening = false;
      this.abortController = null;
    }
  }

  /** Stream one provider's response into runs[i]. Internal — only
   *  convene() calls this. The seeded row at runs[i] is flipped to
   *  `streaming` on first delta and to `done` / `error` on completion
   *  or failure. */
  private async runOne(idx: number, prompt: string, client: CouncilClient): Promise<void> {
    const signal = this.abortController?.signal ?? new AbortController().signal;
    const startedAt = Date.now();

    // Mutate by index + replace the array reference so Svelte's
    // fine-grained reactivity picks up the row update without us
    // having to push every keystroke through a derived store.
    this.updateRun(idx, { status: 'streaming' });

    try {
      for await (const ev of client.streamResponse(prompt, null, signal)) {
        if (signal.aborted) break;
        switch (ev.type) {
          case 'content_delta': {
            // Heuristic mirrors `messages.appendStreamingChunk` — the
            // legacy `/api/chat/events` channel sends cumulative full
            // content; the Responses API sends real deltas. Both
            // paths flow through `streamResponse` (mapped onto
            // content_delta) so detect cumulative vs delta by prefix
            // match. Delta path concats; cumulative path replaces.
            const current = this.runs[idx]?.content ?? '';
            let next: string;
            if (ev.delta.startsWith(current) && ev.delta.length >= current.length) {
              next = ev.delta;
            } else {
              next = current + ev.delta;
            }
            this.updateRun(idx, { content: next });
            break;
          }
          case 'error': {
            this.updateRun(idx, {
              status: 'error',
              error: ev.message,
              latencyMs: Date.now() - startedAt
            });
            return;
          }
          // Other events (message_start, tool_call, tool_result,
          // message_end) are no-ops here — the council column only
          // renders streamed prose, not tool plumbing. Tool calls fired
          // by a council provider still execute server-side; we just
          // don't surface them in the column UI today. A future
          // enhancement could fold a tools chip in below the
          // latency footer.
          default:
            break;
        }
      }

      // Stream ended without an explicit error event. If the column
      // already moved to error / done (e.g. via an error case above
      // returning early), don't clobber it.
      const finalState = this.runs[idx]?.status;
      if (finalState === 'streaming') {
        this.updateRun(idx, {
          status: 'done',
          latencyMs: Date.now() - startedAt
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateRun(idx, {
        status: 'error',
        error: message,
        latencyMs: Date.now() - startedAt
      });
    }
  }

  /** Patch a single run by index, replacing the array reference so
   *  Svelte's reactivity picks up the mutation. No-op if `idx` is
   *  out of bounds (defensive — convene() seeds the array first so
   *  in-bound writes are guaranteed during a single fanout cycle). */
  private updateRun(idx: number, patch: Partial<CouncilRun>): void {
    const current = this.runs[idx];
    if (!current) return;
    const next = [...this.runs];
    next[idx] = { ...current, ...patch };
    this.runs = next;
  }

  /**
   * Promote `runs[idx]` into a fresh chat thread.
   *
   * Creates a new thread via `client.newThread()` titled from the
   * prompt's first line, seeds it with the user prompt via
   * `sendMessage`, then injects the assistant response into the
   * messages store so the chat surface renders the promoted answer
   * immediately on navigation. Returns the new thread id so the
   * caller can `goto('/')` with a deep link.
   *
   * The seeded assistant message is local-only (`local-asst-*`) —
   * the gateway has no API to inject a server-side assistant turn
   * today. Once the thread loads its first real history page from
   * the server (e.g. on next visit), the local seed disappears and
   * the user sees an empty thread minus their user prompt. That's a
   * known limitation; we document it in the column's promote tooltip.
   *
   * Validation:
   *  - empty runs → throws synchronously. The route's button is
   *    disabled when no runs exist; the throw is the test contract.
   *  - idx out of range → throws.
   *  - run not done → throws (UI gates this via the button's
   *    disabled state).
   */
  async promote(idx: number, client: CouncilClient): Promise<string> {
    if (this.runs.length === 0) {
      throw new Error('No council runs to promote');
    }
    if (idx < 0 || idx >= this.runs.length) {
      throw new Error(`Invalid council run index: ${idx}`);
    }
    const run = this.runs[idx];
    if (run.status !== 'done') {
      throw new Error('Can only promote a completed run');
    }

    // Title from the prompt's first line, capped at 80 chars so the
    // sidebar's thread row doesn't overflow. The trim() guard
    // matches the chat surface's own newThread title heuristic.
    const firstLine = run.prompt.split(/\r?\n/, 1)[0] ?? run.prompt;
    const title = firstLine.trim().slice(0, 80) || 'Council promotion';

    try {
      const { id: threadId } = await client.newThread(title);
      if (!threadId) {
        throw new Error('Gateway returned empty thread id');
      }

      // Seed the user prompt via the normal send path so the gateway
      // persists it. We deliberately do NOT trigger a fresh stream
      // here — the council's answer is already what the user picked,
      // and re-running would discard it.
      await client.sendMessage(threadId, run.prompt);

      // Inject the council answer as a local-only assistant message
      // so the chat surface renders the promoted answer immediately.
      // The messages store already has an `appendUserMessage` for
      // user-side rows; we mirror that pattern for the assistant side
      // by pushing onto byThread directly.
      const existing = messages.byThread[threadId] ?? [];
      const promotedLocalId = `local-council-${Date.now()}`;
      const promotedMsg = {
        id: promotedLocalId,
        role: 'assistant' as const,
        content: run.content,
        created_at: new Date().toISOString()
      };
      // Also push an optimistic user message so the chat thread reads
      // [user, assistant] without waiting for the next history refresh.
      const userLocalId = `local-${Date.now()}`;
      const userMsg = {
        id: userLocalId,
        role: 'user' as const,
        content: run.prompt,
        created_at: new Date(Date.now() - 1).toISOString()
      };
      messages.byThread = {
        ...messages.byThread,
        [threadId]: [...existing, userMsg, promotedMsg]
      };

      // Refresh the global thread list so the new thread shows up
      // in the sidebar without a manual reload.
      void threads.refresh();

      toasts.show(`Promoted ${run.providerId} into a new thread.`, 'success');
      return threadId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toasts.show(`Promote failed: ${msg}`, 'error');
      throw err;
    }
  }

  /** Reset to a clean state. Called when the user clicks "New session"
   *  (or when the route unmounts). Selection is preserved — only the
   *  in-flight runs are cleared. */
  reset(): void {
    this.runs = [];
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.convening = false;
  }
}

/** Global singleton — import this anywhere. */
export const council = new CouncilStore();
