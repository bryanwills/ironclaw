import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const logsPagePath = path.join(testDir, 'logs-page.js');

const rawStatusColorPattern =
  /\b(?:text|bg|border)-(?:red|yellow|amber|orange|emerald|green|lime)-\d/g;

test('logs route uses semantic status tokens instead of raw Tailwind colors', async () => {
  const source = await readFile(logsPagePath, 'utf8');
  const violations = [...source.matchAll(rawStatusColorPattern)].map((match) => match[0]);

  assert.deepEqual(violations, []);
  assert.match(source, /--v2-warning-text/);
  assert.match(source, /--v2-danger-text/);
  assert.match(source, /--v2-warning-soft/);
  assert.match(source, /--v2-danger-soft/);
});

test('logs empty state is dignified and offers a real next action (DT-5)', async () => {
  const source = await readFile(logsPagePath, 'utf8');

  // The empty body must be a structured EmptyPanel (title + description), not a
  // bare line of muted text floating in a void.
  assert.match(source, /EmptyPanel/);
  assert.match(source, /title=\$\{t\('nav\.logs'\)\}/);
  assert.match(source, /description=\$\{t\('logs\.empty'\)\}/);

  // It must not dead-end: a primary Chat CTA routes to where work actually lives.
  assert.match(source, /as=\$\{Link\}\s+to="\/chat"\s+variant="primary"/);
  assert.match(source, /\$\{t\('nav\.chat'\)\}/);
});

test('logs stream controls are gated behind a live stream (no fake readiness)', async () => {
  const source = await readFile(logsPagePath, 'utf8');

  // Pause/Resume, Clear, Auto-scroll, and Server level act on a log stream. With
  // no v2 streaming endpoint the hook reports status:'todo'; the toolbar must not
  // render lifecycle controls that imply a controllable stream that has no source.
  assert.match(source, /const liveStream = status !== 'todo';/);

  const pauseIndex = source.indexOf("t('logs.pause')");
  const clearIndex = source.indexOf("t('logs.clear')");
  const autoScrollIndex = source.indexOf("t('logs.autoScroll')");
  assert.ok(pauseIndex > -1 && clearIndex > -1 && autoScrollIndex > -1);

  // Each lifecycle control sits inside a `${liveStream && ...}` guarded block.
  for (const controlIndex of [pauseIndex, clearIndex, autoScrollIndex]) {
    const guardBefore = source.lastIndexOf('${liveStream', controlIndex);
    assert.ok(
      guardBefore > -1 && guardBefore < controlIndex,
      'lifecycle control must be gated behind liveStream'
    );
  }
});

test('logs toolbar controls meet the 44px mobile tap-target floor', async () => {
  const source = await readFile(logsPagePath, 'utf8');

  // The named level-filter select and target-filter input always render, so they
  // must satisfy the >=44px tap-target floor (h-11) the sibling surfaces adopted.
  assert.match(source, /className="v2-select h-11/);
  assert.match(source, /type="text"[\s\S]*?className="h-11/);

  // No toolbar control regresses to the old 32px (h-8) height.
  assert.doesNotMatch(source, /className="v2-select h-8/);
});
