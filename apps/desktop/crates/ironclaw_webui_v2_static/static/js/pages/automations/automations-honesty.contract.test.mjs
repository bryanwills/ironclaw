import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const jsRoot = path.resolve(dir, '..', '..');

// The Scheduled (automations) viewer is a real, gateway-backed, READ-ONLY
// surface (listAutomations). It lists recurring work the agent already created;
// it must never imply a create capability the gateway doesn't expose. Design
// Law: no fake readiness.
test('automations route is visible (real gateway-backed viewer), routines stays hidden (stub)', async () => {
  const routes = await readFile(path.join(jsRoot, 'app', 'routes.js'), 'utf8');
  assert.match(routes, /id: 'automations'[^}]*hidden: false/);
  // routines-api is still a TODO stub — must NOT be unhidden.
  assert.match(routes, /id: 'routines'[^}]*hidden: true/);
});

test('Scheduled viewer is read-only: no create form, only chat is the create path', async () => {
  const list = await readFile(path.join(dir, 'components', 'automations-list.js'), 'utf8');
  // No create/edit form controls — the surface only reads + filters + refreshes.
  assert.doesNotMatch(list, /<form/);
  assert.doesNotMatch(list, /<input/);
  assert.doesNotMatch(list, /<textarea/);
  // The create path is an honest hand-off to chat.
  assert.match(list, /to="\/chat"/);
});

test('nav + copy frame the surface as Scheduled and route creation through chat', async () => {
  const en = await readFile(path.join(jsRoot, 'i18n', 'en.js'), 'utf8');
  assert.match(en, /'nav\.automations': 'Scheduled'/);
  assert.match(en, /'automations\.title': 'Scheduled'/);
  // The description states creation happens in chat (no create UI here). The
  // value may be wrapped onto the next line by prettier, so span whitespace.
  assert.match(en, /'automations\.description':\s*'[^']*chat/i);
});
