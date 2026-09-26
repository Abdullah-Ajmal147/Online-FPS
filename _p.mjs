import { chromium } from '@playwright/test';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
await p.goto('http://192.168.100.73:5173/');
await p.getByTestId('play').click();
await p.waitForFunction(async () => (await import('/src/store.ts')).getStatus().spawned, null, {
  timeout: 30000,
});
await p.keyboard.press('Escape');
await p.waitForTimeout(800);
await p.screenshot({ path: process.argv[2] });
const box = async (sel) => JSON.stringify(await p.locator(sel).first().boundingBox());
console.log(
  'header',
  await box('.menu-top'),
  'squad',
  await box('[data-testid=nav-squad]'),
  'playing',
  await p.evaluate(async () => (await import('/src/store.ts')).getStatus().playing),
);
await b.close();
