import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultRoute, primaryRoutes, routeForId } from './routes.js';

function visibleRouteIds() {
  return primaryRoutes.filter((route) => !route.hidden).map((route) => route.id);
}

test('desktop primary information architecture stays simple for normal users', () => {
  assert.equal(defaultRoute, '/chat');
  // 'automations' (labelled "Scheduled") is a real, gateway-backed read-only
  // viewer of recurring work the agent created — promoted into primary nav.
  assert.deepEqual(visibleRouteIds(), ['chat', 'work', 'automations', 'extensions', 'settings']);
});

test('saved work surface is a registered, visible route', () => {
  const work = primaryRoutes.find((route) => route.id === 'work');
  assert.ok(work, 'work route should be registered');
  assert.equal(work.hidden, false);
  assert.equal(work.path, '/work');
});

test('backend-blocked and specialist routes stay deep-link only', () => {
  const hiddenIds = new Set(primaryRoutes.filter((route) => route.hidden).map((route) => route.id));

  // 'automations' was promoted to visible nav (real read-only viewer); the rest
  // stay deep-link only until their backends are real ('routines' is still a
  // TODO stub, so it must stay hidden).
  for (const id of ['workspace', 'projects', 'jobs', 'routines', 'missions', 'admin']) {
    assert.equal(hiddenIds.has(id), true, `${id} should not appear in primary navigation`);
  }
});

test('unknown route ids fall back to chat', () => {
  assert.equal(routeForId('missing').id, 'chat');
});
