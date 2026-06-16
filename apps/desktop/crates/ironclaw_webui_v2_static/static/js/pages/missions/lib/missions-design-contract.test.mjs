import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const missionsRoot = path.resolve(testDir, '..');
const missionsPagePath = path.join(missionsRoot, 'missions-page.js');
const useMissionsPath = path.join(missionsRoot, 'hooks', 'useMissions.js');
const missionsApiPath = path.join(missionsRoot, 'lib', 'missions-api.js');

// Design Law: "No fake readiness." The missions endpoints are stubs today, so
// the four-tile summary strip would present hardcoded zeros as a live, polling
// metrics ledger. These assertions lock the gate so the lie cannot return
// without a real missions backend. Mirrors jobs-design-contract.test.mjs.

test('missions API is still a stub (gate precondition)', async () => {
  const source = await readFile(missionsApiPath, 'utf8');
  assert.match(source, /export function fetchProjectsOverview\(\)[\s\S]*?todo: true/);
  assert.match(source, /export function fetchMissions\([\s\S]*?todo: true/);
});

test('useMissions exposes a todo status derived from the stub payload', async () => {
  const source = await readFile(useMissionsPath, 'utf8');
  assert.match(source, /status: projectsQuery\.data\?\.todo \? 'todo' : 'ready'/);
});

test('missions page gates the live metrics ledger behind a real backend', async () => {
  const source = await readFile(missionsPagePath, 'utf8');

  // The summary strip render must be guarded by status !== 'todo'.
  assert.match(
    source,
    /missionsState\.status !== 'todo' &&\s*html`<\$\{MissionsSummaryStrip\} summary=\$\{missionsState\.summary\} \/>`/
  );

  // It must not render the strip unconditionally anymore.
  assert.doesNotMatch(
    source,
    /^\s*<\$\{MissionsSummaryStrip\} summary=\$\{missionsState\.summary\} \/>\s*$/m
  );
});
