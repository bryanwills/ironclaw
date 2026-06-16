import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const chatRoot = path.resolve(testDir, '..');
const staticJsRoot = path.resolve(chatRoot, '..', '..');

const primaryChatFiles = [
  path.join(chatRoot, 'components', 'message-bubble.js'),
  path.join(chatRoot, 'components', 'chat-input.js'),
  path.join(chatRoot, 'components', 'connection-status.js'),
  path.join(staticJsRoot, 'components', 'slack-pairing-section.js')
];

const rawStatusColorPattern =
  /\b(?:text|bg|border|hover:text|hover:bg|hover:border)-(?:red|yellow|amber|orange|emerald|green|lime)-\d/g;

test('primary chat status states use semantic desktop tokens', async () => {
  const violations = [];

  for (const file of primaryChatFiles) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(rawStatusColorPattern)) {
      violations.push(`${path.relative(staticJsRoot, file)} contains ${match[0]}`);
    }
  }

  assert.deepEqual(violations, []);
});

test('message bubble does not paint system or assistant turns in warning copper', async () => {
  const messageBubble = path.join(chatRoot, 'components', 'message-bubble.js');
  const source = await readFile(messageBubble, 'utf8');

  assert.doesNotMatch(
    source,
    /copper/,
    'message-bubble.js must use neutral/semantic tokens, not the warning copper accent'
  );
});
