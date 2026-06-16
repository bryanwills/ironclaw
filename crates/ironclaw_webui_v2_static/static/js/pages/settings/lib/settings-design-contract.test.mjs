import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const settingsRoot = path.resolve(testDir, '..');
const staticJsRoot = path.resolve(settingsRoot, '..', '..');

const settingsStatusFiles = [
  path.join(settingsRoot, 'settings-page.js'),
  path.join(settingsRoot, 'components', 'provider-login-status.js'),
  path.join(settingsRoot, 'components', 'provider-dialog.js'),
  path.join(settingsRoot, 'components', 'restart-banner.js'),
  path.join(settingsRoot, 'components', 'skills-tab.js')
];

const rawStatusColorPattern =
  /\b(?:text|bg|border|hover:text|hover:bg|hover:border)-(?:red|yellow|amber|orange|emerald|green|lime)-\d/g;

test('settings status states use semantic desktop tokens', async () => {
  const violations = [];

  for (const file of settingsStatusFiles) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(rawStatusColorPattern)) {
      violations.push(`${path.relative(staticJsRoot, file)} contains ${match[0]}`);
    }
  }

  assert.deepEqual(violations, []);
});

// Settings section eyebrows must share ONE treatment. The cleaned Inference
// summary uses non-mono `text-xs font-semibold uppercase tracking-[0.08em]`;
// the shared field-group and language headers rendered on the same scroll must
// not flip back to the old `font-mono text-[11px]` eyebrow (review 2026-06-12
// line 549/559: "rationalize Settings typography and reduce mono overuse").
const monoEyebrowPattern = /font-mono text-\[11px\] uppercase tracking-\[0\.14em\]/;

test('shared settings section headers stay non-mono like the inference summary', async () => {
  const fieldSource = await readFile(
    path.join(settingsRoot, 'components', 'settings-field.js'),
    'utf8'
  );
  const languageSource = await readFile(
    path.join(settingsRoot, 'components', 'language-tab.js'),
    'utf8'
  );

  assert.doesNotMatch(
    fieldSource,
    monoEyebrowPattern,
    'SettingsGroup header must match the non-mono inference eyebrow'
  );
  assert.doesNotMatch(
    languageSource,
    monoEyebrowPattern,
    'Language header must match the non-mono inference eyebrow'
  );
  assert.match(fieldSource, /text-xs font-semibold uppercase tracking-\[0\.08em\]/);
  assert.match(languageSource, /text-xs font-semibold uppercase tracking-\[0\.08em\]/);
});

// Mobile-first touch-target law: the densest control surface in the app must
// hit 44px on touch widths while staying compact on desktop. Guards the shared
// field controls and the first-class active-model picker.
test('settings controls meet the 44px mobile touch target', async () => {
  const fieldSource = await readFile(
    path.join(settingsRoot, 'components', 'settings-field.js'),
    'utf8'
  );
  const providerSource = await readFile(
    path.join(settingsRoot, 'components', 'provider-card.js'),
    'utf8'
  );

  // Shared select + number input: 44px mobile, dense h-9 desktop.
  assert.match(fieldSource, /h-11[^"]*md:h-9/);
  // Toggle hit area is a 44px touch row collapsing to the compact desktop track.
  assert.match(fieldSource, /h-11 w-11[^"]*md:h-6/);
  // Active-model picker select keeps 44px mobile; the legacy h-9-only is gone.
  assert.match(providerSource, /h-11 text-xs md:h-9/);
  assert.doesNotMatch(providerSource, /className="h-9 text-xs"/);
  // Provider disclosure chevron is tappable on mobile.
  assert.match(providerSource, /h-11 w-11[^"]*md:h-7 md:w-7/);
});

// De-jargon: the language list shows human-readable names, not config dumps.
// English names render in the proportional UI font; only the locale CODE keeps
// mono (it is a genuine identifier).
test('language tab renders prose names without monospace plumbing', async () => {
  const languageSource = await readFile(
    path.join(settingsRoot, 'components', 'language-tab.js'),
    'utf8'
  );

  // The English-name labels (current.name / l.name) must not be mono.
  assert.doesNotMatch(languageSource, /font-mono[^`]*\$\{current\.name\}/);
  assert.doesNotMatch(languageSource, /font-mono[^`]*\$\{l\.name\}/);
  // The locale code stays mono on purpose.
  assert.match(languageSource, /font-mono[^`]*\$\{\s*\n?\s*l\.code/);
});
