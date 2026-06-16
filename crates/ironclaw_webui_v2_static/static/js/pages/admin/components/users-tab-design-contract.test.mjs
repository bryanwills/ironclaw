import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const tabPath = path.join(testDir, 'users-tab.js');
const dashboardPath = path.join(testDir, 'dashboard-tab.js');
const detailPath = path.join(testDir, 'user-detail.js');
const hookPath = path.join(testDir, '..', 'hooks', 'useAdminUsers.js');
const usageHookPath = path.join(testDir, '..', 'hooks', 'useAdminUsage.js');

// The admin user-management endpoints are permanent stubs: `admin-api.js`
// returns `{ todo: true }` for reads and `{ success: false }` for every write
// (create, suspend/activate, role change, token issuance). A deep-link to
// /admin/users must not render an Add-user form or per-row action buttons that
// POST into the void and silently no-op. Design Law: "No fake readiness — a
// surface may not imply a capability the gateway cannot prove."

test('useAdminUsers reports status:todo while the admin backend is a stub', async () => {
  const source = await readFile(hookPath, 'utf8');

  // The stub read carries `{ todo: true }`; the hook must surface it as status so
  // the tab can gate its write controls on a proven backend.
  assert.match(source, /const status = rawUsers\?\.todo \? 'todo' : 'ready';/);
  assert.match(source, /\bstatus,/);
});

test('admin users write controls are gated behind a real backend (no fake readiness)', async () => {
  const source = await readFile(tabPath, 'utf8');

  // The tab derives a single capability flag from the hook status.
  assert.match(source, /const canManage = status !== 'todo';/);

  // The Add-user form must be gated: it submits createUser, which the stub never
  // persists. It may not render over a permanent stub.
  const createFormIndex = source.indexOf('<${CreateUserForm}');
  assert.ok(createFormIndex > -1, 'CreateUserForm must still exist in source');
  const guardBeforeForm = source.lastIndexOf('${canManage', createFormIndex);
  assert.ok(
    guardBeforeForm > -1 && guardBeforeForm < createFormIndex,
    'CreateUserForm must sit inside a ${canManage && ...} guard'
  );

  // The freshly-issued-token banner depends on a token mutation that can never
  // succeed against the stub; it must also be gated.
  const tokenBannerIndex = source.indexOf('<${TokenBanner}');
  assert.ok(tokenBannerIndex > -1, 'TokenBanner must still exist in source');
  const guardBeforeToken = source.lastIndexOf('${canManage', tokenBannerIndex);
  assert.ok(
    guardBeforeToken > -1 && guardBeforeToken < tokenBannerIndex,
    'TokenBanner must sit inside a ${canManage && ...} guard'
  );

  // Per-row Suspend/Activate/Promote/Demote/Token actions are passed canManage
  // and only render their button cluster when management is real.
  assert.match(source, /canManage=\$\{canManage\}/);
  assert.match(source, /\$\{canManage &&\s*html`<div className="flex gap-1">/);
});

test('admin users roster still renders read-only when management is unavailable', async () => {
  const source = await readFile(tabPath, 'utf8');

  // Do not delete the surface: the roster, search, and filters must remain so the
  // page stays informative. The user name button (onSelect) is read navigation,
  // not a stubbed write, so it is never gated.
  assert.match(source, /onClick=\$\{\(\) => onSelect\(user\.id\)\}/);
  assert.match(source, /t\('admin\.users\.title'/);
  // The empty roster keeps its honest existing copy rather than a fake form.
  assert.match(source, /t\('admin\.users\.noMatch'\)/);
});

// ── Admin usage dashboard: no fake readiness ──────────────────────────────
// `fetchUsageSummary` is a permanent stub returning all-zero metrics with
// `{ todo: true }`. The System-overview and 30-day-usage panels render a
// 30s-polling live ledger; showing hardcoded zeros as a metrics dashboard
// implies tracking the gateway cannot prove. Mirror the shipped jobs-page gate.

test('useUsageSummary surfaces a todoStatus derived from the stub payload', async () => {
  const source = await readFile(usageHookPath, 'utf8');

  // The stub read carries `{ todo: true }`; the hook must expose it as a
  // readiness status so the dashboard can gate its metric panels.
  assert.match(source, /const todoStatus = query\.data\?\.todo \? 'todo' : 'ready';/);
  assert.match(source, /return \{ \.\.\.query, todoStatus \};/);
});

test('admin dashboard metric panels are gated behind a real backend (no fake readiness)', async () => {
  const source = await readFile(dashboardPath, 'utf8');

  // The dashboard derives a single readiness flag from the usage hook.
  assert.match(source, /const status = summaryQuery\.todoStatus;/);

  // The System-overview panel (uptime + user-count tiles) must not render over
  // the permanent stub.
  const systemOverviewIndex = source.indexOf("t('admin.dashboard.systemOverview')");
  assert.ok(systemOverviewIndex > -1, 'System-overview panel must still exist');
  const guardBeforeSystem = source.lastIndexOf("status !== 'todo'", systemOverviewIndex);
  assert.ok(
    guardBeforeSystem > -1 && guardBeforeSystem < systemOverviewIndex,
    'System-overview panel must sit inside a status !== todo guard'
  );

  // The 30-day-usage panel (jobs/llm-call/cost tiles) must also be gated.
  const usagePanelIndex = source.indexOf("t('admin.dashboard.usage30d')");
  assert.ok(usagePanelIndex > -1, '30-day-usage panel must still exist');
  const guardBeforeUsage = source.lastIndexOf("status !== 'todo'", usagePanelIndex);
  assert.ok(
    guardBeforeUsage > -1 && guardBeforeUsage < usagePanelIndex,
    '30-day-usage panel must sit inside a status !== todo guard'
  );
});

test('admin dashboard does not hardcode a success tile over all-zero stubs', async () => {
  const source = await readFile(dashboardPath, 'utf8');

  // The Active-users tile previously shipped `tone="success"` unconditionally,
  // painting a zero metric green. Tones must be derived from the value, not
  // hardcoded green. (Static `tone="signal"` neutral-accent tiles are allowed.)
  assert.doesNotMatch(source, /tone="success"/);
  assert.match(source, /tone=\$\{userStats\.active > 0 \? 'success' : 'muted'\}/);
});

test('admin dashboard keeps the read-only recent-users table ungated', async () => {
  const source = await readFile(dashboardPath, 'utf8');

  // The recent-users table reads local roster state (not a stubbed metric), so
  // it must remain visible to keep the surface informative even while the usage
  // backend is a stub.
  assert.match(source, /<\$\{RecentUsersTable\}/);
  assert.match(source, /t\('admin\.dashboard\.recentUsers'\)/);
});

// ── Touch-target floors (44px mobile floor) ───────────────────────────────

test('admin user-management controls meet the 44px touch-target floor', async () => {
  const tabSource = await readFile(tabPath, 'utf8');
  const detailSource = await readFile(detailPath, 'utf8');

  // No sub-floor fixed heights remain on the interactive admin controls
  // (create-user inputs/select were h-9, search was h-8, destructive buttons
  // were h-10). Size-tokened controls use min-h-[44px], never bare h-* tokens
  // that cn() would mis-sort.
  assert.doesNotMatch(tabSource, /className="[^"]*\bh-9\b/);
  assert.doesNotMatch(tabSource, /className="[^"]*\bh-8\b/);
  assert.doesNotMatch(tabSource, /\bh-10\b/);
  assert.doesNotMatch(detailSource, /\bh-10\b/);

  // The create-user inputs, search, filter chips, and destructive buttons all
  // carry the floor.
  const tabFloors = tabSource.match(/min-h-\[44px\]/g) || [];
  assert.ok(
    tabFloors.length >= 6,
    `expected >=6 min-h-[44px] controls in users-tab, found ${tabFloors.length}`
  );
  assert.match(detailSource, /min-h-\[44px\]/);
});

// ── Icon-only close buttons must have an accessible name ───────────────────

test('admin token close (x) buttons have an accessible name', async () => {
  const tabSource = await readFile(tabPath, 'utf8');
  const detailSource = await readFile(detailPath, 'utf8');

  // The token banner close buttons are icon-only (aria-hidden glyph); without a
  // label they are unnamed to the axe scan / screen readers. Reuse the existing
  // shortcuts.close i18n key (no new keys).
  assert.match(tabSource, /aria-label=\$\{t\('shortcuts\.close'\)\}/);
  assert.match(detailSource, /aria-label=\$\{t\('shortcuts\.close'\)\}/);
});
