import { expect, test, type Page } from '@playwright/test';
import { deploy, status } from './helpers.ts';

type Vec = [number, number, number];
const SERVER = '/?server=http://localhost:2575'; // humans only, open arena

/**
 * The main way friends play: one link to join your side, one to play against you. Everyone
 * lands in the host's match where the link says, they are real enemies to each other, and a
 * shot across teams lands. (Private rooms: private.spec.ts.)
 */
test('friends by link: "with me" joins my team, "against me" the other, and they can fight', async ({
  browser,
}) => {
  test.setTimeout(200_000);
  const open = async () => (await browser.newContext()).newPage();
  const pages: Page[] = [];
  try {
    // Host: in a match (humans only here), with both links ready.
    const host = await open();
    pages.push(host);
    await deploy(host, SERVER);
    await expect
      .poll(async () => (await status(host)).inviteVs, { timeout: 15_000 })
      .not.toBeNull();
    const { invite, inviteVs } = await status(host);
    expect(inviteVs).toContain('side=vs');
    const hostTeam = (await status(host)).match!.myTeam;

    // A friend on my side, and a rival on the other.
    const mate = await open();
    pages.push(mate);
    await deploy(mate, new URL(invite!).pathname + new URL(invite!).search);
    const rival = await open();
    pages.push(rival);
    await deploy(rival, new URL(inviteVs!).pathname + new URL(inviteVs!).search);

    const teamOf = async (p: Page) => (await status(p)).match?.myTeam;
    await expect.poll(() => teamOf(mate), { timeout: 15_000 }).toBe(hostTeam);
    await expect.poll(() => teamOf(rival), { timeout: 15_000 }).toBe(1 - hostTeam);
    // All three are in the host's match, nobody got lost in another one.
    for (const p of [mate, rival]) {
      const m = (await status(p)).match!;
      expect(m.players.filter((q) => !q.bot)).toHaveLength(3);
      expect((await status(p)).inviteProblem).toBeNull();
    }

    // The host shoots the rival until the server says the rival was hurt.
    await mate.context().close(); // two players are enough from here (less CPU for the rest)
    pages.splice(pages.indexOf(mate), 1);
    const pos = (p: Page) =>
      p.evaluate(async () => (await import('/src/store.ts')).getStatus().player?.position as Vec);
    let hurt = false;
    for (let attempt = 0; attempt < 40 && !hurt; attempt++) {
      const me = await pos(host);
      const them = await pos(rival);
      if (!me || !them) continue;
      const dx = them[0] - me[0];
      const dz = them[2] - me[2];
      const yaw = Math.atan2(-dx, -dz);
      const pitch = Math.atan2(them[1] + 1.1 - (me[1] + 1.67), Math.hypot(dx, dz));
      await host.evaluate(
        ([y, p]) => {
          const h = (
            window as unknown as {
              __sentinelInput: {
                setLook(y: number, p: number): void;
                setMouse(f: boolean, a: boolean): void;
              };
            }
          ).__sentinelInput;
          h.setLook(y, p);
          h.setMouse(true, true);
        },
        [yaw, pitch],
      );
      await host.waitForTimeout(500);
      const c = (await status(rival)).combat;
      hurt = !!c && (c.health < 100 || !c.alive);
    }
    expect(hurt).toBe(true);
    await expect
      .poll(async () => (await status(host)).combat?.confirmedHits ?? 0, { timeout: 5_000 })
      .toBeGreaterThan(0);
  } finally {
    for (const p of pages)
      await p
        .context()
        .close()
        .catch(() => undefined);
  }
});
