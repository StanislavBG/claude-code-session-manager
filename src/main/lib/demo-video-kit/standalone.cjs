'use strict';
// Demo-video kit standalone check: load one built demo-video HTML file in headless Chromium the
// way bilko.run embeds a Blog post video (sandboxed iframe mounted after a click, plus the same
// page opened top-level via "Open in new tab") and report whether it plays on its own with no
// host player. Copied standalone into ~/.claude/session-manager/demo-video-kit/, so Node builtins
// plus ./playwrightLoader.cjs only. CLI: node standalone.cjs <file.html> -> JSON array on stdout,
// exit 0 all pass, 1 any fail, 2 usage error / Playwright unavailable.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadPlaywright: defaultLoader } = require('./playwrightLoader.cjs');

// Copied verbatim from bilko.run server/security-headers.ts BLOG_VIDEO_CSP (2026-11-24).
const BLOG_VIDEO_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
const AUTOPLAY_ARG = '--autoplay-policy=document-user-activation-required';
const VIEWPORT = { width: 1280, height: 800 };
const FRAME_SIZE = { width: 960, height: 540 };
const EMBED_READS_MS = [2500, 4000];
const MAX_SCENE_S = 15;
const TAP_WINDOW_MS = 1500;
const TAP_SETTLE_MS = 1000;

class StandaloneUsageError extends Error {}

function slugFor(htmlPath) {
  const base = path.basename(htmlPath).toLowerCase() === 'index.html'
    ? path.basename(path.dirname(path.resolve(htmlPath)))
    : path.basename(htmlPath, path.extname(htmlPath));
  return String(base).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'video';
}

function parentPage(slug) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>post</title>
<style>body{margin:0;background:#fff}#cover{display:block;width:${FRAME_SIZE.width}px;height:${FRAME_SIZE.height}px;margin:20px}#slot iframe{display:block;border:0;width:${FRAME_SIZE.width}px;height:${FRAME_SIZE.height}px;margin:20px}</style>
</head><body><div id="slot"><button id="cover" type="button">Play video</button></div>
<script>
document.getElementById('cover').addEventListener('click', (e) => {
  if (!e.isTrusted) return;
  const f = document.createElement('iframe');
  f.id = 'video';
  f.setAttribute('sandbox', 'allow-scripts');
  f.setAttribute('allow', 'autoplay; fullscreen');
  f.src = '/blog-videos/${slug}/';
  const slot = document.getElementById('slot');
  slot.replaceChildren(f);
});
</script></body></html>`;
}

/** One loopback server: /blog-videos/<slug>/ = the file's bytes + BLOG_VIDEO_CSP; /post/<slug>/ = parent. */
function startServer(bytes, slug) {
  const server = http.createServer((req, res) => {
    const url = String(req.url || '').split('?')[0];
    if (url === `/blog-videos/${slug}/`) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': BLOG_VIDEO_CSP, 'Cache-Control': 'no-store' });
      res.end(bytes);
    } else if (url === `/post/${slug}/`) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(parentPage(slug));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const until = (t0, ms) => sleep(t0 + ms - Date.now());

/** Read the document's first <audio> element. */
function readAudio(target) {
  return target.evaluate(() => {
    const a = document.querySelector('audio');
    if (!a) return { present: false };
    return { present: true, paused: a.paused, muted: a.muted, volume: a.volume, currentTime: a.currentTime };
  });
}

const fmt = (s) => (s && s.present
  ? `paused=${s.paused} muted=${s.muted} volume=${s.volume} t=${Number(s.currentTime).toFixed(2)}`
  : 'no <audio> element');
const audible = (s) => !!(s && s.present && !s.paused && !s.muted && s.volume > 0);

/** Problems with two audio reads (empty = playing, unmuted and advancing). */
function audioProblems(a, b) {
  const out = [];
  if (!a || !a.present) return ['no <audio> element in the document'];
  if (!audible(a)) out.push(`first read not playing (${fmt(a)})`);
  if (!audible(b)) out.push(`second read not playing (${fmt(b)})`);
  if (!(b && b.currentTime > a.currentTime)) out.push(`currentTime did not advance (${Number(a.currentTime).toFixed(2)} -> ${Number(b && b.currentTime).toFixed(2)})`);
  return out;
}

/** Click the parent's cover, return { frame, handle, t0 } for the mounted sandboxed iframe. */
async function mountEmbed(page, base, slug) {
  await page.goto(`${base}/post/${slug}/`, { waitUntil: 'load', timeout: 30000 });
  await page.click('#cover');
  const t0 = Date.now();
  const handle = await page.waitForSelector('#video', { timeout: 10000 });
  const frame = await handle.contentFrame();
  if (!frame) throw new Error('iframe has no content frame');
  await frame.waitForLoadState('load', { timeout: 30000 });
  return { frame, handle, t0 };
}

async function embedCheck(browser, base, slug) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    const { frame, handle, t0 } = await mountEmbed(page, base, slug);
    const reads = []; const shots = [];
    for (const ms of EMBED_READS_MS) {
      await until(t0, ms);
      reads.push(await readAudio(frame));
      shots.push(await handle.screenshot({ type: 'png' }));
    }
    const problems = audioProblems(reads[0], reads[1]);
    if (shots[0].equals(shots[1])) problems.push('frame picture identical at 2.5 s and 4 s');
    return { id: 'standalone-embed', ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `plays after the click (${fmt(reads[0])} -> t=${Number(reads[1].currentTime).toFixed(2)}) and the picture moves` };
  } finally { await context.close(); }
}

async function reducedMotionCheck(browser, base, slug) {
  const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    const { frame, handle, t0 } = await mountEmbed(page, base, slug);
    const start = await frame.evaluate(() => {
      const d = window.smDemo;
      const src = d && Array.isArray(d.scenes) ? d.scenes : [];
      const e = src[1];
      const v = typeof e === 'number' ? e : (e && typeof e === 'object' ? (typeof e.t === 'number' ? e.t : e.start) : undefined);
      return typeof v === 'number' && isFinite(v) ? v : null;
    });
    if (start === null) return { id: 'standalone-reduced-motion', ok: false, detail: 'window.smDemo.scenes has no second scene start to compare across' };
    const s = Math.min(Math.max(start, 0), MAX_SCENE_S);
    const beforeS = Math.max(1, s - 1.5); const afterS = s + 1.5;
    await until(t0, beforeS * 1000);
    const a = await readAudio(frame); const before = await handle.screenshot({ type: 'png' });
    await until(t0, afterS * 1000);
    const b = await readAudio(frame); const after = await handle.screenshot({ type: 'png' });
    const problems = audioProblems(a, b);
    if (before.equals(after)) problems.push(`picture identical at ${beforeS.toFixed(1)} s and ${afterS.toFixed(1)} s (frozen across scene 2 at ${s} s)`);
    return { id: 'standalone-reduced-motion', ok: problems.length === 0, detail: problems.length ? `under prefers-reduced-motion: ${problems.join('; ')}` : `under prefers-reduced-motion it plays and cuts to scene 2 at ${s} s` };
  } finally { await context.close(); }
}

async function tapForSoundCheck(browser, base, slug) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/blog-videos/${slug}/`, { waitUntil: 'load', timeout: 30000 });
    await sleep(TAP_SETTLE_MS);
    const pre = await readAudio(page);
    if (!pre.present) return { id: 'standalone-tap-for-sound', ok: false, detail: 'no <audio> element in the document' };
    if (!pre.paused) return { id: 'standalone-tap-for-sound', ok: false, detail: `expected the audio paused before any gesture when opened top-level (${fmt(pre)})` };
    await page.mouse.click(Math.round(VIEWPORT.width / 2), Math.round(VIEWPORT.height / 2));
    const t0 = Date.now();
    let first = null; let last = pre;
    while (Date.now() - t0 <= TAP_WINDOW_MS) {
      await sleep(100);
      last = await readAudio(page);
      if (audible(last)) {
        if (first && last.currentTime > first.currentTime) {
          return { id: 'standalone-tap-for-sound', ok: true, detail: `one tap starts sound within ${Date.now() - t0} ms (${fmt(last)})` };
        }
        if (!first) first = last;
      }
    }
    return { id: 'standalone-tap-for-sound', ok: false, detail: `opened top-level, one tap did not start unmuted, advancing audio within ${TAP_WINDOW_MS} ms (${fmt(last)}); add a pointerdown/keydown fallback that calls audio.play() after a refused play()` };
  } finally { await context.close(); }
}

async function runScenario(fn, id, browser, base, slug) {
  try { return await fn(browser, base, slug); } catch (e) { return { id, ok: false, detail: `check errored: ${e && e.message ? e.message.split('\n')[0] : String(e)}` }; }
}

/**
 * Resolves to [{ id, ok, detail }] for standalone-embed, standalone-reduced-motion and
 * standalone-tap-for-sound. Rejects with StandaloneUsageError when the file is unreadable or
 * Playwright/Chromium cannot be loaded.
 */
async function checkStandalone({ htmlPath, loadPlaywright } = {}) {
  if (!htmlPath) throw new StandaloneUsageError('htmlPath is required');
  let bytes;
  try { bytes = fs.readFileSync(path.resolve(htmlPath)); } catch (e) { throw new StandaloneUsageError(`cannot read ${htmlPath}: ${e.message}`); }
  const pw = (loadPlaywright || (() => defaultLoader()))();
  const resolved = pw && typeof pw.then === 'function' ? await pw : pw;
  const chromium = resolved && resolved.chromium;
  if (!chromium) throw new StandaloneUsageError('Playwright is not installed (looked in cwd, global npm root and the npx cache)');
  const slug = slugFor(htmlPath);
  const { server, base } = await startServer(bytes, slug);
  try {
    let browser;
    try { browser = await chromium.launch({ headless: true, args: [AUTOPLAY_ARG] }); } catch (e) {
      throw new StandaloneUsageError(`Chromium could not launch: ${e && e.message ? e.message.split('\n')[0] : String(e)}`);
    }
    try {
      return [
        await runScenario(embedCheck, 'standalone-embed', browser, base, slug),
        await runScenario(reducedMotionCheck, 'standalone-reduced-motion', browser, base, slug),
        await runScenario(tapForSoundCheck, 'standalone-tap-for-sound', browser, base, slug),
      ];
    } finally { await browser.close(); }
  } finally {
    await new Promise((r) => server.close(() => r()));
  }
}

async function main(argv) {
  const file = argv[0];
  if (!file || argv.length > 1) { process.stderr.write('usage: node standalone.cjs <file.html>\n'); return 2; }
  try {
    const results = await checkStandalone({ htmlPath: file });
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return results.every((r) => r.ok) ? 0 : 1;
  } catch (e) {
    process.stderr.write(`${e && e.message ? e.message : String(e)}\n`);
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { checkStandalone, BLOG_VIDEO_CSP, AUTOPLAY_ARG, StandaloneUsageError, slugFor };
