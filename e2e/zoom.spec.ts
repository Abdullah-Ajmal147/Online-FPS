import { expect, test } from '@playwright/test';
import { deploy } from './helpers.ts';

type DevInput = { setMouse(f: boolean, a: boolean): void; zoom(steps: number): void };
const dev = (page: import('@playwright/test').Page, fn: (i: DevInput) => void) =>
  page.evaluate(`(${fn.toString()})(window.__sentinelInput)`);

/** Aiming zooms by the weapon's levels; the wheel steps through them while aiming. */
test('aim zoom: the wheel steps through the rifle zoom levels while aiming', async ({ page }) => {
  await deploy(page, '/?server=http://localhost:2571');
  const label = page.getByTestId('zoom-level');
  await expect(label).not.toHaveClass(/\bon\b/);
  await dev(page, (i) => i.setMouse(false, true)); // hold right click
  await expect(label).toHaveClass(/\bon\b/);
  await expect(label).toHaveText('1.25×');
  await dev(page, (i) => i.zoom(1));
  await expect(label).toHaveText('1.6×');
  await dev(page, (i) => i.zoom(5)); // past the last level: stays at the top
  await expect(label).toHaveText('2×');
  await dev(page, (i) => i.zoom(-1));
  await expect(label).toHaveText('1.6×');
  await dev(page, (i) => i.setMouse(false, false)); // let go: back to the normal view
  await expect(label).not.toHaveClass(/\bon\b/);
});
