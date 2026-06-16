export interface StatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at: string;
}

export interface ThreadStats {
  messageCount: number;
  byRole: { user: number; assistant: number; tool: number };
  /** ~chars/4 heuristic summed over all content. */
  estimatedTokens: number;
  totalChars: number;
  /** ISO of the earliest / latest created_at, or null when empty. */
  firstAt: string | null;
  lastAt: string | null;
  /** lastAt - firstAt in ms, or 0 when < 2 messages / unparseable. */
  spanMs: number;
}

interface ParsedTimestamp {
  value: string;
  ms: number;
}

/** Compute stats over a message list. Empty list -> all-zero/null stats.
 *  Ignores messages with unparseable created_at for the time span but
 *  still counts them for message/role/token/char totals. Never throws. */
export function computeThreadStats(messages: StatMessage[]): ThreadStats {
  const byRole = { user: 0, assistant: 0, tool: 0 };
  let totalChars = 0;
  let first: ParsedTimestamp | null = null;
  let last: ParsedTimestamp | null = null;
  let validTimestampCount = 0;

  for (const message of messages) {
    byRole[message.role] += 1;
    totalChars += message.content.length;

    const createdAtMs = Date.parse(message.created_at);
    if (Number.isNaN(createdAtMs)) continue;

    validTimestampCount += 1;

    if (first === null || createdAtMs < first.ms) {
      first = { value: message.created_at, ms: createdAtMs };
    }

    if (last === null || createdAtMs > last.ms) {
      last = { value: message.created_at, ms: createdAtMs };
    }
  }

  return {
    messageCount: messages.length,
    byRole,
    estimatedTokens: Math.ceil(totalChars / 4),
    totalChars,
    firstAt: first?.value ?? null,
    lastAt: last?.value ?? null,
    spanMs: validTimestampCount >= 2 && first !== null && last !== null ? last.ms - first.ms : 0
  };
}
