import { expect, test } from '@playwright/test';
import { deploy } from './helpers.ts';

/**
 * Kill-streak rewards as the client shows them. The server side (who earns what, radar only
 * to the team, ammo and armor) is covered by apps/server/src/sim.test.ts; here the events the
 * server would send are fed in directly.
 */
test('streak rewards: announcement, radar sweep with enemy dots, armor badge', async ({ page }) => {
  await deploy(page, '/?server=http://localhost:2571');
  const feed = (events: unknown[]) =>
    page.evaluate((ev) => {
      const d = (
        window as unknown as { __sentinelDebug: { events(e: unknown[]): void; myId(): number } }
      ).__sentinelDebug;
      d.events(
        (ev as { player?: number; by?: number }[]).map((e) => ({
          ...e,
          ...('player' in e ? { player: d.myId() } : {}),
          ...('by' in e ? { by: d.myId() } : {}),
        })),
      );
    }, events);

  await expect(page.getByTestId('radar')).not.toHaveClass(/\bon\b/);
  await feed([
    { type: 'reward', player: 0, reward: 0, streak: 3 },
    {
      type: 'radar',
      by: 0,
      enemies: [
        [5, -20],
        [-15, 3],
      ],
    },
  ]);
  await expect(page.getByTestId('announcements')).toContainText('RADAR SWEEP');
  await expect(page.getByTestId('radar')).toHaveClass(/\bon\b/);
  await page.screenshot({ path: 'test-results/streak-radar.png' });

  await feed([{ type: 'reward', player: 0, reward: 2, streak: 7 }]);
  await expect(page.getByTestId('armor')).toContainText('ARMOR');
  // The sweep ends after its seconds (5 s).
  await expect(page.getByTestId('radar')).not.toHaveClass(/\bon\b/, { timeout: 8_000 });
});
