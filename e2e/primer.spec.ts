import { expect, test } from '@playwright/test';
import { deploy } from './helpers.ts';

/** Phase 8 task 2: first-match tips advance as the player does each thing, once. */
test('first-match primer: steps advance by doing them, then never show again', async ({ page }) => {
  await deploy(page, '/?server=http://localhost:2567');
  const primer = page.getByTestId('primer');
  await expect(primer).toHaveAttribute('data-step', 'move');
  await expect(primer).toContainText('W A S D');
  await page.keyboard.down('KeyW');
  await page.keyboard.up('KeyW');
  await expect(primer).toHaveAttribute('data-step', 'shoot');
  await page.mouse.down();
  await page.mouse.up();
  await expect(primer).toHaveAttribute('data-step', 'ads');
  await page.keyboard.press('Backspace'); // skip the rest
  await expect(primer).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('sentinel.primer.v1'))).toBe('done');

  // A new visit: no primer.
  await deploy(page, '/?server=http://localhost:2567');
  await page.waitForTimeout(1000);
  await expect(primer).toHaveCount(0);
});
