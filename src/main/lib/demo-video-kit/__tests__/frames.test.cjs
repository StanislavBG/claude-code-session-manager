'use strict';
import { describe, it, expect } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sampleFrames, decodePng, encodePng, lumaStats, MAX_FRAMES, viewportForHtml } = require('../frames.cjs');
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

// Fake Playwright: answers each page.evaluate by the function it is handed.
function fakePlaywright({ boxes, smDemo }) {
  const calls = { viewport: null, seeks: [] };
  const png = encodePng(4, 4, solid(4, 4, [200, 100, 50]));
  const page = {
    setDefaultTimeout() {},
    async goto() {},
    async screenshot() { return png; },
    async evaluate(fn, arg) {
      if (fn.name === 'collectTextBoxes') { expect(arg).toBe(60); return boxes; }
      const src = String(fn);
      if (src.includes('d.beats')) return { beats: smDemo.beats ?? null, cuts: smDemo.cuts ?? null };
      if (src.includes('d.seek')) calls.seeks.push(arg);
      return undefined;
    },
  };
  const pw = { chromium: { async launch() { return { async newPage(o) { calls.viewport = o.viewport; return page; }, async close() {} }; } } };
  return { pw, calls };
}

describe('sampleFrames textBoxes + beats/cuts (injected playwright)', () => {
  it('returns normalized textBoxes per frame and window.smDemo beats/cuts; 9:16 -> 1080x1920', async () => {
    const dir = tmp();
    const html = path.join(dir, 'v.html');
    fs.writeFileSync(html, '<meta name="sm-demo-aspect" content="9:16"><p>x</p>');
    const long = 'y'.repeat(80);
    const { pw, calls } = fakePlaywright({
      boxes: [{ text: long, x: 0.1, y: 0.2, w: 0.5, h: 0.05 }],
      smDemo: { beats: { hook: 1, payoff: 8, loop: 9.5 }, cuts: [2, 4, 6] },
    });
    const r = await sampleFrames({ htmlPath: html, lengthS: 1, stepS: 0.5, outDir: dir, loadPlaywright: () => pw });
    expect(calls.viewport).toEqual({ width: 1080, height: 1920 });
    expect(calls.seeks).toEqual([0, 0.5, 1]);
    expect(r.frames).toHaveLength(3);
    expect(r.frames[0].textBoxes).toEqual([{ text: 'y'.repeat(60), x: 0.1, y: 0.2, w: 0.5, h: 0.05 }]);
    expect(r.frames[0].lumaMean).toBeGreaterThan(0);
    expect(r.beats).toEqual({ hook: 1, payoff: 8, loop: 9.5 });
    expect(r.cuts).toEqual([2, 4, 6]);
  });
  it('beats/cuts are null when absent and a non-9:16 document keeps 1280x720', async () => {
    const dir = tmp();
    const html = path.join(dir, 'v.html');
    fs.writeFileSync(html, '<meta name="sm-demo-aspect" content="16:9"><p>x</p>');
    const { pw, calls } = fakePlaywright({ boxes: [], smDemo: {} });
    const r = await sampleFrames({ htmlPath: html, lengthS: 0.5, stepS: 0.5, outDir: dir, loadPlaywright: () => pw });
    expect(calls.viewport).toEqual({ width: 1280, height: 720 });
    expect(r.beats).toBeNull();
    expect(r.cuts).toBeNull();
    expect(r.frames[0].textBoxes).toEqual([]);
  });
  it('viewportForHtml reads either meta attribute order', () => {
    expect(viewportForHtml('<meta content="9:16" name="sm-demo-aspect">')).toEqual({ width: 1080, height: 1920 });
    expect(viewportForHtml('<p>none</p>')).toEqual({ width: 1280, height: 720 });
  });
  it.skipIf(!havePlaywright())('real chromium: collects visible text boxes only', async () => {
    const dir = tmp();
    const html = path.join(dir, 'v.html');
    fs.writeFileSync(html, `<!doctype html><meta name="sm-demo-aspect" content="9:16"><body style="margin:0">
<div style="position:absolute;left:108px;top:192px;width:540px;height:96px">Hello there</div>
<div style="display:none">Gone</div><div style="visibility:hidden">Hidden</div><div style="opacity:0">Clear</div>
<script>window.smDemo={scenes:[],beats:{hook:1},cuts:[1],pause(){},seek(){}};</script>`);
    const r = await sampleFrames({ htmlPath: html, lengthS: 0.5, stepS: 0.5, outDir: dir });
    if (r.skipped) return;
    expect(r.frames[0].textBoxes.map((b) => b.text)).toEqual(['Hello there']);
    expect(r.frames[0].textBoxes[0]).toMatchObject({ x: 0.1, y: 0.1, w: 0.5, h: 0.05 });
    expect(r.beats).toEqual({ hook: 1 });
    expect(r.cuts).toEqual([1]);
  }, 120000);
});
