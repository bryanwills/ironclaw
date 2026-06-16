const MCP_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function normalizeCustomMcpName(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64)
    .replace(/[-_]+$/g, '');
}

export function normalizeCustomMcpUrl(value = '') {
  const raw = String(value).trim();
  if (!raw) return { url: '', error: 'Enter the MCP server URL.' };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return { url: '', error: 'Enter a valid MCP server URL.' };
  }

  const isHttps = parsed.protocol === 'https:';
  const isLocalHttp = parsed.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(parsed.hostname);
  if (!isHttps && !isLocalHttp) {
    return {
      url: '',
      error: 'Use HTTPS, or localhost HTTP for a local MCP server.'
    };
  }

  parsed.hash = '';
  return { url: parsed.toString(), error: '' };
}

export function validateCustomMcpInput({ name, url } = {}) {
  const normalizedName = normalizeCustomMcpName(name);
  const normalizedUrl = normalizeCustomMcpUrl(url);
  const errors = {};

  if (!normalizedName) {
    errors.name = 'Enter a server name.';
  } else if (!MCP_NAME_PATTERN.test(normalizedName)) {
    errors.name = 'Use lowercase letters, numbers, hyphens, or underscores.';
  }

  if (normalizedUrl.error) {
    errors.url = normalizedUrl.error;
  }

  return {
    name: normalizedName,
    url: normalizedUrl.url,
    errors,
    ok: Object.keys(errors).length === 0
  };
}

export function buildCustomMcpInstallPayload(input) {
  const validated = validateCustomMcpInput(input);
  if (!validated.ok) {
    const error = new Error(Object.values(validated.errors)[0] || 'Custom MCP server is invalid.');
    error.errors = validated.errors;
    throw error;
  }

  return {
    name: validated.name,
    url: validated.url,
    kind: 'mcp_server'
  };
}
