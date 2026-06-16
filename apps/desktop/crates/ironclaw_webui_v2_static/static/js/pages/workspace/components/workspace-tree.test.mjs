import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const treePath = path.join(testDir, 'workspace-tree.js');

async function source() {
  return readFile(treePath, 'utf8');
}

// DSYS-2 empty/loading dignity: the workspace tree previously rendered raw
// "Loading…"/"Searching…" text on off-system legacy tokens. Loading must now be
// a calm, reserved skeleton on the shared `.v2-skeleton` primitive, and every
// surface (loading, empty, rows, results) must use --v2-* tokens so the
// treatment is consistent with the rest of the static UI.

test('workspace tree loading uses the calm non-animated skeleton, not raw loading text', async () => {
  const src = await source();
  assert.match(src, /v2-skeleton/, 'loading should reuse the shared skeleton primitive');
  assert.match(src, /TreeSkeleton/, 'directory + search loading should share one skeleton');
  // No raw text-as-loading: the directory expand and search-results loading must
  // not fall back to bare "workspace.loading"/"workspace.searching" copy.
  assert.doesNotMatch(
    src,
    /t\(['"]workspace\.loading['"]\)/,
    'directory loading must not render raw loading text'
  );
  assert.doesNotMatch(
    src,
    /t\(['"]workspace\.searching['"]\)/,
    'search loading must not render raw searching text'
  );
});

test('workspace tree empty/result states keep an honest message and stay on v2 tokens', async () => {
  const src = await source();
  // Empty + no-results states still explain what is (not) here.
  assert.match(src, /workspace\.noFiles/);
  assert.match(src, /workspace\.noResults/);
  // No legacy off-system tokens — these are the inconsistent ad-hoc treatments
  // the dignity pass removed.
  const legacy = [
    /\btext-iron-\d/,
    /\bbg-iron-\d/,
    /\bborder-iron-\d/,
    /\bbg-signal\//,
    /\btext-signal\b/,
    /\bborder-white\//,
    /\bbg-white\//
  ];
  for (const pattern of legacy) {
    assert.doesNotMatch(
      src,
      pattern,
      `legacy token ${pattern} should be replaced with var(--v2-*)`
    );
  }
  assert.match(src, /var\(--v2-text-muted\)/);
});
