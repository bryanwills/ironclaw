import assert from 'node:assert/strict';
import test from 'node:test';

import { containsSecret, redactJsonObject, redactSecrets } from './redact.js';

test('redactSecrets masks bearer tokens while preserving the label', () => {
  const out = redactSecrets('Authorization: Bearer abc123def');
  assert.equal(out, 'Authorization: Bearer *********');
  assert.ok(!out.includes('abc123def'));
});

test('redactSecrets masks prefixed API keys and multiple secrets', () => {
  const out = redactSecrets('sk-1234567890abcdef and pk-abcdefghijkl');
  assert.ok(!out.includes('1234567890abcdef'));
  assert.ok(!out.includes('abcdefghijkl'));
  assert.match(out, /^\*+ and \*+$/);
});

test('redactSecrets masks api_key values without erasing the label', () => {
  const out = redactSecrets('api_key="abcdefghijklmnop"');
  assert.equal(out, 'api_key="****************"');
});

test('redactSecrets preserveTips keeps a non-sensitive cue', () => {
  const out = redactSecrets('Bearer abcdefghij1234567890', { preserveTips: true });
  assert.equal(out, 'Bearer abcd...7890');
});

test('redactSecrets leaves plain and empty text unchanged', () => {
  assert.equal(redactSecrets('plain text'), 'plain text');
  assert.equal(redactSecrets(''), '');
});

test('redactJsonObject walks nested values without mutating input', () => {
  const input = {
    token: 'Bearer abc12345',
    nested: { api_key: 'sk-foofoofoofoo' },
    list: ['hello', 'ghp_123456789012345678901234567890123456']
  };

  const out = redactJsonObject(input);
  assert.ok(!JSON.stringify(out).includes('abc12345'));
  assert.ok(!JSON.stringify(out).includes('foofoofoofoo'));
  assert.ok(!JSON.stringify(out).includes('123456789012345678901234567890123456'));
  assert.equal(input.token, 'Bearer abc12345');
});

test('redactJsonObject preserves non-string leaves', () => {
  const out = redactJsonObject({ count: 7, ok: true, none: null });
  assert.deepEqual(out, { count: 7, ok: true, none: null });
});

test('containsSecret detects supported secret shapes without global regex state', () => {
  assert.equal(containsSecret('Bearer abc12345'), true);
  assert.equal(containsSecret('Bearer abc12345'), true);
  assert.equal(containsSecret('see sk-1234567890abcd'), true);
  assert.equal(containsSecret('hello world'), false);
  assert.equal(containsSecret(''), false);
});
