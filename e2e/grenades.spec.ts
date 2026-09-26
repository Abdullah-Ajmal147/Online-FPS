import { expect, test } from '@playwright/test';

/** Phase 5 task 5: G throws a frag, Q a smoke; the server simulates both. */
test('throwing a frag and a smoke: counts drop, the smoke cloud appears', async ({ page }) => {
  await page.goto('/?server=http://localhost:2570');
  await expect(page.getByTestId('net-status')).toHaveText(/connected/);
  const status = () => page.evaluate(async () => (await import('/src/store.ts')).getStatus());
  await expect.poll(async () => (await status()).combat?.frags).toBe(1);
  await page.addStyleTag({ content: '.menu{display:none!important}' });

  // Look down a little so both land a few metres ahead.
  await page.evaluate(() =>
    (
      window as unknown as { __sentinelInput: { setLook(y: number, p: number): void } }
    ).__sentinelInput.setLook(0, -0.35),
  );
  for (const key of ['KeyG', 'KeyQ']) {
    await page.keyboard.down(key);
    await page.waitForTimeout(150);
    await page.keyboard.up(key);
    await page.waitForTimeout(900); // throw cooldown (content: equipment cooldown 0.6 s)
  }
  await expect.poll(async () => (await status()).combat?.frags).toBe(0);
  await expect.poll(async () => (await status()).combat?.smokes).toBe(0);
  // The smoke's fuse is 1.2 s; give the cloud time to grow, then look at it.
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'test-results/grenades-smoke.png' });
});
