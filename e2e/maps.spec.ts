import { expect, test } from '@playwright/test';
import { status } from './helpers.ts';

/** Map choice on the Play screen: Quick Play puts you in a room that plays that map. */
test('choosing Alder Street on the Play screen joins an Alder Street match', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?server=http://localhost:2568');
  await page.getByTestId('map-alder-street').click();
  await expect(page.getByTestId('map-alder-street')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('play').click();
  await expect
    .poll(async () => (await status(page)).net.state, { timeout: 40_000 })
    .toBe('connected');
  await expect
    .poll(async () => (await status(page)).mapId, { timeout: 20_000 })
    .toBe('alder-street');
  // The choice is remembered for next time.
  await page.reload();
  await expect(page.getByTestId('map-alder-street')).toHaveAttribute('aria-checked', 'true');
});
