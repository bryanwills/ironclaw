# R49 — Lazy-load all SvelteKit routes for bundle savings

**Lane**: A1 (codex)
**Branch**: `codex/r49-lazy-load-routes`
**Depends on**: nothing

## Context

R47 reported the production bundle at 344 KB / 360 KB cap (95.6%). The
budget script is `scripts/check-bundle-size.sh`. We've been adding new
routes (`/council`, `/memory`, `/skills/ironhub`) without splitting,
so route components ship in the entry chunk even when the user never
navigates to them.

This task converts every route's top-level component imports to dynamic
`import()` so each route becomes its own chunk. Target: drop entry
chunk to ≤200 KB gzipped, total budget headroom restored.

## Owned files (exclusive write access)

- All `src/routes/*/+page.svelte` — **modify ONLY the `<script>`
  header**: convert `import Foo from '...'` lines that point at heavy
  components/stores to dynamic `await import('...')` inside
  `onMount`. Component logic, markup, styles — DO NOT TOUCH.
- `vite.config.js` — add `build.rollupOptions.output.manualChunks`
  rules per route.
- `scripts/check-bundle-size.sh` — update threshold + per-route checks.
- `scripts/bundle-baseline.json` — update baseline.

## Forbidden files

- Any logic in `+page.svelte` files (only the import header).
- Anything under `src/lib/**`.
- Anything under `src-tauri/**`.
- `package.json` (no new deps).

## Approach

For each route's `+page.svelte`:

1. Identify which imports are HEAVY (rule of thumb: anything ≥10 KB
   gzipped — use `npm run build && du -sh build/_app/immutable/chunks`
   to measure).
2. Move those imports inside an `onMount` block as
   ```ts
   const { Foo } = await import('$lib/components/Foo.svelte');
   ```
3. Bind the dynamic module to a `$state` slot and conditionally render
   `{#if FooModule}<svelte:component this={FooModule} ... />{/if}`.
4. KEEP small / always-needed imports (Icon, MarkdownView once it's
   on the critical path, stores) static.

Routes that benefit most (verify with measurements before assuming):

- `/skills/ironhub` (whole catalog grid)
- `/council` (provider picker + fanout UI)
- `/memory` (two-column list + editor)
- `/missions` (large surface)
- `/admin` (prompt diff + usage charts — heaviest)
- `/dev/playground` (already dev-only, but split it cleanly)

## Wire contract

None. This is a pure frontend refactor.

## Acceptance

1. `npm run check` → 0 errors.
2. `npm run test` → all green (no test changes needed; if a route test
   relies on synchronous component mount, fix that test in its own
   commit before changing the route).
3. `npm run build` → succeeds.
4. `bash scripts/check-bundle-size.sh` → entry chunk ≤200 KB gzipped,
   total ≤320 KB.
5. Manual: launch the bundled `.app`, navigate to each split route,
   confirm it loads (network tab in devtools shows a fresh chunk fetch).
6. Update `scripts/bundle-baseline.json` to the new numbers so future
   regressions are caught.

## Out of scope

- Splitting library code (do that in a separate lane if needed).
- Adding a loading spinner to every dynamic route (the existing
  layout has fallback rendering; don't introduce new UI).
- Touching `src/lib/components/MarkdownView.svelte` — that has its
  own lane (A3).

## Notes

- Vite's automatic code-splitting will pick up dynamic `import()`
  out of the box. The manualChunks rules in `vite.config.js` should
  be light — one entry per route name only.
- Keep PR focused on splitting. If you find a bug while in there, file
  it as a separate issue. Do not fix in this PR.
