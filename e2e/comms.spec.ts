import { expect, test } from '@playwright/test';

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
