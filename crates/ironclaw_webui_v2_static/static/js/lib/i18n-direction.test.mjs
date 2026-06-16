import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { directionFor } from './i18n.js';

test('directionFor: Arabic is rtl, every other shipped locale is ltr', () => {
  assert.equal(directionFor('ar'), 'rtl');
  for (const lang of ['en', 'es', 'fr', 'de', 'pt-BR', 'ja', 'hi', 'uk', 'zh-CN', 'ko']) {
    assert.equal(directionFor(lang), 'ltr', `${lang} should be ltr`);
  }
  assert.equal(directionFor(''), 'ltr');
  assert.equal(directionFor(null), 'ltr');
});

test('the i18n provider sets document direction (not just lang) on switch + mount', async () => {
  const src = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'i18n.js'),
    'utf8'
  );
  // dir is applied both in setLang and the mount effect, derived from directionFor.
  const matches = src.match(/document\.documentElement\.dir = directionFor\(/g) || [];
  assert.ok(matches.length >= 2, 'documentElement.dir must be set in setLang and the mount effect');
});
