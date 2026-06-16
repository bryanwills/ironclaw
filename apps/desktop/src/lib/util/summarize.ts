const DEFAULT_THRESHOLD_TOKENS = 60_000;
const DEFAULT_KEEP_RECENT = 8;

export interface SummarizableMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

function normalizeKeepRecent(keepRecent: number | undefined): number {
  if (keepRecent === undefined || !Number.isFinite(keepRecent)) {
    return DEFAULT_KEEP_RECENT;
  }

  return Math.max(0, Math.floor(keepRecent));
}

/** Cheap heuristic: ~4 chars per token. Never returns < 0. */
export function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

/** Sum of estimateTokens over every message's content. */
export function estimateHistoryTokens(messages: SummarizableMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content), 0);
}

/**
 * True when the history is large enough to warrant folding. Keeps the
 * last `keepRecent` messages out of the estimate — we never summarize
 * those, so they shouldn't push us over.
 */
export function shouldSummarize(
  messages: SummarizableMessage[],
  opts?: { thresholdTokens?: number; keepRecent?: number }
): boolean {
  const keepRecent = normalizeKeepRecent(opts?.keepRecent);
  const thresholdTokens =
    opts?.thresholdTokens !== undefined && Number.isFinite(opts.thresholdTokens)
      ? opts.thresholdTokens
      : DEFAULT_THRESHOLD_TOKENS;
  const foldableMessages = messages.slice(0, Math.max(0, messages.length - keepRecent));

  return estimateHistoryTokens(foldableMessages) > thresholdTokens;
}

/**
 * Build the meta-prompt sent to the model. Must include each message's
 * role and content in order, and instruct the model to produce a dense
 * factual summary for context handoff (decisions, open questions, key
 * facts) — no preamble, no meta-commentary.
 */
export function buildSummaryPrompt(messages: SummarizableMessage[]): string {
  const transcript = messages
    .map((message) => `<${message.role}>\n${message.content}\n</${message.role}>`)
    .join('\n\n');

  return [
    'Produce a dense factual summary for context handoff.',
    'Preserve decisions, open questions, key facts, constraints, and user preferences.',
    'Write only the summary text. No preamble and no meta-commentary.',
    '',
    transcript
  ].join('\n');
}

/**
 * Fold the oldest messages into a summary. `send` is injected so this
 * is testable with a fake and carries zero client coupling.
 *
 * - Splits `messages` into [toFold, recent] where recent = last
 *   `keepRecent` messages.
 * - If toFold is empty, returns { summary: '', replacedIds: [] } without
 *   calling send.
 * - Otherwise calls send(buildSummaryPrompt(toFold)) and returns the
 *   trimmed summary text plus replacedIds = ids of every folded message.
 */
export async function summarizeHistory(
  send: (prompt: string) => Promise<string>,
  messages: SummarizableMessage[],
  opts?: { keepRecent?: number }
): Promise<{ summary: string; replacedIds: string[] }> {
  const keepRecent = normalizeKeepRecent(opts?.keepRecent);
  const toFold = messages.slice(0, Math.max(0, messages.length - keepRecent));

  if (toFold.length === 0) {
    return { summary: '', replacedIds: [] };
  }

  const summary = await send(buildSummaryPrompt(toFold));

  return {
    summary: summary.trim(),
    replacedIds: toFold.map((message) => message.id)
  };
}
