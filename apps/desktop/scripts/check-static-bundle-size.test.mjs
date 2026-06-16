import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ASSET_GROUPS, measureStaticBundle } from './check-static-bundle-size.mjs';

test('measureStaticBundle covers shipped cold, code, diagram, document, OCR, total, and largest asset budgets', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ironclaw-static-bundle-'));
  const staticRoot = path.join(dir, 'static');

  for (const relativeFiles of Object.values(ASSET_GROUPS)) {
    for (const relativePath of relativeFiles) {
      const filePath = path.join(staticRoot, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${relativePath}\n`.repeat(relativePath.includes('main') ? 40 : 4));
    }
  }

  const budgetFile = path.join(dir, 'budget.json');
  writeFileSync(
    budgetFile,
    JSON.stringify({
      cold_gzip_kb: 100,
      main_bundle_gzip_kb: 100,
      vendor_boot_gzip_kb: 100,
      code_highlight_gzip_kb: 100,
      diagram_gzip_kb: 100,
      document_gzip_kb: 100,
      ocr_gzip_kb: 100,
      total_gzip_kb: 100,
      largest_asset_gzip_kb: 100
    })
  );

  const result = measureStaticBundle({ staticRoot, budgetFile });
  assert.deepEqual(
    result.files.map((file) => file.relativePath).sort(),
    Object.values(ASSET_GROUPS).flat().sort()
  );
  assert.equal(result.metrics.length, 9);
  assert.equal(result.violations.length, 0);
  assert.ok(result.metrics.find((metric) => metric.key === 'main_bundle')?.gzipBytes > 0);
  assert.ok(result.metrics.find((metric) => metric.key === 'vendor_boot')?.gzipBytes > 0);
  assert.ok(result.metrics.find((metric) => metric.key === 'code_highlight')?.gzipBytes > 0);
  assert.ok(result.metrics.find((metric) => metric.key === 'diagram')?.gzipBytes > 0);
  assert.ok(result.metrics.find((metric) => metric.key === 'largest_asset')?.detail);
});

test('measureStaticBundle reports a violation when a tracked shipped asset exceeds budget', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ironclaw-static-bundle-over-'));
  const staticRoot = path.join(dir, 'static');

  for (const relativeFiles of Object.values(ASSET_GROUPS)) {
    for (const relativePath of relativeFiles) {
      const filePath = path.join(staticRoot, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        relativePath === 'js/main.bundle.js'
          ? Array.from({ length: 2000 }, (_, index) => `unique-${index}`).join('\n')
          : relativePath
      );
    }
  }

  const budgetFile = path.join(dir, 'budget.json');
  writeFileSync(
    budgetFile,
    JSON.stringify({
      cold_gzip_kb: 1000,
      main_bundle_gzip_kb: 1,
      vendor_boot_gzip_kb: 1000,
      code_highlight_gzip_kb: 1000,
      diagram_gzip_kb: 1000,
      document_gzip_kb: 1000,
      ocr_gzip_kb: 1000,
      total_gzip_kb: 1000,
      largest_asset_gzip_kb: 1000
    })
  );

  const result = measureStaticBundle({ staticRoot, budgetFile });
  assert.ok(result.violations.some((metric) => metric.key === 'main_bundle'));
});
