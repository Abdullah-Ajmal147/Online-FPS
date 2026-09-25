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

test('two players in two tabs see each other move', async ({ browser }) => {
  test.setTimeout(60_000);
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  // Two pages rendering 3D in one headless browser is slow (software GL): allow time to join.
  await Promise.all([a.goto('/'), b.goto('/')]);
  for (const p of [a, b]) {
    await expect(p.getByTestId('net-status')).toHaveText(/connected/, { timeout: 20_000 });
  }
  const remotes = (p: typeof a) =>
    p.evaluate(
      async () => (await import('/src/store.ts')).getStatus().netStats?.remotePlayers ?? 0,
    );
  await expect.poll(() => remotes(a), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => remotes(b), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

  // A walks; B's view of A (interpolated from snapshots) must move too.
  const remotePos = () =>
    b.evaluate(
      () =>
        (window as unknown as { __sentinelRemotes?: () => number[][] }).__sentinelRemotes?.() ?? [],
    );
  const before = await remotePos();
  await a.keyboard.down('KeyW');
  await a.waitForTimeout(1200);
  await a.keyboard.up('KeyW');
  await b.waitForTimeout(400);
  const after = await remotePos();
  const moved = after.some(
    (p, i) => before[i] && Math.hypot(p[0]! - before[i]![0]!, p[2]! - before[i]![2]!) > 1,
  );
  expect(moved).toBe(true);
});
