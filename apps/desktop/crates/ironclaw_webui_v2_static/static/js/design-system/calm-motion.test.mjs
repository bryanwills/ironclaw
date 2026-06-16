import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jsRoot = path.resolve(testDir, '..');
const staticRoot = path.resolve(jsRoot, '..');

const scannedRoots = [jsRoot, path.join(staticRoot, 'styles')];

const forbiddenTokens = [
  'animate-pulse',
  'animate-bounce',
  'animate-[v2-breathe',
  '.animate-\\[v2-breathe',
  '@keyframes pulse',
  '@keyframes bounce',
  'v2-skeleton-shimmer'
];

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'vendor') return [];
        return collectFiles(fullPath);
      }
      if (!/\.(js|css)$/.test(entry.name)) return [];
      if (entry.name.endsWith('.test.mjs')) return [];
      return [fullPath];
    })
  );
  return files.flat();
}

test('static UI avoids cheap perpetual pulse and bounce utilities', async () => {
  const files = (await Promise.all(scannedRoots.map((root) => collectFiles(root)))).flat();
  const violations = [];

  for (const file of files) {
    const contents = await readFile(file, 'utf8');
    for (const token of forbiddenTokens) {
      if (contents.includes(token)) {
        violations.push(`${path.relative(staticRoot, file)} contains ${token}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('static skeleton primitive remains non-animated', async () => {
  const appCss = await readFile(path.join(staticRoot, 'styles', 'app.css'), 'utf8');
  const skeletonRule = appCss.match(/\.v2-skeleton\s*\{(?<body>[^}]*)\}/s);

  assert.ok(skeletonRule?.groups?.body, 'expected a .v2-skeleton rule in app.css');
  const animationDeclarations = [
    ...skeletonRule.groups.body.matchAll(/animation:\s*([^;]+);/g)
  ].map((match) => match[1].trim());
  assert.deepEqual(animationDeclarations, ['none']);
});

test('reduced-motion policy disables ambient motion and opts in semantic live dots only', async () => {
  const appCss = await readFile(path.join(staticRoot, 'styles', 'app.css'), 'utf8');
  const globalMotionRule = [
    ...appCss.matchAll(/\*,\s*\*::before,\s*\*::after\s*\{(?<body>[^}]*)\}/gs)
  ].find((match) => match.groups?.body?.includes('animation: none !important'));
  const noPreferenceRule = appCss.match(
    /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{(?<body>[\s\S]*?)\n\}/
  );

  assert.ok(globalMotionRule?.groups?.body, 'expected global motion policy rule');
  assert.match(globalMotionRule.groups.body, /animation:\s*none\s*!important;/);
  assert.match(globalMotionRule.groups.body, /transition:\s*none\s*!important;/);

  assert.ok(noPreferenceRule?.groups?.body, 'expected reduced-motion no-preference opt-in');
  assert.match(noPreferenceRule.groups.body, /\.v2-breathing-dot\s*\{/);
  assert.match(noPreferenceRule.groups.body, /animation:\s*v2-breathe\s+2\.4s/);
});
