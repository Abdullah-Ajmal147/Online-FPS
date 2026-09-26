import { expect, test } from '@playwright/test';
import { deploy } from './helpers.ts';

/** Phase 8 task 7: patch notes and a feedback form that reaches the admin page. */
test('Comms screen: patch notes, and feedback reaches the admin page', async ({
  page,
  request,
}) => {
  await page.goto('/?server=http://localhost:2567');
  await page.getByTestId('nav-comms').click();
  await expect(page.getByTestId('patch-notes')).toContainText('Domination');
  const text = `The B node beam flickers ${Date.now()}`;
  await expect(page.getByTestId('feedback-send')).toBeDisabled();
  await page.getByTestId('feedback-idea').click();
  await page.getByTestId('feedback-text').fill(text);
  await page.getByTestId('feedback-send').click();
  await expect(page.getByTestId('feedback-result')).toContainText('Thank you', { timeout: 10_000 });
  await expect(page.getByTestId('feedback-text')).toHaveValue('');

  const admin = {
    authorization: `Basic ${Buffer.from('admin:e2e-admin-password').toString('base64')}`,
  };
  const rows = (await (
    await request.get('http://localhost:8787/admin/api/feedback', { headers: admin })
  ).json()) as { kind: string; text: string; context: Record<string, string> }[];
  const mine = rows.find((r) => r.text === text);
  expect(mine).toMatchObject({ kind: 'idea', context: { mode: 'team-deathmatch' } });
  expect(mine!.context.build).toMatch(/^\d+\.\d+/);
});

/** Phase 8 task 8: a played session is counted on the admin dashboard when the page closes. */
test('session beacon reaches the admin dashboard', async ({ page, browser, request }) => {
  const admin = {
    authorization: `Basic ${Buffer.from('admin:e2e-admin-password').toString('base64')}`,
  };
  const sessions = async () => {
    const s = (await (
      await request.get('http://localhost:8787/admin/api/stats', { headers: admin })
    ).json()) as { days: { sessions: number }[] };
    return s.days.at(-1)!.sessions;
  };
  const before = await sessions();
  await deploy(page, '/?server=http://localhost:2567');
  await page.waitForTimeout(2500); // a few ping samples
  await page.goto('about:blank'); // pagehide → beacon
  await expect.poll(sessions, { timeout: 10_000 }).toBeGreaterThan(before);

  // The admin page renders the numbers (no script errors).
  const ctx = await browser.newContext({
    httpCredentials: { username: 'admin', password: 'e2e-admin-password' },
  });
  const adminPage = await ctx.newPage();
  const errors: string[] = [];
  adminPage.on('pageerror', (e) => errors.push(e.message));
  await adminPage.goto('http://localhost:8787/admin');
  await expect(adminPage.locator('#health')).toContainText('D1 retention');
  await expect(adminPage.locator('#health')).toContainText('Crash-free today');
  expect(errors).toEqual([]);
  await ctx.close();
});
