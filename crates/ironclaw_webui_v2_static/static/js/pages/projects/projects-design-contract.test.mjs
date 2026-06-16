import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectsRoot = testDir;
const projectsPagePath = path.join(projectsRoot, 'projects-page.js');
const useProjectsOverviewPath = path.join(projectsRoot, 'hooks', 'useProjectsOverview.js');
const projectsApiPath = path.join(projectsRoot, 'lib', 'projects-api.js');

// Design Law: "No fake readiness." The projects overview endpoint is a stub
// today, so the four-tile summary strip (including a green "Spend today" tile)
// would present hardcoded zeros as a live, 5s-polling metrics ledger. These
// assertions lock the gate so the lie cannot return without a real projects
// backend. Mirrors the shipped jobs-page gate (jobs-design-contract.test.mjs).

test('projects overview API is still a stub (gate precondition)', async () => {
  const source = await readFile(projectsApiPath, 'utf8');
  assert.match(source, /export function fetchProjectsOverview\(\)[\s\S]*?todo: true/);
});

test('useProjectsOverview exposes a todo status derived from the stub payload', async () => {
  const source = await readFile(useProjectsOverviewPath, 'utf8');
  assert.match(source, /status: query\.data\?\.todo \? 'todo' : 'ready'/);
  assert.match(source, /\bstatus:/);
});

test('projects page gates the live metrics summary strip behind a real backend', async () => {
  const source = await readFile(projectsPagePath, 'utf8');

  // The summary strip render must be guarded by status !== 'todo'.
  assert.match(
    source,
    /overviewState\.status !== 'todo' &&\s*html`<\$\{ProjectsSummaryStrip\} overview=\$\{overviewState\.overview\} \/>`/
  );

  // It must not render the strip unconditionally anymore.
  assert.doesNotMatch(
    source,
    /^\s*<\$\{ProjectsSummaryStrip\} overview=\$\{overviewState\.overview\} \/>\s*$/m
  );
});
