'use strict';
import { describe, it, expect, afterAll } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkStandalone, BLOG_VIDEO_CSP } = require('../standalone.cjs');
const { injectCsp } = require('../../feedback-remote/projectHomeAdminRoutes.cjs');
const { injectPlayerBridge } = require('../../project-pages/playerBridge.cjs');
const { usePlaywrightCache, havePlaywright } = require('./playwrightTestEnv.cjs');

usePlaywrightCache();

const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** 8 s mono 8-bit 8 kHz 440 Hz sine WAV as a data: URI. */
function toneUri() {
  const rate = 8000; const n = rate * 8;
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(60 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return `data:audio/wav;base64,${b.toString('base64')}`;
}

// Arrow functions only: the save route's scanner rejects the Function( pattern.
function fixture({ freezeUnderReducedMotion = false, gestureFallback = true } = {}) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="sm-demo-duration" content="30">
<style>html,body{margin:0;height:100%;overflow:hidden}#s{position:absolute;inset:0;color:#fff;font:72px sans-serif;display:flex;align-items:center;justify-content:center}#bar{position:absolute;left:0;bottom:0;height:30px;width:0;background:#fff}</style>
</head><body><div id="s"></div><div id="bar"></div><audio id="a" loop src="${toneUri()}"></audio>
<script>
(() => {
  const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FREEZE = ${freezeUnderReducedMotion ? 'true' : 'false'};
  const FALLBACK = ${gestureFallback ? 'true' : 'false'};
  const scenes = [0, 3, 6, 9];
  const colors = ['#a33', '#3a3', '#33a', '#aa3'];
  const a = document.getElementById('a');
  const s = document.getElementById('s');
  const bar = document.getElementById('bar');
  let t0 = null; let t = 0;
  const sceneAt = (x) => { let i = 0; scenes.forEach((v, k) => { if (x >= v) i = k; }); return i; };
  const render = () => {
    const i = sceneAt(t);
    s.style.background = colors[i];
    s.textContent = 'Scene ' + (i + 1);
    if (!RM) bar.style.width = Math.round((t * 120) % 900) + 'px';
  };
  const start = () => { if (t0 === null) t0 = performance.now(); };
  setInterval(() => { if (t0 !== null) t = (performance.now() - t0) / 1000; render(); }, 50);
  render();
  const arm = () => {
    const go = () => {
      window.removeEventListener('pointerdown', go);
      window.removeEventListener('keydown', go);
      a.play().then(start).catch(() => {});
    };
    window.addEventListener('pointerdown', go);
    window.addEventListener('keydown', go);
  };
  const tryPlay = () => { a.play().then(start).catch(() => { if (FALLBACK) arm(); }); };
  window.smDemo = { scenes: scenes, duration: 30, getTime: () => t, play: () => tryPlay(), pause: () => a.pause() };
  if (!(RM && FREEZE)) tryPlay();
})();
</script></body></html>`;
}

function write(name, html) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-'));
  dirs.push(d);
  const dir = path.join(d, name);
  fs.mkdirSync(dir);
  const p = path.join(dir, 'index.html');
  fs.writeFileSync(p, html);
  return p;
}

const byId = (rs) => Object.fromEntries(rs.map((r) => [r.id, r]));
const IDS = ['standalone-embed', 'standalone-reduced-motion', 'standalone-tap-for-sound'];

describe('standalone check', () => {
  it('keeps bilko.run BLOG_VIDEO_CSP verbatim', () => {
    expect(BLOG_VIDEO_CSP).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts");
  });

  it('fixtures carry no Function( pattern', () => {
    expect(fixture()).not.toMatch(/Function\(/);
  });

  it('CLI exits 2 on a usage error with a one-line reason', () => {
    const cli = path.join(__dirname, '..', 'standalone.cjs');
    const none = spawnSync(process.execPath, [cli], { encoding: 'utf8', timeout: 30000 });
    expect(none.status).toBe(2);
    expect(none.stderr.trim().split('\n')).toHaveLength(1);
    const missing = spawnSync(process.execPath, [cli, path.join(os.tmpdir(), 'no-such-standalone.html')], { encoding: 'utf8', timeout: 30000 });
    expect(missing.status).toBe(2);
    expect(missing.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('rejects when Playwright cannot be loaded', async () => {
    const p = write('vid-nopw', fixture());
    await expect(checkStandalone({ htmlPath: p, loadPlaywright: () => null })).rejects.toThrow(/Playwright/);
  });

  it.skipIf(!havePlaywright())('(a) a contract-following video passes all three checks', async () => {
    const r = await checkStandalone({ htmlPath: write('vid-good', fixture()) });
    expect(r.map((x) => x.id)).toEqual(IDS);
    for (const x of r) expect(x, x.detail).toMatchObject({ ok: true });
  }, 90000);

  it.skipIf(!havePlaywright())('(b) a video that freezes under reduced motion fails only standalone-reduced-motion', async () => {
    const r = byId(await checkStandalone({ htmlPath: write('vid-freeze', fixture({ freezeUnderReducedMotion: true })) }));
    expect(r['standalone-embed'].ok, r['standalone-embed'].detail).toBe(true);
    expect(r['standalone-reduced-motion'].ok).toBe(false);
    expect(r['standalone-reduced-motion'].detail).toMatch(/not playing/);
    expect(r['standalone-tap-for-sound'].ok, r['standalone-tap-for-sound'].detail).toBe(true);
  }, 90000);

  it.skipIf(!havePlaywright())('(c) a video with no gesture fallback fails only standalone-tap-for-sound', async () => {
    const r = byId(await checkStandalone({ htmlPath: write('vid-nofallback', fixture({ gestureFallback: false })) }));
    expect(r['standalone-embed'].ok, r['standalone-embed'].detail).toBe(true);
    expect(r['standalone-reduced-motion'].ok, r['standalone-reduced-motion'].detail).toBe(true);
    expect(r['standalone-tap-for-sound'].ok).toBe(false);
    expect(r['standalone-tap-for-sound'].detail).toMatch(/did not start/);
  }, 90000);

  it.skipIf(!havePlaywright())('(d) the contract-following video as saved on disk (CSP + player bridge) passes all three', async () => {
    const saved = injectPlayerBridge(injectCsp(fixture()));
    expect(saved).toContain('data-sm-player-bridge');
    const r = await checkStandalone({ htmlPath: write('vid-saved', saved) });
    expect(r.map((x) => x.id)).toEqual(IDS);
    for (const x of r) expect(x, x.detail).toMatchObject({ ok: true });
  }, 90000);
});
