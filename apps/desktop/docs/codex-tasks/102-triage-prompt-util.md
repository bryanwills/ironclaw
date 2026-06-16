# R102 — chief-of-staff thread-triage prompt assembler util

**Lane**: A26 (codex). **Branch**: `codex/r102-triage-prompt-util`.
Pure TS + Vitest. No gateway, client, Svelte, or Rust. This is the data
layer for a "Triage my threads" action: the Chief of Staff persona looks
at the user's recent threads and sorts each into what needs a decision,
what's just FYI, and what the assistant can handle itself — the
executive-filter principle made concrete.

Sibling of `src/lib/util/briefing.ts` (R99); keep the same shape and
quality bar. Define local structural input types (don't import from
`briefing.ts`).

## Owned files (exclusive)
- `src/lib/util/triage.ts` — NEW.
- `src/lib/util/triage.test.ts` — NEW.

## Forbidden
Everything else.

## API
```ts
export interface TriageThread {
  id: string;
  title: string;
  updatedAt: string; // ISO
  messageCount?: number;
  /** Optional one-line snippet of the latest activity, if the caller has it. */
  preview?: string;
}
export interface TriageInput {
  /** Recent threads, any order; the util sorts + caps. */
  threads: TriageThread[];
  /** "now" for deterministic tests; defaults to new Date(). */
  now?: Date;
  /** Max threads to include (default 12). */
  maxThreads?: number;
}

/**
 * Build the prompt sent to the Chief of Staff persona to triage the
 * user's recent threads. Output is a single string instructing the agent
 * to classify EACH listed thread into exactly one of three buckets —
 * "Decision needed", "FYI", or "Can handle" — and for each give a
 * one-line reason and a concrete suggested next action. Executive
 * brevity, no filler. The agent must group its answer by bucket, most
 * urgent first, and reference threads by their title.
 *
 * - Sorts threads by updatedAt desc, caps to maxThreads.
 * - Includes a deterministic recency hint per thread (ISO or day delta —
 *   no wall-clock-relative "2h ago"; tests pin `now`).
 * - Empty threads → still returns a valid prompt that tells the agent
 *   there is nothing to triage and to say so in one line.
 * - Never throws; unparseable updatedAt sorts last.
 */
export function buildTriagePrompt(input: TriageInput): string;
```

## Acceptance
`npx vitest run src/lib/util/triage.test.ts` green:
- Output is non-empty and names all three buckets
  ("Decision needed", "FYI", "Can handle").
- Threads appear most-recently-updated first; capped at `maxThreads`.
- Each thread's title + a deterministic recency hint appear in the prompt.
- `preview` is included when provided, omitted cleanly when not.
- Empty input still yields a valid "nothing to triage" prompt.
- A thread with an unparseable `updatedAt` doesn't throw and sorts last.
- `npm run check` clean. No `any`, no `console.log`, no non-stdlib imports.
