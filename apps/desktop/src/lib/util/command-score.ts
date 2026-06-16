// Command-palette match scoring, extracted from CommandPalette (audit R200
// P2) so the tiered ranking is unit-tested and reusable. Pure + synchronous.
//
// Caller contract: `hay` and `needle` are expected pre-lowercased by the
// caller (the palette lowercases the query + each candidate field before
// scoring), so this function does no case folding itself.

/**
 * Tiered relevance score: exact-prefix > exact-substring > subsequence;
 * 0 means no match. Higher is better.
 * - prefix:      1000 − (extra chars after the needle)
 * - substring:   500 − (offset of the match)
 * - subsequence: 100 − (capped gap count between matched chars)
 */
export function scoreMatch(hay: string, needle: string): number {
  if (!hay) return 0;
  if (hay.startsWith(needle)) return 1000 - (hay.length - needle.length);
  const sub = hay.indexOf(needle);
  if (sub >= 0) return 500 - sub;
  // Subsequence: characters of needle appear in hay in order.
  let i = 0;
  let lastIdx = -1;
  let gaps = 0;
  for (const ch of hay) {
    if (ch === needle[i]) {
      if (lastIdx >= 0) gaps += hay.indexOf(ch, lastIdx + 1) - lastIdx - 1;
      lastIdx = hay.indexOf(ch, lastIdx + 1);
      i++;
      if (i === needle.length) return 100 - Math.min(gaps, 99);
    }
  }
  return 0;
}
