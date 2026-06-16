import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pagePath = path.join(testDir, 'work-page.js');

async function source() {
  return readFile(pagePath, 'utf8');
}

// accent-discipline-2: a saved work product is generated agent work, so its
// glyphs carry the agent's hand (gold), never the user-action accent (blue).
// The empty-state file glyph previously used --v2-accent-text (blue) while the
// saved-work file-artifact glyph already used gold; the two must match.

test('work-page empty-state file glyph uses gold attribution, not the blue accent', async () => {
  const src = await source();
  // The empty-state glyph must be on gold tokens like the saved-work glyph.
  assert.match(
    src,
    /place-items-center rounded-\[14px\] border border-\[color-mix\(in_srgb,var\(--v2-gold\)_34%,var\(--v2-panel-border\)\)\] bg-\[var\(--v2-gold-soft\)\] text-\[var\(--v2-gold-text\)\]/,
    'empty-state file glyph should use gold tokens (agent attribution)'
  );
  // It must not regress to the user-action blue accent text token.
  assert.doesNotMatch(
    src,
    /place-items-center[^>]*text-\[var\(--v2-accent-text\)\]/,
    'empty-state file glyph must not use the blue accent-text token'
  );
});

test('work-page saved-work file-artifact glyph stays gold', async () => {
  const src = await source();
  // Guard the reference treatment the empty state is matched against.
  assert.match(
    src,
    /text-\[var\(--v2-gold-text\)\]/,
    'saved-work file-artifact glyph keeps gold attribution'
  );
});

// The saved-work store holds up to 500 items; the sidebar list must keep every
// one reachable via a filter + a "Show all" expander, never a hard cap.
test('work-page keeps saved items past the first page reachable (filter + show-all, no hard cap)', async () => {
  const src = await source();

  // The list must render the paged/filtered slice, not a hard items.slice(0, 30).
  assert.doesNotMatch(src, /items\.slice\(0,\s*30\)/, 'the hard 30-item cap must be gone');
  assert.match(src, /\$\{visibleItems\.map\(/);

  // A title filter feeds the visible list.
  assert.match(src, /const filteredItems =/);
  assert.match(src, /setWorkFilter\(/);

  // An expander reveals the rest when more are filtered-in than shown.
  assert.match(src, /const hiddenItemCount =/);
  assert.match(src, /setShowAllWork\(true\)/);
  assert.match(src, /Show all \$\{filteredItems\.length\}/);
});
