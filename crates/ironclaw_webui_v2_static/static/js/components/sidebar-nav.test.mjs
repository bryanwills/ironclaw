import assert from 'node:assert/strict';
import test from 'node:test';

import { WORK_ITEMS_KEY } from '../pages/chat/lib/work-product-save.js';
import { hasSavedWork } from './sidebar-nav.js';

function withStoredWorkItems(value, run) {
  const previous = globalThis.localStorage;
  const store = new Map();
  if (value !== undefined) store.set(WORK_ITEMS_KEY, value);
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: (key) => store.delete(key)
  };
  try {
    run();
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
}

test('Work entry stays hidden on first run with no saved work', () => {
  withStoredWorkItems(undefined, () => {
    assert.equal(hasSavedWork(), false);
  });
  withStoredWorkItems('[]', () => {
    assert.equal(hasSavedWork(), false);
  });
});

test('Work entry is gated open once a work product is saved', () => {
  withStoredWorkItems(JSON.stringify([{ id: 'work-1', title: 'Saved doc' }]), () => {
    assert.equal(hasSavedWork(), true);
  });
});

test('corrupt saved-work storage does not surface a dead Work link', () => {
  withStoredWorkItems('not json', () => {
    assert.equal(hasSavedWork(), false);
  });
});
