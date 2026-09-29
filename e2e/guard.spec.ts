import { expect, test } from '@playwright/test';
import { deploy, pause } from './helpers.ts';

/**
 * Ctrl+W can't be blocked in a normal browser window, so in a match closing the tab asks
 * first ("Leave site?"). Leaving through the menu doesn't ask. (Fullscreen + keyboard lock,
 * the other half, needs a real browser window: not testable headless.)
 */
test('in a match, closing the tab asks first; Leave match does not', async ({ page }) => {
  await deploy(page, '/?server=http://localhost:2571&leaveguard');
  const dialog = new Promise<string>((resolve) =>
    page.once('dialog', (d) => {
      resolve(d.type());
      void d.dismiss(); // "Stay on page"
    }),
  );
  await page.close({ runBeforeUnload: true });
  expect(await dialog).toBe('beforeunload');
});

test('leaving through the menu does not ask', async ({ page }) => {
  await deploy(page, '/?server=http://localhost:2571&leaveguard');
  let asked = false;
  page.on('dialog', (d) => {
    asked = true;
    void d.accept();
  });
  await pause(page);
  await page.getByTestId('leave').click();
  await expect(page.getByTestId('play')).toContainText('Deploy', { timeout: 15_000 });
  expect(asked).toBe(false);
});
