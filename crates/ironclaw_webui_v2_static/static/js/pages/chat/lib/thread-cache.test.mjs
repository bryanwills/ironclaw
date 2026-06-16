import assert from 'node:assert/strict';
import test from 'node:test';

import { flattenCachedThreads } from './thread-cache.js';

test('flattenCachedThreads reads the paginated useInfiniteQuery shape', () => {
  const cached = {
    pages: [
      { threads: [{ thread_id: 'a', title: 'A' }], next_cursor: 'c1' },
      { threads: [{ thread_id: 'b', title: 'B' }], next_cursor: null }
    ],
    pageParams: [null, 'c1']
  };
  assert.deepEqual(
    flattenCachedThreads(cached).map((t) => t.thread_id),
    ['a', 'b']
  );
});

test('flattenCachedThreads tolerates the legacy single-page shape and empties', () => {
  assert.deepEqual(
    flattenCachedThreads({ threads: [{ thread_id: 'x' }] }).map((t) => t.thread_id),
    ['x']
  );
  assert.deepEqual(flattenCachedThreads(undefined), []);
  assert.deepEqual(flattenCachedThreads({}), []);
  assert.deepEqual(flattenCachedThreads({ pages: [] }), []);
  assert.deepEqual(flattenCachedThreads({ pages: [{}] }), []);
});
