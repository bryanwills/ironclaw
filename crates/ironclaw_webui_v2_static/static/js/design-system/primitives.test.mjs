import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { StatCard } from './primitives.js';

// Every Badge tone StatCard's consumers actually pass (automations/jobs/routines
// summary strips + admin dashboard/usage tabs) plus the rest of the tone map.
const TONES = [
  'muted',
  'gold',
  'warning',
  'info',
  'signal',
  'success',
  'danger',
  'positive',
  'accent',
  'copper'
];

function visibleText(markup) {
  return [...markup.matchAll(/>([^<>]+)</g)].map((match) => match[1].trim()).filter(Boolean);
}

test('StatCard never renders its tone token as visible copy', () => {
  for (const tone of TONES) {
    const markup = renderToStaticMarkup(
      StatCard({ label: 'Active', value: 2, tone, detail: 'Updated just now' })
    );
    const text = visibleText(markup);

    // Design honesty: a styling token must drive the accent, never leak as a
    // decorative label. Regression guard for the verbatim `<Badge label=${tone}>`
    // that printed MUTED / GOLD / WARNING / INFO / etc. on every card.
    assert.ok(
      !text.some((node) => node.toLowerCase() === tone.toLowerCase()),
      `tone "${tone}" leaked as rendered text: ${JSON.stringify(text)}`
    );
    assert.doesNotMatch(markup, new RegExp(`>${tone}<`, 'i'));
    assert.doesNotMatch(markup, new RegExp(`>${tone.toUpperCase()}<`));
  }
});

test('StatCard still renders its real content (label, value, detail)', () => {
  const markup = renderToStaticMarkup(
    StatCard({ label: 'Paused', value: 7, tone: 'warning', detail: 'Awaiting validation' })
  );
  const text = visibleText(markup);

  assert.ok(text.includes('Paused'), 'label must render');
  assert.ok(text.includes('7'), 'value must render');
  assert.ok(text.includes('Awaiting validation'), 'detail must render');
});

test('StatCard expresses tone as a semantic v2 color dot, not raw status colors', () => {
  const toToken = {
    success: '--v2-positive-text',
    signal: '--v2-positive-text',
    warning: '--v2-warning-text',
    danger: '--v2-danger-text',
    info: '--v2-info-text',
    gold: '--v2-gold-text',
    muted: '--v2-text-muted'
  };

  for (const [tone, token] of Object.entries(toToken)) {
    const markup = renderToStaticMarkup(StatCard({ label: 'Total', value: 1, tone }));
    // Tone drives the accent dot via a semantic token (accent discipline +
    // status states route through --v2 tokens, never raw Tailwind colors).
    assert.match(markup, new RegExp(`bg-\\[var\\(${token}\\)\\]`), `${tone} dot uses ${token}`);
    assert.doesNotMatch(markup, /bg-(?:red|yellow|amber|orange|emerald|green|lime)-\d/);
  }
});

test('StatCard accent dot stays calm (no perpetual motion classes)', () => {
  const markup = renderToStaticMarkup(StatCard({ label: 'In progress', value: 3, tone: 'signal' }));
  // Calm-motion law: the indicator is a static dot, not a breathing/pulsing one.
  assert.doesNotMatch(markup, /v2-breathing-dot/);
  assert.doesNotMatch(markup, /animate-pulse|animate-bounce/);
});

test('StatCard tone dot is decorative and hidden from assistive tech', () => {
  const markup = renderToStaticMarkup(StatCard({ label: 'Failed', value: 0, tone: 'danger' }));
  // The dot carries no independent meaning beyond the label/value, so it is
  // aria-hidden — it must not announce a stray token to screen readers.
  assert.match(markup, /aria-hidden="true"/);
});
