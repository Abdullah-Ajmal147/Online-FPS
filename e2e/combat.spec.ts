import { expect, test, type Page } from '@playwright/test';
import { deploy } from './helpers.ts';

type Vec = [number, number, number];

async function join(page: Page) {
  // Own server: two players only, so they always end up on opposite teams.
  await deploy(page, '/?server=http://localhost:2571');
}

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

test('one player shoots another: the server registers hits and the victim takes damage', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await Promise.all([join(a), join(b)]);
  await expect
    .poll(async () => (await remotes(a)).length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);

  // A aims at B's torso (as A sees B) and fires with sights up until B is hurt or dead.
  let hurt = false;
  for (let attempt = 0; attempt < 40 && !hurt; attempt++) {
    const me = await ownPos(a);
    // Aim at the remote player standing where B says it is.
    const bAt = await ownPos(b);
    const target = bAt
      ? (await remotes(a)).sort(
          (p, q) =>
            Math.hypot(p[0] - bAt[0], p[2] - bAt[2]) - Math.hypot(q[0] - bAt[0], q[2] - bAt[2]),
        )[0]
      : undefined;
    if (!me || !target) continue;
    const dx = target[0] - me[0];
    const dz = target[2] - me[2];
    const eyeY = me[1] + 1.67;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(target[1] + 1.1 - eyeY, Math.hypot(dx, dz));
    await a.evaluate(
      ([y, p]) => {
        const hook = (
          window as unknown as {
            __sentinelInput: {
              setLook(y: number, p: number): void;
              setMouse(f: boolean, a: boolean): void;
            };
          }
        ).__sentinelInput;
        hook.setLook(y, p);
        hook.setMouse(false, true);
      },
      [yaw, pitch],
    );
    await a.waitForTimeout(300); // aim down sights
    await a.evaluate(() =>
      (
        window as unknown as { __sentinelInput: { setMouse(f: boolean, a: boolean): void } }
      ).__sentinelInput.setMouse(true, true),
    );
    await a.waitForTimeout(400);
    const victim = await combat(b);
    hurt = !!victim && (victim.health < 100 || !victim.alive);
  }
  await a.evaluate(() =>
    (
      window as unknown as { __sentinelInput: { setMouse(f: boolean, a: boolean): void } }
    ).__sentinelInput.setMouse(false, false),
  );

  expect(hurt).toBe(true);
  const shooterHud = await combat(a);
  expect(shooterHud!.ammo).toBeLessThan(30); // shots were fired (predicted + server-confirmed ammo)
  // The shooter got server-confirmed hits (not just its own predicted markers).
  await expect
    .poll(async () => (await combat(a))!.confirmedHits, { timeout: 5_000 })
    .toBeGreaterThan(0);
});
