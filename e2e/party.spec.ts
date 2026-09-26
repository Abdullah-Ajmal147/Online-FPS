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
});
