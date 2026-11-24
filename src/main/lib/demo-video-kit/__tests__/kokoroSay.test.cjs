/**
 * kokoroSay.test.cjs — Kokoro runner: validation, missing model, fake python
 * (writes WAVs / writes nothing / hangs), import-failure hint, opt-in real smoke.
 * Run: timeout 120 npx vitest run src/main/lib/demo-video-kit/__tests__/kokoroSay.test.cjs
 * Real model: SM_KOKORO_SMOKE=1 (needs kokoro-onnx + ~/.cache/kokoro-onnx).
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sayKokoro, KOKORO_SCRIPT, PIP_INSTALL } = require('../kokoroSay.cjs');

let root;
let modelDir;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-kokoro-'));
  modelDir = path.join(root, 'models');
  fs.mkdirSync(modelDir);
  fs.writeFileSync(path.join(modelDir, 'kokoro-v1.0.onnx'), 'x');
  fs.writeFileSync(path.join(modelDir, 'voices-v1.0.bin'), 'x');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function fake(name, body) {
  const p = path.join(root, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

const WRITES_WAVS = `
const fs = require('node:fs');
if (process.argv[2] !== '-c' || !process.argv[3].includes('kokoro_onnx')) { console.error('bad argv'); process.exit(3); }
let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => {
  const req = JSON.parse(s);
  fs.writeFileSync(require('node:path').join(process.cwd(), 'req.json'), s);
  for (const ln of req.lines) fs.writeFileSync(ln.out, Buffer.alloc(100));
  console.log(JSON.stringify({ ok: true, seconds: req.lines.map(() => 1.25) }));
});`;
const WRITES_NOTHING = `
let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => {
  console.error('pretend synth trouble');
  console.log(JSON.stringify({ ok: true, seconds: [] }));
});`;
const HANGS = 'process.stdin.resume(); setTimeout(() => {}, 60000);';
const IMPORT_FAILS = `
process.stdin.resume(); process.stdin.on('end', () => {
  console.error("ModuleNotFoundError: No module named 'kokoro_onnx'");
  process.exit(1);
});`;

const line = (over = {}) => ({ text: 'Hello there.', out: 'a.wav', voice: 'af_heart', ...over });

test('KOKORO_SCRIPT loads the model once and writes each line with soundfile', () => {
  expect(KOKORO_SCRIPT).toContain('from kokoro_onnx import Kokoro');
  expect(KOKORO_SCRIPT).toContain('kokoro-v1.0.onnx');
  expect(KOKORO_SCRIPT).toContain('voices-v1.0.bin');
  expect(KOKORO_SCRIPT).toContain('soundfile.write');
  expect(KOKORO_SCRIPT).toContain(PIP_INSTALL);
  expect(KOKORO_SCRIPT.match(/Kokoro\(/g)).toHaveLength(1);
});

test('validation refuses bad lines before spawning', () => {
  const python = path.join(root, 'never-run');
  const bad = [
    [[], /non-empty array/],
    [[line({ text: '  ' })], /text/],
    [[line({ out: 'a.mp3' })], /\.wav/],
    [[line({ voice: '' })], /voice/],
    [[line(), line({ out: './a.wav' })], /duplicates/],
    [[line({ speed: 0.4 })], /speed/],
    [[line({ speed: 2.1 })], /speed/],
    [[line({ speed: '1' })], /speed/],
    [[line({ lang: '' })], /lang/],
  ];
  for (const [lines, re] of bad) {
    const r = sayKokoro(lines, { python, modelDir, cwd: root });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(re);
  }
});

test('a missing model file is named with its curl download command', () => {
  fs.rmSync(path.join(modelDir, 'voices-v1.0.bin'));
  const r = sayKokoro([line()], { python: fake('py', WRITES_WAVS), modelDir, cwd: root });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('voices-v1.0.bin');
  expect(r.error).toContain('curl -L');
  expect(r.error).toContain('model-files-v1.0/voices-v1.0.bin');
  expect(fs.existsSync(path.join(root, 'req.json'))).toBe(false);
});

test('KOKORO_MODEL_DIR is used when opts.modelDir is absent', () => {
  const env = { ...process.env, KOKORO_MODEL_DIR: path.join(root, 'nowhere') };
  const r = sayKokoro([line()], { python: fake('py', WRITES_WAVS), cwd: root, env });
  expect(r.ok).toBe(false);
  expect(r.error).toContain(path.join(root, 'nowhere'));
});

test('a fake python that writes WAVs succeeds; relative outs resolve against cwd with parent dirs made', () => {
  const r = sayKokoro([line({ out: 'sub/dir/a.wav' }), line({ out: 'b.wav', speed: 1.2, lang: 'en-gb' })], {
    python: fake('py', WRITES_WAVS), modelDir, cwd: root,
  });
  expect(r).toEqual({
    ok: true,
    outs: [path.join(root, 'sub/dir/a.wav'), path.join(root, 'b.wav')],
    audioSeconds: 2.5,
    seconds: [1.25, 1.25],
  });
  const req = JSON.parse(fs.readFileSync(path.join(root, 'req.json'), 'utf8'));
  expect(req.modelDir).toBe(modelDir);
  expect(req.lines[0]).toMatchObject({ speed: 1, lang: 'en-us', voice: 'af_heart' });
  expect(req.lines[1]).toMatchObject({ speed: 1.2, lang: 'en-gb' });
});

test('SM_KOKORO_PYTHON picks the interpreter when opts.python is absent', () => {
  const env = { ...process.env, SM_KOKORO_PYTHON: fake('py', WRITES_WAVS) };
  const r = sayKokoro([line()], { modelDir, cwd: root, env });
  expect(r.ok).toBe(true);
});

test('a fake that writes nothing fails with the stderr tail, even over a stale WAV', () => {
  fs.writeFileSync(path.join(root, 'a.wav'), Buffer.alloc(500));
  const r = sayKokoro([line()], { python: fake('py', WRITES_NOTHING), modelDir, cwd: root });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('wrote no WAV');
  expect(r.error).toContain('pretend synth trouble');
});

test('an import failure names the pip install command', () => {
  const r = sayKokoro([line()], { python: fake('py', IMPORT_FAILS), modelDir, cwd: root });
  expect(r.ok).toBe(false);
  expect(r.error).toContain(PIP_INSTALL);
});

test('the call is bounded by opts.timeoutMs', () => {
  const t0 = Date.now();
  const r = sayKokoro([line()], { python: fake('py', HANGS), modelDir, cwd: root, timeoutMs: 500 });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/timed out after 500 ms/);
  expect(Date.now() - t0).toBeLessThan(10000);
});

test.skipIf(process.env.SM_KOKORO_SMOKE !== '1')('real Kokoro model speaks a line (SM_KOKORO_SMOKE=1)', () => {
  const r = sayKokoro([line({ out: 'smoke.wav' })], { cwd: root });
  expect(r.error).toBeUndefined();
  expect(r.ok).toBe(true);
  expect(fs.statSync(path.join(root, 'smoke.wav')).size).toBeGreaterThan(44);
  expect(r.audioSeconds).toBeGreaterThan(0);
}, 15 * 60 * 1000);
