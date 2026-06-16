import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addPending,
  loadPending,
  pendingMessageId,
  recordAcceptedMessageRef,
  removePending,
  replacePending
} from './pending-messages.js';

const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;

function installStorage() {
  const store = new Map();
  const localStorage = {
    getItem: (key) => store.get(key) || null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  };
  globalThis.localStorage = localStorage;
  globalThis.window = { localStorage };
  return store;
}

test.afterEach(() => {
  if (originalWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = originalWindow;
  }
  if (originalLocalStorage === undefined) {
    delete globalThis.localStorage;
  } else {
    globalThis.localStorage = originalLocalStorage;
  }
});

test('recordAcceptedMessageRef: null and non-msg refs leave pending record unchanged', () => {
  const refs = [null, undefined, 123, 'thread:1', 'message-1'];

  for (const acceptedMessageRef of refs) {
    const store = new Map();
    const timestamp = new Date().toISOString();
    const record = {
      id: 'pending-1',
      role: 'user',
      content: 'check my calendar',
      timestamp,
      isOptimistic: true
    };
    const sanitized = {
      ...record,
      images: [],
      attachments: [],
      timelineMessageId: null
    };

    addPending(store, 'thread-1', record);

    assert.equal(
      recordAcceptedMessageRef(store, 'thread-1', 'pending-1', acceptedMessageRef),
      null
    );
    assert.deepEqual(store.get('thread-1'), [sanitized]);
  }
});

test('pending records persist locally until timeline confirmation removes them', () => {
  installStorage();
  const memory = new Map();
  const record = {
    id: 'pending-1',
    role: 'user',
    content: 'draft from this template',
    timestamp: new Date().toISOString(),
    attachments: [
      {
        filename: 'template.pdf',
        mime_type: 'application/pdf',
        size_label: '8 bytes',
        data_base64: 'not persisted'
      }
    ],
    isOptimistic: true
  };

  addPending(memory, 'thread-1', record);

  const hydrated = loadPending('thread-1');
  assert.equal(hydrated.length, 1);
  assert.equal(hydrated[0].content, 'draft from this template');
  assert.deepEqual(hydrated[0].attachments, [
    {
      filename: 'template.pdf',
      mime_type: 'application/pdf',
      size_label: '8 bytes'
    }
  ]);

  recordAcceptedMessageRef(memory, 'thread-1', 'pending-1', 'msg:message-1');
  assert.equal(loadPending('thread-1')[0].timelineMessageId, 'message-1');

  removePending(memory, 'thread-1', 'pending-1');
  assert.deepEqual(loadPending('thread-1'), []);
});

test('replacePending clears storage when no pending records remain', () => {
  installStorage();
  const memory = new Map();
  replacePending(memory, 'thread-1', [
    {
      id: 'pending-1',
      content: 'still waiting',
      timestamp: new Date().toISOString()
    }
  ]);

  assert.equal(loadPending('thread-1').length, 1);
  replacePending(memory, 'thread-1', []);
  assert.deepEqual(loadPending('thread-1'), []);
  assert.equal(memory.has('thread-1'), false);
});

test('pendingMessageId generates collision-proof ids', () => {
  const ids = new Set(Array.from({ length: 200 }, () => pendingMessageId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^pending-/);
});

test('removePending and accepted-ref updates touch only the first id match', () => {
  installStorage();
  const store = new Map();
  const key = 'thread-collide';
  addPending(store, key, {
    id: 'pending-dup',
    role: 'user',
    content: 'restored from a prior session',
    timestamp: '2026-06-02T09:00:00.000Z'
  });
  addPending(store, key, {
    id: 'pending-dup',
    role: 'user',
    content: 'new turn this session',
    timestamp: '2026-06-02T10:00:00.000Z'
  });

  recordAcceptedMessageRef(store, key, 'pending-dup', 'msg:message-new');
  const afterUpdate = store.get(key);
  assert.equal(afterUpdate[0].timelineMessageId, 'message-new');
  assert.equal(afterUpdate[1].timelineMessageId, null);

  removePending(store, key, 'pending-dup');
  const afterRemove = store.get(key);
  assert.equal(afterRemove.length, 1);
  assert.equal(afterRemove[0].content, 'new turn this session');
});

test('sanitizeRecord keeps attachment metadata while dropping image payloads', () => {
  installStorage();
  const store = new Map();
  const key = 'thread-image';
  addPending(store, key, {
    id: pendingMessageId(),
    role: 'user',
    content: 'describe this screenshot',
    // Fresh timestamp: loadPending expires records older than 24h.
    timestamp: new Date().toISOString(),
    images: ['data:image/png;base64,AAAA'],
    attachments: [{ filename: 'screenshot.png', mime_type: 'image/png', size_label: '2048 bytes' }]
  });

  const restored = loadPending(key);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].images, []);
  assert.deepEqual(restored[0].attachments, [
    { filename: 'screenshot.png', mime_type: 'image/png', size_label: '2048 bytes' }
  ]);
});
