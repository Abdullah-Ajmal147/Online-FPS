import { expect, test, type Page } from '@playwright/test';
import { deploy, pause, status } from './helpers.ts';

const SERVER = '/?server=http://localhost:2574'; // own server: bots on, long warm-up

/** Private matches: only invited friends get in; teams can be switched there. */
test('private match: invite-only, strangers kept out, friends can switch team', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = async () => (await browser.newContext()).newPage();

  // Host creates a private match on Saltline Depot, with bots.
  const host = await page();
  await host.goto(SERVER);
  await host.locator('[data-testid=private-match] summary').click();
  await host.getByTestId('private-map').selectOption('saltline-depot');
  await host.getByTestId('create-private').click();
  await expect.poll(async () => (await status(host)).spawned, { timeout: 40_000 }).toBe(true);
  await expect.poll(async () => (await status(host)).match?.private).toBe(true);
  expect((await status(host)).mapId).toBe('saltline-depot');
  await expect(host.getByTestId('private-tag')).toBeVisible();
  await expect
    .poll(async () => (await status(host)).match?.players.length, { timeout: 15_000 })
    .toBe(12); // bots fill
  const invite = (await status(host)).invite!;
  const hostName = (await status(host)).match!.players.find((p) => p.me)!.id;
  const inRoomOf = async (p: Page) =>
    (await status(p)).match?.private === true &&
    (await status(p)).match!.players.some((q) => q.id === hostName && !q.bot);

  // A stranger's Quick Play never lands in it.
  const stranger = await page();
  await deploy(stranger, SERVER);
  expect((await status(stranger)).match?.private).toBe(false);

  // Knowing the room id isn't enough: a bad invite token is refused (falls back to a public
  // match).
  const snoop = await page();
  const bad = new URL(invite);
  bad.searchParams.set('with', 'not-a-real-token');
  await deploy(snoop, bad.pathname + bad.search);
  expect((await status(snoop)).match?.private).toBe(false);

  // The invited friend gets in, on the host's team.
  const friend = await page();
  const link = new URL(invite);
  await deploy(friend, link.pathname + link.search);
  await expect.poll(() => inRoomOf(friend), { timeout: 20_000 }).toBe(true);
  expect((await status(friend)).match!.myTeam).toBe((await status(host)).match!.myTeam);

  // Switch team (pause menu): the friend moves over, and it's still 6 v 6 with bots.
  const before = (await status(friend)).match!.myTeam;
  await pause(friend);
  await friend.getByTestId('switch-team').click();
  await expect
    .poll(async () => (await status(friend)).match!.myTeam, { timeout: 10_000 })
    .toBe(1 - before);
  const players = (await status(friend)).match!.players;
  expect(players.filter((p) => p.team === 0)).toHaveLength(6);
  expect(players.filter((p) => p.team === 1)).toHaveLength(6);
});
