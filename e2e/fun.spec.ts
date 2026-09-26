import { expect, test, type Page } from '@playwright/test';

type Target = {
  id: number;
  enemy: boolean;
  alive: boolean;
  visible: boolean;
  position: [number, number, number];
};

/**
 * Regression test for owner feedback "I shoot the enemies but they don't die": a player who
 * hip-fires at visible bots, like a person would (no aiming down sights), must get kills.
 */
test('a hip-firing player kills bots in a real match', async ({ page }) => {
  test.setTimeout(220_000);
  await page.setViewportSize({ width: 480, height: 270 });
  await page.goto('/?server=http://localhost:2569');
  await expect(page.getByTestId('net-status')).toHaveText(/connected/, { timeout: 20_000 });
  await page.addStyleTag({ content: '.menu{display:none!important}' });
  const status = () => page.evaluate(async () => (await import('/src/store.ts')).getStatus());
  await expect.poll(async () => (await status()).match?.phase, { timeout: 30_000 }).toBe('live');

  const kills = async () => (await status()).match?.players.find((p) => p.me)?.kills ?? 0;
  // Keep playing across match phases (we may join a match that is nearly over).
  // Generous: headless pages run a few fps while other tests share the machine.
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline && (await kills()) < 1) {
    const s = await status();
    if (s.match?.phase !== 'live' || !s.combat?.alive) {
      await page.waitForTimeout(300);
      continue;
    }
    const me = s.player?.position;
    const targets = (await page.evaluate(() =>
      (window as unknown as { __sentinelDebug: { targets(): Target[] } }).__sentinelDebug.targets(),
    )) as Target[];
    const visible = targets.filter((t) => t.enemy && t.alive && t.visible);
    const alive = targets.filter((t) => t.enemy && t.alive);
    await aimAndFire(page, me, visible, alive);
  }
  // The headless browser runs ~10 fps, so its aim lags: one kill proves shots kill enemies.
  expect(await kills()).toBeGreaterThanOrEqual(1);
  // …and the kill is rewarded on screen.
  await expect(page.getByTestId('announcements')).toContainText('ELIMINATED', { timeout: 3_000 });
});

async function aimAndFire(
  page: Page,
  me: readonly number[] | undefined,
  visible: Target[],
  alive: Target[],
) {
  const input = 'window.__sentinelInput';
  if (!me || visible.length === 0) {
    // Like a player: head towards the nearest enemy until one comes into view.
    if (me && alive.length > 0) {
      alive.sort((a, b) => dist(a.position, me) - dist(b.position, me));
      const [x, , z] = alive[0]!.position;
      await page.evaluate(`${input}.setLook(${Math.atan2(-(x - me[0]!), -(z - me[2]!))}, 0)`);
    }
    await page.evaluate(`${input}.setMouse(false, false)`);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(300);
    await page.keyboard.up('KeyW');
    return;
  }
  visible.sort((a, b) => dist(a.position, me) - dist(b.position, me));
  const [x, y, z] = visible[0]!.position;
  // Put the crosshair on the target, like a person does: the crosshair shows view + recoil,
  // so the mouse (view) goes to target − recoil (pulling down against the kick).
  const [ry, rp] = (await page.evaluate('window.__sentinelDebug.recoil()')) as [number, number];
  const yaw = Math.atan2(-(x - me[0]!), -(z - me[2]!)) - ry;
  const pitch = Math.atan2(y + 1.1 - (me[1]! + 1.67), Math.hypot(x - me[0]!, z - me[2]!)) - rp;
  await page.evaluate(`${input}.setLook(${yaw}, ${pitch}); ${input}.setMouse(true, false)`);
  await page.waitForTimeout(120);
}

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!);
}
