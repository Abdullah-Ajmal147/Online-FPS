import { expect, test } from '@playwright/test';
import { deploy } from './helpers.ts';

/**
 * F1 tuning panel: renderer counters and a frame graph from the running game, a time-to-kill
 * table from the weapon data, and sliders that change the live feel values.
 */
test('F1 opens the tuning panel with live counters, TTK table and working sliders', async ({
  page,
}) => {
  await deploy(page, '/?server=http://localhost:2571');
  await page.keyboard.press('F1');
  const panel = page.getByTestId('tuning-panel');
  await expect(panel).toBeVisible();
  // Counters come from the frame loop: some draw calls once the world is drawn.
  await expect(page.getByTestId('tuning-counters')).toContainText(/draw calls [1-9]/, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('ttk-table')).toContainText('Kestrel AR');
  // Kestrel AR at 5 m: 5 body shots at 600 rpm = 400 ms; 3 head shots = 200 ms.
  await expect(page.getByTestId('ttk-table')).toContainText('400 / 200');

  const slider = page.getByTestId('tune-tracerEvery');
  await slider.fill('1');
  await expect(slider.locator('xpath=following-sibling::output')).toHaveText('1');

  await page.keyboard.press('F1');
  await expect(panel).toBeHidden();
});
