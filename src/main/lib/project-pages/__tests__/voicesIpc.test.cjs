/**
 * voicesIpc.test.cjs — the Voices screen IPC: list + lastPreview stats,
 * preview bytes, approve/unapprove/delete and their refusals, and the law that
 * no admin HTTP route or MCP tool can approve, unapprove, change or delete a voice.
 *
 * Run: timeout 120 npx vitest run src/main/lib/project-pages/__tests__/voicesIpc.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { schemas } = require('../../../ipcSchemas.cjs');
const voiceLibrary = require('../../demo-video-kit/voiceLibrary.cjs');
const { registerVoicesIpc, BUILTIN_ERROR, APPROVED_DELETE_ERROR, CHANNELS } = require('../voicesIpc.cjs');

let tmp;
let home;
let root;
const savedEnv = {};

function setEnv(k, v) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  process.env[k] = v;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-voices-ipc-')));
  home = path.join(tmp, 'voices-home');
  root = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(root, '.claude', 'voices'), { recursive: true });
  fs.mkdirSync(path.join(home, 'library'), { recursive: true });
  setEnv('SM_VOICES_HOME', home);
  setEnv('SM_VOICE_LANE_DIR', path.join(home, 'lane'));
  setEnv('KOKORO_MODEL_DIR', path.join(tmp, 'no-model'));
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const kokoro = (id) => ({ engine: 'kokoro', id });
function writeProjectVoice(id, voice = kokoro('af_heart')) {
  const f = path.join(root, '.claude', 'voices', `${id}.json`);
  fs.writeFileSync(f, JSON.stringify({ label: id, voice }));
  return f;
}
function writeMachineVoice(id, voice = kokoro('am_adam')) {
  const f = path.join(home, 'library', `${id}.json`);
  fs.writeFileSync(f, JSON.stringify({ label: id, voice }));
  return f;
}
const readApprovalsFile = () => JSON.parse(fs.readFileSync(path.join(home, 'approvals.json'), 'utf8'));

function setup(extra = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => { handlers.set(ch, fn); } };
  const validated = [];
  registerVoicesIpc(ipcMain, {
    schemas,
    validatePath: (p) => { validated.push(p); if (!path.isAbsolute(p)) throw new Error('bad path'); return p; },
    resolveProjectRoot: (p) => p,
    now: () => new Date('2026-11-23T20:00:00.000Z'),
    ...extra,
  });
  const call = (ch, payload) => handlers.get(ch)({}, payload);
  return { handlers, call, validated };
}

test('registers exactly the five voices channels', () => {
  const { handlers } = setup();
  expect([...handlers.keys()].sort()).toEqual([...CHANNELS].sort());
});

test('voices:list returns voices with approval state, lastPreview from usage and the lane', async () => {
  writeProjectVoice('narrator');
  writeMachineVoice('host');
  const usage = [
    { at: '2026-11-23T19:00:00.000Z', voiceId: 'narrator', projectRoot: root, kind: 'preview', ok: true, audioSeconds: 2.5, wallMs: 900 },
    { at: '2026-11-23T18:00:00.000Z', voiceId: 'narrator', projectRoot: root, kind: 'preview', ok: true, audioSeconds: 1, wallMs: 100 },
    { at: '2026-11-23T19:30:00.000Z', voiceId: 'host', projectRoot: root, kind: 'video', ok: true, audioSeconds: 9, wallMs: 5000 },
  ];
  const lane = { heavy: [], light: [{ voiceId: 'host', label: 'host', projectRoot: root, pid: 1, since: 'x', position: 0 }] };
  let usageArgs = null;
  const { call, validated } = setup({
    voiceLane: { readUsage: (a) => { usageArgs = a; return usage; }, laneSnapshot: () => lane },
  });
  const r = await call('voices:list', { cwd: root });
  expect(validated).toEqual([root]);
  expect(usageArgs.projectRoot).toBe(root);
  const narrator = r.voices.find((v) => v.id === 'narrator');
  expect(narrator.scope).toBe('project');
  expect(narrator.approved).toBe(false);
  expect(narrator.lastPreview).toEqual({ at: '2026-11-23T19:00:00.000Z', wallMs: 900, audioSeconds: 2.5 });
  const host = r.voices.find((v) => v.id === 'host');
  expect(host.scope).toBe('machine');
  expect(host.lastPreview).toBeNull();
  expect(host.inLane).toEqual({ lane: 'light', position: 0 });
  expect(r.voices.some((v) => v.scope === 'builtin')).toBe(true);
  expect(r.lane).toEqual(lane);
  expect(Array.isArray(r.errors)).toBe(true);
});

test('voices:list rejects a payload with extra keys and an invalid cwd', async () => {
  const { call } = setup();
  await expect(call('voices:list', { cwd: root, extra: 1 })).rejects.toThrow();
  await expect(call('voices:list', { cwd: 'relative' })).rejects.toThrow('bad path');
});

test('voices:preview forwards to previewVoice and returns bytes as a Uint8Array', async () => {
  writeProjectVoice('narrator');
  let args = null;
  const { call } = setup({
    previewVoice: async (a) => { args = a; return { ok: true, cached: true, wavPath: '/x.wav', bytes: Buffer.from([1, 2, 3]) }; },
  });
  const r = await call('voices:preview', { cwd: root, voiceId: 'narrator', text: 'Hello' });
  expect(args).toEqual({ projectRoot: root, voiceId: 'narrator', text: 'Hello' });
  expect(r.ok).toBe(true);
  expect(r.bytes).toBeInstanceOf(Uint8Array);
  expect(Buffer.isBuffer(r.bytes)).toBe(false);
  expect([...r.bytes]).toEqual([1, 2, 3]);

  const fail = setup({ previewVoice: async () => ({ ok: false, error: 'nope' }) });
  expect(await fail.call('voices:preview', { cwd: root, voiceId: 'narrator', text: 'Hi' })).toEqual({ ok: false, error: 'nope' });
  await expect(fail.call('voices:preview', { cwd: root, voiceId: 'Bad Id', text: 'Hi' })).rejects.toThrow();
});

test('voices:approve writes approvals.json with pinOf for project and machine voices; resolveVoiceId accepts it', async () => {
  writeProjectVoice('narrator');
  writeMachineVoice('host');
  const { call } = setup();
  const a = await call('voices:approve', { cwd: root, voiceId: 'narrator' });
  expect(a.ok).toBe(true);
  const b = await call('voices:approve', { cwd: root, voiceId: 'host' });
  expect(b.ok).toBe(true);
  const file = readApprovalsFile();
  expect(file.version).toBe(1);
  const entries = voiceLibrary.listVoices(root).voices;
  const narrator = entries.find((v) => v.id === 'narrator');
  const host = entries.find((v) => v.id === 'host');
  expect(file.approvals[`project|${root}|narrator`].pin).toBe(voiceLibrary.pinOf(narrator, root));
  expect(file.approvals['machine||host'].pin).toBe(voiceLibrary.pinOf(host, root));
  expect(voiceLibrary.approvalKey('project', root, 'narrator')).toBe(`project|${root}|narrator`);
  expect(narrator.approved && narrator.pinOk).toBe(true);
  expect(host.approved && host.pinOk).toBe(true);
  expect(voiceLibrary.resolveVoiceId(root, 'narrator').approved).toBe(true);
});

test('writer and reader agree: voicesIpc uses voiceLibrary\'s approvalKey and writes {pin, approvedAt}', async () => {
  expect(require('../voicesIpc.cjs').approvalKey).toBeUndefined();
  expect(typeof voiceLibrary.approvalKey).toBe('function');
  expect(typeof voiceLibrary.canonical).toBe('function');
  writeProjectVoice('narrator');
  writeMachineVoice('host');
  const { call } = setup();
  const a = await call('voices:approve', { cwd: root, voiceId: 'narrator' });
  expect(a).toMatchObject({ ok: true, approvedAt: '2026-11-23T20:00:00.000Z' });
  expect(a.at).toBeUndefined();
  await call('voices:approve', { cwd: root, voiceId: 'host' });
  const file = readApprovalsFile();
  for (const [scope, id] of [['project', 'narrator'], ['machine', 'host']]) {
    const rec = file.approvals[voiceLibrary.approvalKey(scope, root, id)];
    expect(Object.keys(rec).sort()).toEqual(['approvedAt', 'pin']);
    expect(rec.approvedAt).toBe('2026-11-23T20:00:00.000Z');
    expect(new Date(rec.approvedAt).toISOString()).toBe(rec.approvedAt);
    expect(voiceLibrary.resolveVoiceId(root, id)).toMatchObject({ ok: true, approved: true, scope });
    expect(voiceLibrary.listVoices(root).voices.find((v) => v.id === id)).toMatchObject({ approved: true, pinOk: true });
  }
  expect((await call('voices:unapprove', { cwd: root, voiceId: 'narrator' })).ok).toBe(true);
  expect(voiceLibrary.resolveVoiceId(root, 'narrator')).toMatchObject({ ok: true, approved: false });
});

test('voices:approve re-approves a voice changed since approval', async () => {
  const f = writeProjectVoice('narrator');
  const { call } = setup();
  await call('voices:approve', { cwd: root, voiceId: 'narrator' });
  fs.writeFileSync(f, JSON.stringify({ label: 'narrator', voice: kokoro('af_bella') }));
  expect(voiceLibrary.resolveVoiceId(root, 'narrator').ok).toBe(false);
  expect((await call('voices:approve', { cwd: root, voiceId: 'narrator' })).ok).toBe(true);
  expect(voiceLibrary.resolveVoiceId(root, 'narrator').ok).toBe(true);
});

test('voices:approve refuses a built-in and an unknown voice', async () => {
  const { call } = setup();
  expect(await call('voices:approve', { cwd: root, voiceId: 'af_heart' })).toEqual({ ok: false, error: BUILTIN_ERROR });
  expect((await call('voices:approve', { cwd: root, voiceId: 'nobody' })).ok).toBe(false);
  expect(fs.existsSync(path.join(home, 'approvals.json'))).toBe(false);
});

test('voices:unapprove removes that approval and keeps the others; refuses a built-in and a non-approved voice', async () => {
  writeProjectVoice('narrator');
  writeMachineVoice('host');
  const { call } = setup();
  await call('voices:approve', { cwd: root, voiceId: 'narrator' });
  await call('voices:approve', { cwd: root, voiceId: 'host' });
  expect(await call('voices:unapprove', { cwd: root, voiceId: 'narrator' })).toEqual({ ok: true, voiceId: 'narrator' });
  expect(Object.keys(readApprovalsFile().approvals)).toEqual(['machine||host']);
  expect((await call('voices:unapprove', { cwd: root, voiceId: 'narrator' })).ok).toBe(false);
  expect(await call('voices:unapprove', { cwd: root, voiceId: 'af_heart' })).toEqual({ ok: false, error: BUILTIN_ERROR });
});

test('voices:unapprove clears the approval of a voice whose file was removed outside the app', async () => {
  const f = writeProjectVoice('narrator');
  const { call } = setup();
  await call('voices:approve', { cwd: root, voiceId: 'narrator' });
  fs.rmSync(f);
  expect(voiceLibrary.resolveVoiceId(root, 'narrator').ok).toBe(false);
  expect((await call('voices:unapprove', { cwd: root, voiceId: 'narrator' })).ok).toBe(true);
  expect(readApprovalsFile().approvals).toEqual({});
});

test('voices:delete removes the effective voice file; refuses an approved voice and a built-in', async () => {
  const pf = writeProjectVoice('narrator');
  const mf = writeMachineVoice('narrator');
  const { call } = setup();
  await call('voices:approve', { cwd: root, voiceId: 'narrator' });
  expect(await call('voices:delete', { cwd: root, voiceId: 'narrator' })).toEqual({ ok: false, error: APPROVED_DELETE_ERROR });
  expect(APPROVED_DELETE_ERROR).toContain('unapprove it first');
  expect(fs.existsSync(pf)).toBe(true);
  await call('voices:unapprove', { cwd: root, voiceId: 'narrator' });
  const r = await call('voices:delete', { cwd: root, voiceId: 'narrator' });
  expect(r).toEqual({ ok: true, voiceId: 'narrator', scope: 'project', file: pf });
  expect(fs.existsSync(pf)).toBe(false);
  expect(fs.existsSync(mf)).toBe(true);
  expect(await call('voices:delete', { cwd: root, voiceId: 'af_heart' })).toEqual({ ok: false, error: BUILTIN_ERROR });
  expect((await call('voices:delete', { cwd: root, voiceId: 'nobody' })).ok).toBe(false);
});

test('every voices channel payload schema is strict', () => {
  for (const name of ['voicesList', 'voicesPreview', 'voicesApprove', 'voicesUnapprove', 'voicesDelete']) {
    const s = schemas[name];
    expect(s, name).toBeTruthy();
    const base = name === 'voicesList' ? { cwd: '/p' } : name === 'voicesPreview' ? { cwd: '/p', voiceId: 'a', text: 't' } : { cwd: '/p', voiceId: 'a' };
    expect(s.safeParse(base).success, name).toBe(true);
    expect(s.safeParse({ ...base, extra: 1 }).success, name).toBe(false);
  }
});

// ── The single-writer law: approvals and deletions only through this renderer IPC.
const WRITE_WORD = /approv|unapprov|delete|remove|write|save|set|change|update|edit|pin/i;

function fakeAdminHttp() {
  const routes = new Map();
  return { routes, registerRoute(method, url, handler) { routes.set(`${method} ${url}`, handler); } };
}

test('the admin route table has no voices write route', () => {
  const http = fakeAdminHttp();
  const mods = [
    ['../../feedback-remote/projectHomeAdminRoutes.cjs', undefined],
    ['../../feedback-remote/macroAdminRoutes.cjs', { startExternalNewSession: () => {}, isTabBusy: () => false, onChanged: () => {} }],
    ['../../persona-macro/agentAdminRoutes.cjs', undefined],
    ['../../tasks/taskAdminRoutes.cjs', undefined],
    ['../../feedback-remote/needsYouAdminRoutes.cjs', { onChanged: () => {} }],
    ['../../feedback-remote/customerFeedbackAdminRoutes.cjs', undefined],
    ['../../feedback-remote/siteFeedbackAdminRoutes.cjs', undefined],
    ['../../telemetry/eventsAdminRoutes.cjs', undefined],
    ['../../epic/epicAdminRoutes.cjs', { isTabBusy: () => false, listJobs: () => [] }],
  ];
  for (const [mod, deps] of mods) require(mod).registerAdminRoute(http, deps);
  const keys = [...http.routes.keys()];
  expect(keys.length).toBeGreaterThan(5);
  expect(keys.filter((k) => /voice/i.test(k) && (/^(POST|PUT|PATCH|DELETE) /.test(k) && !/\/(preview|list|read)$/.test(k) || WRITE_WORD.test(k.split(' ')[1])))).toEqual([]);

  // Every admin route URL literal anywhere in src/main and the MCP server: none writes a voice.
  const srcMain = path.resolve(__dirname, '..', '..', '..');
  const files = [path.resolve(srcMain, '..', '..', 'scripts', 'scheduler-mcp-server.cjs')];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); } else if (e.name.endsWith('.cjs')) files.push(p);
    }
  };
  walk(srcMain);
  const offenders = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/['"`](\/admin\/[^'"`\s]*voice[^'"`\s]*)['"`]/gi)) {
      if (/approv|delete|remove|write|save|change|update|edit|pin/i.test(m[1])) offenders.push(`${f}: ${m[1]}`);
    }
    // approvals.json is written only by voicesIpc.cjs (voiceLibrary.cjs reads it).
    if (/approvals\.json/.test(text) && !/voicesIpc\.cjs$|voiceLibrary\.cjs$/.test(f)) offenders.push(`${f}: approvals.json`);
  }
  expect(offenders).toEqual([]);
});

test('no MCP tool can approve, unapprove, change or delete a voice', () => {
  const { MCP_TOOL_CATALOG } = require('../../mcpToolCatalog.cjs');
  const bad = MCP_TOOL_CATALOG.map((t) => t.name).filter((n) => /voice/i.test(n) && WRITE_WORD.test(n));
  expect(bad).toEqual([]);
});

test('preload exposes voices.list as read and every voices writer/preview as desktop-only (deny)', () => {
  const table = require('../../../../preload/apiSurface.cjs');
  const rows = table.filter((r) => r.ns === 'voices').map((r) => [r.method, r.channel, r.remote]);
  expect(rows).toEqual([
    ['list', 'voices:list', 'read'],
    ['preview', 'voices:preview', 'deny'],
    ['approve', 'voices:approve', 'deny'],
    ['unapprove', 'voices:unapprove', 'deny'],
    ['delete', 'voices:delete', 'deny'],
  ]);
});
