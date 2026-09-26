import { expect, test } from '@playwright/test';

test('full match with bots: join, play a 45 s match, see results, next match starts', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto('/?server=http://localhost:2568');
  await expect(page.getByTestId('net-status')).toHaveText(/connected/, { timeout: 20_000 });
  await page.addStyleTag({ content: '.menu{display:none!important}' });

  // The match bar shows up and bots fill the match to 12.
  await expect(page.getByTestId('scorebar')).toBeVisible({ timeout: 10_000 });
  const match = () => page.evaluate(async () => (await import('/src/store.ts')).getStatus().match);
  await expect.poll(async () => (await match())?.players.length, { timeout: 10_000 }).toBe(12);
  const m = await match();
  // Bots fill every empty slot (another test's player may still be leaving this server).
  const humans = m!.players.filter((p) => !p.bot).length;
  expect(humans).toBeGreaterThanOrEqual(1);
  expect(m!.players.filter((p) => p.bot)).toHaveLength(12 - humans);
  expect(m!.players.filter((p) => p.team === 0)).toHaveLength(6);

  // Tab shows the scoreboard with bot tags.
  await page.keyboard.down('Tab');
  await expect(page.getByTestId('scoreboard')).toContainText('BOT');
  await page.keyboard.up('Tab');

  // The match goes live, bots fight (kill feed fills), and it ends with a results screen.
  await expect.poll(async () => (await match())?.phase, { timeout: 20_000 }).toBe('live');
  await expect.poll(async () => (await match())?.phase, { timeout: 70_000 }).toBe('ended');
  const results = page.getByTestId('results');
  await expect(results).toBeVisible();
  await expect(results).toContainText(/Victory|Defeat|Draw/);
  const ended = await match();
  expect(ended!.players.reduce((n, p) => n + p.kills, 0)).toBeGreaterThan(0);

  // The server reported the match to the API; our guest profile now has XP (≥ participation).
  const profile = () =>
    page.evaluate(async () => (await import('/src/store.ts')).getStatus().profile);
  await expect
    .poll(async () => (await profile())?.xp ?? 0, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(150);
  expect((await profile())!.matches).toBe(1);

  // After the results, a new match starts on the next map in the rotation, and we can move.
  const mapName = () =>
    page.evaluate(async () => (await import('/src/store.ts')).getStatus().mapName);
  expect(await mapName()).toBe('Relay Yard');
  await expect.poll(async () => (await match())?.phase, { timeout: 20_000 }).not.toBe('ended');
  await expect.poll(mapName, { timeout: 10_000 }).toBe('Saltline Depot');
  const pos = () =>
    page.evaluate(async () => (await import('/src/store.ts')).getStatus().player!.position);
  const before = await pos();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1000);
  await page.keyboard.up('KeyW');
  await expect
    .poll(async () => {
      const now = await pos();
      return Math.hypot(now[0] - before[0], now[2] - before[2]);
    })
    .toBeGreaterThan(1);
});
