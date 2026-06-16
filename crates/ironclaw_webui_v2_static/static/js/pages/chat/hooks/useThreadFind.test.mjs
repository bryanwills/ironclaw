import assert from 'node:assert/strict';
import test from 'node:test';

import { threadFindMatches } from './useThreadFind.js';

const messages = [
  { id: 'm1', role: 'user', content: 'When is the launch date?' },
  { id: 'm2', role: 'assistant', content: 'The launch is on March 3rd.' },
  { id: 'm3', role: 'assistant', content: 'No date mentioned here.' },
  { id: 'm4', role: 'user', content: '' },
  { id: 'm5', role: 'assistant' }
];

test('threadFindMatches: case-insensitive substring match in render order', () => {
  assert.deepEqual(threadFindMatches(messages, 'launch'), ['m1', 'm2']);
  assert.deepEqual(threadFindMatches(messages, 'DATE'), ['m1', 'm3']);
  assert.deepEqual(threadFindMatches(messages, 'march 3rd'), ['m2']);
});

test('threadFindMatches: blank query, no hits, and non-string content yield no matches', () => {
  assert.deepEqual(threadFindMatches(messages, ''), []);
  assert.deepEqual(threadFindMatches(messages, '   '), []);
  assert.deepEqual(threadFindMatches(messages, 'zzz-nope'), []);
  assert.deepEqual(threadFindMatches(null, 'x'), []);
  // m4 (empty content) and m5 (no content field) never match and never throw.
  assert.deepEqual(threadFindMatches(messages, 'mentioned'), ['m3']);
});
