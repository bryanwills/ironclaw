// Design-token coverage guard.
//
// The v2 design system lives in `src/app.css :root` as `--v2-*` custom
// properties. Surfaces consume them either via Tailwind aliases or by
// referencing the raw var directly (e.g. `var(--v2-surface-2)`). When a
// surface references a token name that `:root` never defines, CSS
// silently falls through to the inline fallback (or `initial`), so the
// element renders but is no longer driven by the theme — an invisible
// regression that no render test catches.
//
// This guard reads the real token definitions out of app.css and every
// `var(--v2-*)` reference out of the component/CSS sources, then asserts
// the references are a subset of the definitions. It is intentionally
// filesystem-based (not a render test): the contract is "no v2 surface
// references an undefined token," which is a property of the source
// tree, not of any one rendered component.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const srcDir = path.join(repoRoot, 'src');
const appCss = path.join(srcDir, 'app.css');

/** Names declared inside the `:root { … }` block of app.css. */
function definedTokens(): Set<string> {
  const css = readFileSync(appCss, 'utf8');
  const root = /:root\s*\{([\s\S]*?)\}/.exec(css);
  if (!root) throw new Error('app.css has no :root block');
  const names = new Set<string>();
  for (const m of root[1].matchAll(/(--v2-[a-z0-9-]+)\s*:/g)) names.add(m[1]);
  return names;
}

/** Recursively collect .svelte/.css files under `src`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(svelte|css)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every `var(--v2-*)` reference, mapped name → files that use it. */
function referencedTokens(): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const file of sourceFiles(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/var\(\s*(--v2-[a-z0-9-]+)/g)) {
      const rel = path.relative(repoRoot, file);
      const list = refs.get(m[1]) ?? [];
      if (!list.includes(rel)) list.push(rel);
      refs.set(m[1], list);
    }
  }
  return refs;
}

describe('design tokens', () => {
  it('defines every --v2-* token referenced in the source tree', () => {
    const defined = definedTokens();
    const referenced = referencedTokens();
    const missing = [...referenced.keys()]
      .filter((name) => !defined.has(name))
      .map((name) => `${name} (used in ${referenced.get(name)!.join(', ')})`);
    expect(missing, `Undefined --v2-* tokens:\n${missing.join('\n')}`).toEqual([]);
  });

  it('defines the reconciled aliases that v2 surfaces author against', () => {
    const defined = definedTokens();
    for (const name of ['--v2-surface-2', '--v2-border', '--v2-warning', '--v2-mono']) {
      expect(defined.has(name), `${name} missing from :root`).toBe(true);
    }
  });

  it('exposes a shared motion scale', () => {
    const defined = definedTokens();
    for (const name of [
      '--v2-ease-out',
      '--v2-ease-in-out',
      '--v2-ease-spring',
      '--v2-dur-fast',
      '--v2-dur',
      '--v2-dur-slow'
    ]) {
      expect(defined.has(name), `${name} missing from :root`).toBe(true);
    }
  });

  it('references only tokens, never an empty var() name', () => {
    // A `var(--v2-)` with no suffix is a typo that resolves to nothing.
    for (const file of sourceFiles(srcDir)) {
      const text = readFileSync(file, 'utf8');
      expect(/var\(\s*--v2-\s*[,)]/.test(text), `empty --v2- var in ${file}`).toBe(false);
    }
  });
});
