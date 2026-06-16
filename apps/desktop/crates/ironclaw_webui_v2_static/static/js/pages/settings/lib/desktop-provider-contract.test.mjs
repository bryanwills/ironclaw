import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const NORMAL_SETUP_SURFACES = [
  '../../../lib/api.js',
  '../components/provider-management.js',
  '../components/provider-card.js',
  '../components/provider-login-status.js',
  '../hooks/useProviderLogin.js',
  '../../onboarding/onboarding-page.js',
  '../../chat/components/chat-input.js'
];

const FORBIDDEN_NORMAL_SETUP_PATTERNS = [
  /ChatGPT/i,
  /openai_codex/i,
  /codexSignIn/i,
  /startCodexLogin/i,
  /\/llm\/codex\/login/i
];

test('normal desktop setup is NEAR AI Cloud only, with no ChatGPT/Codex login path', () => {
  const failures = [];

  for (const relativePath of NORMAL_SETUP_SURFACES) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    for (const pattern of FORBIDDEN_NORMAL_SETUP_PATTERNS) {
      if (pattern.test(source)) {
        failures.push(`${relativePath}: ${pattern}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});
