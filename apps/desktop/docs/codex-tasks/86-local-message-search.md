# R86 — Local cached-message search util

**Lane**: A16 (codex)
**Branch**: `codex/r86-local-message-search`
**Depends on**: nothing. Pure TS + Vitest. Operates on already-loaded
message data passed in by the caller — no IndexedDB import, no client.

## Context

R62 added an IndexedDB cache of thread messages for offline reads.
There is no way to search across those cached messages. This task
ships a **pure ranking function** the caller feeds with the cached
data (a map of threadId → messages). Claude wires it to the
omnibar / global search and the IDB cache after merge.

Keeping it pure (no IDB import) means it tests instantly and stays
decoupled from storage.

## Owned files (exclusive write access)

- `src/lib/util/message-search.ts` — NEW.
- `src/lib/util/message-search.test.ts` — NEW.

## Forbidden files

- `src/lib/util/idb-cache.ts` — do NOT import it. The caller passes the
  data in.
- Every store, route, component, the API client, `types.ts`, all Rust.
- Define a local structural `SearchableMessage` interface inside
  `message-search.ts` (`{ id: string; role: 'user' | 'assistant' |
  'tool'; content: string; created_at: string }`).

## API to implement

```ts
export interface SearchableMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at: string; // ISO
}

export interface MessageHit {
  threadId: string;
  messageId: string;
  role: 'user' | 'assistant' | 'tool';
  snippet: string; // ~120 chars of context around the first match
  score: number;   // higher = better
}

/**
 * Rank cached messages against a free-text query.
 *
 * - Case-insensitive. Query is split on whitespace into terms; a message
 *   matches if it contains ANY term, scores higher for matching MORE
 *   distinct terms and for higher term frequency.
 * - Recency tiebreaker: newer created_at ranks above older at equal score.
 * - Returns at most `limit` hits (default 50), highest score first.
 * - Empty/whitespace query returns [].
 * - `snippet` is built around the first matched term, trimmed to ~120
 *   chars with a leading/trailing ellipsis when truncated. Do NOT inject
 *   HTML — return plain text (the caller renders + highlights).
 */
export function searchCachedMessages(
  query: string,
  byThread: Record<string, SearchableMessage[]>,
  opts?: { limit?: number }
): MessageHit[];
```

## Acceptance

- `npx vitest run src/lib/util/message-search.test.ts` green with at least:
  - Empty / whitespace query → `[]`.
  - A term that appears in two threads returns hits from both, tagged with
    the right `threadId` + `messageId`.
  - A message matching two query terms outranks one matching a single term.
  - At equal score, the newer `created_at` sorts first.
  - `limit` caps the result count.
  - `snippet` contains the matched term and is <= ~123 chars.
  - Snippet output never contains raw `<`/`>` HTML injected by the
    function itself (it just slices the source text).
- `npm run check` clean. No `any`, no `console.log`, no non-stdlib imports.

## Out of scope

- Reading from IndexedDB (caller supplies data).
- Highlighting / rendering (caller does it).
- Fuzzy / semantic / embedding search — plain term match only this round.
