import { describe, expect, it } from 'vitest';
import { validateHostedUrl } from './validate-url';

describe('validateHostedUrl', () => {
  it('rejects empty / whitespace-only input', () => {
    expect(validateHostedUrl('')).toMatchObject({ ok: false });
    expect(validateHostedUrl('   ')).toMatchObject({ ok: false });
  });

  it('rejects unparseable input', () => {
    const r = validateHostedUrl('not a url');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not a valid URL/i);
  });

  it('rejects non-http(s) schemes', () => {
    for (const bad of ['file:///etc/passwd', 'ws://example.com', 'javascript:alert(1)']) {
      const r = validateHostedUrl(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/scheme/i);
    }
  });

  it('refuses cleartext http:// to a remote host (token would leak)', () => {
    const r = validateHostedUrl('http://gateway.example.com');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unencrypted|https/i);
  });

  it('allows http:// to loopback hosts (traffic stays on-device)', () => {
    for (const ok of [
      'http://localhost:3100',
      'http://127.0.0.1:3100',
      'http://[::1]:3100',
      'http://LOCALHOST:3100'
    ]) {
      expect(validateHostedUrl(ok), ok).toMatchObject({ ok: true });
    }
  });

  it('allows https:// to any host', () => {
    expect(validateHostedUrl('https://gateway.example.com')).toMatchObject({
      ok: true,
      url: 'https://gateway.example.com'
    });
  });

  it('strips trailing slashes on success', () => {
    expect(validateHostedUrl('https://gateway.example.com/api/')).toMatchObject({
      ok: true,
      url: 'https://gateway.example.com/api'
    });
    // The bare-origin case: URL() appends a slash, which we strip.
    expect(validateHostedUrl('https://gateway.example.com')).toMatchObject({
      ok: true,
      url: 'https://gateway.example.com'
    });
  });
});
