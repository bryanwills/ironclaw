import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/static',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://127.0.0.1:1420',
    trace: 'on-first-retry'
  },
  webServer: {
    command: 'PORT=1420 npm run dev:webui-static',
    url: 'http://127.0.0.1:1420/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
