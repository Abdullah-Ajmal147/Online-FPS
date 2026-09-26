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
  // The guest profile (level/XP) loads from the API on page load.
  await expect(page.getByTestId('profile')).toContainText('Level 1');
});

test('graphics presets switch without breaking rendering', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('/');
  await expect(page.getByTestId('net-status')).toHaveText(/connected/, { timeout: 20_000 });
  const fps = () => page.evaluate(async () => (await import('/src/store.ts')).getStatus().fps);
  for (const preset of ['low', 'high', 'medium']) {
    await page.getByTestId('graphics').selectOption(preset);
    await page.waitForTimeout(1500);
    expect(await fps(), preset).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
});

test('starting on the Low preset (no shadows) renders', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript(() =>
    localStorage.setItem('sentinel.settings.v1', JSON.stringify({ graphics: 'low' })),
  );
  await page.goto('/');
  await expect(page.getByTestId('net-status')).toHaveText(/connected/, { timeout: 20_000 });
  await expect(page.getByTestId('graphics')).toHaveValue('low');
  await expect
    .poll(() => page.evaluate(async () => (await import('/src/store.ts')).getStatus().fps))
    .toBeGreaterThan(0);
  expect(errors).toEqual([]);
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

test('the loadout saved in settings is the one the server spawns you with', async ({ page }) => {
  test.setTimeout(60_000);
  // A player who picked the shotgun last time (settings live in localStorage). One page only:
  // closing a WebGL tab and opening another makes headless Chrome refuse the new context.
  await page.addInitScript(() => {
    if (!localStorage.getItem('sentinel.settings.v1')) {
      localStorage.setItem(
        'sentinel.settings.v1',
        JSON.stringify({ primary: 'thresher-12', attachments: ['extended-mag'] }),
      );
    }
  });
  const weapon = () =>
    page.evaluate(async () => (await import('/src/store.ts')).getStatus().combat?.weaponName);
  await page.goto('/');
  await expect(page.getByTestId('net-status')).toHaveText(/connected/, { timeout: 20_000 });
  await expect.poll(weapon, { timeout: 15_000 }).toBe('Thresher 12');
  // The extended magazine (6 × 1.3 → 8 shells) is simulated by the server and predicted here.
  const ammo = () =>
    page.evaluate(async () => (await import('/src/store.ts')).getStatus().combat?.ammo);
  await expect.poll(ammo).toBe(8);
  await expect(page.getByTestId('weapon-thresher-12')).toHaveAttribute('aria-pressed', 'true');

  // Picking another weapon saves it for next time (and tells the server for the next spawn).
  await page.getByTestId('weapon-vireo-smg').click();
  await expect(page.getByTestId('weapon-vireo-smg')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('attachment-vertical-grip').click();
  await page.getByTestId('perk-quick-hands').click();
  await expect(page.getByTestId('perk-quick-hands')).toHaveAttribute('aria-pressed', 'true');
  const saved = await page.evaluate(() => localStorage.getItem('sentinel.settings.v1'));
  expect(JSON.parse(saved!)).toMatchObject({
    primary: 'vireo-smg',
    attachments: ['extended-mag', 'vertical-grip'],
    perks: ['quick-hands'],
  });
});
