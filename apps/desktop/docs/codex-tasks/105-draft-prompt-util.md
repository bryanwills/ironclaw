# R105 — chief-of-staff "draft to send" prompt assembler util

**Lane**: A26 (codex). **Branch**: `codex/r105-draft-prompt-util`.
Pure TS + Vitest. No gateway, client, Svelte, or Rust. Data layer for a
"Draft a reply" action: the Chief of Staff persona writes a finished,
ready-to-send draft in the user's voice, grounded in the thread so far.

Sibling of `src/lib/util/briefing.ts` (R99) and `triage.ts` (R102); same
shape + quality bar. Define local structural input types.

## Owned files (exclusive)
- `src/lib/util/draft.ts` — NEW.
- `src/lib/util/draft.test.ts` — NEW.

## Forbidden
Everything else.

## API
```ts
export interface DraftMessage {
  /** "user" | "assistant" (or any role string the caller passes). */
  role: string;
  content: string;
}
export interface DraftInput {
  /**
   * What to write, in the user's words ("reply declining the meeting",
   * "follow up asking for the revised timeline"). Optional — when absent,
   * the agent infers the most likely needed reply from the transcript.
   */
  instruction?: string;
  /** The conversation so far, oldest-first. The util caps to the last N. */
  transcript: DraftMessage[];
  /** Max transcript messages to include, most-recent kept (default 20). */
  maxMessages?: number;
}

/**
 * Build the prompt sent to the Chief of Staff persona to produce a single
 * finished draft, ready to send, in the user's voice. The output must
 * instruct the agent to:
 *   - return ONLY the draft body (no preamble, no "here's a draft", no
 *     options), matching the register of the conversation;
 *   - be concrete and direct; never pad;
 *   - if key facts are missing, make reasonable assumptions and note them
 *     in a single line prefixed "Assumptions:" AFTER the draft;
 *   - if there is nothing to go on (empty transcript AND no instruction),
 *     ask in one line what the user wants drafted.
 *
 * - Includes the (capped) transcript, oldest-first, each line labeled by role.
 * - Includes the instruction when provided.
 * - Never throws. Trims/normalizes empty content lines.
 */
export function buildDraftPrompt(input: DraftInput): string;
```

## Acceptance
`npx vitest run src/lib/util/draft.test.ts` green:
- Output is non-empty and instructs "return only the draft" (no preamble).
- The instruction appears when provided.
- Transcript is included oldest-first and capped to `maxMessages`
  (keeping the most recent messages).
- Empty transcript + no instruction → a prompt that tells the agent to ask
  what to draft.
- Role labels appear for each included message; empty-content messages are
  dropped, not rendered blank.
- `npm run check` clean. No `any`, no `console.log`, no non-stdlib imports.
