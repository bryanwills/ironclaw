// Unit tests for workspace file-path extraction (gates the download chips).
//
// Run with Node's built-in test runner (no extra deps):
//   node --test crates/ironclaw_webui_v2_static/static/js/pages/chat/lib/project-file-paths.test.js
//
// `build.rs` excludes `*.test.js` from the embedded bundle, so this is never
// served to the browser.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { basename, extractWorkspaceFilePaths, formatSize } from './project-file-paths.js';

test('extracts a bare workspace path', () => {
  assert.deepEqual(extractWorkspaceFilePaths('I saved it to /workspace/report.csv for you.'), [
    '/workspace/report.csv'
  ]);
});

test('extracts a markdown link href without the closing paren', () => {
  assert.deepEqual(extractWorkspaceFilePaths('Here it is: [report](/workspace/out/report.csv)'), [
    '/workspace/out/report.csv'
  ]);
});

test('de-duplicates repeated references, first-seen order', () => {
  assert.deepEqual(
    extractWorkspaceFilePaths(
      'See /workspace/b.json and /workspace/a.csv, then /workspace/b.json again.'
    ),
    ['/workspace/b.json', '/workspace/a.csv']
  );
});

test('ignores non-workspace paths and extensionless tokens', () => {
  assert.deepEqual(
    extractWorkspaceFilePaths('Not these: /etc/passwd, /workspace (a dir), /project/x.csv'),
    []
  );
});

test('ignores workspace paths shown inside inline code', () => {
  assert.deepEqual(extractWorkspaceFilePaths('Run `cat /workspace/secret.env` to inspect it.'), []);
});

test('ignores workspace paths inside fenced code blocks', () => {
  assert.deepEqual(extractWorkspaceFilePaths('```sh\nrm /workspace/config.yaml\n```'), []);
});

test('still extracts a real reference alongside a code example', () => {
  assert.deepEqual(
    extractWorkspaceFilePaths(
      'Saved to /workspace/report.csv. To peek: `head /workspace/report.csv`.'
    ),
    ['/workspace/report.csv']
  );
});

test('handles empty / non-string content', () => {
  assert.deepEqual(extractWorkspaceFilePaths(''), []);
  assert.deepEqual(extractWorkspaceFilePaths(null), []);
  assert.deepEqual(extractWorkspaceFilePaths(undefined), []);
});

test('basename returns the final segment', () => {
  assert.equal(basename('/workspace/out/report.csv'), 'report.csv');
});

test('formatSize renders human-readable units', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatSize(undefined), '');
});
