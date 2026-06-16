export function appBasePath() {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.location.pathname.startsWith('/v2') ? '/v2' : '';
}

export function appScopedPath(path) {
  const base = appBasePath();
  if (!base) {
    return path;
  }
  return `${base}${path === '/' ? '' : path}`;
}
