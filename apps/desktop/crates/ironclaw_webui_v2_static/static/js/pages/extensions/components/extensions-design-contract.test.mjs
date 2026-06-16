import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SURFACE_FILES = [
  '../extensions-page.js',
  './action-toast.js',
  './channels-tab.js',
  './extension-card.js',
  './installed-tab.js',
  './mcp-tab.js',
  './pairing-section.js',
  './registry-tab.js'
];

const LEGACY_SURFACE_PATTERNS = [
  /text-iron-/,
  /text-white/,
  /border-white/,
  /bg-white\//,
  /bg-white\[/,
  /text-signal/,
  /text-mint/,
  /border-mint/,
  /bg-mint/,
  /text-red-/,
  /border-red-/,
  /bg-red-/
];

test('Connections surfaces use v2 tokens instead of legacy dark-era utility classes', () => {
  const failures = [];

  for (const path of SURFACE_FILES) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const pattern of LEGACY_SURFACE_PATTERNS) {
      if (pattern.test(source)) {
        failures.push(`${path}: ${pattern}`);
      }
    }
    if (
      source.includes('className="v2-panel') ||
      source.includes("className='v2-panel") ||
      source.includes('className={`v2-panel') ||
      source.includes("'v2-panel ")
    ) {
      failures.push(`${path}: className contains legacy v2-panel`);
    }
  }

  assert.deepEqual(failures, []);
});
