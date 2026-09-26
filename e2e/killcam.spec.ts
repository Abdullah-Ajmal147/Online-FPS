import { expect, test, type Page } from '@playwright/test';
import { deploy } from './helpers.ts';

type Vec = [number, number, number];
type Hook = { setLook(y: number, p: number): void; setMouse(f: boolean, a: boolean): void };

const combat = (p: Page) =>
  p.evaluate(async () => (await import('/src/store.ts')).getStatus().combat);
const ownPos = (p: Page) =>
  p.evaluate(
    async () => (await import('/src/store.ts')).getStatus().player?.position as Vec | undefined,
  );
const remotes = (p: Page) =>
  p.evaluate(
    () => (window as unknown as { __sentinelRemotes?: () => Vec[] }).__sentinelRemotes?.() ?? [],
  );
const input = (p: Page, look: [number, number] | null, fire: boolean) =>
  p.evaluate(
    ([l, f]) => {
      const hook = (window as unknown as { __sentinelInput: Hook }).__sentinelInput;
      if (l) hook.setLook(l[0], l[1]);
      hook.setMouse(f, true);
    },
    [look, fire] as const,
  );

/** Owner feature list: after a death, the killer's view is replayed until respawn. */
test('killcam: the victim sees the replay from the killer, then respawns', async ({ browser }) => {
  test.setTimeout(90_000);
  const killer = await (await browser.newContext()).newPage();
  const victim = await (await browser.newContext()).newPage();
  await Promise.all([
    deploy(killer, '/?server=http://localhost:2573'),
    deploy(victim, '/?server=http://localhost:2573'),
  ]);
  await expect
    .poll(async () => (await remotes(killer)).length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);

  // The killer aims at the victim and fires until the victim is down.
  let dead = false;
  for (let attempt = 0; attempt < 60 && !dead; attempt++) {
    const me = await ownPos(killer);
    const target = (await remotes(killer))[0];
    if (!me || !target) continue;
    const dx = target[0] - me[0];
    const dz = target[2] - me[2];
    const pitch = Math.atan2(target[1] + 1.1 - (me[1] + 1.67), Math.hypot(dx, dz));
    await input(killer, [Math.atan2(-dx, -dz), pitch], true);
    await killer.waitForTimeout(250);
    dead = (await combat(victim))?.alive === false;
  }
  await input(killer, null, false);
  expect(dead).toBe(true);

  // Death view first, then the killcam names the killer (the victim saw them long enough:
  // they stood in the open the whole time).
  const cam = victim.getByTestId('killcam');
  await expect(cam).toBeVisible({ timeout: 3_000 });
  await expect(cam).toContainText('Kestrel');
  await victim.screenshot({ path: 'test-results/killcam.png' });
  // It ends with the respawn.
  await expect.poll(async () => (await combat(victim))?.alive, { timeout: 8_000 }).toBe(true);
  await expect(cam).toHaveCount(0);
});
