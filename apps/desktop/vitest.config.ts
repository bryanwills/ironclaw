// Vitest configuration for the IronClaw desktop client.
//
// Separate from `vite.config.js` on purpose — the SvelteKit plugin
// pulls in `$app/*` ambient types and route generators that aren't
// useful (and break) under jsdom. Here we use only the `svelte`
// plugin, which is enough to compile `.svelte` files for the
// testing-library renderer.
//
// The `$lib` alias is hand-wired to match `svelte.config.js`. Tests
// import from `$lib/...` exactly like app code.
//
// The `$app/*` aliases point at tiny stub modules under
// `tests/__mocks__/` so component tests that render Sidebar /
// StatusBar / AboutDialog don't blow up at import-analysis time when
// the SvelteKit plugin isn't in the pipeline. Individual tests still
// override behavior via `vi.mock(...)` — the stubs are just there to
// give Vite a resolvable path.

import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    alias: {
      $lib: path.resolve(projectRoot, 'src/lib'),
      '$app/state': path.resolve(projectRoot, 'tests/__mocks__/app-state.ts'),
      '$app/navigation': path.resolve(projectRoot, 'tests/__mocks__/app-navigation.ts'),
      '$app/stores': path.resolve(projectRoot, 'tests/__mocks__/app-stores.ts')
    },
    // testing-library/svelte resolves to the browser entry — match
    // what the runtime webview sees.
    conditions: ['browser']
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['src-tauri/**', 'build/**', 'node_modules/**', '.svelte-kit/**']
  }
});
