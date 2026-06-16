# R98 — tests: omnibar fuzzy-fallback ranking

**Lane**: A25 (codex). **Branch**: `codex/r98-omnibar-fuzzy-tests`.
Vitest only. Appends to one existing test file — conflict-free with the
council E2E lane.

## Context
A review flagged that the omnibar's R94 fuzzy subsequence fallback (added
to the private `scoreText` in `src/lib/stores/omnibar.svelte.ts`) is
untested. The fallback promotes items that no substring tier matched, in
a low score band (<= 0.7), so a fuzzy hit never outranks a real
prefix/word-boundary/substring match. `scoreText` is module-private, so
test it THROUGH the public store API (register commands, set a query,
read `omnibar.results`).

## Owned files (exclusive)
- `src/lib/stores/omnibar.test.ts` — APPEND new `it(...)` cases inside the
  existing top-level `describe`. Do not modify existing cases or other files.

## Forbidden
Everything else (including `omnibar.svelte.ts` — tests only).

## What to build
Read the existing `omnibar.test.ts` to reuse its setup (it drives the real
`omnibar` singleton, registers commands via `omnibar.registerCommand`,
calls `omnibar.show()` / `omnibar.setQuery(...)`, and reads
`omnibar.results` after the ~80ms debounce — copy that exact async/debounce
pattern, including the `setTimeout` wait the existing substring-ranking
test uses).

Add cases:
1. **Fuzzy fallback surfaces a subsequence match** — register a command
   titled `GitHub Dashboard`, query `ghd` (a subsequence, NOT a substring),
   and assert that command appears in `omnibar.results` (id present). A
   pure substring scorer would have dropped it.
2. **Fuzzy never outranks a substring match** — register two commands:
   `Settings` (substring of query `set`) and `Secure Tunnel` (only a
   subsequence of `set`). Query `set`. Assert `Settings` ranks ABOVE
   `Secure Tunnel` in `omnibar.results` order.
3. **Non-subsequence query drops the item** — register `Knowledge`, query
   `zzz`, assert that command is absent from results.

Clean up registered commands between cases if the existing file does
(match its `beforeEach`/`afterEach` pattern).

## Acceptance
- `npx vitest run src/lib/stores/omnibar.test.ts` green (existing + new).
- `npm run check` clean. No `any`, no `.only`, no non-stdlib imports.
