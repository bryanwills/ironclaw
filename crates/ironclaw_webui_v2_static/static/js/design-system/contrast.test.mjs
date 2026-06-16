/**
 * contrast.test.mjs — WCAG 2.1 AA color-contrast guard for v2 design tokens.
 *
 * Parses --v2-* token values straight from styles/app.css (both :root light
 * and :root[data-theme="dark"]), resolves var() fallback chains, alpha-
 * composites rgba()/color-mix soft backgrounds over the solid surface they
 * render on, computes WCAG relative-luminance contrast ratios, and asserts
 * AA (4.5:1 normal text) for every pair used as genuinely readable text.
 *
 * Documented exceptions (decorative / icon-only / hairline, below the 3:1 bar
 * but not used as essential readable text) are encoded in EXCEPTIONS so the
 * guard cannot silently swallow a real regression but also cannot false-fail
 * on intentional non-text uses.
 *
 * This is an additive guard: it does not change any token. If tokens regress
 * below AA on a readable-text pair, this test fails.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const appCssPath = path.resolve(testDir, '..', '..', 'styles', 'app.css');

/* ── color math ─────────────────────────────────────────────────────── */

function clamp8(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function parseColor(str) {
  // returns { rgb:[r,g,b], a } with a in 0..1
  const s = str.trim();
  let m = s.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (m) {
    let hex = m[1];
    if (hex.length === 3)
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    return {
      rgb: [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16)
      ],
      a: 1
    };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/);
  if (m) {
    return {
      rgb: [Number(m[1]), Number(m[2]), Number(m[3])],
      a: m[4] === undefined ? 1 : Number(m[4])
    };
  }
  throw new Error(`unparseable color: ${str}`);
}

function composite(fg, bg) {
  // fg {rgb,a} over bg {rgb,a=1}; returns solid rgb
  if (fg.a >= 1) return fg.rgb;
  return [0, 1, 2].map((i) => clamp8(fg.rgb[i] * fg.a + bg.rgb[i] * (1 - fg.a)));
}

function lin(c) {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function luminance(rgb) {
  const [r, g, b] = rgb.map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fgRgb, bgRgb) {
  const l1 = luminance(fgRgb);
  const l2 = luminance(bgRgb);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/* ── token parsing ──────────────────────────────────────────────────── */

function extractBlock(css, selectorRegex) {
  const m = css.match(selectorRegex);
  if (!m) throw new Error(`no block for ${selectorRegex}`);
  return m[1];
}

function parseTokens(block) {
  const tokens = {};
  for (const m of block.matchAll(/(--v2-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokens[m[1]] = m[2].trim();
  }
  return tokens;
}

// resolve a token value to a {rgb,a} color, following var() fallbacks.
function resolveColor(tokens, value, depth = 0) {
  if (depth > 8) throw new Error(`var() chain too deep: ${value}`);
  let v = value.trim();
  const varMatch = v.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([\s\S]+))?\)$/);
  if (varMatch) {
    const name = varMatch[1];
    const fallback = varMatch[2];
    if (tokens[name] !== undefined) return resolveColor(tokens, tokens[name], depth + 1);
    if (fallback !== undefined) return resolveColor(tokens, fallback, depth + 1);
    throw new Error(`unresolved var ${name}`);
  }
  return parseColor(v);
}

// Resolve a surface token to a solid rgb. Translucent surface tokens
// (e.g. dark surface-soft = rgba(148,180,255,0.045)) paint over the theme's
// opaque canvas, NOT over white — otherwise a near-transparent dark surface
// composites to near-white and the math inverts. canvas itself is always opaque.
function resolveSolid(tokens, name) {
  const color = resolveColor(tokens, tokens[name]);
  if (color.a >= 1 || name === '--v2-canvas') return color.rgb;
  const canvas = resolveColor(tokens, tokens['--v2-canvas']);
  const canvasSolid =
    canvas.a >= 1 ? canvas.rgb : composite(canvas, { rgb: [255, 255, 255], a: 1 });
  return composite(color, { rgb: canvasSolid, a: 1 });
}

/* ── pairs ──────────────────────────────────────────────────────────── */
// surfaces a soft token / text can realistically sit on, worst-case-inclusive.
const SURFACES = ['--v2-canvas', '--v2-surface', '--v2-surface-soft', '--v2-card-bg'];

// readable text-on-surface pairs that must clear 4.5
const TEXT_TOKENS = ['--v2-text', '--v2-text-strong', '--v2-text-muted', '--v2-text-faint'];

// status text token -> its soft bg token; soft is composited over each backing.
const STATUS = [
  ['--v2-accent-text', '--v2-accent-soft'],
  ['--v2-positive-text', '--v2-positive-soft'],
  ['--v2-warning-text', '--v2-warning-soft'],
  ['--v2-danger-text', '--v2-danger-soft'],
  ['--v2-info-text', '--v2-info-soft'],
  ['--v2-gold-text', '--v2-gold-soft']
];

// Backings a soft chip can sit inside. surface-soft is the worst (darkest in
// light) realistic backing; include all so the guard is backing-agnostic.
const CHIP_BACKINGS = ['--v2-surface', '--v2-surface-soft', '--v2-canvas', '--v2-card-bg'];

const AA = 4.5;

/**
 * EXCEPTIONS — pairs intentionally allowed below AA because they are NOT used
 * as essential readable text. Each must carry a reason. Encoded as a Set of
 * `theme|fg|bg` keys. Keep this list SHORT and justified; do not add a pair
 * here to dodge a real readability failure.
 *
 * Currently empty: the recommended fixes (see guardSpec / handoff) bring every
 * readable pair to >= AA, so no exception is required. If the team decides a
 * specific use is decorative, add it here with a comment.
 */
const EXCEPTIONS = new Set([
  // example shape (commented):
  // 'light|--v2-text-faint|--v2-surface-soft', // placeholder text only, WCAG 1.4.3 exempt
]);

async function loadThemes() {
  const css = await readFile(appCssPath, 'utf8');
  const light = parseTokens(extractBlock(css, /:root\s*\{([\s\S]*?)\n\}/));
  const dark = parseTokens(extractBlock(css, /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/));
  // dark inherits light tokens it does not override (cascade); merge.
  return { light, dark: { ...light, ...dark } };
}

function checkPair(theme, tokens, fgName, bgSolidRgb, bgLabel, failures) {
  const fg = resolveColor(tokens, tokens[fgName]);
  const fgSolid = composite(fg, { rgb: bgSolidRgb, a: 1 });
  const ratio = contrast(fgSolid, bgSolidRgb);
  const key = `${theme}|${fgName}|${bgLabel}`;
  if (ratio + 1e-9 < AA && !EXCEPTIONS.has(key)) {
    failures.push(`[${theme}] ${fgName} on ${bgLabel}: ${ratio.toFixed(2)} < ${AA}`);
  }
}

for (const themeName of ['light', 'dark']) {
  test(`v2 readable text meets WCAG AA on every surface (${themeName})`, async () => {
    const themes = await loadThemes();
    const tokens = themes[themeName];
    const failures = [];

    // text tokens on each surface
    for (const fg of TEXT_TOKENS) {
      for (const bg of SURFACES) {
        checkPair(themeName, tokens, fg, resolveSolid(tokens, bg), bg, failures);
      }
    }

    // status/accent text on its soft chip, over each backing
    for (const [fg, soft] of STATUS) {
      for (const backing of CHIP_BACKINGS) {
        const backingRgb = resolveSolid(tokens, backing);
        const softRgb = composite(resolveColor(tokens, tokens[soft]), { rgb: backingRgb, a: 1 });
        checkPair(themeName, tokens, fg, softRgb, `${soft}@${backing}`, failures);
      }
    }

    // white/inverse text on the primary-button backing (--v2-accent-btn, a
    // deeper shade of the brand accent reserved for white-on-solid buttons;
    // the brand --v2-accent stays for chips/borders/icons).
    {
      const accentRgb = resolveSolid(tokens, '--v2-accent-btn');
      const white = [255, 255, 255];
      const ratio = contrast(white, accentRgb);
      const key = `${themeName}|white|--v2-accent-btn`;
      if (ratio + 1e-9 < AA && !EXCEPTIONS.has(key)) {
        failures.push(
          `[${themeName}] white on --v2-accent-btn (primary button): ${ratio.toFixed(2)} < ${AA}`
        );
      }
    }

    assert.deepEqual(
      failures,
      [],
      `WCAG AA contrast failures (${themeName}):\n  ${failures.join('\n  ')}`
    );
  });
}
