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
// 256-colour palette: ~100 KB vs ~255 KB in full colour, with no visible loss (PSNR 42.6 dB). Kept by choice,
// not for a host limit: bilko.run loads og.png as its /projects hero and X fetches it for previews. Needs ImageMagick.
execFileSync('convert', [out, '-dither', 'FloydSteinberg', '-colors', '256', '-define', 'png:compression-level=9', `PNG8:${out}`]);
