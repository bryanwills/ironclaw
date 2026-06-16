// Tests for the agent-UI state reader. Pure module — no DOM/stores; we pass a
// UiStateSource and assert the redacted snapshot.

import { describe, expect, it } from 'vitest';
import { readUiState, redactSecrets, surfaceForPath } from './state';

describe('surfaceForPath', () => {
  it('maps known routes to their surface names', () => {
    expect(surfaceForPath('/')).toBe('dashboard');
    expect(surfaceForPath('/chat')).toBe('chat');
    expect(surfaceForPath('/work')).toBe('work');
    expect(surfaceForPath('/knowledge')).toBe('knowledge');
    expect(surfaceForPath('/admin')).toBe('admin');
  });

  it('ignores a query string and trailing slash', () => {
    expect(surfaceForPath('/knowledge/')).toBe('knowledge');
    expect(surfaceForPath('/knowledge?q=x')).toBe('knowledge');
  });

  it('resolves an unknown path to "unknown" (never fabricates a surface)', () => {
    expect(surfaceForPath('/nope')).toBe('unknown');
  });
});

describe('redactSecrets', () => {
  it('masks bearer tokens, sk- keys, github tokens, and long hex blobs', () => {
    expect(redactSecrets('Authorization: Bearer abc123.def-456')).not.toContain('abc123');
    expect(redactSecrets('key sk-ABCDEFGH12345678')).toContain('[redacted]');
    expect(redactSecrets('tok ghp_ABCDEFGH12345678')).toContain('[redacted]');
    expect(redactSecrets('hash ' + 'a'.repeat(40))).toContain('[redacted]');
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'Summarize the budget thread and draft a reply.';
    expect(redactSecrets(prose)).toBe(prose);
  });
});

describe('readUiState', () => {
  it('builds a snapshot with the surface derived from the path', () => {
    const s = readUiState({
      path: '/routines',
      activeThreadId: 't1',
      connectionStatus: 'connected'
    });
    expect(s.surface).toBe('routines');
    expect(s.path).toBe('/routines');
    expect(s.activeThreadId).toBe('t1');
    expect(s.connectionStatus).toBe('connected');
  });

  it('defaults missing optional fields to null', () => {
    const s = readUiState({ path: '/chat' });
    expect(s.surface).toBe('chat');
    expect(s.activeThreadId).toBeNull();
    expect(s.openModal).toBeNull();
    expect(s.composerDraft).toBeNull();
    expect(s.connectionStatus).toBeNull();
    expect(s.profileName).toBeNull();
  });

  it('redacts a token pasted into the composer draft', () => {
    const s = readUiState({ path: '/chat', composerDraft: 'use Bearer abcdef123456 to connect' });
    expect(s.composerDraft).not.toContain('abcdef123456');
    expect(s.composerDraft).toContain('[redacted]');
  });
});
