import { expect, test, type Page } from '@playwright/test';
import { deploy } from './helpers.ts';

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
  standing: 'weapons=ar,sidearm',
  'aiming up': 'weapons=ar&pitch=0.8',
  'aiming down': 'weapons=marksman&pitch=-0.8',
  crouched: 'weapons=ar,shotgun&crouch=1',
  'crouch-walking': 'weapons=smg&crouch=1&speed=2.5',
  jogging: 'weapons=ar&speed=5',
  sprinting: 'weapons=smg&speed=7.5',
  strafing: 'weapons=ar&speed=4&dir=1.57',
  'walking backwards': 'weapons=ar&speed=3&dir=3.14',
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
  for (const weapon of ['kestrel-ar', 'wren-sp']) {
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

test('a bot match with the soldier models: models drawn, no page errors', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await deploy(page, '/?server=http://localhost:2569', { soldierModels: true });
  // Bots are near and drawn; give the models time to load and replace the simple shapes.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __sentinelRemotes: () => number[][] }).__sentinelRemotes()
              .length,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(8000);
  expect(errors).toEqual([]);
});
