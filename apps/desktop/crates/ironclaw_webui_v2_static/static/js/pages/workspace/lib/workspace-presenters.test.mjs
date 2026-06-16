import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_WORKSPACE_PATH, routeForWorkspacePath } from './workspace-presenters.js';

test('workspace root does not select a phantom default file', () => {
  assert.equal(DEFAULT_WORKSPACE_PATH, '');
  assert.equal(routeForWorkspacePath(DEFAULT_WORKSPACE_PATH), '/workspace');
});
