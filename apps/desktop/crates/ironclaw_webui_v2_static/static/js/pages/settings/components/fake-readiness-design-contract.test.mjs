import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = path.dirname(fileURLToPath(import.meta.url));
const hooksDir = path.resolve(componentsDir, '..', 'hooks');
const settingsDir = path.resolve(componentsDir, '..');
const i18nDir = path.resolve(componentsDir, '..', '..', '..', 'i18n');

// Settings sub-tabs reachable by deep-link (/v2/settings/<tab>) must not present
// actionable controls backed by permanent stubs. `settings-api.js` returns
// `{ todo: true }` for skills/tools reads and `{ success: false }` for their
// writes. Design Law: "No fake readiness — a surface may not imply a capability
// the gateway cannot prove." Mirrors the inference-tab and logs gates.

test('useSkills reports status:todo while the skills backend is a stub', async () => {
  const source = await readFile(path.join(hooksDir, 'useSkills.js'), 'utf8');

  assert.match(source, /const status = query\.data\?\.todo \? 'todo' : 'ready';/);
  assert.match(source, /\bstatus,/);
});

test('skills import form is gated behind a real backend (no fake readiness)', async () => {
  const source = await readFile(path.join(componentsDir, 'skills-tab.js'), 'utf8');

  // The install panel is built once, gated on a proven backend, then reused in
  // every render branch. It must never render unconditionally over the stub.
  assert.match(source, /const installPanel =\s*\n?\s*status !== 'todo'/);
  assert.match(source, /\? html`<\$\{SkillInstallPanel\}/);

  // No render branch may mount SkillInstallPanel directly; only `${installPanel}`
  // is allowed past the gated definition.
  const directMounts = [...source.matchAll(/<\$\{SkillInstallPanel\}/g)];
  assert.equal(
    directMounts.length,
    1,
    'SkillInstallPanel may only be referenced inside the gated installPanel definition'
  );
  assert.match(source, /\$\{installPanel\}/);

  // The dignified installed/empty states stay so the surface is not deleted.
  assert.match(source, /t\('skills\.noInstalled'\)/);
  assert.match(source, /t\('skills\.noInstalledDesc'\)/);
});

test('useTools reports status:todo and never flashes a fake saved state', async () => {
  const source = await readFile(path.join(hooksDir, 'useTools.js'), 'utf8');

  assert.match(source, /const status = query\.data\?\.todo \? 'todo' : 'ready';/);
  assert.match(source, /\bstatus,/);

  // The optimistic cache write + "saved" flash must only fire on a confirmed
  // write, never on the `{ success: false }` / `{ todo: true }` stub response.
  assert.match(source, /if \(data\?\.success === false \|\| data\?\.todo\) \{\s*\n?\s*return;/);
  const guardIndex = source.indexOf('data?.success === false');
  const savedIndex = source.indexOf('setSavedTools((prev) => ({ ...prev, [name]: true }))');
  assert.ok(
    guardIndex > -1 && savedIndex > -1 && guardIndex < savedIndex,
    'the success/todo guard must precede the saved-indicator write'
  );
});

test('tool permission selects are gated behind a real backend (no fake readiness)', async () => {
  const source = await readFile(path.join(componentsDir, 'tools-tab.js'), 'utf8');

  // The tab derives a capability flag from the hook status and passes it down.
  assert.match(source, /const canEdit = status !== 'todo';/);
  assert.match(source, /canEdit=\$\{canEdit\}/);

  // A row presents as read-only (a Badge) when locked OR when the gateway cannot
  // persist permission changes — never an editable select that silently no-ops.
  assert.match(source, /const isLocked = tool\.locked \|\| !canEdit;/);

  // The editable select still sits behind the isLocked branch (read-only Badge in
  // the truthy branch, select only in the falsy branch).
  const lockedTernaryIndex = source.indexOf('${isLocked');
  const selectIndex = source.indexOf('onChange=${(e) => onPermissionChange');
  assert.ok(
    lockedTernaryIndex > -1 && selectIndex > -1 && lockedTernaryIndex < selectIndex,
    'the permission select must remain gated behind the isLocked ternary'
  );
});

// The Agent and Networking sub-tabs render only `SettingsGroup` field cards, every
// one of which writes through `useSettings.save` (the v2 `{ success: false }`
// stub). When the settings backend cannot persist (status:'todo') they must show
// an honest explanation, never editable controls that silently no-op. Mirrors the
// inference-tab gate. Design Law: "No fake readiness."
for (const tab of ['agent', 'networking']) {
  test(`${tab}-tab gates its editable fields on settings status (no fake readiness)`, async () => {
    const source = await readFile(path.join(componentsDir, `${tab}-tab.js`), 'utf8');

    // The tab accepts the settings status and derives the gate from a todo stub.
    assert.match(source, /settingsStatus = 'ready'/);
    assert.match(source, /if \(settingsStatus === 'todo'\) \{/);

    // The honest unavailable state renders instead of the field controls.
    assert.match(source, /import \{ SettingsNotWritable \} from '\.\/settings-not-writable\.js';/);
    assert.match(source, /<\$\{SettingsNotWritable\} \/>/);

    // The editable SettingsGroup must sit after the todo gate, so the stub branch
    // returns before any field card is ever constructed.
    const gateIndex = source.indexOf("if (settingsStatus === 'todo')");
    const groupIndex = source.indexOf('<${SettingsGroup}');
    assert.ok(
      gateIndex > -1 && groupIndex > -1 && gateIndex < groupIndex,
      'the todo gate must precede the editable SettingsGroup render'
    );
  });
}

test('settings-page wires the settings status into the agent and networking tabs', async () => {
  const source = await readFile(path.join(settingsDir, 'settings-page.js'), 'utf8');

  // Both deep-linkable write tabs receive the real settings status so their gate
  // reflects the gateway, not a hardcoded default.
  for (const tag of ['AgentTab', 'NetworkingTab']) {
    const open = source.indexOf(`<\${${tag}}`);
    assert.ok(open > -1, `${tag} must be mounted`);
    const close = source.indexOf('/>', open);
    const props = source.slice(open, close);
    assert.match(props, /settingsStatus=\$\{status\}/);
  }
});

// The Users sub-tab's only write is `createUser`, which hits the v2 users stub
// (`fetchUsers` → { todo: true }, `createUser` → { success: false }). The
// add-user form must not render over that stub — it would silently no-op.
test('useUsers reports status:todo while the users backend is a stub', async () => {
  const source = await readFile(path.join(hooksDir, 'useUsers.js'), 'utf8');

  assert.match(source, /const status = query\.data\?\.todo \? 'todo' : 'ready';/);
  assert.match(source, /\bstatus,/);
});

test('users-tab gates the create-user form behind a real backend (no fake readiness)', async () => {
  const source = await readFile(path.join(componentsDir, 'users-tab.js'), 'utf8');

  // The honest unavailable state renders instead of the add-user form.
  assert.match(source, /import \{ SettingsNotWritable \} from '\.\/settings-not-writable\.js';/);
  assert.match(source, /if \(status === 'todo'\) \{/);
  assert.match(source, /<\$\{SettingsNotWritable\} \/>/);

  // The todo gate must precede the CreateUserForm render so the stub branch
  // returns before the add-user affordance is ever mounted.
  const gateIndex = source.indexOf("if (status === 'todo')");
  const formIndex = source.indexOf('<${CreateUserForm}');
  assert.ok(
    gateIndex > -1 && formIndex > -1 && gateIndex < formIndex,
    'the todo gate must precede the CreateUserForm render'
  );
});

test('SettingsNotWritable is a read-only honest state backed by real i18n keys', async () => {
  const source = await readFile(path.join(componentsDir, 'settings-not-writable.js'), 'utf8');

  // It is an explanation, not a control surface: no inputs, toggles, or buttons.
  assert.doesNotMatch(source, /<button|<input|<select|role="switch"/);
  assert.match(source, /t\('settings\.notWritable'\)/);
  assert.match(source, /t\('settings\.notWritableDesc'\)/);

  // The shared copy must exist in the English pack so the gate is never a blank.
  const en = await readFile(path.join(i18nDir, 'en.js'), 'utf8');
  assert.match(en, /'settings\.notWritable':/);
  assert.match(en, /'settings\.notWritableDesc':/);
});
