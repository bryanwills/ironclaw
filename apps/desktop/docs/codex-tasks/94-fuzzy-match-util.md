# R94 — subsequence fuzzy-match util

**Lane**: A21 (codex). **Branch**: `codex/r94-fuzzy-match-util`.
Pure TS + Vitest. No gateway, client, Svelte, or Rust. Consumer: the
omnibar (R55/R86) currently ranks with a coarse prefix/substring score;
this util enables subsequence matching + match-range highlighting later.

## Owned files (exclusive)
- `src/lib/util/fuzzy.ts` — NEW.
- `src/lib/util/fuzzy.test.ts` — NEW.

## Forbidden
Everything else. Do NOT edit the omnibar — Claude adopts this later.

## API
```ts
export interface FuzzyResult {
  /** True when every char of the (lowercased) query appears in order. */
  matched: boolean;
  /** Higher = better. 0 when !matched. Reward contiguous runs + matches
   *  at word boundaries / string start. */
  score: number;
  /** Indices into the ORIGINAL target string that matched, ascending —
   *  for highlighting. Empty when !matched. */
  indices: number[];
}

/** Case-insensitive subsequence match of `query` within `target`.
 *  Empty query → { matched: true, score: 0, indices: [] }. */
export function fuzzyMatch(query: string, target: string): FuzzyResult;

/** Convenience: rank a list of candidates, returning the matched ones
 *  sorted by score desc (stable for ties), each with its FuzzyResult.
 *  `key` extracts the searchable string from an item (defaults to String). */
export function fuzzyRank<T>(
  query: string,
  items: T[],
  key?: (item: T) => string
): Array<{ item: T; result: FuzzyResult }>;
```

## Acceptance
`npx vitest run src/lib/util/fuzzy.test.ts` green:
- `fuzzyMatch('gth', 'GitHub')` matched, indices ascending into "GitHub".
- `fuzzyMatch('xyz', 'GitHub')` → matched:false, score:0, indices:[].
- Empty query → matched:true, score:0.
- A contiguous match ('git' in 'github') outscores a scattered one
  ('gtb' in 'github'); a boundary/start match outscores a mid-word one.
- `fuzzyRank` drops non-matches and sorts by score desc; ties keep input order.
- `npm run check` clean. No `any`, no `console.log`, no non-stdlib imports.
