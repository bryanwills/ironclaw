# R91 — token-cost estimator util

**Lane**: A18 (codex). **Branch**: `codex/r91-cost-estimate-util`.
Pure TS + Vitest. No gateway, no client, no Svelte, no Rust.

## Owned files (exclusive)
- `src/lib/util/cost-estimate.ts` — NEW.
- `src/lib/util/cost-estimate.test.ts` — NEW.

## Forbidden
Everything else. Define all types locally in the util.

## Context
The chat surface shows a per-thread cost tracker (R41) but cost is
computed ad hoc. Ship a pure, tested estimator with a small built-in
price table so any surface can turn token counts into a USD figure.

## API
```ts
export interface ModelPrice {
  /** USD per 1,000,000 prompt (input) tokens. */
  promptPerM: number;
  /** USD per 1,000,000 completion (output) tokens. */
  completionPerM: number;
}

/** Built-in price table keyed by a normalized model id (lowercase, the
 *  part after any `provider/` prefix stripped). Include reasonable entries
 *  for: deepseek-chat / deepseek-v3 / deepseek-v4-pro, kimi-k2,
 *  gpt-4o / gpt-4o-mini, claude-3.5-sonnet / claude-3.7 / opus, and a
 *  conservative `default`. Values are approximate; exact numbers aren't
 *  load-bearing, but `default` MUST exist. */
export const MODEL_PRICES: Record<string, ModelPrice>;

/** Look up a price by raw model id. Normalizes the id (lowercase, strip a
 *  leading `vendor/`), matches the longest known key that is a prefix of
 *  the normalized id, else returns MODEL_PRICES.default. Never throws. */
export function priceForModel(modelId: string): ModelPrice;

/** USD cost for a single call. Negative/NaN token counts are treated as 0. */
export function estimateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number
): number;

/** Format a USD amount: `$0.0000` for < $0.01 (4 dp), `$1.23` otherwise
 *  (2 dp). Always prefixed with `$`. */
export function formatUsd(amount: number): string;
```

## Acceptance
`npx vitest run src/lib/util/cost-estimate.test.ts` green:
- `priceForModel('deepseek/deepseek-chat-v3-0324')` resolves to a
  deepseek entry, not default (prefix match after stripping vendor).
- `priceForModel('totally-unknown')` returns `MODEL_PRICES.default`.
- `estimateCost` is linear in tokens; negative/NaN inputs → counted as 0.
- `formatUsd(0.0003)` → `$0.0003`; `formatUsd(1.5)` → `$1.50`.
- `npm run check` clean. No `any`, no `console.log`, no non-stdlib imports.
