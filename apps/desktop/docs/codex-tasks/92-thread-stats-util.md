# R92 — conversation stats util

**Lane**: A19 (codex). **Branch**: `codex/r92-thread-stats-util`.
Pure TS + Vitest. No gateway, no client, no Svelte, no Rust.

## Owned files (exclusive)
- `src/lib/util/thread-stats.ts` — NEW.
- `src/lib/util/thread-stats.test.ts` — NEW.

## Forbidden
Everything else. Define a local structural `StatMessage` interface
(`{ role: 'user' | 'assistant' | 'tool'; content: string; created_at: string }`).

## Context
A thread-info panel wants at-a-glance stats for a conversation. Ship the
pure computation; the UI reads it later.

## API
```ts
export interface StatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at: string; // ISO
}

export interface ThreadStats {
  messageCount: number;
  byRole: { user: number; assistant: number; tool: number };
  /** ~chars/4 heuristic summed over all content. */
  estimatedTokens: number;
  totalChars: number;
  /** ISO of the earliest / latest created_at, or null when empty. */
  firstAt: string | null;
  lastAt: string | null;
  /** lastAt - firstAt in ms, or 0 when < 2 messages / unparseable. */
  spanMs: number;
}

/** Compute stats over a message list. Empty list → all-zero/null stats.
 *  Ignores messages with unparseable created_at for the time span but
 *  still counts them for message/role/token/char totals. Never throws. */
export function computeThreadStats(messages: StatMessage[]): ThreadStats;
```

## Acceptance
`npx vitest run src/lib/util/thread-stats.test.ts` green:
- Empty list → `{ messageCount: 0, byRole: {user:0,assistant:0,tool:0},
  estimatedTokens: 0, totalChars: 0, firstAt: null, lastAt: null, spanMs: 0 }`.
- Role tallies are correct for a mixed list.
- `estimatedTokens` = ceil(totalChars / 4); `totalChars` is the sum of
  content lengths.
- `firstAt`/`lastAt` pick the chronological min/max (not array order), and
  `spanMs` = their difference.
- A message with an unparseable `created_at` doesn't crash and is excluded
  from the span calc but counted everywhere else.
- `npm run check` clean. No `any`, no `console.log`, no non-stdlib imports.
