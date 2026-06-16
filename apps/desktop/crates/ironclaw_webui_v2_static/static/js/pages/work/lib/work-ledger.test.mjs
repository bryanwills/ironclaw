import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWorkLedger } from './work-ledger.js';

test('buildWorkLedger flattens saved + action events reverse-chron, tagged by matter', () => {
  const items = [
    {
      id: 'newer',
      title: 'Q3 memo',
      updated_at: '2026-06-14T17:00:00.000Z',
      artifacts: [{ id: 'art-1', content: '...' }],
      receipts: [{ label: 'read_file', detail: 'board-notes.md', status: 'done' }]
    },
    {
      id: 'older',
      title: 'Invoice',
      created_at: '2026-06-14T09:00:00.000Z',
      artifacts: [{ id: 'art-2' }],
      receipts: []
    }
  ];
  const ledger = buildWorkLedger(items);
  // Newer matter's events (saved + its action) come before the older matter's.
  assert.deepEqual(
    ledger.map((e) => [e.kind, e.label, e.matterId]),
    [
      ['saved', 'Q3 memo', 'newer'],
      ['action', 'read_file', 'newer'],
      ['saved', 'Invoice', 'older']
    ]
  );
  // Action rows carry their matter + the artifact link target.
  const action = ledger.find((e) => e.kind === 'action');
  assert.equal(action.matter, 'Q3 memo');
  assert.equal(action.artifactId, 'art-1');
  assert.equal(action.detail, 'board-notes.md');
});

test('buildWorkLedger tolerates empty / malformed input', () => {
  assert.deepEqual(buildWorkLedger([]), []);
  assert.deepEqual(buildWorkLedger(null), []);
  assert.deepEqual(buildWorkLedger([{ title: 'no id' }]), []);
});
