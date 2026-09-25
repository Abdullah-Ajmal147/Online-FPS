import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:5173' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Run binaries directly (no pnpm wrapper, no watch) so Playwright can stop them cleanly.
      command: 'node_modules/.bin/tsx src/index.ts',
      cwd: 'apps/server',
      url: 'http://localhost:2567/healthz',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 3000 },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'node_modules/.bin/vite',
      cwd: 'apps/client',
      url: 'http://localhost:5173',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 3000 },
      reuseExistingServer: !process.env.CI,
    },
  ],
});
