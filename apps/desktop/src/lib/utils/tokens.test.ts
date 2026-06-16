// Tests for the token estimator.
//
// The heuristic is `Math.ceil(text.length / 4)` — deterministic, so each
// case asserts the exact expected count rather than a fuzzy tolerance,
// except for the paragraph + 4000-char cases where we exercise the +/- 5%
// band documented in the prompt.

import { describe, expect, it } from 'vitest';

import { estimateTokens } from './tokens';

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns 0 for null / undefined / non-string input', () => {
    // Defensive: callers may pass a missing `content` from a malformed
    // message in the store. Should never throw.
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(estimateTokens(123 as any)).toBe(0);
  });

  it('counts a single character as 1 token (ceil)', () => {
    // 1 / 4 = 0.25 → ceil → 1. A real tokenizer would also emit 1 token
    // for a single character, so the heuristic matches reality at the
    // lower bound.
    expect(estimateTokens('a')).toBe(1);
  });

  it('estimates "Hello world" at 3 tokens', () => {
    // 11 chars / 4 = 2.75 → ceil → 3. The string is 2 tokens under a
    // real BPE tokenizer (`Hello`, ` world`), so the heuristic rounds
    // up slightly — acceptable for a "~N tokens" badge.
    expect(estimateTokens('Hello world')).toBe(3);
  });

  it('estimates a 200-char paragraph at ~50 tokens (+/- 5%)', () => {
    // A deterministic 200-char string lands at exactly ceil(200/4) = 50
    // tokens. We assert the exact value plus the +/- 5% band the prompt
    // asked for; if a future round swaps the divisor, the band-bound
    // check is the canary that flags the change before the exact one
    // does.
    const paragraph = 'x'.repeat(200);
    expect(paragraph.length).toBe(200);
    const tokens = estimateTokens(paragraph);
    // +/- 5% band around 50 tokens.
    expect(tokens).toBeGreaterThanOrEqual(47);
    expect(tokens).toBeLessThanOrEqual(53);
    expect(tokens).toBe(50);
  });

  it('estimates a 4000-char block at ~1000 tokens (+/- 5%)', () => {
    // 4000 / 4 = 1000 exactly. The 5% band is here as a regression
    // guard: if a future round swaps the divisor, this case should be
    // the canary that flags the change.
    const block = 'x'.repeat(4000);
    const tokens = estimateTokens(block);
    expect(tokens).toBeGreaterThanOrEqual(950);
    expect(tokens).toBeLessThanOrEqual(1050);
    // Exact value for the current heuristic — a divisor change makes
    // this fail explicitly rather than silently passing.
    expect(tokens).toBe(1000);
  });
});
