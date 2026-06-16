import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pagesRoot = path.dirname(fileURLToPath(import.meta.url));
const staticJsRoot = path.resolve(pagesRoot, '..');

const routedStatusFiles = [
  'admin/components/user-detail.js',
  'automations/automations-page.js',
  'jobs/jobs-page.js',
  'jobs/components/job-files-tab.js',
  'missions/missions-page.js',
  'projects/projects-page.js',
  'projects/components/feedback-banner.js',
  'projects/components/project-inspector-rail.js',
  'projects/components/projects-attention-strip.js',
  'routines/routines-page.js',
  'workspace/workspace-page.js'
].map((relativePath) => path.join(pagesRoot, relativePath));

const rawStatusColorPattern =
  /\b(?:text|bg|border|hover:text|hover:bg|hover:border)-(?:red|yellow|amber|orange|emerald|green|lime)-\d/g;

test('routed pages and admin flows use semantic status tokens', async () => {
  const violations = [];

  for (const file of routedStatusFiles) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(rawStatusColorPattern)) {
      violations.push(`${path.relative(staticJsRoot, file)} contains ${match[0]}`);
    }
  }

  assert.deepEqual(violations, []);
});
