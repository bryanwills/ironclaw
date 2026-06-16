// Stub for SvelteKit's `$app/state` module under vitest.
//
// The SvelteKit Vite plugin isn't loaded inside the vitest config
// (importing it pulls in the full route generator), so `$app/state`
// has no resolvable real path. This shim exposes the minimal surface
// the in-tree components touch — primarily `page.url.pathname` —
// with a deterministic default and a writable setter so individual
// tests can pin a path before rendering.

interface PageStub {
  url: { pathname: string };
  route: { id: string | null };
  status: number;
  error: unknown;
  data: Record<string, unknown>;
  state: Record<string, unknown>;
  params: Record<string, string>;
  form: unknown;
}

export const page: PageStub = {
  url: { pathname: '/' },
  route: { id: null },
  status: 200,
  error: null,
  data: {},
  state: {},
  params: {},
  form: null
};

/** Reset `page` to the default landing for cross-test isolation. Tests
 *  that need a non-root pathname call `setPagePathname('/settings')`
 *  before rendering. */
export function setPagePathname(pathname: string): void {
  page.url = { pathname };
}

export const navigating = null;
export const updated = { current: false, check: async () => false };
