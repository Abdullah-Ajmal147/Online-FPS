import { expect, test } from '@playwright/test';

test('client renders and connects to the match room', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await expect(page.getByTestId('net-status')).toHaveText('connected, protocol v1');
  await expect(page.getByTestId('render-backend')).toHaveText(/renderer: (WebGPU|WebGL 2)/);
  expect(errors).toEqual([]);
});
