// Renders the link-preview image (og.png) from og-card.html with headless Chrome.
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(`file://${here}og-card.html`);
await page.screenshot({ path: `${here}../../apps/client/public/og.png` });
await browser.close();
