import { describe, expect, it } from 'vitest';

import { searchCachedMessages, type SearchableMessage } from './message-search';

function message(
  id: string,
  content: string,
  createdAt = '2026-05-28T00:00:00Z'
): SearchableMessage {
  return {
    id,
    role: 'user',
    content,
    created_at: createdAt
  };
}

describe('message-search', () => {
  it('returns no hits for empty or whitespace-only queries', () => {
    const byThread = {
      'thread-1': [message('m1', 'cached search text')]
    };

    expect(searchCachedMessages('', byThread)).toEqual([]);
    expect(searchCachedMessages('   \n\t  ', byThread)).toEqual([]);
  });

  it('returns hits from every matching thread with message identifiers', () => {
    const hits = searchCachedMessages('cache', {
      'thread-1': [message('m1', 'Cache this thread')],
      'thread-2': [message('m2', 'offline cache hit')],
      'thread-3': [message('m3', 'nothing relevant')]
    });

    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => `${hit.threadId}:${hit.messageId}`).sort()).toEqual([
      'thread-1:m1',
      'thread-2:m2'
    ]);
  });

  it('ranks messages matching more distinct query terms above single-term matches', () => {
    const hits = searchCachedMessages('alpha beta', {
      'thread-1': [message('single', 'alpha alpha alpha alpha alpha')],
      'thread-2': [message('double', 'alpha beta')]
    });

    expect(hits[0].messageId).toBe('double');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('uses recency as the tiebreaker at equal score', () => {
    const hits = searchCachedMessages('cache', {
      'thread-1': [message('old', 'cache', '2026-05-27T00:00:00Z')],
      'thread-2': [message('new', 'cache', '2026-05-28T00:00:00Z')]
    });

    expect(hits.map((hit) => hit.messageId)).toEqual(['new', 'old']);
  });

  it('caps results at the requested limit', () => {
    const hits = searchCachedMessages(
      'cache',
      {
        'thread-1': [
          message('m1', 'cache', '2026-05-28T00:00:01Z'),
          message('m2', 'cache', '2026-05-28T00:00:02Z'),
          message('m3', 'cache', '2026-05-28T00:00:03Z')
        ]
      },
      { limit: 2 }
    );

    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.messageId)).toEqual(['m3', 'm2']);
  });

  it('builds a bounded plain-text snippet around the matched term', () => {
    const content = `${'before '.repeat(20)}needle ${'after '.repeat(20)}`;
    const [hit] = searchCachedMessages('needle', {
      'thread-1': [message('m1', content)]
    });

    expect(hit.snippet).toContain('needle');
    expect(hit.snippet.length).toBeLessThanOrEqual(123);
    expect(hit.snippet.startsWith('...')).toBe(true);
    expect(hit.snippet.endsWith('...')).toBe(true);
  });

  it('does not inject HTML markup into snippets', () => {
    const [hit] = searchCachedMessages('needle', {
      'thread-1': [message('m1', 'plain needle text')]
    });

    expect(hit.snippet).toBe('plain needle text');
    expect(hit.snippet).not.toContain('<mark>');
    expect(hit.snippet).not.toContain('</mark>');
    expect(hit.snippet).not.toContain('<');
    expect(hit.snippet).not.toContain('>');
  });
});
