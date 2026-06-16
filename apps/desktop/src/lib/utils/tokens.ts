// Token estimator.
//
// A tokenizer-free heuristic: roughly `len / 4` characters per token. This is
// OpenAI's published rule-of-thumb for English BPE tokenizers — accurate to
// within ~5% on natural-language paragraphs, fast (O(1) per call), and avoids
// pulling in a multi-MB tokenizer bundle (tiktoken-wasm, gpt-tokenizer) just
// to render a faint "~N tokens" badge in the thread list.
//
// Known limitations of the heuristic:
//   - Heavy code, JSON, or non-English text drifts from `/4` (typically
//     undercounts code and overcounts CJK). A future round can swap in a
//     real tokenizer if the surface grows out of "rough estimate" territory.
//   - Whitespace counts equally — a string of 100 spaces estimates ~25 tokens
//     even though a real tokenizer would compress it. Good enough for the
//     ~N-tokens badge; not good enough for cost budgeting.
//
// The function is defensive against missing input: `null`, `undefined`, and
// non-string values all collapse to 0 rather than throwing, so a malformed
// message in the messages store can't take down the render.

/**
 * Estimate the number of tokens in a string using OpenAI's `~4 chars per
 * token` heuristic. Returns 0 for empty / missing input.
 *
 * The estimate uses `Math.ceil` so a single-character string still costs
 * one token (matching how a real tokenizer would handle it), and so any
 * non-empty content is always reported as at least 1 token rather than 0.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
