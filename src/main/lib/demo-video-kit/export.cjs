'use strict';
// Demo-video kit exporter: render a finished self-contained video document frame by frame in
// headless Chromium (window.smDemo.seek(i / fps), never real-time playback), pipe the PNG frames
// into ffmpeg (image2pipe) muxed with the soundtrack, write outDir/video.mp4 (H.264 yuv420p
// +faststart, AAC) and outDir/poster.png, then verify the MP4 with ffprobe. Playwright is
// resolved at runtime (shared playwrightLoader.cjs). Node builtins + this folder only; no shell.
// CLI: node export.cjs spec.json -> prints the JSON result; exit 0 ok, 1 failed export, 2 bad input.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { loadPlaywright: defaultLoader } = require('./playwrightLoader.cjs');

const FFMPEG = process.env.SM_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.SM_FFPROBE || 'ffprobe';
const TIMEOUT_MS = 600000;
const DURATION_TOLERANCE_S = 0.2;
const SIZE_16_9 = { width: 1920, height: 1080 };
const SIZE_9_16 = { width: 1080, height: 1920 };

/** Export size from the document's sm-demo-aspect meta: 9:16 -> 1080x1920, else 1920x1080. */
function sizeForHtml(html) {
  const h = String(html || '');
  const m = h.match(/<meta[^>]*name=["']sm-demo-aspect["'][^>]*content=["']([^"']*)["']/i)
    || h.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']sm-demo-aspect["']/i);
  return m && m[1].replace(/\s+/g, '') === '9:16' ? { ...SIZE_9_16 } : { ...SIZE_16_9 };
}

/** ffmpeg argv: PNG frames on stdin + audio file -> H.264/AAC MP4 of exactly lengthS seconds. */
function ffmpegArgs({ fps, audioPath, lengthS, mp4Path }) {
  return [
    '-hide_banner', '-nostats', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', 'pipe:0',
    '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k',
    '-t', String(lengthS),
    '-movflags', '+faststart',
    mp4Path,
  ];
}

function ffprobeArgs(file) {
  return ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file];
}

/**
 * Default ffmpeg runner: spawn without a shell, stream every Buffer from the async iterable
 * `input` into stdin (respecting backpressure), resolve with stderr on exit 0. Rejects when
 * ffmpeg cannot start, exits non-zero, exceeds the timeout, or `input` throws.
 */
function runFfmpegDefault(args, { input, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const child = spawnFn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'], shell: false });
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { try { child.kill('SIGKILL'); } catch { /* gone */ } reject(err); } else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`ffmpeg timed out after ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
    child.on('error', (e) => finish(new Error(`ffmpeg failed to run: ${e.message}`)));
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.stdin.on('error', () => { /* EPIPE: the exit code reports the cause */ });
    child.on('close', (code) => {
      if (code === 0) finish(null, stderr);
      else finish(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`));
    });
    (async () => {
      if (input) {
        for await (const buf of input) {
          if (settled) return;
          if (!child.stdin.write(buf)) {
            // Wait for drain or close, then drop BOTH listeners so none accumulate per frame.
            await new Promise((r) => {
              const done = () => { child.stdin.off('drain', done); child.off('close', done); r(); };
              child.stdin.once('drain', done);
              child.once('close', done);
            });
          }
        }
      }
      child.stdin.end();
    })().catch((e) => finish(e));
  });
}

/** Default ffprobe runner: returns stdout (JSON text). Throws when ffprobe cannot run or fails. */
function runFfprobeDefault(args) {
  const r = spawnSync(FFPROBE, args, { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, shell: false });
  if (r.error) throw new Error(`ffprobe failed to run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffprobe exited ${r.status}: ${String(r.stderr).slice(-600)}`);
  return String(r.stdout || '');
}

/** Compare ffprobe JSON against the expected export -> {ok, detail, durationS}. */
function verifyProbe(probe, { width, height, lengthS }) {
  const streams = Array.isArray(probe && probe.streams) ? probe.streams : [];
  const v = streams.find((s) => s && s.codec_type === 'video');
  const a = streams.find((s) => s && s.codec_type === 'audio');
  const problems = [];
  if (!v) problems.push('no video stream');
  else {
    if (v.codec_name !== 'h264') problems.push(`video codec ${v.codec_name}, expected h264`);
    if (Number(v.width) !== width || Number(v.height) !== height) problems.push(`size ${v.width}x${v.height}, expected ${width}x${height}`);
  }
  if (!a) problems.push('no audio stream');
  else if (a.codec_name !== 'aac') problems.push(`audio codec ${a.codec_name}, expected aac`);
  const durationS = Number((probe && probe.format && probe.format.duration) ?? (v && v.duration));
  if (!Number.isFinite(durationS)) problems.push('duration unknown');
  else if (Math.abs(durationS - lengthS) > DURATION_TOLERANCE_S + 1e-9) problems.push(`duration ${durationS} s, expected ${lengthS} s (±${DURATION_TOLERANCE_S} s)`);
  return problems.length
    ? { ok: false, detail: `ffprobe verification failed: ${problems.join('; ')}`, durationS }
    : { ok: true, detail: `h264+aac ${width}x${height}, ${durationS} s`, durationS };
}

const fail = (error) => ({ ok: false, error, check: { id: 'export', ok: false, detail: error } });
const errMsg = (e) => (e && e.message) || String(e);

/**
 * Export a video document + soundtrack to outDir/video.mp4 and outDir/poster.png.
 * runFfmpeg(args, {input}) receives an async iterable of PNG Buffers for stdin;
 * runFfprobe(args) returns ffprobe's JSON stdout. Both may be sync or async.
 * Returns {ok:true, mp4Path, posterPath, width, height, durationS, check} | {ok:false, error, check}.
 */
async function exportVideo({ htmlPath, lengthS, audioPath, outDir, fps = 30, posterAtS, loadPlaywright, runFfmpeg = runFfmpegDefault, runFfprobe = runFfprobeDefault } = {}) {
  const length = Number(lengthS); const rate = Number(fps);
  if (!htmlPath || !audioPath || !outDir || !(length > 0) || !(rate > 0)) return fail('htmlPath, audioPath, outDir, lengthS > 0 and fps > 0 are required');
  const posterT = posterAtS == null ? Math.min(3, length / 2) : Number(posterAtS);
  if (!(posterT >= 0 && posterT <= length)) return fail(`posterAtS must be within 0..${length}`);
  let html;
  try { html = fs.readFileSync(path.resolve(htmlPath), 'utf8'); } catch (e) { return fail(`cannot read htmlPath: ${errMsg(e)}`); }
  if (!fs.existsSync(path.resolve(audioPath))) return fail(`audioPath not found: ${audioPath}`);

  let chromium;
  try {
    const pw = (loadPlaywright || (() => defaultLoader()))();
    const resolved = pw && typeof pw.then === 'function' ? await pw : pw;
    chromium = resolved && resolved.chromium;
  } catch (e) { return fail(`playwright failed to load: ${errMsg(e)}`); }
  if (!chromium) return fail('playwright not found (no-playwright)');

  const { width, height } = sizeForHtml(html);
  const frameCount = Math.round(length * rate);
  const out = path.resolve(outDir);
  const mp4Path = path.join(out, 'video.mp4');
  const posterPath = path.join(out, 'poster.png');
  const cleanup = () => { for (const f of [mp4Path, posterPath]) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } } };

  let browser;
  try {
    fs.mkdirSync(out, { recursive: true });
    cleanup();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(30000);
    await page.goto(pathToFileURL(path.resolve(htmlPath)).href, { timeout: 30000, waitUntil: 'load' });
    await page.evaluate(() => { const d = window.smDemo; if (d && typeof d.pause === 'function') d.pause(); });
    const seekTo = async (t) => {
      await page.evaluate((s) => {
        const d = window.smDemo;
        if (!d || typeof d.seek !== 'function') throw new Error('window.smDemo.seek is missing');
        d.seek(s);
      }, t);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    };
    async function* frames() {
      for (let i = 0; i < frameCount; i++) {
        await seekTo(i / rate);
        yield await page.screenshot({ type: 'png' });
      }
    }
    await runFfmpeg(ffmpegArgs({ fps: rate, audioPath: path.resolve(audioPath), lengthS: length, mp4Path }), { input: frames() });
    await seekTo(posterT);
    await page.screenshot({ type: 'png', path: posterPath });
  } catch (e) {
    cleanup();
    return fail(errMsg(e));
  } finally {
    if (browser) { try { await browser.close(); } catch { /* already gone */ } }
  }

  let probe;
  try {
    const text = await runFfprobe(ffprobeArgs(mp4Path));
    probe = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (e) {
    cleanup();
    return fail(`ffprobe: ${errMsg(e)}`);
  }
  const v = verifyProbe(probe, { width, height, lengthS: length });
  if (!v.ok) { cleanup(); return fail(v.detail); }
  return { ok: true, mp4Path, posterPath, width, height, durationS: v.durationS, check: { id: 'export', ok: true, detail: v.detail } };
}

module.exports = { exportVideo, runFfmpegDefault, sizeForHtml, ffmpegArgs, ffprobeArgs, verifyProbe, DURATION_TOLERANCE_S, TIMEOUT_MS };

if (require.main === module) {
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    if (!spec || typeof spec !== 'object') throw new Error('spec must be a JSON object');
  } catch (e) {
    process.stderr.write(`export: ${e.message}\n`);
    process.exit(2);
  }
  exportVideo(spec).then((r) => {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.ok ? 0 : 1);
  }, (e) => {
    process.stdout.write(JSON.stringify(fail(errMsg(e)), null, 2) + '\n');
    process.exit(1);
  });
}
