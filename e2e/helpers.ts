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
    .poll(async () => (await status(page)).net.state, { timeout: 40_000 })
    .toBe('connected');
  // …and until the server has placed our soldier (inputs before that aren't sent).
  await expect
    .poll(async () => (await status(page)).spawned, { timeout: 40_000 })
    .toBe(true)
    .catch(async (e: unknown) => {
      const st = await status(page);
      console.log(
        '[deploy] not spawned:',
        JSON.stringify({
          net: st.net,
          match: st.match?.phase,
          stats: st.netStats,
          inMatch: st.inMatch,
        }),
      );
      throw e;
    });
  // DEPLOY clicked while the engine was still loading joins once it's ready, but the mouse is
  // only captured on the next click (browsers require a click): press RESUME like a player.
  // Best effort: only the focused page can capture the mouse, so with several players open
  // the others stay unfocused (they don't need it). Tests that need it check it themselves.
  if (!(await status(page)).playing) {
    await page.bringToFront();
    const play = page.getByTestId('play');
    if (await play.isVisible()) await play.click({ timeout: 5_000 }).catch(() => undefined);
  }
}

/** Release the mouse (what Esc does in a real browser): the pause menu opens. */
export async function pause(page: Page): Promise<void> {
  await page.evaluate(() => document.exitPointerLock());
  await expect(page.getByTestId('menu')).toBeVisible();
}
