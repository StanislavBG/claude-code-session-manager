'use strict';
// Demo-video kit frame sampler: open a finished video document in headless Chromium, seek
// window.smDemo every stepS seconds, compute per-frame luma stats (input for checkBlankFrames)
// and write a contact sheet PNG for the persona to review. Playwright is resolved at runtime
// (same resolution as capture.cjs) and never installed here. Node builtins only.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const MAX_FRAMES = 120;
const VIEWPORT = { width: 1280, height: 720 };
const TILE_W = 160;
const SHEET_COLS = 8;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function tryRequire(name, paths) {
  try { return require(require.resolve(name, { paths })); } catch { return null; }
}
function globalNpmRoot() {
  try {
    const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 15000 });
    return r.status === 0 ? String(r.stdout).trim() : '';
  } catch { return ''; }
}
/** Same resolution as capture.cjs: process.cwd() first, then the global npm root. */
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

// ---- minimal PNG codec -------------------------------------------------------------------
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Decode a non-interlaced 8-bit PNG (gray, RGB, gray+alpha, RGBA) -> {width, height, channels, data}. */
function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
  let pos = 8; let ihdr = null; const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error('PNG missing IHDR');
  const width = ihdr.readUInt32BE(0); const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8]; const ctype = ihdr[9]; const interlace = ihdr[12];
  if (depth !== 8 || !CHANNELS[ctype] || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, type ${ctype}, interlace ${interlace})`);
  const ch = CHANNELS[ctype];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  if (raw.length < (stride + 1) * height) throw new Error('PNG data truncated');
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1; const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= ch ? out[dst + i - ch] : 0;
      const b = y > 0 ? out[dst - stride + i] : 0;
      const c = i >= ch && y > 0 ? out[dst - stride + i - ch] : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) {
        const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`bad PNG filter ${f}`);
      out[dst + i] = v & 255;
    }
  }
  return { width, height, channels: ch, data: out };
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, body) {
  const t = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, body])));
  return Buffer.concat([len, t, body, crc]);
}
/** Encode 8-bit RGB pixels (width*height*3) as a PNG. */
function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Rec.601 luma of every pixel (alpha ignored) -> {mean, stdDev}. */
function lumaStats(img) {
  const { width, height, channels: ch, data } = img;
  const n = width * height;
  if (!n) return { mean: 0, stdDev: 0 };
  let sum = 0; let sumSq = 0;
  for (let p = 0; p < n; p++) {
    const o = p * ch;
    const l = ch >= 3 ? 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2] : data[o];
    sum += l; sumSq += l * l;
  }
  const mean = sum / n;
  return { mean, stdDev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}

function toRgb(img, x, y) {
  const o = (y * img.width + x) * img.channels;
  return img.channels >= 3 ? [img.data[o], img.data[o + 1], img.data[o + 2]] : [img.data[o], img.data[o], img.data[o]];
}
/** Nearest-neighbour tile grid of decoded images -> PNG buffer. */
function buildContactSheet(images) {
  const cols = Math.max(1, Math.min(SHEET_COLS, images.length));
  const rows = Math.max(1, Math.ceil(images.length / cols));
  const first = images[0];
  const tileH = first ? Math.max(1, Math.round(TILE_W * first.height / first.width)) : Math.round(TILE_W * 9 / 16);
  const W = cols * TILE_W; const H = rows * tileH;
  const out = Buffer.alloc(W * H * 3);
  images.forEach((img, i) => {
    const ox = (i % cols) * TILE_W; const oy = Math.floor(i / cols) * tileH;
    for (let y = 0; y < tileH; y++) {
      const sy = Math.min(img.height - 1, Math.floor(y * img.height / tileH));
      for (let x = 0; x < TILE_W; x++) {
        const [r, g, b] = toRgb(img, Math.min(img.width - 1, Math.floor(x * img.width / TILE_W)), sy);
        const o = ((oy + y) * W + ox + x) * 3;
        out[o] = r; out[o + 1] = g; out[o + 2] = b;
      }
    }
  });
  return encodePng(W, H, out);
}

/**
 * Seek the video document every stepS seconds and report per-frame luma spread.
 * Returns {frames:[{t, lumaStdDev, lumaStddev}], contactSheet} | {skipped} | {error}.
 * `lumaStddev` mirrors `lumaStdDev` because checkBlankFrames reads that spelling.
 */
async function sampleFrames({ htmlPath, lengthS, stepS = 0.5, outDir, loadPlaywright } = {}) {
  const length = Number(lengthS); const step = Number(stepS);
  if (!htmlPath || !outDir || !(length > 0) || !(step > 0)) return { error: 'htmlPath, outDir, lengthS > 0 and stepS > 0 are required' };
  const count = Math.floor(length / step + 1e-9) + 1;
  if (count > MAX_FRAMES) return { error: `refused: ${count} frames exceeds the ${MAX_FRAMES} frame cap` };
  const pw = (loadPlaywright || defaultLoader)();
  const resolved = pw && typeof pw.then === 'function' ? await pw : pw;
  const chromium = resolved && resolved.chromium;
  if (!chromium) return { skipped: 'no-playwright' };

  fs.mkdirSync(outDir, { recursive: true });
  const frames = []; const images = [];
  let browser;
  try { browser = await chromium.launch({ headless: true }); } catch { return { skipped: 'no-playwright' }; } // package without a browser binary
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.setDefaultTimeout(30000);
    await page.goto(pathToFileURL(path.resolve(htmlPath)).href, { timeout: 30000, waitUntil: 'load' });
    await page.evaluate(() => { const d = window.smDemo; if (d && typeof d.pause === 'function') d.pause(); });
    for (let i = 0; i < count; i++) {
      const t = Math.round(i * step * 1000) / 1000;
      await page.evaluate((s) => { const d = window.smDemo; if (d && typeof d.seek === 'function') d.seek(s); }, t);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const img = decodePng(await page.screenshot({ type: 'png' }));
      const { stdDev } = lumaStats(img);
      const v = Math.round(stdDev * 100) / 100;
      frames.push({ t, lumaStdDev: v, lumaStddev: v });
      images.push(img);
    }
  } finally {
    await browser.close();
  }
  const contactSheet = path.join(outDir, 'contact-sheet.png');
  fs.writeFileSync(contactSheet, buildContactSheet(images));
  return { frames, contactSheet };
}

module.exports = { MAX_FRAMES, sampleFrames, decodePng, encodePng, lumaStats, buildContactSheet };
