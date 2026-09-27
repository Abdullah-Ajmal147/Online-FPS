import { expect, test } from '@playwright/test';

/** The Help screen: how to play, from the game's own data, with a way to contact us. */
test('Help explains controls, modes, weapons and problems, and leads to feedback', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('/');
  await page.getByTestId('nav-help').click();
  await expect(page.getByTestId('help')).toBeVisible();

  await page.getByTestId('help-tab-controls').click();
  await expect(page.getByTestId('help-controls')).toContainText('Move forward');
  await expect(page.getByTestId('help-controls')).toContainText('W');

  await page.getByTestId('help-tab-modes').click();
  await expect(page.getByTestId('help-mode-domination')).toContainText('first to 200 points');

  await page.getByTestId('help-tab-weapons').click();
  await expect(page.getByTestId('help-weapons')).toContainText('Kestrel AR');

  await page.getByTestId('help-tab-problems').click();
  await expect(page.getByTestId('help-faq')).toContainText('touchpad');

  await page.getByTestId('help-tab-contact').click();
  await page.getByTestId('help-feedback').click();
  await expect(page.getByTestId('feedback')).toBeVisible();
  expect(errors).toEqual([]);
});
