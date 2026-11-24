'use strict';
// Demo-video kit capture helper: up to 6 size-budgeted screenshots and short clips of the live
// product at one URL. Playwright is resolved at runtime via playwrightLoader.cjs (cwd, global npm root,
// npx cache, or an injected loader) and is never installed here. A clip shot with no injected encoder
// is recorded with Playwright's recordVideo and transcoded by ffmpeg (no shell, bounded) to an
// H.264/yuv420p/+faststart MP4 with no audio. Node builtins only.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadPlaywright: defaultLoader } = require('./playwrightLoader.cjs');

const MAX_SHOTS = 6;
const IMAGE_BUDGET = 120 * 1024;
const CLIP_BUDGET = 280 * 1024;
const QUALITY_STEPS = [80, 65, 52, 40, 30, 20]; // at most 6 tries
const NAV_TIMEOUT_MS = 30000;
const VIEWPORT = { width: 1280, height: 720 };
const CLIP_MIN_S = 2;
const CLIP_MAX_S = 6;
const CLIP_DEFAULT_S = 4;
const CLIP_SETTLE_MS = 500;
const FFMPEG_TIMEOUT_MS = 60000;
// Step-down ladder for the default clip encoder: width, fps, then quality (crf) — at most 6 tries.
const CLIP_STEPS = Object.freeze([
  { width: 1280, fps: 30, crf: 28 },
  { width: 1280, fps: 24, crf: 32 },
  { width: 960, fps: 24, crf: 34 },
  { width: 960, fps: 20, crf: 37 },
  { width: 720, fps: 15, crf: 40 },
  { width: 640, fps: 12, crf: 44 },
]);

/** Default ffmpeg runner: no shell, bounded by a timeout. Returns spawnSync's result. */
function defaultFfmpeg(args) {
  const bin = process.env.SM_FFMPEG || 'ffmpeg';
  return spawnSync(bin, args, { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, shell: false });
}

function ffmpegFailure(r) {
  if (!r) return 'no result';
  if (r.error) return r.error.message || String(r.error);
  if (r.status !== 0) return `exit ${r.status}: ${String(r.stderr || '').slice(-300)}`;
  return null;
}

function ffmpegAvailable(run) {
  try {
    const r = run(['-hide_banner', '-version']);
    return !ffmpegFailure(r);
  } catch { return false; }
}

function clipArgs(input, output, { width, fps, crf }) {
  return ['-hide_banner', '-nostats', '-loglevel', 'error', '-y', '-i', input, '-an',
    '-vf', `fps=${fps},scale=${width}:-2:flags=lanczos`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', output];
}

/** Transcode a recorded clip, stepping width/fps/quality down until it fits; {buf} or {reason}. */
function transcodeToBudget(run, input, outFile, maxWidth, budget) {
  let lastSize = null;
  for (const step of CLIP_STEPS) {
    const width = Math.max(2, Math.min(step.width, maxWidth) & ~1);
    let r;
    try { r = run(clipArgs(input, outFile, { ...step, width })); } catch (e) { return { reason: `transcode-failed: ${e.message}` }; }
    const fail = ffmpegFailure(r);
    if (fail) return { reason: `transcode-failed: ${fail}` };
    let buf;
    try { buf = fs.readFileSync(outFile); } catch { return { reason: 'transcode-failed: no output' }; }
    if (buf.length <= budget) return { buf };
    lastSize = buf.length;
  }
  try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
  return { reason: `over-budget: smallest ${lastSize} bytes > ${budget}` };
}

function clipDuration(shot) {
  const d = Number(shot.durationS);
  if (!Number.isFinite(d)) return CLIP_DEFAULT_S;
  return Math.max(CLIP_MIN_S, Math.min(CLIP_MAX_S, d));
}

function shotViewport(shot) {
  const v = shot.viewport;
  const w = v && Number(v.width);
  const h = v && Number(v.height);
  if (w > 0 && h > 0) return { width: Math.round(w), height: Math.round(h) };
  return { ...VIEWPORT };
}

/** Scroll by `px` pixels spread over `ms`, or just hold when px is 0. */
async function scrollOver(page, px, ms) {
  const steps = px ? Math.max(1, Math.round(ms / 100)) : 0;
  if (!steps) { await page.waitForTimeout(ms); return; }
  const per = px / steps;
  for (let i = 0; i < steps; i++) {
    await page.evaluate((dy) => window.scrollBy(0, dy), per);
    await page.waitForTimeout(ms / steps);
  }
}

function scrollPx(shot) {
  const s = shot.scroll;
  if (typeof s === 'number' && Number.isFinite(s)) return s;
  if (s && typeof s === 'object' && Number.isFinite(Number(s.y))) return Number(s.y);
  return 0;
}

/** Default clip path: fresh recordVideo context, then ffmpeg to a budgeted MP4. {buf, focus} or {reason}. */
async function recordClip({ browser, url, shot, timeout, outDir, outFile, run }) {
  const viewport = shotViewport(shot);
  const durationS = clipDuration(shot);
  const tmpDir = fs.mkdtempSync(path.join(outDir, '.clip-'));
  try {
    let webm;
    let focus;
    try {
      const ctx = await browser.newContext({ viewport, recordVideo: { dir: tmpDir, size: viewport } });
      try {
        const page = await ctx.newPage();
        page.setDefaultTimeout(timeout);
        await page.goto(url, { timeout, waitUntil: 'load' });
        await page.waitForTimeout(Number(shot.waitMs) >= 0 ? Math.min(Number(shot.waitMs), 10000) : CLIP_SETTLE_MS);
        if (shot.selector) {
          try { await page.locator(shot.selector).first().scrollIntoViewIfNeeded({ timeout }); } catch { /* keep going */ }
        }
        await scrollOver(page, scrollPx(shot), durationS * 1000);
        focus = await focusFor(page, shot, viewport);
        const video = page.video && page.video();
        if (!video) throw new Error('recordVideo produced no video');
        await ctx.close(); // flushes the .webm
        webm = await video.path();
      } finally {
        await ctx.close().catch(() => {});
      }
      if (!webm || !fs.existsSync(webm)) throw new Error('recorded video file missing');
    } catch (e) {
      return { reason: `record-failed: ${e && e.message ? e.message : String(e)}` };
    }
    const out = transcodeToBudget(run, webm, outFile, viewport.width, CLIP_BUDGET);
    return out.buf ? { buf: out.buf, focus, durationS } : out;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function defaultEncode(page, { kind, quality }) {
  if (kind !== 'image') return null; // clips without an injected encoder go through recordClip
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

async function focusFor(page, shot, vp = VIEWPORT) {
  const sel = shot.focusSelector || shot.selector;
  if (sel) {
    try {
      const b = await page.locator(sel).first().boundingBox();
      if (b) return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    } catch { /* fall through to default */ }
  }
  return { x: Math.round(vp.width * 0.25), y: Math.round(vp.height * 0.25), w: Math.round(vp.width * 0.5), h: Math.round(vp.height * 0.5) };
}

async function capture({ url, outDir, shots, max = MAX_SHOTS, loadPlaywright, encode, navTimeoutMs, ffmpeg } = {}) {
  if (!url || typeof url !== 'string') return { skipped: 'no-url' };
  const pw = (loadPlaywright || (() => defaultLoader()))();
  const resolved = pw && typeof pw.then === 'function' ? await pw : pw;
  const chromium = resolved && resolved.chromium;
  if (!chromium) return { skipped: 'no-playwright' };

  const cap = Math.max(0, Math.min(Number(max) || MAX_SHOTS, MAX_SHOTS));
  const list = (Array.isArray(shots) && shots.length ? shots : [{}]).slice(0, cap);
  const enc = encode || defaultEncode;
  const timeout = Math.min(Number(navTimeoutMs) || NAV_TIMEOUT_MS, NAV_TIMEOUT_MS);
  fs.mkdirSync(outDir, { recursive: true });

  const run = ffmpeg || defaultFfmpeg;
  let hasFfmpeg = null; // probed once, on the first default-encoded clip
  const items = [];
  const dropped = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.setDefaultTimeout(timeout);
    await page.goto(url, { timeout, waitUntil: 'load' }); // the only navigation, to the given URL
    for (let i = 0; i < list.length; i++) {
      const shot = list[i] || {};
      const kind = shot.kind === 'clip' ? 'clip' : 'image';
      const num = String(i + 1).padStart(2, '0');
      if (kind === 'clip' && !encode) {
        if (hasFfmpeg === null) hasFfmpeg = ffmpegAvailable(run);
        if (!hasFfmpeg) { dropped.push({ index: i, kind, reason: 'no-ffmpeg' }); continue; }
        const file = path.join(outDir, `shot-${num}.mp4`);
        const r = await recordClip({ browser, url, shot, timeout, outDir, outFile: file, run });
        if (!r.buf) { dropped.push({ index: i, kind, reason: r.reason }); continue; }
        items.push({ file, kind, mime: 'video/mp4', bytes: r.buf.length, durationS: r.durationS, focus: r.focus });
        continue;
      }
      if (shot.selector) {
        try { await page.locator(shot.selector).first().scrollIntoViewIfNeeded({ timeout }); } catch { /* keep going */ }
      }
      const buf = await fitBudget(enc, page, kind, kind === 'image' ? IMAGE_BUDGET : CLIP_BUDGET);
      if (!buf) { dropped.push({ index: i, kind, reason: 'over-budget' }); continue; }
      const file = path.join(outDir, `shot-${num}.${kind === 'image' ? 'jpg' : 'webm'}`);
      fs.writeFileSync(file, buf);
      items.push({ file, kind, mime: kind === 'image' ? 'image/jpeg' : 'video/webm', bytes: buf.length, focus: await focusFor(page, shot) });
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { items, dropped };
}

module.exports = { capture, IMAGE_BUDGET, CLIP_BUDGET, QUALITY_STEPS, CLIP_STEPS };
