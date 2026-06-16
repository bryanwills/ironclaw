import assert from 'node:assert/strict';
import test from 'node:test';

import { workItemSearchMatch } from './work-search.js';

const item = {
  title: 'Q3 board memo',
  artifacts: [
    {
      content:
        'The launch is scheduled for March 3rd, pending legal review of the indemnity clause.'
    }
  ]
};

test('workItemSearchMatch: blank query matches with no snippet', () => {
  assert.deepEqual(workItemSearchMatch(item, ''), { match: true, snippet: '' });
  assert.deepEqual(workItemSearchMatch(item, '   '), { match: true, snippet: '' });
});

test('workItemSearchMatch: title hit matches with no snippet (the row shows the title)', () => {
  assert.deepEqual(workItemSearchMatch(item, 'board'), { match: true, snippet: '' });
  assert.deepEqual(workItemSearchMatch(item, 'Q3 BOARD'), { match: true, snippet: '' });
});

test('workItemSearchMatch: body-only hit matches and returns a snippet around the term', () => {
  const result = workItemSearchMatch(item, 'indemnity');
  assert.equal(result.match, true);
  assert.match(result.snippet, /indemnity/i);
  // Mid-document hit is bracketed with an ellipsis.
  assert.match(result.snippet, /…/);
});

test('workItemSearchMatch: no hit, and file artifacts without text body never match', () => {
  assert.deepEqual(workItemSearchMatch(item, 'zzz-nope'), { match: false, snippet: '' });
  const fileItem = {
    title: 'Deck',
    artifacts: [{ type: 'file', data_base64: 'UEsD', content: '' }]
  };
  assert.deepEqual(workItemSearchMatch(fileItem, 'slide'), { match: false, snippet: '' });
  assert.deepEqual(workItemSearchMatch(null, 'x'), { match: false, snippet: '' });
});
