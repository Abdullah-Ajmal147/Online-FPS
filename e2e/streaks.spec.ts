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

  const minimap = page.getByTestId('minimap');
  await expect(minimap).toHaveClass(/\bon\b/); // always up while alive
  await expect(minimap).toHaveAttribute('data-sweep', 'off');
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
  await expect(minimap).toHaveAttribute('data-sweep', 'on');
  await page.screenshot({ path: 'test-results/streak-radar.png' });

  await feed([{ type: 'reward', player: 0, reward: 2, streak: 7 }]);
  await expect(page.getByTestId('armor')).toContainText('ARMOR');
  // The sweep ends after its seconds (5 s).
  await expect(minimap).toHaveAttribute('data-sweep', 'off', { timeout: 8_000 });
});

/** Taking damage: a red edge pulse, and at low health a heartbeat pulse. */
test('hurt feedback: a hit pulses the red edge', async ({ page }) => {
  await deploy(page, '/?server=http://localhost:2571');
  // The pulse lasts 0.6 s and the next snapshot restores our real health, so on a slow
  // software-rendered page a poll can miss it: record the highest opacity it reaches instead.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="hurt"]') as HTMLElement;
    const w = window as unknown as { __hurtMax: number };
    w.__hurtMax = Number(el.style.opacity || 0);
    new MutationObserver(() => {
      w.__hurtMax = Math.max(w.__hurtMax, Number(el.style.opacity || 0));
    }).observe(el, { attributes: true, attributeFilter: ['style'] });
  });
  const max = () => page.evaluate(() => (window as unknown as { __hurtMax: number }).__hurtMax);
  expect(await max()).toBe(0);
  await page.evaluate(() => {
    const d = (window as unknown as { __sentinelDebug: { events(e: unknown[]): void } })
      .__sentinelDebug;
    d.events([{ type: 'damaged', attacker: 250, from: [0, 1, -10], health: 20 }]);
  });
  await expect.poll(max, { timeout: 10_000 }).toBeGreaterThan(0.2);
});
