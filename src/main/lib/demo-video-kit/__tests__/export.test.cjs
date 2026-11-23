/**
 * export.test.cjs — demo-video kit MP4 + poster exporter, driven with injected fakes.
 * Run: timeout 120 npx vitest run src/main/lib/demo-video-kit/__tests__/export.test.cjs
 */
'use strict';
import { describe, it, expect } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { exportVideo, sizeForHtml, verifyProbe } = require('../export.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'export-'));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function fixture(aspect) {
  const dir = tmp();
  const htmlPath = path.join(dir, 'v.html');
  fs.writeFileSync(htmlPath, `<meta name="sm-demo-aspect" content="${aspect}"><p>x</p>`);
  const audioPath = path.join(dir, 'a.wav');
  fs.writeFileSync(audioPath, 'RIFF');
  return { dir, htmlPath, audioPath, outDir: path.join(dir, 'out') };
}

function fakePlaywright({ seekThrowsAt } = {}) {
  const calls = { viewport: null, seeks: [], shots: [], closed: false };
  const page = {
    setDefaultTimeout() {},
    async goto() {},
    async screenshot(o) {
      calls.shots.push({ t: calls.seeks[calls.seeks.length - 1], path: o && o.path });
      if (o && o.path) fs.writeFileSync(o.path, PNG);
      return PNG;
    },
    async evaluate(fn, arg) {
      if (String(fn).includes('d.seek')) {
        if (seekThrowsAt != null && arg === seekThrowsAt) throw new Error('seek boom');
        calls.seeks.push(arg);
      }
      return undefined;
    },
  };
  const pw = { chromium: { async launch() { return { async newPage(o) { calls.viewport = o.viewport; return page; }, async close() { calls.closed = true; } }; } } };
  return { pw, calls };
}

function fakeFfmpeg() {
  const calls = { args: null, frames: 0 };
  async function runFfmpeg(args, { input }) {
    calls.args = args;
    for await (const buf of input) { expect(Buffer.isBuffer(buf)).toBe(true); calls.frames++; }
    fs.writeFileSync(args[args.length - 1], 'mp4');
    return '';
  }
  return { runFfmpeg, calls };
}

const probeJson = ({ v = 'h264', a = 'aac', w = 1080, h = 1920, d = 2 } = {}) => JSON.stringify({
  streams: [{ codec_type: 'video', codec_name: v, width: w, height: h }, { codec_type: 'audio', codec_name: a }],
  format: { duration: String(d) },
});

describe('exportVideo (injected fakes)', () => {
  it('9:16 renders every frame by seek(i/fps), muxes audio as H.264/AAC and writes the poster', async () => {
    const f = fixture('9:16');
    const { pw, calls } = fakePlaywright();
    const ff = fakeFfmpeg();
    let probeArgs = null;
    const r = await exportVideo({
      ...f, lengthS: 2, fps: 5, loadPlaywright: () => pw, runFfmpeg: ff.runFfmpeg,
      runFfprobe: (args) => { probeArgs = args; return probeJson(); },
    });
    expect(r.ok).toBe(true);
    expect(r.check).toEqual({ id: 'export', ok: true, detail: expect.any(String) });
    expect(calls.viewport).toEqual({ width: 1080, height: 1920 });
    expect([r.width, r.height, r.durationS]).toEqual([1080, 1920, 2]);
    expect(ff.calls.frames).toBe(10);
    // 10 frame seeks then the poster seek at min(3, 2/2) = 1
    expect(calls.seeks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 1]);
    expect(r.mp4Path).toBe(path.join(f.outDir, 'video.mp4'));
    expect(r.posterPath).toBe(path.join(f.outDir, 'poster.png'));
    expect(fs.existsSync(r.posterPath)).toBe(true);
    const a = ff.calls.args;
    const after = (flag) => a[a.indexOf(flag) + 1];
    expect(after('-f')).toBe('image2pipe');
    expect(after('-framerate')).toBe('5');
    expect(a).toContain('pipe:0');
    expect(a).toContain(path.resolve(f.audioPath));
    expect(after('-c:v')).toBe('png');
    expect(a[a.lastIndexOf('-c:v') + 1]).toBe('libx264');
    expect(after('-pix_fmt')).toBe('yuv420p');
    expect(after('-c:a')).toBe('aac');
    expect(after('-movflags')).toBe('+faststart');
    expect(after('-t')).toBe('2');
    expect(a[a.length - 1]).toBe(r.mp4Path);
    expect(probeArgs).toEqual(expect.arrayContaining(['-show_streams', '-show_format', r.mp4Path]));
    expect(calls.closed).toBe(true);
  });

  it('16:9 (or no meta) exports 1920x1080, default fps 30, explicit posterAtS', async () => {
    const f = fixture('16:9');
    const { pw, calls } = fakePlaywright();
    const ff = fakeFfmpeg();
    const r = await exportVideo({ ...f, lengthS: 1, posterAtS: 0.25, loadPlaywright: () => pw, runFfmpeg: ff.runFfmpeg, runFfprobe: () => probeJson({ w: 1920, h: 1080, d: 1.02 }) });
    expect(r.ok).toBe(true);
    expect(calls.viewport).toEqual({ width: 1920, height: 1080 });
    expect(ff.calls.frames).toBe(30);
    expect(calls.seeks.slice(0, 3)).toEqual([0, 1 / 30, 2 / 30]);
    expect(calls.seeks[calls.seeks.length - 1]).toBe(0.25);
    expect(sizeForHtml('<p>no meta</p>')).toEqual({ width: 1920, height: 1080 });
    expect(sizeForHtml('<meta content="9:16" name="sm-demo-aspect">')).toEqual({ width: 1080, height: 1920 });
  });

  it('ffprobe mismatch -> ok false with the reason and no outputs left behind', async () => {
    for (const [bad, needle] of [[{ v: 'vp9' }, 'h264'], [{ a: 'mp3' }, 'aac'], [{ w: 720 }, 'size'], [{ d: 2.5 }, 'duration']]) {
      const f = fixture('9:16');
      const { pw } = fakePlaywright();
      const ff = fakeFfmpeg();
      const r = await exportVideo({ ...f, lengthS: 2, fps: 2, loadPlaywright: () => pw, runFfmpeg: ff.runFfmpeg, runFfprobe: () => probeJson(bad) });
      expect(r.ok).toBe(false);
      expect(r.check.ok).toBe(false);
      expect(r.check.id).toBe('export');
      expect(r.check.detail).toContain(needle);
      expect(r.mp4Path).toBeUndefined();
      expect(fs.existsSync(path.join(f.outDir, 'video.mp4'))).toBe(false);
      expect(fs.existsSync(path.join(f.outDir, 'poster.png'))).toBe(false);
    }
  });

  it('duration within 0.2 s passes, beyond fails', () => {
    const want = { width: 1080, height: 1920, lengthS: 2 };
    expect(verifyProbe(JSON.parse(probeJson({ d: 2.2 })), want).ok).toBe(true);
    expect(verifyProbe(JSON.parse(probeJson({ d: 1.75 })), want).ok).toBe(false);
  });

  it('missing ffmpeg -> ok false with the error', async () => {
    const f = fixture('9:16');
    const { pw } = fakePlaywright();
    const r = await exportVideo({
      ...f, lengthS: 1, fps: 2, loadPlaywright: () => pw,
      runFfmpeg: async () => { throw new Error('ffmpeg failed to run: spawn ffmpeg ENOENT'); },
      runFfprobe: () => { throw new Error('should not be reached'); },
    });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('ENOENT'), check: { id: 'export', ok: false, detail: expect.stringContaining('ENOENT') } });
  });

  it('missing ffprobe -> ok false', async () => {
    const f = fixture('9:16');
    const { pw } = fakePlaywright();
    const r = await exportVideo({ ...f, lengthS: 1, fps: 2, loadPlaywright: () => pw, runFfmpeg: fakeFfmpeg().runFfmpeg, runFfprobe: () => { throw new Error('ffprobe failed to run: ENOENT'); } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ffprobe');
  });

  it('missing playwright -> ok false', async () => {
    const f = fixture('9:16');
    const r = await exportVideo({ ...f, lengthS: 1, loadPlaywright: () => null, runFfmpeg: fakeFfmpeg().runFfmpeg, runFfprobe: () => probeJson() });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/playwright/);
  });

  it('a throwing seek -> ok false, never a partial success', async () => {
    const f = fixture('9:16');
    const { pw, calls } = fakePlaywright({ seekThrowsAt: 1 });
    const ff = fakeFfmpeg();
    const r = await exportVideo({ ...f, lengthS: 2, fps: 2, loadPlaywright: () => pw, runFfmpeg: ff.runFfmpeg, runFfprobe: () => probeJson() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('seek boom');
    expect(ff.calls.frames).toBe(2);
    expect(calls.closed).toBe(true);
    expect(fs.existsSync(path.join(f.outDir, 'video.mp4'))).toBe(false);
  });

  it('rejects missing inputs', async () => {
    expect((await exportVideo({ lengthS: 1 })).ok).toBe(false);
    const f = fixture('9:16');
    const r = await exportVideo({ ...f, audioPath: path.join(f.dir, 'nope.wav'), lengthS: 1, loadPlaywright: () => fakePlaywright().pw });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('audioPath');
  });
});

describe('export.cjs CLI', () => {
  const cli = path.join(__dirname, '..', 'export.cjs');
  it('exits 2 on unreadable input', () => {
    const r = spawnSync(process.execPath, [cli, path.join(tmp(), 'missing.json')], { encoding: 'utf8', timeout: 30000 });
    expect(r.status).toBe(2);
  });
  it('exits 1 and prints the JSON result on a failed export', () => {
    const spec = path.join(tmp(), 'spec.json');
    fs.writeFileSync(spec, JSON.stringify({ lengthS: 1 }));
    const r = spawnSync(process.execPath, [cli, spec], { encoding: 'utf8', timeout: 30000 });
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(false);
    expect(out.check.id).toBe('export');
  });
});
