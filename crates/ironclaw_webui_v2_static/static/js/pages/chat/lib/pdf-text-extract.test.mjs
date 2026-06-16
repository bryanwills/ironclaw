import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopOcrAssetBase } from './pdf-text-extract.js';

test('desktop OCR assets use the per-boot tokenized loopback endpoint', () => {
  assert.equal(
    desktopOcrAssetBase({ port: 49152, token: 'boot token/with spaces' }),
    'http://127.0.0.1:49152/boot%20token%2Fwith%20spaces'
  );
});

test('desktop OCR assets keep legacy numeric endpoint compatibility', () => {
  assert.equal(desktopOcrAssetBase(49152), 'http://127.0.0.1:49152');
});
