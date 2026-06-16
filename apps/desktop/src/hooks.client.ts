// SvelteKit client hooks.
//
// `handleError` intercepts any error thrown during route load or render
// before SvelteKit propagates it to `+error.svelte`. The returned object
// becomes `page.error` (typed as `App.Error` in `src/app.d.ts`) and is
// what the error page renders. We log to the console for the devtools
// path, then surface a structured payload to the UI.
//
// Stack traces are gated on `dev` so production builds (shipped to
// users via Tauri) don't leak source paths or implementation detail in
// the visible error UI. The dev path is fully verbose for our own
// debugging.

import type { HandleClientError } from '@sveltejs/kit';
import { dev } from '$app/environment';

export const handleError: HandleClientError = ({ error }) => {
  // eslint-disable-next-line no-console
  console.error('[ironclaw] client error:', error);

  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
  const stack = dev && error instanceof Error ? error.stack : undefined;

  return { message, stack };
};
