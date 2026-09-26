import { expect, test } from '@playwright/test';

/**
 * Timing checks run alone, after every other test (project "timing" in playwright.config.ts):
 * measured next to a dozen parallel browsers they'd measure CPU contention, not the game.
 */
test('cold link to in a match in under 20 s (Phase 4 exit test)', async ({ page }) => {
  const start = Date.now();
  await page.goto('/?server=http://localhost:2568');
  // In a match = the server's match info arrived and we have a live soldier from the server.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const s = (await import('/src/store.ts')).getStatus();
          return s.net.state === 'connected' && s.match !== null && s.combat?.alive === true;
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
  const seconds = (Date.now() - start) / 1000;
  console.log(`cold link → in match: ${seconds.toFixed(1)} s`);
  expect(seconds).toBeLessThan(20);
});
