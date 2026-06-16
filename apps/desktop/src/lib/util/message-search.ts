export interface SearchableMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at: string;
}

export interface MessageHit {
  threadId: string;
  messageId: string;
  role: 'user' | 'assistant' | 'tool';
  snippet: string;
  score: number;
}

const DEFAULT_LIMIT = 50;
const SNIPPET_MAX_LENGTH = 123;
const SNIPPET_CONTEXT_LENGTH = 117;
const DISTINCT_TERM_WEIGHT = 100_000;

interface RankedMessageHit extends MessageHit {
  createdAtMs: number;
}

function parseQueryTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const rawTerm of query.trim().toLocaleLowerCase().split(/\s+/)) {
    if (!rawTerm || seen.has(rawTerm)) continue;
    seen.add(rawTerm);
    terms.push(rawTerm);
  }

  return terms;
}

function countOccurrences(content: string, term: string): number {
  let count = 0;
  let fromIndex = 0;

  while (fromIndex < content.length) {
    const index = content.indexOf(term, fromIndex);
    if (index === -1) break;
    count += 1;
    fromIndex = index + term.length;
  }

  return count;
}

function findFirstMatchIndex(content: string, terms: string[]): number {
  let firstIndex = -1;

  for (const term of terms) {
    const index = content.indexOf(term);
    if (index !== -1 && (firstIndex === -1 || index < firstIndex)) {
      firstIndex = index;
    }
  }

  return firstIndex;
}

function buildSnippet(content: string, matchIndex: number): string {
  if (content.length <= SNIPPET_MAX_LENGTH) return content;

  const contextStart = Math.max(0, matchIndex - Math.floor(SNIPPET_CONTEXT_LENGTH / 2));
  const contextEnd = Math.min(content.length, contextStart + SNIPPET_CONTEXT_LENGTH);
  const start = Math.max(0, contextEnd - SNIPPET_CONTEXT_LENGTH);
  const prefix = start > 0 ? '...' : '';
  const suffix = contextEnd < content.length ? '...' : '';

  return `${prefix}${content.slice(start, contextEnd)}${suffix}`;
}

/**
 * Rank cached messages against a free-text query.
 *
 * The caller owns storage and rendering. This function only ranks already-loaded
 * message data and returns plain-text snippets.
 */
export function searchCachedMessages(
  query: string,
  byThread: Record<string, SearchableMessage[]>,
  opts?: { limit?: number }
): MessageHit[] {
  const terms = parseQueryTerms(query);
  if (terms.length === 0) return [];

  const limit = Math.max(0, Math.floor(opts?.limit ?? DEFAULT_LIMIT));
  if (limit === 0) return [];

  const hits: RankedMessageHit[] = [];

  for (const [threadId, messages] of Object.entries(byThread)) {
    for (const message of messages) {
      const lowerContent = message.content.toLocaleLowerCase();
      let matchedTermCount = 0;
      let frequency = 0;

      for (const term of terms) {
        const termFrequency = countOccurrences(lowerContent, term);
        if (termFrequency > 0) {
          matchedTermCount += 1;
          frequency += termFrequency;
        }
      }

      if (matchedTermCount === 0) continue;

      const firstMatchIndex = findFirstMatchIndex(lowerContent, terms);
      hits.push({
        threadId,
        messageId: message.id,
        role: message.role,
        snippet: buildSnippet(message.content, firstMatchIndex),
        score: matchedTermCount * DISTINCT_TERM_WEIGHT + frequency,
        createdAtMs: Date.parse(message.created_at)
      });
    }
  }

  return hits
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.createdAtMs - a.createdAtMs;
    })
    .slice(0, limit)
    .map(({ createdAtMs: _createdAtMs, ...hit }) => hit);
}
