import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import '../../i18n/en.js';
import { getRegisteredPacks } from '../../lib/i18n.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const onboardingPagePath = path.join(testDir, 'onboarding-page.js');
const emptyStatePath = path.resolve(testDir, '..', 'chat', 'components', 'empty-state.js');

// onboarding-desk-1 — no fake readiness.
// The green READY badge must reflect a capability the gateway can prove:
// the provider is the active selection, or it holds a real stored key.
// It must NOT light up off `configured`, which is true for NEAR AI Cloud
// before any sign-in (api_key_required: false).
test('onboarding READY badge is gated on real auth, not pre-auth configured', async () => {
  const source = await readFile(onboardingPagePath, 'utf8');

  // The positive badge renders behind the showReady flag, not bare configured.
  assert.match(
    source,
    /\$\{showReady &&\s*html`<\$\{Badge\} tone="positive" label=\$\{t\('onboarding\.ready'\)\}/,
    'expected the READY badge to be gated on showReady'
  );

  // showReady is derived from real authentication signals.
  assert.match(
    source,
    /showReady=\$\{state\.activeProviderId === provider\.id \|\|\s*provider\.has_api_key === true\}/,
    'expected showReady to come from activeProviderId or a stored key'
  );

  // The old contract — badge keyed directly off `configured` — is gone.
  assert.doesNotMatch(
    source,
    /\$\{configured &&\s*html`<\$\{Badge\} tone="positive"/,
    'badge must not render off pre-auth `configured`'
  );

  // Settings owns isProviderConfigured; onboarding may import it but must not
  // redefine it here.
  assert.doesNotMatch(
    source,
    /function isProviderConfigured\b/,
    'onboarding must not redefine isProviderConfigured'
  );
});

// onboarding-tap-target — every NEAR AI Cloud auth control is a real tap target.
// The screen's whole job is the three sign-in actions; the two secondary ones
// (Use Google / Use NEAR Wallet) must match the primary's `md` height, not the
// 32px `size="sm"` they previously shipped at. The rendered floor is enforced in
// tests/static/a11y-static.spec.ts; this guards the source so the secondary auth
// buttons cannot silently regress to `sm`.
test('onboarding auth secondary actions use the md tap-target size, not sm', async () => {
  const source = await readFile(onboardingPagePath, 'utf8');

  // Pull every <Button …> element and look only at the auth actions that drive
  // NEAR AI Cloud sign-in (Google + Wallet). They must not be size="sm".
  const buttonBlocks = source.match(/<\$\{Button\}[\s\S]*?\/>|<\$\{Button\}[\s\S]*?<\/\/>/g) || [];
  const authSecondaries = buttonBlocks.filter(
    (block) => block.includes("startNearai('google')") || block.includes('startNearaiWallet')
  );
  assert.ok(authSecondaries.length >= 4, 'expected the Google/Wallet auth buttons to be present');
  for (const block of authSecondaries) {
    assert.doesNotMatch(
      block,
      /size="sm"/,
      'auth secondary actions must not use the sub-44px sm size'
    );
    assert.match(block, /size="md"/, 'auth secondary actions must use the md tap-target size');
  }
});

// onboarding-accent-discipline — gold is the agent's hand (DESIGN.md color law:
// "Never use gold as decoration"). The first-run trust rows are static product
// promises, not agent artifacts/receipts, so their icon tiles must not be gold.
test('onboarding trust-row icon tiles do not use gold as decoration', async () => {
  const source = await readFile(onboardingPagePath, 'utf8');

  const trustRow = source.match(/function TrustRow\([\s\S]*?\n}/);
  assert.ok(trustRow, 'expected a TrustRow component');
  assert.doesNotMatch(
    trustRow[0],
    /var\(--v2-gold/,
    'TrustRow must not paint its icon tile with gold (reserved for agent work)'
  );
});

// onboarding-desk-4 — the hero is a single, stable prepared-desk question, not a
// generic time-of-day greeting. The three hour-keyed slots exist for the i18n
// key-lock but intentionally resolve to one strong question. A chief-of-staff
// desk asks for the next task; it does not say "Good morning". This guards
// against re-introducing time-of-day greeting theater (an AI-tell trope) and
// against the DT-1 / spec heading drift it caused.
test('greeting keys resolve to the single stable prepared-desk question', () => {
  const packs = getRegisteredPacks();
  const en = packs.en || {};
  const morning = en['chat.heroMorning'];
  const afternoon = en['chat.heroAfternoon'];
  const evening = en['chat.heroEvening'];

  for (const [name, value] of [
    ['chat.heroMorning', morning],
    ['chat.heroAfternoon', afternoon],
    ['chat.heroEvening', evening]
  ]) {
    assert.equal(typeof value, 'string', `${name} should be a string`);
    assert.ok(value.trim().length > 0, `${name} should not be empty`);
  }

  const distinct = new Set([morning, afternoon, evening]);
  assert.equal(distinct.size, 1, 'hero stays one stable question, not time-of-day greetings');
  assert.match(morning, /What should IronClaw handle next\?/);
});

// The hour branch that selects those keys still exists and maps to the three
// hour-keyed hero slots (guards the rendering path even though they resolve equal).
test('empty-state hour branch maps to the three greeting keys', async () => {
  const source = await readFile(emptyStatePath, 'utf8');

  assert.match(source, /hour < 12.*return 'chat\.heroMorning'/s);
  assert.match(source, /hour < 18.*return 'chat\.heroAfternoon'/s);
  assert.match(source, /return 'chat\.heroEvening'/);
});
