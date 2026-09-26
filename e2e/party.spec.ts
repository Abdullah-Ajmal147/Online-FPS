import { expect, test, type Page } from '@playwright/test';
import { deploy, pause, status } from './helpers.ts';

const myTeam = (p: Page) =>
  p.evaluate(async () => (await import('/src/store.ts')).getStatus().match?.myTeam ?? null);

/** Phase 6 exit test: three people join a party by link and land on the same team. */
test('three friends join by one invite link and play on the same team', async ({ browser }) => {
  test.setTimeout(90_000);
  const host = await (await browser.newContext()).newPage();
  await deploy(host, '/?server=http://localhost:2572');
  // The invite link (Squad screen) from the game's state.
  await expect.poll(async () => (await status(host)).invite, { timeout: 15_000 }).not.toBeNull();
  const link = (await status(host)).invite!;
  expect(link).toContain('room=');
  await expect.poll(() => myTeam(host), { timeout: 15_000 }).not.toBeNull();
  const team = await myTeam(host);

  const friends: Page[] = [];
  for (let i = 0; i < 2; i++) {
    const page = await (await browser.newContext()).newPage();
    await deploy(page, link);
    friends.push(page);
  }
  for (const f of friends) await expect.poll(() => myTeam(f), { timeout: 15_000 }).toBe(team);
  // Everyone is in the same match: the host sees two more humans on its team.
  await expect
    .poll(() =>
      host.evaluate(async () => {
        const m = (await import('/src/store.ts')).getStatus().match;
        return m?.players.filter((p) => !p.bot && p.team === m.myTeam).length ?? 0;
      }),
    )
    .toBe(3);
  for (const p of [host, ...friends]) await p.context().close();
});

const chatText = (p: Page) =>
  p.evaluate(async () =>
    (await import('/src/store.ts'))
      .getStatus()
      .chat.map((l) => `${l.teamOnly ? 'T ' : ''}${l.text}`),
  );

async function say(p: Page, key: 'Enter' | 'KeyT', text: string) {
  await p.keyboard.press(key);
  await p.getByTestId('chat-input').fill(text);
  await p.getByTestId('chat-input').press('Enter');
}

test('chat: filtered by the server, team chat stays in the team, mute hides a player', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const host = await (await browser.newContext()).newPage();
  await deploy(host, '/?server=http://localhost:2572');
  // The invite link (Squad screen) from the game's state.
  await expect.poll(async () => (await status(host)).invite, { timeout: 15_000 }).not.toBeNull();
  const link = (await status(host)).invite!;
  const mate = await (await browser.newContext()).newPage();
  await deploy(mate, link);
  const enemy = await (await browser.newContext()).newPage();
  await deploy(enemy, '/?server=http://localhost:2572');
  await expect.poll(() => myTeam(mate)).toBe(await myTeam(host));
  await expect.poll(() => myTeam(enemy)).not.toBe(await myTeam(host));

  await say(host, 'Enter', 'what the fuck, gg');
  await expect.poll(() => chatText(mate)).toContain('what the ****, gg');
  await expect.poll(() => chatText(enemy)).toContain('what the ****, gg');

  await say(host, 'KeyT', 'push left');
  await expect.poll(() => chatText(mate)).toContain('T push left');
  await host.waitForTimeout(1500);
  expect(await chatText(enemy)).not.toContain('T push left');

  // The enemy mutes the host (click the name with the menu open): their lines disappear.
  await pause(enemy);
  await enemy.getByTestId('chat').getByRole('button').first().click();
  await expect(enemy.getByTestId('chat')).not.toContainText('gg');
  for (const p of [host, mate, enemy]) await p.context().close();
});

/** Phase 7 tasks 5–6: report from the pause menu → admin queue → shadow pool. */
test('report → admin shadow-ban → the player is matched in a separate pool', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const admin = {
    authorization: `Basic ${Buffer.from('admin:e2e-admin-password').toString('base64')}`,
  };
  const host = await (await browser.newContext()).newPage();
  await deploy(host, '/?server=http://localhost:2572');
  await expect.poll(async () => (await status(host)).invite, { timeout: 15_000 }).not.toBeNull();
  const hostCode = (await status(host)).profile!.code;
  const mate = await (await browser.newContext()).newPage();
  await deploy(mate, (await status(host)).invite!);

  // The teammate reports the host from the pause menu (Squad screen).
  await pause(mate);
  await mate.getByTestId('nav-squad').click();
  await mate.getByTestId(`report-cheating-${hostCode}`).click();
  await expect(mate.getByTestId('match-players')).toContainText('Report sent');

  // A moderator sees it and shadow-bans the host.
  const queue = (await (
    await request.get('http://localhost:8787/admin/api/queue', { headers: admin })
  ).json()) as { code: string; reports: number }[];
  expect(queue.find((q) => q.code === hostCode)?.reports).toBeGreaterThanOrEqual(1);
  const set = await request.post(`http://localhost:8787/admin/api/players/${hostCode}/status`, {
    // The admin page's own requests are same-origin JSON (anything else is refused: CSRF).
    headers: { ...admin, 'sec-fetch-site': 'same-origin' },
    data: { status: 'shadow' },
  });
  expect(set.status()).toBe(200);

  // The host's next match is in the shadow pool: a different room from everyone else's.
  const roomOf = async (p: Page) => new URL((await status(p)).invite!).searchParams.get('room');
  const normalRoom = await roomOf(mate);
  await pause(host);
  await host.getByTestId('leave').click(); // back to the main menu (fresh page)
  await host.getByTestId('play').click();
  await expect.poll(async () => (await status(host)).spawned, { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await status(host)).invite, { timeout: 15_000 }).not.toBeNull();
  expect(await roomOf(host)).not.toBe(normalRoom);
  for (const p of [host, mate]) await p.context().close();
});
