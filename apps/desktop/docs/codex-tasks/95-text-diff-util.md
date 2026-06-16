# R95 — line-level text diff util

**Lane**: A22 (codex). **Branch**: `codex/r95-text-diff-util`.
Pure TS + Vitest. No gateway, client, Svelte, or Rust. Consumer: the
system-prompt diff viewer (R137) + any future "what changed" view.

## Owned files (exclusive)
- `src/lib/util/text-diff.ts` — NEW.
- `src/lib/util/text-diff.test.ts` — NEW.

## Forbidden
Everything else. Do NOT edit the prompt-diff component — adopted later.

## API
```ts
export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffLine {
  op: DiffOp;
  /** The line text (without trailing newline). */
  text: string;
  /** 1-based line number in the OLD text, or null for inserts. */
  oldLine: number | null;
  /** 1-based line number in the NEW text, or null for deletes. */
  newLine: number | null;
}

/** Line-level diff via LCS. Splits on \n (\r\n tolerated). Returns the
 *  merged sequence: unchanged lines as 'equal', removed as 'delete',
 *  added as 'insert', in reading order (deletes before inserts at a hunk).
 *  Two identical texts → all 'equal'. Empty old → all 'insert'; empty new
 *  → all 'delete'. Deterministic. */
export function diffLines(oldText: string, newText: string): DiffLine[];

/** Counts for a summary chip. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number; unchanged: number };
```

## Acceptance
`npx vitest run src/lib/util/text-diff.test.ts` green:
- Identical text → every line `op: 'equal'`, correct old/new line numbers.
- A changed middle line shows as a `delete` then `insert` with the
  surrounding lines `equal`.
- Empty old → all inserts (oldLine null); empty new → all deletes (newLine null).
- `diffStats` counts match the ops.
- `\r\n` input doesn't leak `\r` into `text`.
- `npm run check` clean. No `any`, no `console.log`, no non-stdlib imports.
