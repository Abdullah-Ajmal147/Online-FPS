import { defineConfig, devices } from '@playwright/test';

/**
 * Game servers:
 *   :2567 — no bots, open arena, long warm-up: functional tests (movement, two players, combat)
 *   :2568 — bots, Relay Yard → Saltline Depot rotation, 45 s matches: the match-flow test
 *   :2569 — open arena, easy bots, 10 min matches: the hip-fire kill regression test
 *   :2570 — no bots, open arena: grenade test (its smoke and frag would disturb other tests)
 *   :2571 — no bots, open arena: the two-player combat test (exactly two players, so they are
 *           always on opposite teams)
 *   :8787 — progression API (in-memory DB); the :2568 server reports finished matches to it
 * Game servers are never reused (they need these exact settings), so stop `pnpm dev` first.
 */
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
      env: { SENTINEL_BOTS: '0', SENTINEL_MAP: 'arena', SENTINEL_WARMUP_SECONDS: '3600' },
      gracefulShutdown: { signal: 'SIGTERM', timeout: 3000 },
      reuseExistingServer: false,
    },
    {
      command: 'node_modules/.bin/tsx src/index.ts',
      cwd: 'apps/server',
      url: 'http://localhost:2568/healthz',
      env: {
        PORT: '2568',
        SENTINEL_MAP_ROTATION: 'relay-yard,saltline-depot',
        SENTINEL_WARMUP_SECONDS: '3',
        SENTINEL_MATCH_SECONDS: '45',
        SENTINEL_RESULTS_SECONDS: '6',
      },
      gracefulShutdown: { signal: 'SIGTERM', timeout: 3000 },
      reuseExistingServer: false,
    },
    {
      // Hip-fire kill test: open arena, easy bots, long matches (stable conditions).
      command: 'node_modules/.bin/tsx src/index.ts',
      cwd: 'apps/server',
      url: 'http://localhost:2569/healthz',
      env: {
        PORT: '2569',
        SENTINEL_MAP: 'arena',
        SENTINEL_BOT_DIFFICULTY: 'easy',
        SENTINEL_WARMUP_SECONDS: '2',
        SENTINEL_MATCH_SECONDS: '600',
      },
      gracefulShutdown: { signal: 'SIGTERM', timeout: 3000 },
      reuseExistingServer: false,
    },
    {
      command: 'node_modules/.bin/tsx src/index.ts',
      cwd: 'apps/server',
      url: 'http://localhost:2570/healthz',
      env: {
        PORT: '2570',
        SENTINEL_BOTS: '0',
        SENTINEL_MAP: 'arena',
        SENTINEL_WARMUP_SECONDS: '3600',
      },
      gracefulShutdown: { signal: 'SIGTERM', timeout: 3000 },
      reuseExistingServer: false,
    },
    {
      command: 'node_modules/.bin/tsx src/index.ts',
      cwd: 'apps/server',
      url: 'http://localhost:2571/healthz',
      env: {
        PORT: '2571',
        SENTINEL_BOTS: '0',
        SENTINEL_MAP: 'arena',
        SENTINEL_WARMUP_SECONDS: '3600',
      },
      gracefulShutdown: { signal: 'SIGTERM', timeout: 3000 },
      reuseExistingServer: false,
    },
    {
      // Progression API with a throwaway in-memory database.
      command: 'node_modules/.bin/tsx src/index.ts',
      cwd: 'apps/api',
      url: 'http://localhost:8787/healthz',
      env: { SENTINEL_DB: ':memory:' },
      gracefulShutdown: { signal: 'SIGTERM', timeout: 3000 },
      reuseExistingServer: false,
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
