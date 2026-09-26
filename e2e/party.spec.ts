import { expect, test, type Page } from '@playwright/test';

const myTeam = (p: Page) =>
  p.evaluate(async () => (await import('/src/store.ts')).getStatus().match?.myTeam ?? null);

/** Phase 6 exit test: three people join a party by link and land on the same team. */
test('three friends join by one invite link and play on the same team', async ({ browser }) => {
  test.setTimeout(90_000);
  const host = await (await browser.newContext()).newPage();
  await host.goto('/?server=http://localhost:2572');
  await expect(host.getByTestId('net-status')).toHaveText(/connected/, { timeout: 20_000 });
  const link = await host.getByTestId('invite-link').inputValue();
  expect(link).toContain('room=');
  await expect.poll(() => myTeam(host)).not.toBeNull();
  const team = await myTeam(host);

  const friends: Page[] = [];
  for (let i = 0; i < 2; i++) {
    const page = await (await browser.newContext()).newPage();
    await page.goto(link);
    await expect(page.getByTestId('net-status')).toHaveText(/connected/, { timeout: 20_000 });
    friends.push(page);
  }
  for (const f of friends) await expect.poll(() => myTeam(f)).toBe(team);
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
  await host.goto('/?server=http://localhost:2572');
  await expect(host.getByTestId('net-status')).toHaveText(/connected/, { timeout: 20_000 });
  const link = await host.getByTestId('invite-link').inputValue();
  const mate = await (await browser.newContext()).newPage();
  await mate.goto(link);
  const enemy = await (await browser.newContext()).newPage();
  await enemy.goto('/?server=http://localhost:2572');
  for (const p of [mate, enemy])
    await expect(p.getByTestId('net-status')).toHaveText(/connected/, { timeout: 20_000 });
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
  await enemy.getByTestId('chat').getByRole('button').first().click();
  await expect(enemy.getByTestId('chat')).not.toContainText('gg');
  for (const p of [host, mate, enemy]) await p.context().close();
});
