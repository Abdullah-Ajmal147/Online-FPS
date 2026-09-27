import { expect, test } from '@playwright/test';
import { deploy, status } from './helpers.ts';

/**
 * One player, two tabs (same browser, so the same guest profile): the second tab takes over
 * the player in that match, and the first is told why it was disconnected. Never two seats:
 * a second tab can't be an extra body to farm kills on, or an extra vote.
 */
test('the same player in a second tab takes over the seat; the first tab is told', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  await context.addInitScript(() =>
    localStorage.setItem('sentinel.settings.v1', JSON.stringify({ name: 'TabTester' })),
  );
  const first = await context.newPage();
  await deploy(first, '/?server=http://localhost:2568');
  await expect.poll(async () => (await status(first)).invite, { timeout: 15_000 }).not.toBeNull();
  const invite = new URL((await status(first)).invite!);
  const mine = (p: typeof first) =>
    p.evaluate(async () => {
      const m = (await import('/src/store.ts')).getStatus().match;
      return m?.players.filter((q) => q.name === 'TabTester').map((q) => ({ id: q.id, me: q.me }));
    });
  await expect.poll(() => mine(first), { timeout: 15_000 }).toHaveLength(1);
  const [before] = (await mine(first))!;

  const second = await context.newPage();
  await deploy(second, invite.pathname + invite.search);
  // The first tab is disconnected with the reason; the second plays the same player.
  await expect
    .poll(async () => (await status(first)).net.text, { timeout: 15_000 })
    .toContain('another tab');
  await expect
    .poll(() => mine(second), { timeout: 15_000 })
    .toEqual([{ id: before!.id, me: true }]);
  await context.close();
});
