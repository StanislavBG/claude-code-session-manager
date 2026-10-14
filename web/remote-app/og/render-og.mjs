// Renders og/og.html to public/og.png (1200x630) — the bilko.run listing.shareImage.
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, 'og.html')).href);
await page.evaluate(() => document.fonts.ready);
const out = join(here, '..', 'public', 'og.png');
await page.screenshot({ path: out, type: 'png' });
await browser.close();
// 256-colour palette keeps the bundle under the Bilko budget gate (~100 KB vs ~310 KB). Needs ImageMagick.
execFileSync('convert', [out, '-dither', 'FloydSteinberg', '-colors', '256', '-define', 'png:compression-level=9', `PNG8:${out}`]);
