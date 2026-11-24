'use strict';
import { describe, it, expect } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { capture: rawCapture, IMAGE_BUDGET, CLIP_BUDGET, CLIP_STEPS, resolveFfprobeBin, parseFfmpegDuration } = require('../capture.cjs');

// ffprobe fake: logs its args and prints `seconds` (default: long enough for any clip).
function fakeFfprobe(calls, seconds = '6.000') {
  return (args) => { calls.push(args); return { status: 0, stdout: `${seconds}\n`, stderr: '' }; };
}
// Every test gets a passing ffprobe unless it injects its own.
const capture = (o) => rawCapture({ ffprobe: fakeFfprobe([]), ...o });

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
// `clock.t` (ms) advances in newPage by `clock.newPageMs`, on goto by `clock.gotoMs` and on every
// waitForTimeout by its ms.
function fakeRecPw(log = {}, { failContext = false, clock = { t: 0 } } = {}) {
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
        async goto(u) { (log.clipGotos ||= []).push(u); clock.t += clock.gotoMs || 0; },
        async waitForTimeout(ms) { (log.waits ||= []).push(ms); clock.t += ms; },
        async evaluate(_fn, dy) { (log.scrolls ||= []).push(dy); },
        locator() { return { first: () => ({ boundingBox: async () => null, scrollIntoViewIfNeeded: async () => {} }) }; },
        video: () => ({ path: async () => webm }),
      };
      return { newPage: async () => { clock.t += clock.newPageMs || 0; return page; }, close: async () => { if (!fs.existsSync(webm)) fs.writeFileSync(webm, 'webm'); log.ctxClosed = true; log.ctxCloses = (log.ctxCloses || 0) + 1; } };
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
    if (args[args.length - 1] === '-') return { status: 0, stderr: '' }; // a null-muxer length read
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
  it('defaults a missing or non-number durationS to 4 s and clamps every value to 2-6 s', async () => {
    const shots = [undefined, null, '3', NaN, 1, 60, 3.5].map((d) => ({ kind: 'clip', durationS: d }));
    const calls = [];
    const r = await capture({ url: 'http://x', outDir: tmp(), shots: shots.slice(0, 6), loadPlaywright: () => fakeRecPw(), ffmpeg: fakeFfmpeg(calls, () => 10) });
    expect(r.items.map((i) => i.durationS)).toEqual([4, 4, 4, 4, 2, 6]);
    const r2 = await capture({ url: 'http://x', outDir: tmp(), shots: [shots[6]], loadPlaywright: () => fakeRecPw(), ffmpeg: fakeFfmpeg(calls, () => 10) });
    expect(r2.items[0].durationS).toBe(3.5);
    const tx = calls.filter((a) => !a.includes('-version'));
    expect(tx.map((a) => argOf(a, '-t'))).toEqual(['4.000', '4.000', '4.000', '4.000', '2.000', '6.000', '3.500']);
  });
  it('trims the measured load lead-in with an input seek and caps the output at durationS', async () => {
    const log = {};
    const clock = { t: 1000, gotoMs: 1200 };
    const calls = [];
    const r = await capture({
      url: 'http://x', outDir: tmp(), shots: [{ kind: 'clip', durationS: 3, scroll: 600 }],
      loadPlaywright: () => fakeRecPw(log, { clock }), ffmpeg: fakeFfmpeg(calls, () => 10), now: () => clock.t,
    });
    expect(r.items[0].durationS).toBe(3);
    const a = calls.filter((x) => !x.includes('-version'))[0];
    // lead-in = goto (1200 ms) + default settle wait (500 ms), measured from the page's video origin
    expect(argOf(a, '-ss')).toBe('1.700');
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i')); // input seek, before -i
    expect(argOf(a, '-t')).toBe('3.000');
    expect(a.indexOf('-t')).toBeGreaterThan(a.indexOf('-i'));
  });
  it('measures the lead-in from right after newPage(), the page video origin', async () => {
    const clock = { t: 0, newPageMs: 900, gotoMs: 1200 };
    const calls = [];
    await capture({
      url: 'http://x', outDir: tmp(), shots: [{ kind: 'clip', durationS: 3 }],
      loadPlaywright: () => fakeRecPw({}, { clock }), ffmpeg: fakeFfmpeg(calls, () => 10), now: () => clock.t,
    });
    const a = calls.filter((x) => !x.includes('-version'))[0];
    // the 900 ms spent creating the page precedes its video, so it is not trimmed
    expect(argOf(a, '-ss')).toBe('1.700');
  });
  it('drops a clip that comes out shorter than durationS minus one frame as too-short, keeping image shots', async () => {
    const probes = [];
    const outDir = tmp();
    const r = await rawCapture({
      url: 'http://x', outDir, shots: [{ kind: 'clip', durationS: 3 }, {}],
      loadPlaywright: () => fakeRecPw(), ffmpeg: fakeFfmpeg([], () => 10), ffprobe: fakeFfprobe(probes, '2.767'),
    });
    expect(r.items.map((i) => i.kind)).toEqual(['image']);
    expect(r.dropped).toEqual([{ index: 0, kind: 'clip', reason: 'too-short' }]);
    expect(probes).toHaveLength(1);
    expect(probes[0][probes[0].length - 1]).toBe(path.join(outDir, 'shot-01.mp4'));
    expect(probes[0]).toContain('format=duration');
    expect(fs.existsSync(path.join(outDir, 'shot-01.mp4'))).toBe(false);
  });
  it('keeps an exact-length clip and one within a frame of durationS', async () => {
    for (const secs of ['3.000', '2.980']) { // 30 fps: one frame = 0.0333 s
      const r = await rawCapture({
        url: 'http://x', outDir: tmp(), shots: [{ kind: 'clip', durationS: 3 }],
        loadPlaywright: () => fakeRecPw(), ffmpeg: fakeFfmpeg([], () => 10), ffprobe: fakeFfprobe([], secs),
      });
      expect(r.dropped).toEqual([]);
      expect(r.items[0]).toMatchObject({ kind: 'clip', durationS: 3 });
    }
  });
  it('drops a clip as probe-failed only when neither ffprobe nor ffmpeg yields a length', async () => {
    const ffprobe = () => ({ error: new Error('spawn ffprobe ENOENT') });
    const calls = [];
    const r = await rawCapture({ url: 'http://x', outDir: tmp(), shots: [{ kind: 'clip' }], loadPlaywright: () => fakeRecPw(), ffmpeg: fakeFfmpeg(calls, () => 10), ffprobe });
    expect(r.items).toEqual([]);
    expect(r.dropped[0].reason).toMatch(/^probe-failed: spawn ffprobe ENOENT/);
    expect(r.dropped[0].reason).toMatch(/ffmpeg: no duration/);
    expect(calls.some((a) => a[a.length - 1] === '-' && argOf(a, '-f') === 'null')).toBe(true);
  });
  it("falls back to ffmpeg's own duration output when no ffprobe is usable", async () => {
    const ffprobe = () => ({ error: new Error('spawn ffprobe ENOENT') });
    const outDir = tmp();
    const reads = [];
    const ffmpeg = (args) => {
      if (args.includes('-version')) return { status: 0, stderr: '' };
      if (args[args.length - 1] === '-') {
        reads.push(args);
        return { status: 0, stderr: '  Duration: 00:00:03.00, start: 0.000000, bitrate: 10 kb/s\nframe=   45 fps=0.0 q=-0.0 size=N/A time=00:00:01.50 bitrate=N/A\rframe=   89 fps=0.0 q=-0.0 Lsize=N/A time=00:00:02.967 bitrate=N/A speed= 50x\n' };
      }
      fs.writeFileSync(args[args.length - 1], Buffer.alloc(10));
      return { status: 0, stderr: '' };
    };
    const r = await rawCapture({ url: 'http://x', outDir, shots: [{ kind: 'clip', durationS: 3 }], loadPlaywright: () => fakeRecPw(), ffmpeg, ffprobe });
    expect(r.dropped).toEqual([]);
    expect(r.items[0]).toMatchObject({ kind: 'clip', durationS: 3 });
    expect(reads).toHaveLength(1);
    expect(argOf(reads[0], '-i')).toBe(path.join(outDir, 'shot-01.mp4'));
    expect(argOf(reads[0], '-f')).toBe('null');
    // the too-short rule still applies to the fallback's length
    const short = (args) => (args[args.length - 1] === '-' ? { status: 0, stderr: 'Duration: 00:00:03.00\ntime=00:00:02.500 bitrate=N/A\n' } : ffmpeg(args));
    const r2 = await rawCapture({ url: 'http://x', outDir: tmp(), shots: [{ kind: 'clip', durationS: 3 }], loadPlaywright: () => fakeRecPw(), ffmpeg: short, ffprobe });
    expect(r2.dropped).toEqual([{ index: 0, kind: 'clip', reason: 'too-short' }]);
  });
  it('reads the final time= line, else the Duration: line, from ffmpeg output', () => {
    expect(parseFfmpegDuration('Duration: 00:00:04.00, start\ntime=00:00:01.00\rtime=00:00:03.967 bitrate')).toBeCloseTo(3.967);
    expect(parseFfmpegDuration('Duration: 00:01:02.50, start: 0')).toBeCloseTo(62.5);
    expect(parseFfmpegDuration('time=N/A Duration: N/A')).toBeNull();
    expect(parseFfmpegDuration('')).toBeNull();
  });
  it('looks for ffprobe beside SM_FFMPEG when SM_FFPROBE is unset', () => {
    const dir = tmp();
    const ff = path.join(dir, 'ffmpeg');
    const fp = path.join(dir, 'ffprobe');
    fs.writeFileSync(ff, ''); fs.writeFileSync(fp, '');
    expect(resolveFfprobeBin({ SM_FFMPEG: ff })).toBe(fp);
    expect(resolveFfprobeBin({ SM_FFMPEG: ff, SM_FFPROBE: '/opt/x/ffprobe' })).toBe('/opt/x/ffprobe');
    expect(resolveFfprobeBin({ SM_FFMPEG: path.join(tmp(), 'ffmpeg') })).toBe('ffprobe'); // none beside it
    expect(resolveFfprobeBin({})).toBe('ffprobe');
    const exe = tmp();
    fs.writeFileSync(path.join(exe, 'ffmpeg-7.exe'), ''); fs.writeFileSync(path.join(exe, 'ffprobe-7.exe'), '');
    expect(resolveFfprobeBin({ SM_FFMPEG: path.join(exe, 'ffmpeg-7.exe') })).toBe(path.join(exe, 'ffprobe-7.exe'));
  });
  it.skipIf(process.platform === 'win32')('runs the ffprobe found beside SM_FFMPEG for the clip length', async () => {
    const dir = tmp();
    const ff = path.join(dir, 'ffmpeg');
    const fp = path.join(dir, 'ffprobe');
    fs.writeFileSync(ff, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(fp, '#!/bin/sh\necho 2.000\n', { mode: 0o755 });
    const saved = { SM_FFMPEG: process.env.SM_FFMPEG, SM_FFPROBE: process.env.SM_FFPROBE };
    process.env.SM_FFMPEG = ff;
    delete process.env.SM_FFPROBE;
    try {
      // the sibling ffprobe says 2.0 s, so a 3 s clip is too-short (proving that ffprobe ran)
      const r = await rawCapture({ url: 'http://x', outDir: tmp(), shots: [{ kind: 'clip', durationS: 3 }], loadPlaywright: () => fakeRecPw(), ffmpeg: fakeFfmpeg([], () => 10) });
      expect(r.dropped).toEqual([{ index: 0, kind: 'clip', reason: 'too-short' }]);
      fs.writeFileSync(fp, '#!/bin/sh\necho 3.000\n', { mode: 0o755 });
      const r2 = await rawCapture({ url: 'http://x', outDir: tmp(), shots: [{ kind: 'clip', durationS: 3 }], loadPlaywright: () => fakeRecPw(), ffmpeg: fakeFfmpeg([], () => 10) });
      expect(r2.dropped).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
  it('closes the recording context exactly once', async () => {
    const log = {};
    await capture({ url: 'http://x', outDir: tmp(), shots: [{ kind: 'clip' }], loadPlaywright: () => fakeRecPw(log), ffmpeg: fakeFfmpeg([], () => 10) });
    expect(log.ctxCloses).toBe(1);
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
