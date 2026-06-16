# R93 — relative-time + duration formatter util

**Lane**: A20 (codex). **Branch**: `codex/r93-format-time-util`.
Pure TS + Vitest. No gateway, no client, no Svelte, no Rust.

## Owned files (exclusive)
- `src/lib/util/format-time.ts` — NEW.
- `src/lib/util/format-time.test.ts` — NEW.

## Forbidden
Everything else. Several surfaces currently hand-roll "12m ago" strings;
this is the canonical util they will adopt later — do NOT edit them now.

## API
```ts
/** Compact relative time: "just now" (< 45s), "5m ago", "3h ago",
 *  "2d ago", "3w ago", "5mo ago", "2y ago". Past only; a future or
 *  unparseable input returns "just now". `now` is injectable for tests
 *  (defaults to Date.now()). Accepts an ISO string or epoch ms. */
export function relativeTime(input: string | number, now?: number): string;

/** Humanize a duration in ms: "0s", "45s", "5m", "1h 5m", "2d 3h".
 *  Shows at most the two largest non-zero units. Negative → "0s". */
export function formatDuration(ms: number): string;

/** Absolute local timestamp for tooltips, e.g. "2026-05-28 17:42".
 *  Unparseable input returns the empty string. */
export function absoluteTime(input: string | number): string;
```

## Acceptance
`npx vitest run src/lib/util/format-time.test.ts` green (use the injectable
`now` / fixed epoch inputs — never wall-clock):
- `relativeTime(now - 10_000, now)` → "just now"; `now - 5*60_000` → "5m ago";
  `now - 3*3600_000` → "3h ago"; `now - 2*86400_000` → "2d ago".
- A future timestamp and an unparseable string both → "just now".
- `formatDuration(0)` → "0s"; `45_000` → "45s"; `65*60_000` → "1h 5m";
  negative → "0s".
- `absoluteTime('not a date')` → "".
- `npm run check` clean. No `any`, no `console.log`, no non-stdlib imports.
- Deterministic: tests must not depend on the machine timezone for the
  relative/duration assertions (absoluteTime may be timezone-local —
  assert only its shape/length there, or that bad input → "").
