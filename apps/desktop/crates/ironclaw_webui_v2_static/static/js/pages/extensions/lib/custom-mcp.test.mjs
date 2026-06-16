import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCustomMcpInstallPayload,
  normalizeCustomMcpName,
  normalizeCustomMcpUrl,
  validateCustomMcpInput
} from './custom-mcp.js';

test('normalizeCustomMcpName produces Reborn-safe extension names', () => {
  assert.equal(normalizeCustomMcpName('Team Docs'), 'team-docs');
  assert.equal(normalizeCustomMcpName('Finance.Knowledge'), 'finance-knowledge');
  assert.equal(normalizeCustomMcpName('  Ops___MCP  '), 'ops-mcp');
  assert.equal(normalizeCustomMcpName('../bad/path'), 'bad-path');
});

test('normalizeCustomMcpUrl accepts https and local development http only', () => {
  assert.deepEqual(normalizeCustomMcpUrl('https://docs.example.com/mcp'), {
    url: 'https://docs.example.com/mcp',
    error: ''
  });
  assert.deepEqual(normalizeCustomMcpUrl('http://localhost:8787/mcp'), {
    url: 'http://localhost:8787/mcp',
    error: ''
  });
  assert.equal(normalizeCustomMcpUrl('http://docs.example.com/mcp').url, '');
  assert.match(normalizeCustomMcpUrl('not a url').error, /valid MCP server URL/);
});

test('validateCustomMcpInput returns inline field errors', () => {
  assert.deepEqual(validateCustomMcpInput({ name: '', url: '' }).errors, {
    name: 'Enter a server name.',
    url: 'Enter the MCP server URL.'
  });

  const validated = validateCustomMcpInput({
    name: 'Team Docs',
    url: 'https://docs.example.com/mcp'
  });
  assert.equal(validated.ok, true);
  assert.equal(validated.name, 'team-docs');
  assert.equal(validated.url, 'https://docs.example.com/mcp');
});

test('buildCustomMcpInstallPayload matches the Reborn custom MCP install contract', () => {
  assert.deepEqual(
    buildCustomMcpInstallPayload({
      name: 'Team Docs',
      url: 'https://docs.example.com/mcp'
    }),
    {
      name: 'team-docs',
      url: 'https://docs.example.com/mcp',
      kind: 'mcp_server'
    }
  );

  assert.throws(
    () => buildCustomMcpInstallPayload({ name: 'Team Docs', url: 'http://docs.example.com/mcp' }),
    /Use HTTPS/
  );
});
