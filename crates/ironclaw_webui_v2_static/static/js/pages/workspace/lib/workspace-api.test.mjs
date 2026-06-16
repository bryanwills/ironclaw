import assert from 'node:assert/strict';
import test from 'node:test';

import { requireWorkspaceWriteSuccess } from './workspace-api.js';

test('workspace writes reject backend-blocked success false responses', () => {
  assert.throws(
    () =>
      requireWorkspaceWriteSuccess({
        success: false,
        message: 'TODO: requires v2 workspace endpoint'
      }),
    /requires v2 workspace endpoint/
  );
});

test('workspace writes preserve successful responses', () => {
  const response = { success: true, path: 'notes.md' };
  assert.equal(requireWorkspaceWriteSuccess(response), response);
});
