'use strict';
import { describe, it, expect } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { capture, IMAGE_BUDGET, CLIP_BUDGET, CLIP_STEPS } = require('../capture.cjs');

function fakePw(log = {}) {
  const page = {
    setDefaultTimeout() {},
    async screenshot() { return Buffer.alloc(100); },
    async goto(u, o) { (log.gotos ||= []).push([u, o.timeout]); },
    locator() { return { first: () => ({ boundingBox: async () => ({ x: 1, y: 2, width: 30, height: 40 }), scrollIntoViewIfNeeded: async () => {} }) }; },
  };
  return { chromium: { launch: async () => ({ newPage: async () => page, close: async () => { log.closed = true; } }) } };
}
// Playwright fake with a recordVideo-capable newContext; close() flushes a fake .webm into recordVideo.dir.
function fakeRecPw(log = {}, { failContext = false } = {}) {
  const base = fakePw(log);
  const launch = base.chromium.launch;
  base.chromium.launch = async () => {
    const b = await launch();
    b.newContext = async (opts) => {
      if (failContext) throw new Error('boom');
      (log.contexts ||= []).push(opts);
      const webm = path.join(opts.recordVideo.dir, 'rec.webm');
      const page = {
        setDefaultTimeout() {},
        async goto(u) { (log.clipGotos ||= []).push(u); },
        async waitForTimeout(ms) { (log.waits ||= []).push(ms); },
        async evaluate(_fn, dy) { (log.scrolls ||= []).push(dy); },
        locator() { return { first: () => ({ boundingBox: async () => null, scrollIntoViewIfNeeded: async () => {} }) }; },
        video: () => ({ path: async () => webm }),
      };
      return { newPage: async () => page, close: async () => { if (!fs.existsSync(webm)) fs.writeFileSync(webm, 'webm'); log.ctxClosed = true; } };
    };
    return b;
  };
  return base;
}
// ffmpeg fake: `-version` probe succeeds; a transcode writes `sizeFor(args)` bytes to the last arg.
function fakeFfmpeg(calls, sizeFor) {
  return (args) => {
    calls.push(args);
    if (args.includes('-version')) return { status: 0, stderr: '' };
    fs.writeFileSync(args[args.length - 1], Buffer.alloc(sizeFor(args)));
    return { status: 0, stderr: '' };
  };
}
const argOf = (args, flag) => args[args.indexOf(flag) + 1];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));

describe('capture', () => {
  it('skips without a url', async () => {
    expect(await capture({ outDir: tmp(), loadPlaywright: () => fakePw() })).toEqual({ skipped: 'no-url' });
  });
  it('skips without playwright', async () => {
    expect(await capture({ url: 'http://x', outDir: tmp(), loadPlaywright: () => null })).toEqual({ skipped: 'no-playwright' });
  });
  it('steps quality down within 6 tries and records focus', async () => {
    const qs = [];
    const encode = async (_p, { quality }) => { qs.push(quality); return Buffer.alloc(quality > 40 ? IMAGE_BUDGET + 1 : 1000); };
    const log = {};
    const r = await capture({ url: 'http://x', outDir: tmp(), shots: [{ selector: '#a' }], loadPlaywright: () => fakePw(log), encode, navTimeoutMs: 999999 });
    expect(qs).toEqual([80, 65, 52, 40]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: 'image', bytes: 1000, focus: { x: 1, y: 2, w: 30, h: 40 } });
    expect(log.gotos).toEqual([['http://x', 30000]]);
    expect(log.closed).toBe(true);
  });
  it('drops an image never fitting after 6 tries and oversized clips', async () => {
    let calls = 0;
    const encode = async (_p, { kind }) => { calls++; return Buffer.alloc((kind === 'image' ? IMAGE_BUDGET : CLIP_BUDGET) + 1); };
    const r = await capture({ url: 'http://x', outDir: tmp(), shots: [{}, { kind: 'clip' }], loadPlaywright: () => fakePw(), encode });
    expect(r.items).toEqual([]);
    expect(calls).toBeLessThanOrEqual(6 + 6);
  });
  it('caps at 6 shots', async () => {
    const encode = async () => Buffer.alloc(10);
    const r = await capture({ url: 'http://x', outDir: tmp(), shots: Array.from({ length: 10 }, () => ({})), max: 20, loadPlaywright: () => fakePw(), encode });
    expect(r.items).toHaveLength(6);
  });

  it('records a default clip with recordVideo and transcodes it to a budgeted H.264 MP4', async () => {
    const log = {};
    const calls = [];
    const outDir = tmp();
    const ffmpeg = fakeFfmpeg(calls, () => 5000);
    const r = await capture({ url: 'http://x', outDir, shots: [{ kind: 'clip', durationS: 3, scroll: 600, viewport: { width: 1000, height: 600 } }, {}], loadPlaywright: () => fakeRecPw(log), encode: undefined, ffmpeg });
    expect(r.dropped).toEqual([]);
    expect(r.items).toHaveLength(2);
    const clip = r.items[0];
    expect(clip).toMatchObject({ kind: 'clip', mime: 'video/mp4', bytes: 5000, durationS: 3, focus: { x: 250, y: 150, w: 500, h: 300 } });
    expect(clip.file.endsWith('shot-01.mp4')).toBe(true);
    expect(fs.statSync(clip.file).size).toBe(5000);
    expect(r.items[1]).toMatchObject({ kind: 'image', mime: 'image/jpeg' });
    expect(log.contexts[0].viewport).toEqual({ width: 1000, height: 600 });
    expect(log.contexts[0].recordVideo.size).toEqual({ width: 1000, height: 600 });
    expect(log.clipGotos).toEqual(['http://x']);
    expect(log.ctxClosed).toBe(true);
    expect(log.scrolls.reduce((a, b) => a + b, 0)).toBeCloseTo(600);
    expect(log.waits.slice(1).reduce((a, b) => a + b, 0)).toBeCloseTo(3000);
    const tx = calls.filter((a) => !a.includes('-version'));
    expect(tx).toHaveLength(1);
    const a = tx[0];
    expect(argOf(a, '-c:v')).toBe('libx264');
    expect(argOf(a, '-pix_fmt')).toBe('yuv420p');
    expect(argOf(a, '-movflags')).toBe('+faststart');
    expect(a).toContain('-an');
    expect(argOf(a, '-vf')).toBe('fps=30,scale=1000:-2:flags=lanczos'); // width capped at the viewport
    // the temp recordVideo dir is gone
    expect(fs.readdirSync(outDir).filter((f) => f.startsWith('.clip-'))).toEqual([]);
  });
  it('clamps clip duration to 2-6 seconds', async () => {
    const log = {};
    const r = await capture({ url: 'http://x', outDir: tmp(), shots: [{ kind: 'clip', durationS: 60 }], loadPlaywright: () => fakeRecPw(log), ffmpeg: fakeFfmpeg([], () => 10) });
    expect(r.items[0].durationS).toBe(6);
  });
  it('steps width, fps and quality down until the clip fits the budget', async () => {
    const calls = [];
    const ffmpeg = fakeFfmpeg(calls, (args) => (Number(argOf(args, '-crf')) >= 37 ? CLIP_BUDGET : CLIP_BUDGET + 1));
    const r = await capture({ url: 'http://x', outDir: tmp(), shots: [{ kind: 'clip' }], loadPlaywright: () => fakeRecPw(), ffmpeg });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].bytes).toBe(CLIP_BUDGET);
    const vf = calls.filter((a) => !a.includes('-version')).map((a) => [argOf(a, '-vf'), argOf(a, '-crf')]);
    expect(vf).toEqual(CLIP_STEPS.slice(0, 4).map((s) => [`fps=${s.fps},scale=${s.width}:-2:flags=lanczos`, String(s.crf)]));
  });
  it('drops a clip that never fits, keeping image shots', async () => {
    const calls = [];
    const outDir = tmp();
    const r = await capture({ url: 'http://x', outDir, shots: [{}, { kind: 'clip' }], loadPlaywright: () => fakeRecPw(), ffmpeg: fakeFfmpeg(calls, () => CLIP_BUDGET + 1) });
    expect(r.items.map((i) => i.kind)).toEqual(['image']);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]).toMatchObject({ index: 1, kind: 'clip' });
    expect(r.dropped[0].reason).toMatch(/^over-budget/);
    expect(calls.filter((a) => !a.includes('-version'))).toHaveLength(CLIP_STEPS.length);
    expect(fs.existsSync(path.join(outDir, 'shot-02.mp4'))).toBe(false);
  });
  it('drops clips with no-ffmpeg when ffmpeg is missing, keeping image shots', async () => {
    const log = {};
    const ffmpeg = () => ({ error: Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }) });
    const r = await capture({ url: 'http://x', outDir: tmp(), shots: [{ kind: 'clip' }, {}, { kind: 'clip' }], loadPlaywright: () => fakeRecPw(log), ffmpeg });
    expect(r.items.map((i) => i.kind)).toEqual(['image']);
    expect(r.dropped).toEqual([{ index: 0, kind: 'clip', reason: 'no-ffmpeg' }, { index: 2, kind: 'clip', reason: 'no-ffmpeg' }]);
    expect(log.contexts).toBeUndefined(); // nothing recorded without ffmpeg
  });
  it('drops a clip whose recordVideo fails, keeping image shots', async () => {
    const r = await capture({ url: 'http://x', outDir: tmp(), shots: [{ kind: 'clip' }, {}], loadPlaywright: () => fakeRecPw({}, { failContext: true }), ffmpeg: fakeFfmpeg([], () => 10) });
    expect(r.items.map((i) => i.kind)).toEqual(['image']);
    expect(r.dropped).toEqual([{ index: 0, kind: 'clip', reason: 'record-failed: boom' }]);
  });
  it('drops a clip whose transcode fails', async () => {
    const ffmpeg = (args) => (args.includes('-version') ? { status: 0 } : { status: 1, stderr: 'bad input' });
    const r = await capture({ url: 'http://x', outDir: tmp(), shots: [{ kind: 'clip' }], loadPlaywright: () => fakeRecPw(), ffmpeg });
    expect(r.items).toEqual([]);
    expect(r.dropped[0].reason).toMatch(/^transcode-failed: exit 1: bad input/);
  });
});
