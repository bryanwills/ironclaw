import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const jobsRoot = path.resolve(testDir, '..');
const jobsPagePath = path.join(jobsRoot, 'jobs-page.js');
const useJobsPath = path.join(jobsRoot, 'hooks', 'useJobs.js');
const jobsApiPath = path.join(jobsRoot, 'lib', 'jobs-api.js');

// Design Law: "No fake readiness." The jobs endpoints are stubs today, so the
// six-tile summary strip would present hardcoded zeros as a live, polling
// metrics ledger. These assertions lock the gate so the lie cannot return
// without a real jobs backend.

test('jobs API is still a stub (gate precondition)', async () => {
  const source = await readFile(jobsApiPath, 'utf8');
  assert.match(source, /export function fetchJobsSummary\(\)[\s\S]*?todo: true/);
  assert.match(source, /export function fetchJobs\(\)[\s\S]*?todo: true/);
});

test('useJobs exposes a todo status derived from the stub payload', async () => {
  const source = await readFile(useJobsPath, 'utf8');
  assert.match(
    source,
    /status: summaryQuery\.data\?\.todo \|\| jobsQuery\.data\?\.todo \? 'todo' : 'ready'/
  );
});

test('jobs page gates the live metrics ledger behind a real backend', async () => {
  const source = await readFile(jobsPagePath, 'utf8');

  // The summary strip render must be guarded by status !== 'todo'.
  assert.match(
    source,
    /jobsState\.status !== 'todo' &&\s*html`<\$\{JobsSummaryStrip\} summary=\$\{jobsState\.summary\} \/>`/
  );

  // It must not render the strip unconditionally anymore.
  assert.doesNotMatch(
    source,
    /^\s*<\$\{JobsSummaryStrip\} summary=\$\{jobsState\.summary\} \/>\s*$/m
  );
});
