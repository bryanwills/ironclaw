// Tests for the bearer-token / API-key sanitizer.
//
// Pure functions, no IPC, no DOM. The mask uses a literal `•` (U+2022),
// not an ASCII bullet — keep that in mind when reading the expected
// values.

import { describe, expect, it } from 'vitest';

import { redactSecrets, redactJsonObject, containsSecret } from './redact';

describe('redactSecrets', () => {
  it('masks a Bearer token while preserving the label', () => {
    const out = redactSecrets('Authorization: Bearer abc123def');
    expect(out).toContain('Bearer ');
    expect(out).not.toContain('abc123def');
    // The mask is length-preserving.
    expect(out).toBe('Authorization: Bearer •••••••••');
  });

  it('masks an OpenAI-style sk- key', () => {
    const out = redactSecrets('sk-1234567890abcdef');
    expect(out).not.toContain('1234567890abcdef');
    expect(out).toMatch(/^•+$/);
  });

  it('leaves plain text without secrets unchanged', () => {
    const input = 'plain text with no secrets';
    expect(redactSecrets(input)).toBe(input);
  });

  it('returns the empty string unchanged', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('masks multiple secrets in one string', () => {
    const out = redactSecrets('Bearer abc12345 and sk-aaaaaaaa1');
    expect(out).not.toContain('abc12345');
    expect(out).not.toContain('aaaaaaaa1');
    expect(out).toContain('Bearer ');
  });

  it('preserveTips keeps the first 4 / last 4 chars when the secret is long enough', () => {
    const out = redactSecrets('Bearer abcdefghij1234567890', { preserveTips: true });
    expect(out).toContain('Bearer abcd•••7890');
  });
});

describe('redactJsonObject', () => {
  it('masks a string value under a benign key', () => {
    const out = redactJsonObject({ api_key: 'sk-foofoofoofoo' }) as Record<string, unknown>;
    // Either the value is masked via the `sk-` pattern OR via the
    // `api-key` pattern — both are fine. What matters is the secret
    // never appears verbatim.
    expect(JSON.stringify(out)).not.toContain('foofoofoofoo');
  });

  it('walks nested objects recursively', () => {
    const out = redactJsonObject({ nested: { token: 'Bearer xyz12345' } });
    expect(JSON.stringify(out)).not.toContain('xyz12345');
    expect(JSON.stringify(out)).toContain('Bearer ');
  });

  it('preserves non-string leaves untouched', () => {
    const out = redactJsonObject({
      count: 7,
      ok: true,
      none: null,
      tags: ['hello', 'Bearer abc12345']
    }) as { count: number; ok: boolean; none: null; tags: string[] };
    expect(out.count).toBe(7);
    expect(out.ok).toBe(true);
    expect(out.none).toBe(null);
    expect(out.tags[0]).toBe('hello');
    expect(out.tags[1]).not.toContain('abc12345');
  });

  it('does not mutate the input object', () => {
    const input = { token: 'Bearer abc12345' };
    redactJsonObject(input);
    expect(input.token).toBe('Bearer abc12345');
  });
});

describe('containsSecret', () => {
  it('returns true for a Bearer token', () => {
    expect(containsSecret('Bearer abc12345')).toBe(true);
  });

  it('returns true for an sk- prefix', () => {
    expect(containsSecret('see sk-1234567890abcd for details')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(containsSecret('hello world')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(containsSecret('')).toBe(false);
  });
});
