import { expect, test, type Page } from '@playwright/test';

/**
 * Soldier models (the dev-only model lab, /lab.html): "hit where you see". The server's
 * hitboxes are fixed capsules; the drawn head must sit on the head sphere (r 0.14 m) in every
 * pose the rig can take, or players would shoot a visible head and miss.
 */
async function headOffsets(page: Page, query: string): Promise<number[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/lab.html?view=hold&${query}`);
  await page.waitForFunction(
    () => (window as unknown as { __labReady?: boolean }).__labReady,
    null,
    {
      timeout: 60_000,
    },
  );
  const text = (await page.locator('#info').textContent()) ?? '';
  expect(errors).toEqual([]);
  const offsets = [...text.matchAll(/dx (-?[\d.]+) dy (-?[\d.]+) dz (-?[\d.]+)/g)].map((m) =>
    Math.hypot(Number(m[1]), Number(m[2]), Number(m[3])),
  );
  expect(offsets.length).toBeGreaterThan(0);
  return offsets;
}

const POSES = {
  standing: 'weapons=rifle,sidearm',
  'aiming up': 'weapons=rifle&pitch=0.8',
  'aiming down': 'weapons=marksman&pitch=-0.8',
  crouched: 'weapons=rifle,shotgun&crouch=1',
  'crouch-walking': 'weapons=smg&crouch=1&speed=2.5',
  jogging: 'weapons=rifle&speed=5',
  sprinting: 'weapons=smg&speed=7.5',
  strafing: 'weapons=rifle&speed=4&dir=1.57',
  'walking backwards': 'weapons=rifle&speed=3&dir=3.14',
};

test('soldier models: the drawn head sits on the head hitbox in every pose', async ({ page }) => {
  test.setTimeout(300_000); // nine lab pages, each drawing soldiers in software
  for (const [pose, query] of Object.entries(POSES)) {
    for (const d of await headOffsets(page, query)) expect(d, pose).toBeLessThan(0.05);
  }
});

test('first-person arms and weapon models render without errors', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const weapon of ['rifle', 'sidearm']) {
    await page.goto(`/lab.html?view=fp&weapon=${weapon}&ads=1`);
    await page.waitForFunction(
      () => (window as unknown as { __labReady?: boolean }).__labReady,
      null,
      {
        timeout: 60_000,
      },
    );
  }
  expect(errors).toEqual([]);
});
