// Bearer-token / API-key sanitizer for any surface that may render
// server-returned strings or JSON.
//
// Background — IronClaw's `/api/settings` endpoint embeds raw bearer
// tokens (e.g. `Authorization: Bearer sk-agent-…`) inside the
// `mcp_servers` value on single-tenant owner installs. The smoke test
// (Round 7e, 2026-05-27) confirmed this against baremetal3. Today no
// route in this desktop client renders that field, but the Admin page
// is a likely consumer in the future, and the SystemPromptEditor
// already echoes server-provided text. A pure, dependency-free
// redactor is the cheapest defense-in-depth.
//
// Design notes:
//   - All patterns use the global flag so multiple matches in one
//     string are each redacted (a `mcp_servers` payload can have
//     several tokens).
//   - We mask the *secret span* only, never the surrounding label
//     ("Bearer ", "api_key=") so the reader still recognises the
//     shape.
//   - `redactJsonObject` is the recursive companion for full
//     structures; numbers / booleans / null pass through unchanged.
//   - `preserveTips` keeps the first 4 and last 4 chars of the
//     secret with `•••` between them, which is enough of a "looks
//     like a token" cue for ops debugging without leaking the
//     unique parts of the secret. Default OFF — full mask.

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // RFC 6750 bearer tokens. The matched group is the token; the
  // "Bearer " label survives the replacement so the reader sees the
  // shape.
  { name: 'bearer', re: /Bearer\s+([A-Za-z0-9._\-+/]+={0,2})/g },
  // OpenAI-style `sk-…` prefix. 8+ chars after the prefix is enough
  // to dodge ordinary words while catching real keys (`sk-agent-…`,
  // `sk-or-v1-…`, etc.). The boundary anchors keep `sk-` mid-word
  // false-positives in check.
  { name: 'sk-prefix', re: /\b(sk-[A-Za-z0-9_\-]{8,})/g },
  // Public-key-style `pk-…` prefix (Stripe, etc.).
  { name: 'pk-prefix', re: /\b(pk-[A-Za-z0-9_\-]{8,})/g },
  // `api_key=…`, `api-key: "…"`, etc. Two groups: label + value.
  // Only the value is redacted; the label survives.
  { name: 'api-key', re: /\b(api[_-]?key)\s*[:=]\s*"?([A-Za-z0-9._\-+/]{12,})/gi },
  // JWTs — three base64url segments separated by dots. Anchored on
  // the canonical `eyJ` prefix (base64 of `{"`) so we don't redact
  // arbitrary triple-dotted strings.
  { name: 'jwt', re: /\b(eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)/g },
  // GitHub PATs (`ghp_…`) and installation tokens (`ghs_…`). 36
  // chars is the canonical width.
  { name: 'github-pat', re: /\b(ghp_[A-Za-z0-9]{36})/g },
  { name: 'github-installation', re: /\b(ghs_[A-Za-z0-9]{36})/g }
];

export interface RedactOptions {
  /**
   * If true, leaves the first 4 and last 4 chars of the secret
   * visible with `•••` between them (e.g. `sk-a••••••cdef`). Useful
   * when the operator needs a "looks like a token" cue without the
   * full value. Defaults to false (full mask: all secret characters
   * replaced with `•`, preserving length).
   */
  preserveTips?: boolean;
}

/**
 * Mask a single secret span. Either a length-preserving solid block
 * of `•` (default) or a tip-preserving variant when `preserveTips`
 * is set. We don't pad short secrets — a 6-char value gets a 6-char
 * mask, full stop.
 */
function maskSecret(secret: string, preserveTips: boolean): string {
  if (!preserveTips || secret.length <= 8) {
    return '•'.repeat(secret.length);
  }
  return `${secret.slice(0, 4)}•••${secret.slice(-4)}`;
}

/**
 * Walk every pattern in PATTERNS and replace the captured secret
 * span(s) with a masked equivalent. The label / prefix portion of
 * each match (e.g. "Bearer ", "api_key=") is preserved so the
 * surface still reads as "this is a token, just redacted".
 *
 * Patterns with two capture groups (currently just `api-key`) put
 * the secret in group 2; everything else uses group 1. The reducer
 * below is generic over both shapes.
 *
 * String inputs only — callers with arbitrary JSON should use
 * `redactJsonObject`.
 */
export function redactSecrets(text: string, opts: RedactOptions = {}): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  const preserveTips = opts.preserveTips ?? false;
  let out = text;
  for (const { re } of PATTERNS) {
    // RegExp.replace with a function handles all matches per the `g`
    // flag. We capture the secret span from the rightmost group so
    // the same handler covers single- and double-group patterns
    // without per-pattern branching.
    out = out.replace(re, (match, g1: string, g2?: string) => {
      const secret = typeof g2 === 'string' && g2.length > 0 ? g2 : g1;
      // Preserve everything except the secret span. Splice by string
      // index — simpler and faster than re-running the regex.
      const start = match.lastIndexOf(secret);
      if (start < 0) return match;
      return (
        match.slice(0, start) +
        maskSecret(secret, preserveTips) +
        match.slice(start + secret.length)
      );
    });
  }
  return out;
}

/**
 * Recursively walk an arbitrary JSON-shaped value and apply
 * `redactSecrets` to every string leaf. Numbers, booleans, null,
 * and undefined pass through unchanged. Objects and arrays are
 * rebuilt (immutable) so the caller can safely render the result
 * without mutating the source.
 *
 * Keys are not redacted — only values. (A property literally
 * named `Bearer sk-…` would be exotic enough to investigate
 * rather than silently mask.)
 */
export function redactJsonObject(value: unknown, opts: RedactOptions = {}): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value, opts);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactJsonObject(v, opts));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactJsonObject(v, opts);
    }
    return out;
  }
  // numbers, booleans, null, undefined, functions, symbols — return as-is.
  return value;
}

/**
 * Cheap detector — returns true if any of the configured patterns
 * matches anywhere in the input. Useful for surfaces that want to
 * show a "tokens detected" banner without committing to render the
 * redacted form (the SystemPromptEditor's read-only mode is the
 * current consumer).
 *
 * We rebuild the regex without the `g` flag because `.test()` on a
 * sticky global regex carries state across calls and breaks on the
 * second hit — the safer pattern for one-shot probing.
 */
export function containsSecret(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  for (const { re } of PATTERNS) {
    const probe = new RegExp(re.source, re.flags.replace('g', ''));
    if (probe.test(text)) return true;
  }
  return false;
}
