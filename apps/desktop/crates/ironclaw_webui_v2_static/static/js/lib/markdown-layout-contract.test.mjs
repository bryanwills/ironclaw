import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const cssPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../styles/app.css'
);
const css = readFileSync(cssPath, 'utf8');

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1].replace(/\s+/g, ' ');
}

test('markdown tables stay inside the chat canvas instead of widening the page', () => {
  const table = rule('.markdown-body table');
  assert.match(table, /display:\s*block/);
  assert.match(table, /max-width:\s*100%/);
  assert.match(table, /overflow-x:\s*auto/);

  const cells = rule('.markdown-body th,.markdown-body td');
  assert.match(cells, /overflow-wrap:\s*anywhere/);
  assert.match(cells, /vertical-align:\s*top/);
});

test('markdown-generated SVG and media are bounded to the message width', () => {
  assert.match(css, /\.markdown-body svg,[\s\S]*?\.markdown-body canvas\s*\{[\s\S]*?max-width:\s*100%/);
  assert.match(css, /\.markdown-body svg,[\s\S]*?\.markdown-body canvas\s*\{[\s\S]*?height:\s*auto/);
});
