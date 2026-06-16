// Legacy Playwright config for the Svelte/Vite reference shell.
//
// The shipped desktop UI is the Reborn static WebUI. The default `npm run
// test:e2e` command runs `smoke:webui-static`; use `npm run test:e2e:legacy`
// when you explicitly want this older browser-only suite.
//
// Two suites today live under `tests/e2e/`:
//   - onboarding.spec.ts — cold-start wizard through to the chat surface
//   - chat.spec.ts       — sends a message and verifies the optimistic +
//                          mocked-stream bubbles render
//
// These specs run browser-only (not against the real Tauri shell). Tauri IPC is
// shimmed via `window.__TAURI_INTERNALS__` injected by `mockTauri()`; the
// IronClaw gateway is mocked via `page.route()` from `mockGateway()`. See
// `tests/e2e/_helpers.ts` for the contract.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // One Vite dev server, one suite at a time — parallel webworkers would
  // contend on settings/state in the shared `window.__TAURI_INTERNALS__`
  // shim if they shared a page, and the dev server can't easily be
  // multiplexed. Keep this serial; the suite is small.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry'
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
