import assert from 'node:assert/strict';
import test from 'node:test';

import { INFERENCE_FIELDS } from './settings-schema.js';

function fieldByKey(key) {
  for (const group of INFERENCE_FIELDS) {
    const field = group.fields.find((entry) => entry.key === key);
    if (field) return field;
  }
  return null;
}

test('desktop inference settings expose NEAR AI Cloud as the only embeddings provider', () => {
  const field = fieldByKey('embeddings.provider');

  assert.ok(field, 'embeddings.provider field should exist');
  assert.deepEqual(field.options, ['nearai']);
  assert.equal(field.optionLabels.nearai, 'NEAR AI Cloud');
  assert.equal(field.allowDefault, false);
});
