import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

// ConfirmDialog guards the app's most irreversible actions (delete / clear).
// Its footer buttons must meet the touch-target floor — `size="sm"` renders at
// 32px, well under 44px. Both footer buttons must be `size="md"` (44px desktop /
// 40px mobile), the design-system default. Design Law: 44px min touch targets.
test('ConfirmDialog footer buttons meet the touch-target floor (size md, never sm)', async () => {
  const source = await readFile(path.join(dir, 'confirm-dialog.js'), 'utf8');

  // The cancel (ghost) and confirm (danger/primary) buttons are both md. (The
  // Modal itself stays size="sm" — that's the dialog width, not a touch target.)
  assert.match(source, /variant="ghost" size="md"/);
  assert.match(source, /size="md"\n\s*disabled=\$\{pending\}\n\s*onClick=\$\{runConfirm\}/);

  // Neither footer Button may regress to the 32px sm size.
  assert.doesNotMatch(source, /<\$\{Button\}[^>]*size="sm"/);
  assert.doesNotMatch(source, /\n\s*size="sm"\n/);
});
