/**
 * voicePreview.test.cjs — cached voice preview through the kit speak CLI:
 * miss then hit, key change on params, in-flight sharing, exit-75 retry,
 * the CLI error path and cache pruning. Uses a project voice whose command is
 * a fake node TTS (writes a RIFF WAV holding the text).
 * Run: timeout 300 npx vitest run src/main/lib/project-pages/__tests__/voicePreview.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const vp = require('../voicePreview.cjs');

const tmp = [];
const saved = {};
let home; let project;
let spawnSpy;
const realSpawn = cp.spawn;

const FAKE_TTS = [
  "const fs = require('fs');",
  'const [text, out] = process.argv.slice(2);',
  "if (text === 'bad') { process.stderr.write('fake tts refused bad'); process.exit(3); }",
  "fs.writeFileSync(out, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60), Buffer.from(text)]));",
].join('\n');

function writeVoice(id, extra = {}) {
  const dir = path.join(project, '.claude', 'voices');
  fs.mkdirSync(dir, { recursive: true });
  const voice = { engine: 'command', command: [process.execPath, path.join(project, 'tts.cjs'), '{text}', '{out}'], ...extra };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ label: id, voice, heavy: false }));
}

beforeEach(() => {
  for (const k of ['SM_VOICES_HOME', 'KOKORO_MODEL_DIR', 'SM_VOICE_LANE_DIR']) saved[k] = process.env[k];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-voicepreview-'));
  tmp.push(root);
  home = path.join(root, 'voices');
  project = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'tts.cjs'), FAKE_TTS);
  process.env.SM_VOICES_HOME = home;
  process.env.KOKORO_MODEL_DIR = path.join(root, 'model');
  delete process.env.SM_VOICE_LANE_DIR;
  writeVoice('pip');
  spawnSpy = vi.spyOn(cp, 'spawn');
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true });
});

test('miss spawns the kit speak CLI once; the second call is a cache hit', async () => {
  const a = await vp.previewVoice({ projectRoot: project, voiceId: 'pip', text: '  hello there  ' });
  expect(a.ok, a.error).toBe(true);
  expect(a.cached).toBe(false);
  expect(Buffer.isBuffer(a.bytes)).toBe(true);
  expect(a.bytes.subarray(0, 4).toString()).toBe('RIFF');
  expect(a.bytes.subarray(64).toString()).toBe('hello there');
  expect(a.wavPath).toBe(path.join(home, 'cache', `${path.basename(a.wavPath, '.wav')}.wav`));
  expect(spawnSpy).toHaveBeenCalledTimes(1);
  const [bin, args, opts] = spawnSpy.mock.calls[0];
  expect(bin).toBe(process.execPath);
  expect(args[0]).toBe(path.resolve(__dirname, '../../demo-video-kit/character.cjs'));
  expect(args[1]).toBe('speak');
  expect(opts.env.ELECTRON_RUN_AS_NODE).toBe('1');
  expect(opts.cwd).toBe(project);
  expect(opts.shell).toBeFalsy();

  const b = await vp.previewVoice({ projectRoot: project, voiceId: 'pip', text: 'hello there' });
  expect(b).toMatchObject({ ok: true, cached: true, wavPath: a.wavPath });
  expect(b.bytes.equals(a.bytes)).toBe(true);
  expect(spawnSpy).toHaveBeenCalledTimes(1);
  // no tmp leftovers in the cache
  expect(fs.readdirSync(path.join(home, 'cache'))).toEqual([path.basename(a.wavPath)]);
});

test('spec written to the CLI carries voice/kind/label/lines', async () => {
  let spec = null;
  spawnSpy.mockImplementation((bin, args, opts) => {
    spec = JSON.parse(fs.readFileSync(args[2], 'utf8'));
    return realSpawn(bin, args, opts);
  });
  const r = await vp.previewVoice({ projectRoot: project, voiceId: 'pip', text: 'hi' });
  expect(r.ok, r.error).toBe(true);
  expect(spec).toMatchObject({ projectRoot: project, voice: 'pip', kind: 'preview', label: 'preview pip' });
  expect(spec.lines).toHaveLength(1);
  expect(spec.lines[0].text).toBe('hi');
  expect(spec.lines[0].out.endsWith('.tmp.wav')).toBe(true);
  // the spec dir is cleaned up
  expect(fs.existsSync(path.dirname(spawnSpy.mock.calls[0][1][2]))).toBe(false);
});

test('changing the voice params changes the key and never serves the stale clip', async () => {
  const resolved = () => {
    const vl = require('../../demo-video-kit/voiceLibrary.cjs');
    const rv = vl.resolveVoiceId(project, 'pip');
    return vp.previewKey({ voiceId: 'pip', text: 'hi', voice: rv.voice, pin: vl.pinOf(rv.entry, project), scope: rv.scope, projectRoot: project });
  };
  const k1 = resolved();
  const a = await vp.previewVoice({ projectRoot: project, voiceId: 'pip', text: 'hi' });
  expect(path.basename(a.wavPath, '.wav')).toBe(k1);
  writeVoice('pip', { command: [process.execPath, path.join(project, 'tts.cjs'), '{text}', '{out}', '--fast'] });
  const k2 = resolved();
  expect(k2).not.toBe(k1);
  const b = await vp.previewVoice({ projectRoot: project, voiceId: 'pip', text: 'hi' });
  expect(b.ok, b.error).toBe(true);
  expect(b.cached).toBe(false);
  expect(path.basename(b.wavPath, '.wav')).toBe(k2);
  expect(spawnSpy).toHaveBeenCalledTimes(2);
  // key also differs by text and voice id
  expect(vp.previewKey({ voiceId: 'pip', text: 'hi', voice: {}, pin: 'p' }))
    .not.toBe(vp.previewKey({ voiceId: 'pip', text: 'ho', voice: {}, pin: 'p' }));
  expect(vp.previewKey({ voiceId: 'pip', text: 'hi', voice: { a: 1, b: 2 }, pin: 'p' }))
    .toBe(vp.previewKey({ voiceId: 'pip', text: 'hi', voice: { b: 2, a: 1 }, pin: 'p' }));
});

test('a project voice key includes projectRoot; a built-in voice key is shared across roots', () => {
  const vl = require('../../demo-video-kit/voiceLibrary.cjs');
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-voicepreview-other-'));
  tmp.push(otherRoot);
  // the same project voice id + voice JSON in two project roots
  const dir = path.join(otherRoot, '.claude', 'voices');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(project, '.claude', 'voices', 'pip.json'), path.join(dir, 'pip.json'));
  const keyIn = (root, id) => {
    const rv = vl.resolveVoiceId(root, id);
    expect(rv.ok, rv.error).toBe(true);
    return { rv, key: vp.previewKey({ voiceId: id, text: 'hi', voice: rv.voice, pin: vl.pinOf(rv.entry, root), scope: rv.scope, projectRoot: root }) };
  };
  const a = keyIn(project, 'pip');
  const b = keyIn(otherRoot, 'pip');
  expect(a.rv.scope).toBe('project');
  expect(a.rv.voice).toEqual(b.rv.voice);
  expect(a.key).not.toBe(b.key);
  // a built-in voice keeps one key across project roots
  const builtin = vl.listVoices(project).voices.find((v) => v.scope === 'builtin');
  expect(builtin).toBeTruthy();
  const c = keyIn(project, builtin.id);
  const d = keyIn(otherRoot, builtin.id);
  expect(c.rv.scope).toBe('builtin');
  expect(c.key).toBe(d.key);
  // machine scope is shared too
  expect(vp.previewKey({ voiceId: 'm', text: 'hi', voice: {}, pin: 'p', scope: 'machine', projectRoot: project }))
    .toBe(vp.previewKey({ voiceId: 'm', text: 'hi', voice: {}, pin: 'p', scope: 'machine', projectRoot: otherRoot }));
});

test('voicePreview uses voiceLibrary.canonical, not a copy of its own', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'voicePreview.cjs'), 'utf8');
  expect(src).not.toMatch(/function canonical\(/);
  expect(src).toMatch(/voiceLibrary\.canonical\(/);
});

test('concurrent calls with the same key share one in-flight run', async () => {
  const [a, b, c] = await Promise.all([
    vp.previewVoice({ projectRoot: project, voiceId: 'pip', text: 'same' }),
    vp.previewVoice({ projectRoot: project, voiceId: 'pip', text: 'same' }),
    vp.previewVoice({ projectRoot: project, voiceId: 'pip', text: ' same ' }),
  ]);
  expect(a.ok && b.ok && c.ok).toBe(true);
  expect(spawnSpy).toHaveBeenCalledTimes(1);
  expect(b.wavPath).toBe(a.wavPath);
  expect(c.wavPath).toBe(a.wavPath);
});

test('exit 75 re-runs the same command until done', async () => {
  let n = 0;
  const seen = [];
  spawnSpy.mockImplementation((bin, args, opts) => {
    n += 1;
    seen.push(JSON.stringify(args));
    if (n <= 2) return realSpawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ok:false,pending:true})); process.exit(75)'], opts);
    return realSpawn(bin, args, opts);
  });
  const r = await vp.previewVoice({ projectRoot: project, voiceId: 'pip', text: 'later' });
  expect(r.ok, r.error).toBe(true);
  expect(n).toBe(3);
  expect(new Set(seen).size).toBe(1);
});

test('exit 75 past timeoutMs returns an error', async () => {
  spawnSpy.mockImplementation((bin, args, opts) => realSpawn(process.execPath, ['-e', 'setTimeout(() => process.exit(75), 50)'], opts));
  const r = await vp.previewVoice({ projectRoot: project, voiceId: 'pip', text: 'never', timeoutMs: 300 });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/timed out/);
});

test('a failing voice returns the CLI error and caches nothing', async () => {
  const r = await vp.previewVoice({ projectRoot: project, voiceId: 'pip', text: 'bad' });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/fake tts refused bad/);
  const cache = path.join(home, 'cache');
  expect(fs.existsSync(cache) ? fs.readdirSync(cache) : []).toEqual([]);
});

test('input validation: text 1-300 chars, voice must resolve', async () => {
  expect((await vp.previewVoice({ projectRoot: project, voiceId: 'pip', text: '   ' })).ok).toBe(false);
  expect((await vp.previewVoice({ projectRoot: project, voiceId: 'pip', text: 'x'.repeat(301) })).error).toMatch(/300/);
  const u = await vp.previewVoice({ projectRoot: project, voiceId: 'nope', text: 'hi' });
  expect(u).toEqual({ ok: false, error: "unknown voice 'nope'" });
  expect(spawnSpy).not.toHaveBeenCalled();
});

test('the cache keeps at most 200 clips, oldest mtime removed', async () => {
  const cache = path.join(home, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  const base = Date.now() / 1000 - 10000;
  for (let i = 0; i < 200; i++) {
    const f = path.join(cache, `old${String(i).padStart(3, '0')}.wav`);
    fs.writeFileSync(f, 'RIFF');
    fs.utimesSync(f, base + i, base + i);
  }
  const r = await vp.previewVoice({ projectRoot: project, voiceId: 'pip', text: 'new one' });
  expect(r.ok, r.error).toBe(true);
  const left = fs.readdirSync(cache).filter((f) => f.endsWith('.wav'));
  expect(left).toHaveLength(200);
  expect(left).not.toContain('old000.wav');
  expect(left).toContain('old001.wav');
  expect(left).toContain(path.basename(r.wavPath));
});
