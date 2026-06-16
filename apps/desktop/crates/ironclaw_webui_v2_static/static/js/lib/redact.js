const SECRET_PATTERNS = [
  { re: /Bearer\s+([A-Za-z0-9._\-+/]+={0,2})/g },
  { re: /\b(sk-[A-Za-z0-9_\-]{8,})/g },
  { re: /\b(pk-[A-Za-z0-9_\-]{8,})/g },
  { re: /\b(api[_-]?key)\s*[:=]\s*"?([A-Za-z0-9._\-+/]{12,})/gi },
  { re: /\b(eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)/g },
  { re: /\b(ghp_[A-Za-z0-9]{36})/g },
  { re: /\b(ghs_[A-Za-z0-9]{36})/g }
];

function maskSecret(secret, preserveTips) {
  if (!preserveTips || secret.length <= 8) {
    return '*'.repeat(secret.length);
  }
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

export function redactSecrets(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return text;

  const preserveTips = options.preserveTips === true;
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, (match, group1, group2) => {
      const secret = typeof group2 === 'string' && group2.length > 0 ? group2 : group1;
      const start = match.lastIndexOf(secret);
      if (start < 0) return match;
      return (
        match.slice(0, start) +
        maskSecret(secret, preserveTips) +
        match.slice(start + secret.length)
      );
    });
  }
  return out;
}

export function redactJsonObject(value, options = {}) {
  if (typeof value === 'string') return redactSecrets(value, options);
  if (Array.isArray(value)) return value.map((item) => redactJsonObject(item, options));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactJsonObject(nested, options);
    }
    return out;
  }
  return value;
}

export function containsSecret(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return SECRET_PATTERNS.some(({ re }) => {
    const probe = new RegExp(re.source, re.flags.replace('g', ''));
    return probe.test(text);
  });
}
