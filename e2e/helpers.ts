import { expect, type Page } from '@playwright/test';

/** The game's status store, read in the page. */
export const status = (page: Page) =>
  page.evaluate(async () => (await import('/src/store.ts')).getStatus());

/**
 * Open the game and press DEPLOY (the main menu joins nothing by itself), then wait until the
 * match connection is up. The click captures the mouse, so the menu closes, like for a player.
 */
export async function deploy(page: Page, url = '/'): Promise<void> {
  // A page error here would otherwise only show up as a timeout below.
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('GL Driver')) console.log('[console]', m.text());
  });
  await page.goto(url);
  await page.getByTestId('play').click();
  await expect
    .poll(async () => (await status(page)).net.state, { timeout: 20_000 })
    .toBe('connected');
  // …and until the server has placed our soldier (inputs before that aren't sent).
  await expect.poll(async () => (await status(page)).spawned, { timeout: 10_000 }).toBe(true);
}

/** Release the mouse (what Esc does in a real browser): the pause menu opens. */
export async function pause(page: Page): Promise<void> {
  await page.evaluate(() => document.exitPointerLock());
  await expect(page.getByTestId('menu')).toBeVisible();
}
