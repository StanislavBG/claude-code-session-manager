'use strict';
// Demo-video kit capture helper: up to 6 size-budgeted screenshots (and optional short clips)
// of the live product at one URL. Playwright is resolved at runtime (cwd, then global npm
// root, or an injected loader) and is never installed here. Node builtins only.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_SHOTS = 6;
const IMAGE_BUDGET = 120 * 1024;
const CLIP_BUDGET = 280 * 1024;
const QUALITY_STEPS = [80, 65, 52, 40, 30, 20]; // at most 6 tries
const NAV_TIMEOUT_MS = 30000;
const VIEWPORT = { width: 1280, height: 720 };

function tryRequire(name, paths) {
  try {
    return require(require.resolve(name, { paths }));
  } catch {
    return null;
  }
}

function globalNpmRoot() {
  try {
    const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 15000 });
    return r.status === 0 ? String(r.stdout).trim() : '';
  } catch {
    return '';
  }
}

/** Default loader: process.cwd() first, then the global npm root. Never installs. */
function defaultLoader() {
  for (const name of ['playwright', 'playwright-core']) {
    const m = tryRequire(name, [process.cwd()]);
    if (m) return m;
  }
  const root = globalNpmRoot();
  if (root) {
    for (const name of ['playwright', 'playwright-core']) {
      const m = tryRequire(name, [root]);
      if (m) return m;
    }
  }
  return null;
}

async function defaultEncode(page, { kind, quality }) {
  if (kind !== 'image') return null; // clips need an injected encoder; dropped otherwise
  return page.screenshot({ type: 'jpeg', quality });
}

/** Step quality down (<= 6 tries) until the buffer fits the budget; null when it never does. */
async function fitBudget(encode, page, kind, budget) {
  const steps = kind === 'image' ? QUALITY_STEPS : [QUALITY_STEPS[0], QUALITY_STEPS[2], QUALITY_STEPS[4]];
  for (let i = 0; i < steps.length && i < 6; i++) {
    const buf = await encode(page, { kind, quality: steps[i] });
    if (!buf) return null;
    if (buf.length <= budget) return buf;
  }
  return null;
}

async function focusFor(page, shot) {
  const sel = shot.focusSelector || shot.selector;
  if (sel) {
    try {
      const b = await page.locator(sel).first().boundingBox();
      if (b) return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    } catch { /* fall through to default */ }
  }
  return { x: Math.round(VIEWPORT.width * 0.25), y: Math.round(VIEWPORT.height * 0.25), w: Math.round(VIEWPORT.width * 0.5), h: Math.round(VIEWPORT.height * 0.5) };
}

async function capture({ url, outDir, shots, max = MAX_SHOTS, loadPlaywright, encode, navTimeoutMs } = {}) {
  if (!url || typeof url !== 'string') return { skipped: 'no-url' };
  const pw = (loadPlaywright || defaultLoader)();
  const resolved = pw && typeof pw.then === 'function' ? await pw : pw;
  const chromium = resolved && resolved.chromium;
  if (!chromium) return { skipped: 'no-playwright' };

  const cap = Math.max(0, Math.min(Number(max) || MAX_SHOTS, MAX_SHOTS));
  const list = (Array.isArray(shots) && shots.length ? shots : [{}]).slice(0, cap);
  const enc = encode || defaultEncode;
  const timeout = Math.min(Number(navTimeoutMs) || NAV_TIMEOUT_MS, NAV_TIMEOUT_MS);
  fs.mkdirSync(outDir, { recursive: true });

  const items = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.setDefaultTimeout(timeout);
    await page.goto(url, { timeout, waitUntil: 'load' }); // the only navigation, to the given URL
    for (let i = 0; i < list.length; i++) {
      const shot = list[i] || {};
      const kind = shot.kind === 'clip' ? 'clip' : 'image';
      if (shot.selector) {
        try { await page.locator(shot.selector).first().scrollIntoViewIfNeeded({ timeout }); } catch { /* keep going */ }
      }
      const buf = await fitBudget(enc, page, kind, kind === 'image' ? IMAGE_BUDGET : CLIP_BUDGET);
      if (!buf) continue;
      const file = path.join(outDir, `shot-${String(i + 1).padStart(2, '0')}.${kind === 'image' ? 'jpg' : 'webm'}`);
      fs.writeFileSync(file, buf);
      items.push({ file, kind, bytes: buf.length, focus: await focusFor(page, shot) });
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { items };
}

module.exports = { capture, IMAGE_BUDGET, CLIP_BUDGET, QUALITY_STEPS };
