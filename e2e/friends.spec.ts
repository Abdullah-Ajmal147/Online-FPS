import { expect, test } from '@playwright/test';
import { deploy, status } from './helpers.ts';

/** Friends: see where a friend plays and join their match (their team) with one click. */
test('Join button: a friend in a match is shown live and one click joins them', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const host = await (await browser.newContext()).newPage();
  await deploy(host, '/?server=http://localhost:2567');
  await expect
    .poll(async () => (await status(host)).profile?.code, { timeout: 15_000 })
    .toBeTruthy();
  const code = (await status(host)).profile!.code;

  const friend = await (await browser.newContext()).newPage();
  await friend.goto('/?server=http://localhost:2567');
  await friend.getByTestId('nav-squad').click();
  await friend.getByTestId('friend-code').fill(code);
  await friend.getByRole('button', { name: 'Add' }).click();
  // The game server reports presence about a second after a join; the list polls every 10 s.
  const join = friend.getByTestId(`join-${code}`);
  await expect(join).toBeVisible({ timeout: 25_000 });
  await expect(friend.getByTestId(`friend-${code}`)).toContainText('In a match');
  await join.click();

  // The page reloads into the friend's match and joins by itself, on the host's team.
  await expect.poll(async () => (await status(friend)).spawned, { timeout: 40_000 }).toBe(true);
  const h = await status(host);
  const f = await status(friend);
  expect(f.match!.myTeam).toBe(h.match!.myTeam);
  const hostRow = h.match!.players.find((p) => p.me)!;
  expect(f.match!.players.some((p) => p.id === hostRow.id && p.name === hostRow.name)).toBe(true);
});

test('with "Let friends join my match" off, friends see the match but get no Join button', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const hostCtx = await browser.newContext();
  await hostCtx.addInitScript(() =>
    localStorage.setItem('sentinel.settings.v1', JSON.stringify({ allowJoin: false })),
  );
  const host = await hostCtx.newPage();
  await deploy(host, '/?server=http://localhost:2567');
  await expect
    .poll(async () => (await status(host)).profile?.code, { timeout: 15_000 })
    .toBeTruthy();
  const code = (await status(host)).profile!.code;
  const friend = await (await browser.newContext()).newPage();
  await friend.goto('/?server=http://localhost:2567');
  await friend.getByTestId('nav-squad').click();
  await friend.getByTestId('friend-code').fill(code);
  await friend.getByRole('button', { name: 'Add' }).click();
  await expect(friend.getByTestId(`friend-${code}`)).toContainText('In a match', {
    timeout: 25_000,
  });
  await expect(friend.getByTestId(`join-${code}`)).toHaveCount(0);
});
