import { expect, test } from '@playwright/test';
import { deploy, pause, status } from './helpers.ts';

test('the main menu comes first; nothing is joined until DEPLOY', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('/');
  await expect(page.getByTestId('menu')).toBeVisible();
  await expect(page.getByTestId('render-backend')).toHaveText(/renderer: (WebGPU|WebGL 2)/);
  await expect(page.getByTestId('net-status')).toHaveText('not in a match');
  await page.waitForTimeout(1500);
  expect((await status(page)).inMatch).toBe(false);
  // One server region in this build: its measured ping is shown.
  await expect(page.getByTestId('regions')).toContainText(/Server \d+ ms/);

  await page.getByTestId('play').click(); // DEPLOY
  await expect.poll(async () => (await status(page)).net.text).toMatch(/connected, protocol v\d+/);
  expect((await status(page)).region).toBe('default');
  expect((await status(page)).invite).toContain('region=default');
  await expect.poll(async () => (await status(page)).combat?.alive, { timeout: 15_000 }).toBe(true);
  // Pause (Esc in a real browser): the menu is back as a pause menu with RESUME and LEAVE.
  await pause(page);
  await expect(page.getByTestId('play')).toContainText('Resume');
  await expect(page.getByTestId('leave')).toBeVisible();
  // LEAVE MATCH: back to the main menu, out of the match.
  await page.getByTestId('leave').click();
  await expect(page.getByTestId('play')).toContainText('Deploy');
  await expect(page.getByTestId('net-status')).toHaveText('not in a match');
  expect(errors).toEqual([]);
});

test('holding W walks the player forward (-Z)', async ({ page }) => {
  await deploy(page, '/');
  await expect.poll(async () => (await status(page)).combat?.alive, { timeout: 15_000 }).toBe(true);
  const zOf = async () => (await status(page)).player!.position[2];
  // Face -Z (yaw 0) whatever team we got: the spawn direction depends on the side.
  await page.evaluate(() =>
    (
      window as unknown as { __sentinelInput: { setLook(y: number, p: number): void } }
    ).__sentinelInput.setLook(0, 0),
  );
  const z0 = await zOf();

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);

  // Walk speed 5 m/s; allow for acceleration and frame timing in CI.
  expect(z0 - (await zOf())).toBeGreaterThan(2.5);
});

test('menu screens: play, settings with controls, career with challenges', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu')).toBeVisible();
  await expect(page.getByTestId('play')).toContainText('Deploy');
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-controls').click();
  await expect(page.getByText('Crouch / slide')).toBeVisible();
  await page.getByTestId('nav-intel').click();
  await expect(page.getByText('Aegis Directive')).toBeVisible();
  await page.getByTestId('nav-career').click();
  // The guest profile (level/XP) loads from the API on page load.
  await expect(page.getByTestId('profile')).toContainText('Level 1');
  // Daily and weekly challenges, progress from zero.
  await expect(page.getByTestId('challenges')).toContainText('Daily challenges');
  await expect(page.getByTestId('challenges')).toContainText('Weekly challenges');
});

test('graphics presets switch without breaking rendering', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await deploy(page, '/');
  await pause(page);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-graphics').click();
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
  await deploy(page, '/');
  await pause(page);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-graphics').click();
  await expect(page.getByTestId('graphics')).toHaveValue('low');
  await expect
    .poll(() => page.evaluate(async () => (await import('/src/store.ts')).getStatus().fps))
    .toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('F3 toggles the network debug overlay', async ({ page }) => {
  await deploy(page, '/');
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
  await Promise.all([deploy(a, '/'), deploy(b, '/')]);
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

test('the server enforces unlocks: a new player gets unlocked gear only', async ({ page }) => {
  test.setTimeout(60_000);
  // Saved last time: the shotgun (unlocks at level 4) with an extended magazine (unlocked from
  // the start). This test server uses real unlocks, and this is a brand-new guest (level 1).
  await page.addInitScript(() => {
    if (!localStorage.getItem('sentinel.settings.v1')) {
      localStorage.setItem(
        'sentinel.settings.v1',
        JSON.stringify({ primary: 'thresher-12', attachments: ['extended-mag'] }),
      );
    }
  });
  const status = () => page.evaluate(async () => (await import('/src/store.ts')).getStatus());
  await deploy(page, '/');
  // The server fell back to the rifle but kept the extended magazine (30 × 1.3 → 39 rounds).
  await expect
    .poll(async () => (await status()).combat?.weaponName, { timeout: 15_000 })
    .toBe('Kestrel AR');
  await expect.poll(async () => (await status()).combat?.ammo).toBe(39);
  // The menu shows the same thing: the shotgun is locked, the rifle is selected.
  await pause(page);
  await page.getByTestId('nav-loadout').click();
  await expect(page.getByTestId('weapon-thresher-12')).toBeDisabled();
  await expect(page.getByTestId('weapon-thresher-12')).toContainText('Unlocks at level 4');
  await expect(page.getByTestId('weapon-kestrel-ar')).toHaveAttribute('aria-pressed', 'true');

  // Picking unlocked things saves them (and tells the server for the next spawn).
  await page.getByTestId('attachment-reflex-sight').click();
  await page.getByTestId('perk-light-step').click();
  await expect(page.getByTestId('perk-light-step')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('perk-flak-vest')).toBeDisabled();
  const saved = await page.evaluate(() => localStorage.getItem('sentinel.settings.v1'));
  expect(JSON.parse(saved!)).toMatchObject({
    primary: 'kestrel-ar',
    attachments: ['reflex-sight', 'extended-mag'],
    perks: ['light-step'],
  });
});
