// SvelteKit augmentation point for app-wide types.
//
// `App.Error` shapes the value returned from `handleError` in
// `src/hooks.client.ts` and consumed by `src/routes/+error.svelte`
// via `page.error`. SvelteKit's default shape is just `{ message }`;
// we add an optional `stack` so the error page can offer a collapsible
// trace in dev builds.
declare global {
  namespace App {
    interface Error {
      message: string;
      stack?: string;
    }
  }
}

export {};
