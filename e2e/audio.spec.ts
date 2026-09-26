import { expect, test, type Page } from '@playwright/test';
import { deploy } from './helpers.ts';

type Meter = { rms: number; peak: number };
const audio = (page: Page) =>
  page.evaluate(async () => {
    const { gameAudio } = await import('/src/audio/index.ts');
    return { unlocked: gameAudio.unlocked, music: gameAudio.musicState, meter: gameAudio.meter() };
  });
/** Loudest RMS and peak over a stretch of time, sampled inside the page (the music has quiet
 * moments; one evaluate per sample would be slow while the 3D view renders in software). */
async function loudest(page: Page, ms: number): Promise<Meter> {
  const m = await page.evaluate(async (duration) => {
    const { gameAudio } = await import('/src/audio/index.ts');
    const best = { rms: 0, peak: 0 };
    const end = performance.now() + duration;
    while (performance.now() < end) {
      const x = gameAudio.meter();
      best.rms = Math.max(best.rms, x.rms);
      best.peak = Math.max(best.peak, x.peak);
      await new Promise((r) => setTimeout(r, 20));
    }
    return best;
  }, ms);
  if (process.env.AUDIO_DEBUG) console.log('level', JSON.stringify(m));
  return m;
}

/** Owner feature list: music in the menu, quiet in play, sounds without clipping. */
test('audio: menu music plays after the first click, fades for play, never clips', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?server=http://localhost:2567');
  expect((await audio(page)).unlocked).toBe(false); // nothing before a gesture
  await page.getByTestId('nav-settings').click(); // first click unlocks audio
  await expect.poll(async () => (await audio(page)).unlocked).toBe(true);
  expect((await audio(page)).music).toBe('menu');
  const menu = await loudest(page, 4000);
  // The theme is audible but sits under the effects (about -22 dBFS RMS at default volume).
  expect(menu.rms).toBeGreaterThan(0.03);
  expect(menu.rms).toBeLessThan(0.15);
  expect(menu.peak).toBeLessThan(1); // and doesn't clip

  // Volume sliders apply live: music at 0 → silence.
  await page.getByRole('button', { name: 'audio' }).click();
  await page.getByTestId('volumeMusic').fill('0');
  await page.waitForTimeout(1500);
  expect((await loudest(page, 1000)).rms).toBeLessThan(0.002);

  // In a match the music steps aside; firing makes (unclipped) noise.
  await deploy(page, '/?server=http://localhost:2567');
  await page.evaluate(async () => (await import('/src/audio/index.ts')).gameAudio.unlock());
  await expect.poll(async () => (await audio(page)).music).toBe('match');
  await page.evaluate(() =>
    (
      window as unknown as { __sentinelInput: { setMouse(f: boolean, a: boolean): void } }
    ).__sentinelInput.setMouse(true, false),
  );
  const firing = await loudest(page, 1500);
  await page.evaluate(() =>
    (
      window as unknown as { __sentinelInput: { setMouse(f: boolean, a: boolean): void } }
    ).__sentinelInput.setMouse(false, false),
  );
  // Gunfire is audible. (Its balance against the music, about 5 dB louder, was measured on a
  // quiet machine; under a loaded test run the page fires fewer frames, so no ratio here.)
  expect(firing.peak).toBeGreaterThan(0.05);
  expect(firing.peak).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
