/**
 * macroAdminRoutes.test.cjs — lib/feedback-remote/macroAdminRoutes.cjs's three routes
 * (GET /admin/macros?cwd=…, POST /admin/macros/save {cwd, id?, label,
 * agentName, tag, prompt} and POST /admin/macros/delete {cwd, id,
 * originClaudeSessionId?}), backed by a temp macros.json via macroLibrary's
 * `{ filePath }` option.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/macroAdminRoutes.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const { registerAdminRoute } = require('../lib/feedback-remote/macroAdminRoutes.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkProjectCwd() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-macro-admin-'));
  config.addAllowedRoot(dir);
  fs.mkdirSync(path.join(dir, 'session-manager-operations'), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

async function mkMacrosFile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-macro-store-'));
  tmpDirs.push(dir);
  return path.join(dir, 'macros.json');
}

/** Fake adminHttp stub: captures registered routes and invokes one directly. */
function makeFakeAdminHttp() {
  const routes = new Map();
  return {
    registerRoute(method, url, handler) {
      routes.set(`${method} ${url}`, handler);
    },
    async call(method, url, { rawBody, body, query } = {}) {
      const handler = routes.get(`${method} ${url}`);
      if (!handler) throw new Error(`no route registered for ${method} ${url}`);
      const text = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : '';
      const chunks = text ? [Buffer.from(text)] : [];
      const req = {
        on(event, cb) {
          if (event === 'data') chunks.forEach((c) => cb(c));
          if (event === 'end') cb();
          return req;
        },
      };
      let status = null;
      let payload = null;
      const res = {
        writeHead(s) { status = s; },
        end(b) { payload = b ? JSON.parse(b) : null; },
      };
      const params = new URLSearchParams(query || {});
      await handler(req, res, params);
      return { status, body: payload };
    },
    routes,
  };
}

function makeHandlers() {
  let changedCount = 0;
  const onChanged = () => { changedCount += 1; };
  return { onChanged, getChangedCount: () => changedCount };
}

test('registers GET /admin/macros, POST /admin/macros/save and POST /admin/macros/delete', () => {
  const adminHttp = makeFakeAdminHttp();
  const { onChanged } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged });
  expect([...adminHttp.routes.keys()]).toEqual([
    'GET /admin/macros',
    'POST /admin/macros/save',
    'POST /admin/macros/delete',
  ]);
});

test('create: projects is [cwd], surface is sessions, onChanged called once', async () => {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged, getChangedCount } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const { status, body } = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, label: 'Publish', agentName: 'builder', tag: 'build', prompt: 'Publish this project' },
  });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.macro.projects).toEqual([fs.realpathSync(cwd)]);
  expect(body.macro.surface).toBe('sessions');
  expect(getChangedCount()).toBe(1);
});

test('list filters by cwd and includes * macros', async () => {
  const cwdA = await mkProjectCwd();
  const cwdB = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd: cwdA, label: 'A only', agentName: 'builder', tag: 'build', prompt: 'do a' },
  });
  const macroLibrary = require('../lib/persona-macro/macroLibrary.cjs');
  await macroLibrary.saveMacro({ label: 'Everywhere', agentName: 'builder', tag: 'build', prompt: 'do everywhere', projects: ['*'] }, { filePath });

  const resA = await adminHttp.call('GET', '/admin/macros', { query: { cwd: cwdA } });
  expect(resA.status).toBe(200);
  const labelsA = resA.body.macros.map((m) => m.label);
  expect(labelsA).toContain('A only');
  expect(labelsA).toContain('Everywhere');

  const resB = await adminHttp.call('GET', '/admin/macros', { query: { cwd: cwdB } });
  const labelsB = resB.body.macros.map((m) => m.label);
  expect(labelsB).not.toContain('A only');
  expect(labelsB).toContain('Everywhere');
});

test('builtin id is refused with 400, onChanged never called', async () => {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged, getChangedCount } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const { status, body } = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, id: 'builtin-project-home', label: 'x', agentName: 'builder', tag: 'build', prompt: 'x' },
  });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(getChangedCount()).toBe(0);
});

test('unknown id is refused with 400', async () => {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged, getChangedCount } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const { status, body } = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, id: 'nonexistent-abc123', label: 'x', agentName: 'builder', tag: 'build', prompt: 'x' },
  });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(getChangedCount()).toBe(0);
});

test('update of a macro whose projects do not include the resolved cwd is refused', async () => {
  const cwdA = await mkProjectCwd();
  const cwdB = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged, getChangedCount } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const created = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd: cwdA, label: 'A only', agentName: 'builder', tag: 'build', prompt: 'do a' },
  });
  expect(created.status).toBe(200);
  const id = created.body.macro.id;

  const { status, body } = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd: cwdB, id, label: 'hijacked', agentName: 'builder', tag: 'build', prompt: 'do b' },
  });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(getChangedCount()).toBe(1); // only the create above
});

test('non-absolute cwd is refused with 400 on both routes', async () => {
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged, getChangedCount } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const list = await adminHttp.call('GET', '/admin/macros', { query: { cwd: 'relative/dir' } });
  expect(list.status).toBe(400);

  const save = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd: 'relative/dir', label: 'x', agentName: 'builder', tag: 'build', prompt: 'x' },
  });
  expect(save.status).toBe(400);
  expect(getChangedCount()).toBe(0);
});

test('zod validation error on bad field surfaces as a 400 with a message, onChanged never called', async () => {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged, getChangedCount } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const { status, body } = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, label: '', agentName: 'builder', tag: 'build', prompt: 'x' },
  });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(typeof body.error).toBe('string');
  expect(getChangedCount()).toBe(0);
});

const STREAM_INPUTS = [{ name: 'stream', label: 'Stream', default: 'education-veggies' }];

test('create with inputs returns 200, GET list includes them, update without inputs keeps them', async () => {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const created = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, label: 'Stream', agentName: 'builder', tag: 'build', prompt: 'stream={{stream}}', inputs: STREAM_INPUTS },
  });
  expect(created.status).toBe(200);
  expect(created.body.macro.inputs).toEqual(STREAM_INPUTS);

  const list = await adminHttp.call('GET', '/admin/macros', { query: { cwd } });
  const listed = list.body.macros.find((m) => m.id === created.body.macro.id);
  expect(listed.inputs).toEqual(STREAM_INPUTS);

  const updated = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, id: created.body.macro.id, label: 'Stream 2', agentName: 'builder', tag: 'build', prompt: 'stream={{stream}}' },
  });
  expect(updated.status).toBe(200);
  const list2 = await adminHttp.call('GET', '/admin/macros', { query: { cwd } });
  const relisted = list2.body.macros.find((m) => m.id === created.body.macro.id);
  expect(relisted.label).toBe('Stream 2');
  expect(relisted.inputs).toEqual(STREAM_INPUTS);
});

test('undeclared placeholder with no inputs is refused with 400', async () => {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged, getChangedCount } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const { status, body } = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, label: 'Bad', agentName: 'builder', tag: 'build', prompt: 'Run {{x}}' },
  });
  expect(status).toBe(400);
  expect(body.error).toContain('{{x}}');
  expect(getChangedCount()).toBe(0);
});

test('undeclared placeholder with non-empty inputs is refused with 400, onChanged never called', async () => {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged, getChangedCount } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const { status, body } = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, label: 'Bad', agentName: 'builder', tag: 'build', prompt: 'stream={{stream}} x={{x}}', inputs: STREAM_INPUTS },
  });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(body.error).toContain('{{x}}');
  expect(getChangedCount()).toBe(0);
});

test('non-project cwd (missing session-manager-operations/) is refused with 400', async () => {
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const bare = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-macro-bare-'));
  tmpDirs.push(bare);
  config.addAllowedRoot(bare);

  const res = await adminHttp.call('GET', '/admin/macros', { query: { cwd: bare } });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain('not a Session Manager project');
});

test('admin save never sets autoStartTargets on create and leaves a stored list untouched on update', async () => {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });
  const macroLibrary = require('../lib/persona-macro/macroLibrary.cjs');

  const created = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, label: 'Sneaky', agentName: 'builder', tag: 'build', prompt: 'x', autoStartTargets: ['*'] },
  });
  expect(created.status).toBe(200);
  expect('autoStartTargets' in created.body.macro).toBe(false);

  const id = created.body.macro.id;
  await macroLibrary.saveMacro({ id, label: 'Sneaky', agentName: 'builder', tag: 'build', prompt: 'x', autoStartTargets: ['/work/b'] }, { filePath });
  for (const ast of [['*'], []]) {
    const upd = await adminHttp.call('POST', '/admin/macros/save', {
      body: { cwd, id, label: 'Sneaky2', agentName: 'builder', tag: 'build', prompt: 'x', autoStartTargets: ast },
    });
    expect(upd.status).toBe(200);
    expect(upd.body.macro.autoStartTargets).toEqual(['/work/b']);
  }
});

// --- POST /admin/macros/delete ----------------------------------------------

const { readTail } = require('../lib/telemetry/auditLog.cjs');
const macroLib = require('../lib/persona-macro/macroLibrary.cjs');

function deleteEvents(id) {
  return readTail(1_000_000)
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'admin_macro_delete' && e.macro?.id === id);
}

async function setupDelete() {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const h = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged: h.onChanged }, { filePath });
  return { cwd, filePath, adminHttp, ...h };
}

test('delete: sole-project macro is deleted, listing drops it, onChanged once, one audit event', async () => {
  const { cwd, adminHttp, getChangedCount } = await setupDelete();
  const created = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, label: 'Doomed', agentName: 'builder', tag: 'build', prompt: 'x' },
  });
  const id = created.body.macro.id;
  const before = getChangedCount();
  const res = await adminHttp.call('POST', '/admin/macros/delete', { body: { cwd, id, originClaudeSessionId: 'sess-1' } });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.deleted).toBe(true);
  expect(res.body.macro.id).toBe(id);
  const list = await adminHttp.call('GET', '/admin/macros', { query: { cwd } });
  expect(list.body.macros.map((m) => m.id)).not.toContain(id);
  expect(getChangedCount() - before).toBe(1);
  const ev = deleteEvents(id);
  expect(ev).toHaveLength(1);
  expect(ev[0].route).toBe('/admin/macros/delete');
  expect(ev[0].cwd).toBe(fs.realpathSync(cwd));
  expect(ev[0].deleted).toBe(true);
  expect(ev[0].originClaudeSessionId).toBe('sess-1');
});

test('delete: macro shared by two projects only loses this project', async () => {
  const { cwd, filePath, adminHttp, getChangedCount } = await setupDelete();
  const other = await mkProjectCwd();
  const m = await macroLib.saveMacro(
    { label: 'Shared', agentName: 'builder', tag: 'build', prompt: 'x', projects: [fs.realpathSync(cwd), fs.realpathSync(other)] },
    { filePath },
  );
  const res = await adminHttp.call('POST', '/admin/macros/delete', { body: { cwd, id: m.id } });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ ok: true, deleted: false });
  expect(res.body.macro.id).toBe(m.id);
  const list = await adminHttp.call('GET', '/admin/macros', { query: { cwd: other } });
  expect(list.body.macros.map((x) => x.id)).toContain(m.id);
  expect(getChangedCount()).toBe(1);
  const ev = deleteEvents(m.id);
  expect(ev).toHaveLength(1);
  expect(ev[0].deleted).toBe(false);
  expect(ev[0].originClaudeSessionId).toBeNull();
});

test('delete: originClaudeSessionId outside 1..128 chars or non-string is recorded as null', async () => {
  const { cwd, adminHttp } = await setupDelete();
  for (const origin of ['', 'x'.repeat(129), 42]) {
    const created = await adminHttp.call('POST', '/admin/macros/save', {
      body: { cwd, label: 'O', agentName: 'builder', tag: 'build', prompt: 'x' },
    });
    const id = created.body.macro.id;
    const res = await adminHttp.call('POST', '/admin/macros/delete', { body: { cwd, id, originClaudeSessionId: origin } });
    expect(res.status).toBe(200);
    expect(deleteEvents(id)[0].originClaudeSessionId).toBeNull();
  }
});

test('delete: refusals return 400 with no onChanged and no audit event', async () => {
  const { cwd, filePath, adminHttp, getChangedCount } = await setupDelete();
  const other = await mkProjectCwd();
  const foreign = await macroLib.saveMacro(
    { label: 'Foreign', agentName: 'builder', tag: 'build', prompt: 'x', projects: [fs.realpathSync(other)] }, { filePath });
  const star = await macroLib.saveMacro(
    { label: 'Star', agentName: 'builder', tag: 'build', prompt: 'x', projects: ['*'] }, { filePath });
  const cases = [
    { body: { cwd, id: 'builtin-project-home' }, id: 'builtin-project-home' },
    { body: { cwd, id: foreign.id }, id: foreign.id },
    { body: { cwd, id: star.id }, id: star.id },
    { body: { cwd, id: 'nonexistent-abc123' }, id: 'nonexistent-abc123' },
    { body: { cwd, id: 'bad id!/..' }, error: 'invalid macro id' },
    { body: { cwd }, error: 'id is required' },
    { body: { cwd: 'relative/dir', id: foreign.id } },
    { rawBody: '{nope', error: 'invalid JSON body' },
    { rawBody: 'null', error: 'invalid JSON body' },
  ];
  for (const c of cases) {
    const res = await adminHttp.call('POST', '/admin/macros/delete', c.body ? { body: c.body } : { rawBody: c.rawBody });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
    if (c.error) expect(res.body.error).toContain(c.error);
    if (c.id) expect(deleteEvents(c.id)).toHaveLength(0);
  }
  expect(getChangedCount()).toBe(0);
  const list = await adminHttp.call('GET', '/admin/macros', { query: { cwd: other } });
  expect(list.body.macros.map((m) => m.id)).toContain(foreign.id);
});

// --- surface / '*' projects / verified human request ------------------------

const humanLedger = require('../lib/feedback-remote/humanPromptLedger.cjs');
const { quoteNamesEveryProject, quoteNamesProjectHome } = require('../lib/feedback-remote/macroAdminRoutes.cjs');

function saveEvents(id) {
  return readTail(1_000_000)
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'admin_macro_save' && e.macroId === id);
}

const MAC = { label: 'Review', agentName: 'builder', tag: 'build', prompt: 'x' };
const HUMAN_TEXT = 'please show the Review macro in every project on Project Home';
const HUMAN_QUOTE = 'show the Review macro in every project';

test('quoteNamesEveryProject matches every/all/each projects and everywhere only', () => {
  for (const q of ['in every project', 'for all my projects', 'each of the projects', 'every-project', 'show everywhere']) {
    expect(quoteNamesEveryProject(q)).toBe(true);
  }
  for (const q of ['in this project', 'all proj', 'everyprojects', '', 42]) {
    expect(quoteNamesEveryProject(q)).toBe(false);
  }
});

const PH_TEXT = 'Write a new Macro for Project Home - a CPU audit';
const PH_QUOTE = 'Write a new Macro for Project Home';

test('quoteNamesProjectHome matches Project Home spellings only', () => {
  for (const q of ['Write a new Macro for Project Home', 'add a project-home tool', 'PROJECT_HOME tools']) {
    expect(quoteNamesProjectHome(q)).toBe(true);
  }
  for (const q of ['home project', 'in this project', '', 42]) {
    expect(quoteNamesProjectHome(q)).toBe(false);
  }
});

test('surface: sessions create stays [cwd]; project-home saves store [*] and keep it on update', async () => {
  humanLedger._resetForTests();
  const { cwd, adminHttp, getChangedCount } = await setupDelete();
  const origin = 'sess-surface';
  humanLedger.recordHumanPrompt(origin, PH_TEXT);
  const verified = { humanRequestQuote: PH_QUOTE, originClaudeSessionId: origin };

  const plain = await adminHttp.call('POST', '/admin/macros/save', { body: { cwd, ...MAC, surface: 'sessions' } });
  expect(plain.status).toBe(200);
  expect(plain.body.macro.projects).toEqual([fs.realpathSync(cwd)]);
  const upd0 = await adminHttp.call('POST', '/admin/macros/save', { body: { cwd, id: plain.body.macro.id, ...MAC, label: 'R2' } });
  expect(upd0.status).toBe(200);
  expect(upd0.body.macro.projects).toEqual([fs.realpathSync(cwd)]);

  const created = await adminHttp.call('POST', '/admin/macros/save', { body: { cwd, ...MAC, surface: 'project-home', ...verified } });
  expect(created.status).toBe(200);
  expect(created.body.macro.surface).toBe('project-home');
  expect(created.body.macro.projects).toEqual(['*']);
  const id = created.body.macro.id;
  const upd = await adminHttp.call('POST', '/admin/macros/save', { body: { cwd, id, ...MAC, label: 'Renamed', ...verified } });
  expect(upd.status).toBe(200);
  expect(upd.body.macro.surface).toBe('project-home');
  expect(upd.body.macro.projects).toEqual(['*']);
  expect(getChangedCount()).toBe(4);
  humanLedger._resetForTests();
});

test('project-home create with a verified Project Home quote stores [*] and writes one audit event', async () => {
  humanLedger._resetForTests();
  const { cwd, adminHttp, getChangedCount } = await setupDelete();
  const origin = 'sess-ph-ok';
  humanLedger.recordHumanPrompt(origin, PH_TEXT);
  const res = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, ...MAC, label: 'CPU audit', surface: 'project-home', humanRequestQuote: PH_QUOTE, originClaudeSessionId: origin },
  });
  expect(res.status).toBe(200);
  expect(res.body.macro.projects).toEqual(['*']);
  const ev = saveEvents(res.body.macro.id);
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({
    route: '/admin/macros/save', projects: ['*'], surface: 'project-home', created: true,
    humanRequestQuote: PH_QUOTE, originClaudeSessionId: origin,
  });
  expect(getChangedCount()).toBe(1);
  humanLedger._resetForTests();
});

test('project-home create or switch is refused without a verified Project Home quote; no write, onChanged or audit', async () => {
  humanLedger._resetForTests();
  const { cwd, adminHttp, getChangedCount } = await setupDelete();
  const origin = 'sess-ph-refuse';
  humanLedger.recordHumanPrompt(origin, 'please keep the Review macro available for this project only');
  const existing = await adminHttp.call('POST', '/admin/macros/save', { body: { cwd, ...MAC, label: 'SessionsOne' } });
  expect(existing.status).toBe(200);
  const id = existing.body.macro.id;
  const before = getChangedCount();
  const cases = [
    {},
    { humanRequestQuote: PH_QUOTE },
    { humanRequestQuote: PH_QUOTE, originClaudeSessionId: origin },
    { humanRequestQuote: 'keep the Review macro available for this project only', originClaudeSessionId: origin },
  ];
  for (const extra of cases) {
    for (const idPart of [{}, { id }]) {
      const res = await adminHttp.call('POST', '/admin/macros/save', {
        body: { cwd, ...MAC, label: 'PhRefused', surface: 'project-home', ...idPart, ...extra },
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Project Home ▸ Tools ▸ Add a tool');
    }
  }
  expect(getChangedCount()).toBe(before);
  expect(saveEvents(id)).toHaveLength(1);
  const list = await adminHttp.call('GET', '/admin/macros', { query: { cwd } });
  const labels = list.body.macros.map((m) => m.label);
  expect(labels).not.toContain('PhRefused');
  expect(list.body.macros.find((m) => m.id === id)).toMatchObject({ surface: 'sessions', projects: [fs.realpathSync(cwd)] });
  humanLedger._resetForTests();
});

test("sessions '*' create needs an every-project quote; a Project Home quote is refused", async () => {
  humanLedger._resetForTests();
  const { cwd, adminHttp, getChangedCount } = await setupDelete();
  const origin = 'sess-sessions-star';
  humanLedger.recordHumanPrompt(origin, PH_TEXT);
  const res = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, ...MAC, label: 'SessStar', projects: ['*'], humanRequestQuote: PH_QUOTE, originClaudeSessionId: origin },
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain('Show in every project');
  const noQuote = await adminHttp.call('POST', '/admin/macros/save', { body: { cwd, ...MAC, label: 'SessPlain' } });
  expect(noQuote.status).toBe(200);
  expect(noQuote.body.macro.projects).toEqual([fs.realpathSync(cwd)]);
  expect(getChangedCount()).toBe(1);
  humanLedger._resetForTests();
});

test('projects other than exactly ["*"] is refused with 400', async () => {
  const { cwd, adminHttp, getChangedCount } = await setupDelete();
  for (const projects of [['/work/other'], [], ['*', '/x'], '*', ['*', '*']]) {
    const res = await adminHttp.call('POST', '/admin/macros/save', { body: { cwd, ...MAC, projects } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('["*"]');
  }
  expect(getChangedCount()).toBe(0);
});

test("'*' create is refused without a verified human request; no write, onChanged or audit", async () => {
  humanLedger._resetForTests();
  const { cwd, adminHttp, getChangedCount } = await setupDelete();
  const origin = 'sess-star-refuse';
  humanLedger.recordHumanPrompt(origin, 'please keep the Review macro available for this project only');
  const cases = [
    {},
    { humanRequestQuote: HUMAN_QUOTE },
    { humanRequestQuote: HUMAN_QUOTE, originClaudeSessionId: origin },
    { humanRequestQuote: 'keep the Review macro available for this project only', originClaudeSessionId: origin },
  ];
  for (const extra of cases) {
    const res = await adminHttp.call('POST', '/admin/macros/save', {
      body: { cwd, ...MAC, label: 'StarRefused', projects: ['*'], ...extra },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Show in every project');
  }
  expect(getChangedCount()).toBe(0);
  const list = await adminHttp.call('GET', '/admin/macros', { query: { cwd } });
  expect(list.body.macros.map((m) => m.label)).not.toContain('StarRefused');
  humanLedger._resetForTests();
});

test("'*' create and '*' update are accepted with a verified quote; audit written on success only", async () => {
  humanLedger._resetForTests();
  const { cwd, adminHttp, getChangedCount } = await setupDelete();
  const other = await mkProjectCwd();
  const origin = 'sess-star-ok';
  humanLedger.recordHumanPrompt(origin, HUMAN_TEXT);
  const verified = { humanRequestQuote: HUMAN_QUOTE, originClaudeSessionId: origin };

  const created = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, ...MAC, projects: ['*'], surface: 'project-home', ...verified },
  });
  expect(created.status).toBe(200);
  expect(created.body.macro.projects).toEqual(['*']);
  expect(created.body.macro.surface).toBe('project-home');
  const id = created.body.macro.id;
  let ev = saveEvents(id);
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({
    route: '/admin/macros/save', cwd: fs.realpathSync(cwd), projects: ['*'], surface: 'project-home',
    created: true, humanRequestQuote: HUMAN_QUOTE, originClaudeSessionId: origin,
  });

  // update a '*' macro from a different project: needs a verified quote, reachable via macroVisibleIn
  const refused = await adminHttp.call('POST', '/admin/macros/save', { body: { cwd: other, id, ...MAC, label: 'nope' } });
  expect(refused.status).toBe(400);
  expect(saveEvents(id)).toHaveLength(1);
  const upd = await adminHttp.call('POST', '/admin/macros/save', { body: { cwd: other, id, ...MAC, label: 'Renamed', ...verified } });
  expect(upd.status).toBe(200);
  expect(upd.body.macro.label).toBe('Renamed');
  expect(upd.body.macro.projects).toEqual(['*']);
  ev = saveEvents(id);
  expect(ev).toHaveLength(2);
  expect(ev[1].created).toBe(false);
  expect(getChangedCount()).toBe(2);
  humanLedger._resetForTests();
});

test('a plain create writes one audit event with a null quote', async () => {
  const { cwd, adminHttp } = await setupDelete();
  const created = await adminHttp.call('POST', '/admin/macros/save', { body: { cwd, ...MAC, label: 'Plain' } });
  const ev = saveEvents(created.body.macro.id);
  expect(ev).toHaveLength(1);
  expect(ev[0].humanRequestQuote).toBeNull();
  expect(ev[0].originClaudeSessionId).toBeNull();
  expect(ev[0].created).toBe(true);
});
