# R85 — Auto-summarization util (completes R68)

**Lane**: A15 (codex)
**Branch**: `codex/r85-auto-summarize-util`
**Depends on**: nothing. Pure TS + Vitest. No gateway probe needed —
the caller injects the send function.

## Context

Long threads blow the model's context window. The elite move is to
fold the oldest N messages into a compact summary stub the model can
still reason over, keeping the most recent turns verbatim. This task
ships the **pure logic only** — token estimation, the
"should we summarize yet" predicate, the meta-prompt builder, and an
injectable `summarizeHistory` that calls a caller-supplied async send
function. Claude wires this into the messages store (one site) after
merge; do not touch the store.

## Owned files (exclusive write access)

- `src/lib/util/summarize.ts` — NEW.
- `src/lib/util/summarize.test.ts` — NEW.

## Forbidden files

- `src/lib/stores/messages.svelte.ts` and every other store.
- `src/lib/api/ironclaw.ts`, `src/lib/api/types.ts` — do NOT import the
  client and do NOT add types there. Define a local `SummarizableMessage`
  interface inside `summarize.ts` (structural: `{ id: string; role:
  'user' | 'assistant' | 'tool'; content: string }`).
- All Svelte, all Rust, all routes.

## API to implement

```ts
export interface SummarizableMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

/** Cheap heuristic: ~4 chars per token. Never returns < 0. */
export function estimateTokens(text: string): number;

/** Sum of estimateTokens over every message's content. */
export function estimateHistoryTokens(messages: SummarizableMessage[]): number;

/**
 * True when the history is large enough to warrant folding. Keeps the
 * last `keepRecent` messages out of the estimate — we never summarize
 * those, so they shouldn't push us over.
 */
export function shouldSummarize(
  messages: SummarizableMessage[],
  opts?: { thresholdTokens?: number; keepRecent?: number }
): boolean; // defaults: thresholdTokens = 60_000, keepRecent = 8

/**
 * Build the meta-prompt sent to the model. Must include each message's
 * role and content in order, and instruct the model to produce a dense
 * factual summary for context handoff (decisions, open questions, key
 * facts) — no preamble, no meta-commentary.
 */
export function buildSummaryPrompt(messages: SummarizableMessage[]): string;

/**
 * Fold the oldest messages into a summary. `send` is injected so this
 * is testable with a fake and carries zero client coupling.
 *
 * - Splits `messages` into [toFold, recent] where recent = last
 *   `keepRecent` messages.
 * - If toFold is empty, returns { summary: '', replacedIds: [] } without
 *   calling send.
 * - Otherwise calls send(buildSummaryPrompt(toFold)) and returns the
 *   trimmed summary text plus replacedIds = ids of every folded message.
 */
export async function summarizeHistory(
  send: (prompt: string) => Promise<string>,
  messages: SummarizableMessage[],
  opts?: { keepRecent?: number }
): Promise<{ summary: string; replacedIds: string[] }>; // keepRecent default 8
```

## Acceptance

- `npx vitest run src/lib/util/summarize.test.ts` green with at least:
  - `estimateTokens('')` is 0; longer strings estimate higher (monotonic).
  - `shouldSummarize` false for a tiny history, true once total content
    exceeds the threshold (build a history programmatically with long
    strings rather than hardcoding 60k chars).
  - `shouldSummarize` ignores the last `keepRecent` messages.
  - `buildSummaryPrompt` output contains each message's content and a
    role marker.
  - `summarizeHistory` with `keepRecent: 2` on a 5-message history calls
    the fake send exactly once, returns `replacedIds` = the first 3 ids,
    and trims the fake's response.
  - `summarizeHistory` returns `{ summary: '', replacedIds: [] }` and does
    NOT call send when everything fits in `keepRecent`.
- `npm run check` clean (0 errors).
- No imports outside the standard library / vitest. No `any`. No
  `console.log`.

## Out of scope

- Wiring into the store or UI (Claude does this).
- Rendering the summary stub as a disclosure bubble (later, claude).
- Persisting summaries.
