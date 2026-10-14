// Renders og/og.html to public/og.png (1200x630) — the bilko.run listing.shareImage.
import { chromium } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, 'og.html')).href);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(here, '..', 'public', 'og.png'), type: 'png' });
await browser.close();
