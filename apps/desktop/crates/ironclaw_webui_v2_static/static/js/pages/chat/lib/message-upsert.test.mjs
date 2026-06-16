import assert from 'node:assert/strict';
import test from 'node:test';

import {
  failureMessageSourcePriority,
  upsertRunFailureMessage
} from './message-upsert.js';

test('upsertRunFailureMessage: keeps the first message when set is empty', () => {
  let messages = [];

  upsertRunFailureMessage((updater) => {
    messages = typeof updater === 'function' ? updater(messages) : updater;
  }, {
    runId: 'run-1',
    content: 'generic timeout text',
    source: 'fallback'
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'err-run-1');
  assert.equal(messages[0].content, 'generic timeout text');
  assert.equal(messages[0].errorSource, 'fallback');
});

test('upsertRunFailureMessage: run-status error replaces prior fallback', () => {
  let messages = [];

  upsertRunFailureMessage((updater) => {
    messages = typeof updater === 'function' ? updater(messages) : updater;
  }, {
    runId: 'run-1',
    content: 'generic timeout text',
    source: 'fallback'
  });

  upsertRunFailureMessage((updater) => {
    messages = typeof updater === 'function' ? updater(messages) : updater;
  }, {
    runId: 'run-1',
    content: 'summary: token limit',
    source: 'run_status'
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'summary: token limit');
  assert.equal(messages[0].errorSource, 'run_status');
});

test('upsertRunFailureMessage: keeps higher-priority failure when generic arrives later', () => {
  let messages = [];

  upsertRunFailureMessage((updater) => {
    messages = typeof updater === 'function' ? updater(messages) : updater;
  }, {
    runId: 'run-1',
    content: 'specific failure summary',
    source: 'run_status'
  });

  upsertRunFailureMessage((updater) => {
    messages = typeof updater === 'function' ? updater(messages) : updater;
  }, {
    runId: 'run-1',
    content: 'accepted this turn but no response',
    source: 'fallback'
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'specific failure summary');
  assert.equal(messages[0].errorSource, 'run_status');
});

test('upsertRunFailureMessage: source priority map is deterministic', () => {
  assert.equal(failureMessageSourcePriority('run_status'), 3);
  assert.equal(failureMessageSourcePriority('fallback'), 1);
  assert.equal(failureMessageSourcePriority('generic'), 1);
  assert.equal(failureMessageSourcePriority('other-unknown-value'), 0);
});
