'use strict';
import { describe, it, expect } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sampleFrames, decodePng, encodePng, lumaStats, MAX_FRAMES } = require('../frames.cjs');
const { checkBlankFrames } = require('../checks.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'frames-'));
const solid = (w, h, rgb) => { const b = Buffer.alloc(w * h * 3); for (let i = 0; i < w * h; i++) rgb.forEach((v, k) => { b[i * 3 + k] = v; }); return b; };

function havePlaywright() {
  for (const n of ['playwright', 'playwright-core']) {
    try { require.resolve(n, { paths: [process.cwd()] }); return true; } catch { /* next */ }
  }
  return false;
}

describe('png decoder + luma', () => {
  it('round-trips an RGB PNG', () => {
    const rgb = solid(4, 3, [10, 20, 30]);
    const img = decodePng(encodePng(4, 3, rgb));
    expect([img.width, img.height, img.channels]).toEqual([4, 3, 3]);
    expect(img.data.equals(rgb)).toBe(true);
  });
  it('rejects non-PNG input', () => {
    expect(() => decodePng(Buffer.from('nope'))).toThrow();
  });
  it('flat frame has zero spread, a two-tone frame does not', () => {
    expect(lumaStats(decodePng(encodePng(8, 8, solid(8, 8, [0, 0, 0])))).stdDev).toBe(0);
    const half = Buffer.concat([solid(8, 4, [0, 0, 0]), solid(8, 4, [255, 255, 255])]);
    const s = lumaStats(decodePng(encodePng(8, 8, half)));
    expect(s.mean).toBeCloseTo(127.5, 0);
    expect(s.stdDev).toBeCloseTo(127.5, 0);
  });
});

describe('sampleFrames', () => {
  it('refuses more than the frame cap', async () => {
    const r = await sampleFrames({ htmlPath: 'x.html', lengthS: 100, stepS: 0.5, outDir: tmp(), loadPlaywright: () => null });
    expect(MAX_FRAMES).toBe(120);
    expect(r.error).toMatch(/refused/);
  });
  it('skips cleanly without playwright', async () => {
    const r = await sampleFrames({ htmlPath: 'x.html', lengthS: 2, outDir: tmp(), loadPlaywright: () => null });
    expect(r).toEqual({ skipped: 'no-playwright' });
  });
  it.skipIf(!havePlaywright())('flags the blank scene of a two-scene fixture', async () => {
    const dir = tmp();
    const html = path.join(dir, 'v.html');
    fs.writeFileSync(html, `<!doctype html><meta name="sm-demo-duration" content="2"><body style="margin:0;background:#000">
<div id="a" style="position:absolute;inset:0;background:linear-gradient(90deg,#fff,#f00,#00f,#0f0)"></div>
<script>window.smDemo={scenes:[],duration:2,pause(){},play(){},seek(t){document.getElementById('a').style.display=t<1?'block':'none'}};</script>`);
    const r = await sampleFrames({ htmlPath: html, lengthS: 2, stepS: 0.5, outDir: dir });
    if (r.skipped) return; // package present but no browser binary
    expect(r.frames).toHaveLength(5);
    expect(fs.existsSync(r.contactSheet)).toBe(true);
    expect(decodePng(fs.readFileSync(r.contactSheet)).width).toBeGreaterThan(0);
    expect(r.frames[0].lumaStdDev).toBeGreaterThan(10);
    expect(checkBlankFrames(r.frames).ok).toBe(false);
  }, 120000);
});
