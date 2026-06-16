// Stub for SvelteKit's legacy `$app/stores`. None of the snapshot
// targets import from here today, but the alias is present so a
// stray re-export inside a transitive dep doesn't break import
// analysis under vitest.

import { readable } from 'svelte/store';

export const page = readable({
  url: { pathname: '/' },
  route: { id: null },
  status: 200,
  error: null,
  data: {},
  state: {},
  params: {},
  form: null
});

export const navigating = readable(null);
export const updated = readable(false);
export const getStores = () => ({ page, navigating, updated });
