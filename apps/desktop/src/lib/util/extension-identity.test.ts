import { describe, expect, it } from 'vitest';

import { extensionName, extensionRefCandidates, extensionTarget } from './extension-identity';

describe('extension identity helpers', () => {
  it('converts registry paths into Reborn extension names plus kind hints', () => {
    expect(extensionTarget('tools/gmail')).toEqual({ name: 'gmail', kind: 'wasm_tool' });
    expect(extensionTarget('channels/slack')).toEqual({ name: 'slack', kind: 'wasm_channel' });
    expect(extensionTarget('mcp-servers/notion')).toEqual({
      name: 'notion',
      kind: 'mcp_server'
    });
  });

  it('canonicalizes legacy hyphen names to the Reborn underscore identity', () => {
    expect(extensionName('tools/google-calendar')).toBe('google_calendar');
  });

  it('keeps aliases for old desktop deep links and Reborn bare names', () => {
    expect(extensionRefCandidates('tools/gmail')).toEqual(['tools/gmail', 'gmail']);
    expect(extensionRefCandidates('gmail', 'wasm_tool')).toEqual(['gmail', 'tools/gmail']);
  });

  it('maps UI category hints back to Reborn kind strings', () => {
    expect(extensionTarget('notion', 'mcp')).toEqual({ name: 'notion', kind: 'mcp_server' });
    expect(extensionTarget('slack', 'channel')).toEqual({ name: 'slack', kind: 'wasm_channel' });
    expect(extensionTarget('gmail', 'oauth')).toEqual({ name: 'gmail', kind: undefined });
  });

  it('rejects malformed slash refs instead of laundering them into lifecycle names', () => {
    expect(() => extensionTarget('mcp-servers/../gmail')).toThrow(/invalid extension/i);
    expect(() => extensionTarget('tools//gmail')).toThrow(/invalid extension/i);
    expect(() => extensionTarget('unknown/gmail')).toThrow(/invalid extension/i);
    expect(() => extensionTarget('tools\\gmail')).toThrow(/invalid extension/i);
  });
});
