# R99 — chief-of-staff briefing-prompt assembler util

**Lane**: A26 (codex). **Branch**: `codex/r99-briefing-prompt-util`.
Pure TS + Vitest. No gateway, client, Svelte, or Rust. This is the data
layer for an upcoming "Brief me" action where the Chief of Staff persona
produces a morning agenda from the user's recent context.

## Owned files (exclusive)
- `src/lib/util/briefing.ts` — NEW.
- `src/lib/util/briefing.test.ts` — NEW.

## Forbidden
Everything else. Define local structural input types in the util.

## API
```ts
export interface BriefingThread {
  id: string;
  title: string;
  updatedAt: string; // ISO
  messageCount?: number;
}
export interface BriefingInput {
  /** Recent threads, any order; the util sorts + caps. */
  threads: BriefingThread[];
  /** Free-text open loops / commitments the user is tracking. */
  openLoops?: string[];
  /** "now" for deterministic tests; defaults to new Date(). */
  now?: Date;
  /** Max threads to include (default 8). */
  maxThreads?: number;
}

/**
 * Build the prompt sent to the Chief of Staff persona to produce a daily
 * brief. Output is a single string instructing the agent to: greet by
 * date, summarize what's active (the recent threads, most-recently-updated
 * first), restate open loops, and propose the top 3 priorities for today
 * with a one-line rationale each — executive brevity, no filler.
 *
 * - Sorts threads by updatedAt desc, caps to maxThreads.
 * - Includes a relative recency hint per thread ("2h ago" style is NOT
 *   required — just include the ISO or a day delta; keep it deterministic).
 * - Empty threads + no open loops → still returns a valid prompt that asks
 *   for a fresh-start plan for the day.
 * - Never throws; unparseable updatedAt sorts last.
 */
export function buildBriefingPrompt(input: BriefingInput): string;
```

## Acceptance
`npx vitest run src/lib/util/briefing.test.ts` green:
- Output is non-empty and contains the date (derive from `now`).
- Threads appear most-recently-updated first; capped at `maxThreads`.
- Open loops are included when provided.
- Empty input still yields a valid "plan my day from scratch" prompt.
- A thread with an unparseable `updatedAt` doesn't throw and sorts last.
- `npm run check` clean. No `any`, no `console.log`, no non-stdlib imports.
