/**
 * voiceLibrary.test.cjs — library voice resolver: built-in zip listing, fallback,
 * project > machine > builtin precedence, invalid files, approval-pin refusals.
 * Run: timeout 120 npx vitest run src/main/lib/demo-video-kit/__tests__/voiceLibrary.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vl = require('../voiceLibrary.cjs');

const tmp = [];
const saved = {};
let home; let modelDir; let project;

beforeEach(() => {
  for (const k of ['SM_VOICES_HOME', 'KOKORO_MODEL_DIR']) saved[k] = process.env[k];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-voicelib-'));
  tmp.push(root);
  home = path.join(root, 'voices');
  modelDir = path.join(root, 'model');
  project = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(modelDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  process.env.SM_VOICES_HOME = home;
  process.env.KOKORO_MODEL_DIR = modelDir;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true });
});

/** A stored (uncompressed) zip with the given entry names, like numpy's savez. */
function buildZip(names) {
  const locals = []; const centrals = []; let offset = 0;
  for (const name of names) {
    const nb = Buffer.from(name, 'utf8');
    const data = Buffer.from('npy-bytes');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const local = Buffer.concat([lh, nb, data]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nb]));
    locals.push(local); offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(names.length, 8); eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function writeVoice(dir, id, json) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));
  return file;
}
const projDir = () => path.join(project, '.claude', 'voices');
const machDir = () => path.join(home, 'library');
function approve(scope, id, pin) {
  const key = vl.approvalKey(scope, project, id);
  let cur = { version: 1, approvals: {} };
  try { cur = JSON.parse(fs.readFileSync(path.join(home, 'approvals.json'), 'utf8')); } catch { /* fresh */ }
  cur.approvals[key] = { pin, approvedAt: '2026-11-23T00:00:00Z' };
  fs.writeFileSync(path.join(home, 'approvals.json'), JSON.stringify(cur));
}

test('exports the documented API', () => {
  for (const k of ['voicesHome', 'listVoices', 'resolveVoiceId', 'pinOf', 'readApprovals', 'validateVoiceEntry']) {
    expect(typeof vl[k]).toBe('function');
  }
  expect(vl.KOKORO_V1_VOICES.length).toBe(54);
  expect(vl.voicesHome()).toBe(home);
});

test('requires only node built-ins and files in its own folder', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'voiceLibrary.cjs'), 'utf8');
  const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  expect(reqs.length).toBeGreaterThan(0);
  for (const r of reqs) expect(r.startsWith('node:') || /^\.\/[^/]+$/.test(r)).toBe(true);
});

test('built-ins come from the zip directory of voices-v1.0.bin', () => {
  fs.writeFileSync(path.join(modelDir, 'voices-v1.0.bin'), buildZip(['af_heart.npy', 'bm_george.npy', 'zz_readme.txt']));
  const { voices, errors } = vl.listVoices(project);
  expect(errors).toEqual([]);
  expect(voices.map((v) => v.id)).toEqual(['af_heart', 'bm_george']);
  const heart = voices[0];
  expect(heart).toMatchObject({
    id: 'af_heart', label: 'Heart (US female)', scope: 'builtin', installed: true, engine: 'kokoro',
    voice: { engine: 'kokoro', id: 'af_heart' }, licence: 'Apache-2.0 (Kokoro-82M)', approved: false,
  });
  expect(voices[1].label).toBe('George (UK male)');
});

test('missing or unreadable model file falls back to KOKORO_V1_VOICES, installed:false', () => {
  let { voices } = vl.listVoices(project);
  expect(voices.map((v) => v.id)).toEqual([...vl.KOKORO_V1_VOICES].sort());
  expect(voices.every((v) => v.installed === false && v.scope === 'builtin')).toBe(true);
  fs.writeFileSync(path.join(modelDir, 'voices-v1.0.bin'), 'not a zip');
  ({ voices } = vl.listVoices(project));
  expect(voices.length).toBe(54);
  expect(voices[0].installed).toBe(false);
});

test('project beats machine beats builtin; sorted by scope then id', () => {
  writeVoice(machDir(), 'af_heart', { label: 'Machine heart', voice: { engine: 'kokoro', id: 'af_bella' } });
  writeVoice(machDir(), 'narrator', { label: 'Machine narrator', voice: { engine: 'kokoro', id: 'am_adam' } });
  writeVoice(projDir(), 'narrator', { label: 'Project narrator', voice: { engine: 'command', command: ['say', '{text}', '{out}'] }, heavy: true });
  const { voices, errors } = vl.listVoices(project);
  expect(errors).toEqual([]);
  expect(voices.slice(0, 2).map((v) => [v.scope, v.id])).toEqual([['project', 'narrator'], ['machine', 'af_heart']]);
  expect(voices.filter((v) => v.id === 'narrator').length).toBe(1);
  expect(voices.filter((v) => v.id === 'af_heart').length).toBe(1);
  expect(voices[0]).toMatchObject({ label: 'Project narrator', engine: 'command', heavy: true, licence: 'unknown', file: path.join(projDir(), 'narrator.json') });
  expect(voices[0].sampleText).toMatch(/Hello!/);
  expect(voices.slice(2).every((v) => v.scope === 'builtin')).toBe(true);
  const r = vl.resolveVoiceId(project, 'narrator');
  expect(r).toMatchObject({ ok: true, scope: 'project', approved: false, voice: { engine: 'command' } });
  expect(vl.resolveVoiceId(project, 'af_heart')).toMatchObject({ ok: true, scope: 'machine', voice: { id: 'af_bella' } });
  expect(vl.resolveVoiceId(project, 'am_adam')).toMatchObject({ ok: true, scope: 'builtin' });
});

test('invalid files are reported in errors[] with path and reason, never thrown', () => {
  const bad = [
    writeVoice(projDir(), 'broken', '{nope'),
    writeVoice(projDir(), 'Bad_Name', { voice: { engine: 'kokoro', id: 'af_heart' } }),
    writeVoice(projDir(), 'mismatch', { id: 'other', voice: { engine: 'kokoro', id: 'af_heart' } }),
    writeVoice(projDir(), 'chain', { voice: { voiceId: 'narrator' } }),
    writeVoice(machDir(), 'noengine', { voice: { engine: 'piper' } }),
    writeVoice(machDir(), 'escape', { voice: { engine: 'kokoro', id: 'x' }, pinFiles: ['../etc/passwd'] }),
    writeVoice(machDir(), 'longsample', { voice: { engine: 'kokoro', id: 'x' }, sampleText: 'a'.repeat(301) }),
  ];
  const { voices, errors } = vl.listVoices(project);
  expect(errors.map((e) => e.file).sort()).toEqual([...bad].sort());
  for (const e of errors) expect(typeof e.error).toBe('string');
  expect(voices.some((v) => ['broken', 'mismatch', 'chain', 'noengine', 'escape', 'longsample'].includes(v.id))).toBe(false);
  expect(vl.validateVoiceEntry({ voice: { engine: 'command', command: ['tts', '{lines}'] } }, 'batch')).toBe(null);
  expect(vl.validateVoiceEntry({ voice: { voiceId: 'x' } }, 'x')).toMatch(/voiceId/);
  expect(vl.validateVoiceEntry({ voice: { engine: 'kokoro', id: 'a' }, pinFiles: ['/abs'] }, 'x')).toMatch(/pinFiles/);
  expect(vl.validateVoiceEntry({ voice: { engine: 'kokoro', id: 'a' }, label: '' }, 'x')).toMatch(/label/);
});

test('readApprovals never throws: missing or corrupt = empty', () => {
  expect(vl.readApprovals()).toEqual({ version: 1, approvals: {} });
  fs.writeFileSync(path.join(home, 'approvals.json'), '{corrupt');
  expect(vl.readApprovals()).toEqual({ version: 1, approvals: {} });
});

test('pinOf hashes id, voice, pinFiles and the pinFiles bytes', () => {
  const entry = { id: 'n', voice: { engine: 'kokoro', id: 'af_heart' }, pinFiles: ['model.onnx'] };
  const missing = vl.pinOf(entry, project);
  expect(missing).toMatch(/^[0-9a-f]{64}$/);
  fs.writeFileSync(path.join(project, 'model.onnx'), 'v1');
  const v1 = vl.pinOf(entry, project);
  expect(v1).not.toBe(missing);
  fs.writeFileSync(path.join(project, 'model.onnx'), 'v2');
  expect(vl.pinOf(entry, project)).not.toBe(v1);
  expect(vl.pinOf({ ...entry, voice: { id: 'af_heart', engine: 'kokoro' } }, project)).toBe(vl.pinOf(entry, project));
});

test('refusal: unknown id', () => {
  expect(vl.resolveVoiceId(project, 'nobody')).toEqual({ ok: false, error: "unknown voice 'nobody'" });
});

test('refusal: an approved voice whose pin changed', () => {
  writeVoice(projDir(), 'narrator', { voice: { engine: 'command', command: ['say', '{text}', '{out}'] }, pinFiles: ['m.bin'] });
  fs.writeFileSync(path.join(project, 'm.bin'), 'weights-1');
  const before = vl.resolveVoiceId(project, 'narrator');
  expect(before.ok).toBe(true);
  approve('project', 'narrator', vl.pinOf(before.entry, project));
  const ok = vl.resolveVoiceId(project, 'narrator');
  expect(ok).toMatchObject({ ok: true, approved: true });
  expect(vl.listVoices(project).voices[0]).toMatchObject({ approved: true, pinOk: true });
  fs.writeFileSync(path.join(project, 'm.bin'), 'weights-2');
  expect(vl.resolveVoiceId(project, 'narrator')).toEqual({
    ok: false, error: "approved voice 'narrator' changed since a human approved it; re-approve it in Project Home > Video > Voices",
  });
  expect(vl.listVoices(project).voices[0]).toMatchObject({ approved: true, pinOk: false });
  // machine scope: a voice change also breaks the pin
  writeVoice(machDir(), 'host', { voice: { engine: 'kokoro', id: 'af_heart' } });
  approve('machine', 'host', vl.pinOf(vl.resolveVoiceId(project, 'host').entry, project));
  expect(vl.resolveVoiceId(project, 'host').ok).toBe(true);
  writeVoice(machDir(), 'host', { voice: { engine: 'kokoro', id: 'af_bella' } });
  expect(vl.resolveVoiceId(project, 'host').ok).toBe(false);
});

test('refusal: an approved project or machine voice whose file is gone never falls back', () => {
  // project voice shadows a machine voice and a builtin
  writeVoice(machDir(), 'af_heart', { voice: { engine: 'kokoro', id: 'af_bella' } });
  const pfile = writeVoice(projDir(), 'af_heart', { voice: { engine: 'kokoro', id: 'am_adam' } });
  approve('project', 'af_heart', vl.pinOf(vl.resolveVoiceId(project, 'af_heart').entry, project));
  fs.rmSync(pfile);
  expect(vl.resolveVoiceId(project, 'af_heart')).toEqual({ ok: false, error: "approved voice 'af_heart' was removed outside the Voices screen" });
  // machine voice shadowing a builtin
  const mfile = path.join(machDir(), 'am_adam.json');
  writeVoice(machDir(), 'am_adam', { voice: { engine: 'kokoro', id: 'am_echo' } });
  approve('machine', 'am_adam', vl.pinOf(vl.resolveVoiceId(project, 'am_adam').entry, project));
  fs.rmSync(mfile);
  expect(vl.resolveVoiceId(project, 'am_adam')).toEqual({ ok: false, error: "approved voice 'am_adam' was removed outside the Voices screen" });
});

test('exports the one approvalKey format and the canonical JSON helper', () => {
  expect(vl.approvalKey('project', project, 'narrator')).toBe(`project|${path.resolve(project)}|narrator`);
  expect(vl.approvalKey('project', `${project}/./`, 'narrator')).toBe(`project|${path.resolve(project)}|narrator`);
  expect(vl.approvalKey('machine', project, 'host')).toBe('machine||host');
  expect(vl.canonical({ b: 1, a: [2, { d: undefined, c: 'x' }] })).toBe('{"a":[2,{"c":"x"}],"b":1}');
  expect(vl.canonical(undefined)).toBe('null');
});
