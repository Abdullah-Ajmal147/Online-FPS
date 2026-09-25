import { expect, test } from '@playwright/test';

test('client renders and connects to the match room', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await expect(page.getByTestId('net-status')).toHaveText(/connected, protocol v\d+/);
  await expect(page.getByTestId('render-backend')).toHaveText(/renderer: (WebGPU|WebGL 2)/);
  expect(errors).toEqual([]);
});

test('holding W walks the player forward (-Z)', async ({ page }) => {
  await page.goto('/');
  const debug = page.getByTestId('player-debug');
  await expect(debug).toBeVisible();
  const zOf = async () => Number((await debug.textContent())!.match(/pos \S+ \S+ (\S+)/)![1]);
  const z0 = await zOf();

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);

  // Walk speed 5 m/s; allow for acceleration and frame timing in CI.
  expect(z0 - (await zOf())).toBeGreaterThan(2.5);
});

test('menu shows controls and rebinding', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu')).toBeVisible();
  await expect(page.getByTestId('play')).toBeVisible();
  await expect(page.getByText('Crouch / slide')).toBeVisible();
});

test('F3 toggles the network debug overlay', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('net-status')).toHaveText(/connected/);
  await page.keyboard.press('F3');
  const overlay = page.getByTestId('debug-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText('ping (rtt)');
  await expect(overlay).toContainText('corrections');
  // Stats arrive once the server has sent our first snapshots.
  await expect(overlay).toContainText('network', { timeout: 5000 });
  await page.keyboard.press('F3');
  await expect(overlay).toBeHidden();
});
