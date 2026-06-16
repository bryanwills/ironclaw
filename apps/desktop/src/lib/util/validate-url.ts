// Validation for a user-entered hosted-gateway URL, applied BEFORE an access
// token is ever sent to it. The hazard is a cleartext `http://` connection to a
// non-loopback host: the bearer token would travel unencrypted and could be
// captured in transit or land in proxy/access logs. We therefore require
// `https:` for remote hosts, with an explicit exception for loopback addresses
// (a local gateway reached over http never leaves the machine).

/** Hosts for which plain `http://` is acceptable — traffic stays on-device. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export type HostedUrlValidation = { ok: true; url: string } | { ok: false; error: string };

/**
 * Validate and normalize a hosted IronClaw gateway URL.
 *
 * - Rejects empty or unparseable input.
 * - Requires an `http:` or `https:` scheme (no `file:`, `ws:`, `javascript:`, …).
 * - Requires `https:` UNLESS the host is loopback (`localhost` / `127.0.0.1` /
 *   `::1`), so a token is never transmitted in cleartext to a remote host.
 *
 * On success returns the parsed URL serialized with trailing slashes stripped
 * (matching the caller's previous normalization).
 */
export function validateHostedUrl(raw: string): HostedUrlValidation {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Enter a gateway URL to connect.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `"${trimmed}" is not a valid URL.` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const scheme = parsed.protocol.replace(/:$/, '');
    return {
      ok: false,
      error: `Unsupported URL scheme "${scheme}". Use https:// (or http:// for a local gateway).`
    };
  }

  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  if (parsed.protocol === 'http:' && !isLoopback) {
    return {
      ok: false,
      error:
        'Refusing to send your access token over an unencrypted http:// connection. Use https:// for a remote gateway.'
    };
  }

  const normalized = parsed.toString().replace(/\/+$/, '');
  return { ok: true, url: normalized };
}
