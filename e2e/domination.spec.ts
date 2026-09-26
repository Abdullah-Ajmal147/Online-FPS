import { expect, test } from '@playwright/test';
import { status } from './helpers.ts';

/** Phase 8: Domination is a second playlist, picked on the Play screen. */
test('choosing Domination joins a Domination match with points A, B and C', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?server=http://localhost:2568');
  await page.getByTestId('mode-domination').click();
  await expect(page.getByTestId('mode-domination')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('play').click();
  await expect.poll(async () => (await status(page)).spawned, { timeout: 25_000 }).toBe(true);
  await expect.poll(async () => (await status(page)).match?.mode).toBe('domination');
  await expect
    .poll(async () => (await status(page)).match?.points.map((p) => p.id).join(''))
    .toBe('ABC');
  await expect(page.getByTestId('points')).toContainText('A');
  // The choice is remembered for next time.
  const saved = await page.evaluate(() => localStorage.getItem('sentinel.settings.v1'));
  expect(JSON.parse(saved!)).toMatchObject({ mode: 'domination' });
});
