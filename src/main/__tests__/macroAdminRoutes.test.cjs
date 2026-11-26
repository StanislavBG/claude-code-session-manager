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

test('admin save never sets scriptStart on create and leaves a stored true untouched on update', async () => {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });
  const macroLibrary = require('../lib/persona-macro/macroLibrary.cjs');

  const created = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, label: 'Scripty', agentName: 'builder', tag: 'build', prompt: 'x', scriptStart: true },
  });
  expect(created.status).toBe(200);
  expect('scriptStart' in created.body.macro).toBe(false);

  const id = created.body.macro.id;
  await macroLibrary.saveMacro({ id, label: 'Scripty', agentName: 'builder', tag: 'build', prompt: 'x', scriptStart: true }, { filePath });
  for (const ss of [true, false]) {
    const upd = await adminHttp.call('POST', '/admin/macros/save', {
      body: { cwd, id, label: 'Scripty2', agentName: 'builder', tag: 'build', prompt: 'x', scriptStart: ss },
    });
    expect(upd.status).toBe(200);
    expect(upd.body.macro.scriptStart).toBe(true);
  }
  const stored = (await macroLibrary.listMacros({ filePath })).find((m) => m.id === id);
  expect(stored.scriptStart).toBe(true);
});

// --- POST /admin/macros/delete ----------------------------------------------

const { readTail } = require('../lib/telemetry/auditLog.cjs');
const macroLib = require('../lib/persona-macro/macroLibrary.cjs');

function deleteEvents(id) {
  return readTail(1_000_000)
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'admin_macro_delete' && e.macro?.id === id);
}

/** Project-video saves are checked by checkProjectVideoToolRunnable; stubbed ok unless a test passes its own. */
const runnableOk = async () => ({ ok: true });
async function setupDelete(extraDeps = {}) {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const h = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged: h.onChanged, checkProjectVideoToolRunnable: runnableOk, ...extraDeps }, { filePath });
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

// --- POST /admin/macros/run -------------------------------------------------

const http = require('node:http');

function runEvents(macroId) {
  return readTail(1_000_000)
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'admin_macro_run' && e.macroId === macroId);
}

let epicSeq = 0;
function makeRunDeps({ result, busy = () => false, personas = ['builder'], usageHold = () => null } = {}) {
  const launches = [];
  return {
    launches,
    deps: {
      onChanged: () => {},
      startExternalNewSession: async (p) => {
        launches.push(p);
        if (result) return typeof result === 'function' ? result(p) : result;
        epicSeq += 1;
        return { ok: true, epicId: `epic-run-${process.pid}-${epicSeq}` };
      },
      isTabBusy: busy,
      listPersonas: async () => personas.map((name) => ({ name })),
      usageHold,
    },
  };
}

async function setupRun(opts = {}, macroFields = {}) {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const macro = await macroLib.saveMacro({
    label: 'Daily digest',
    agentName: 'builder',
    tag: 'build',
    prompt: 'Digest {{topic}} for {{days}} days',
    inputs: [
      { name: 'topic', label: 'Topic', default: 'news' },
      { name: 'days', label: 'Days', default: '1' },
    ],
    projects: [fs.realpathSync(cwd)],
    scriptStart: true,
    ...macroFields,
  }, { filePath });
  const stored = (await macroLib.listMacros({ filePath })).find((m) => m.id === macro.id);
  const adminHttp = makeFakeAdminHttp();
  const { launches, deps } = makeRunDeps(opts);
  registerAdminRoute(adminHttp, deps, { filePath });
  const run = (body) => adminHttp.call('POST', '/admin/macros/run', { body: { cwd, id: stored.id, ...body } });
  return { cwd, realCwd: fs.realpathSync(cwd), filePath, adminHttp, launches, macro: stored, run };
}

function writeIndex(cwd, sessions) {
  const dir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify({ sessions, events: {} }));
}

test('run route registers when startExternalNewSession is injected', () => {
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp, makeRunDeps().deps);
  expect(adminHttp.routes.has('POST /admin/macros/run')).toBe(true);
});

test('run: starts with defaults + overrides, exact payload, one audit event', async () => {
  const s = await setupRun();
  const { status, body } = await s.run({ inputs: { topic: 'rust' }, effort: 'high' });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.alreadyRunning).toBe(false);
  expect(s.launches).toEqual([{
    cwd: s.realCwd,
    agentName: 'builder',
    tag: 'build',
    title: 'Daily digest',
    prompt: 'Digest rust for 1 days',
    macroId: s.macro.id,
    via: 'script',
    startedBy: { kind: 'script', route: '/admin/macros/run' },
    effort: 'high',
  }]);
  const ev = runEvents(s.macro.id);
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ route: '/admin/macros/run', cwd: s.realCwd, macroId: s.macro.id, epicId: body.epicId, alreadyRunning: false });
});

test('run: payload has no effort key when effort is omitted', async () => {
  const s = await setupRun();
  const { status } = await s.run({});
  expect(status).toBe(200);
  expect('effort' in s.launches[0]).toBe(false);
  expect(s.launches[0].prompt).toBe('Digest news for 1 days');
});

test('run: every refusal is a 400 and launches nothing', async () => {
  const s = await setupRun();
  const cases = [
    { id: undefined },
    { id: '' },
    { id: 'builtin-project-home' },
    { id: 'nope-abc123' },
    { inputs: { undeclared: 'x' } },
    { inputs: { topic: 5 } },
    { inputs: { topic: 'x'.repeat(2001) } },
    { inputs: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])) },
    { inputs: 'topic=x' },
    { effort: 'turbo' },
    { inputs: { topic: 'x'.repeat(600) } }, // renderMacroPrompt failure (over input max)
  ];
  for (const c of cases) {
    const body = { ...c };
    if ('id' in c && c.id === undefined) {
      const r = await s.adminHttp.call('POST', '/admin/macros/run', { body: { cwd: s.cwd } });
      expect(r.status).toBe(400);
      continue;
    }
    const r = await s.run(body);
    expect(r.status, JSON.stringify(c).slice(0, 80)).toBe(400);
    expect(r.body.ok).toBe(false);
  }
  expect(s.launches).toEqual([]);
  expect(runEvents(s.macro.id)).toEqual([]);
});

test('run: macro not visible in cwd is refused', async () => {
  const s = await setupRun();
  const other = await mkProjectCwd();
  const r = await s.adminHttp.call('POST', '/admin/macros/run', { body: { cwd: other, id: s.macro.id } });
  expect(r.status).toBe(400);
  expect(s.launches).toEqual([]);
});

test("run: macro without scriptStart is refused naming 'Can be started by a script'", async () => {
  const s = await setupRun({}, { scriptStart: false });
  const r = await s.run({});
  expect(r.status).toBe(400);
  expect(r.body.error).toContain('Can be started by a script');
  expect(s.launches).toEqual([]);
});

test('run: unlisted persona is refused', async () => {
  const s = await setupRun({ personas: ['someone-else'] });
  const r = await s.run({});
  expect(r.status).toBe(400);
  expect(s.launches).toEqual([]);
});

test('run: a job macro is refused', async () => {
  const s = await setupRun();
  const orig = macroLib.listMacros;
  macroLib.listMacros = async (o) => (await orig(o)).map((m) => (m.id === s.macro.id ? { ...m, job: { kind: 'x' } } : m));
  try {
    const r = await s.run({});
    expect(r.status).toBe(400);
  } finally {
    macroLib.listMacros = orig;
  }
  expect(s.launches).toEqual([]);
});

test('run: a busy open Epic of this macro is returned, nothing launched', async () => {
  const s = await setupRun({ busy: (id) => id === 'epic-busy' });
  writeIndex(s.realCwd, {
    'epic-busy': { id: 'epic-busy', status: 'active', source: { producer: 'new-epic-ui', macroId: s.macro.id } },
  });
  const r = await s.run({});
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true, epicId: 'epic-busy', alreadyRunning: true });
  expect(s.launches).toEqual([]);
  expect(runEvents(s.macro.id)).toEqual([]);
});

test('run: an idle or completed Epic of this macro does not block a start', async () => {
  const s = await setupRun({ busy: () => false });
  writeIndex(s.realCwd, {
    a: { id: 'a', status: 'active', source: { producer: 'new-epic-ui', macroId: s.macro.id } },
  });
  const r = await s.run({});
  expect(r.body.alreadyRunning).toBe(false);
  expect(s.launches).toHaveLength(1);
});

test('run: a second call within 60 s returns the Epic this route just started', async () => {
  const s = await setupRun();
  const first = await s.run({});
  const second = await s.run({});
  expect(second.status).toBe(200);
  expect(second.body).toEqual({ ok: true, epicId: first.body.epicId, alreadyRunning: true });
  expect(s.launches).toHaveLength(1);
  // Once that Epic is completed, a new start goes through.
  writeIndex(s.realCwd, { [first.body.epicId]: { id: first.body.epicId, status: 'completed', source: { producer: 'new-epic-ui', macroId: s.macro.id } } });
  const third = await s.run({});
  expect(third.body.alreadyRunning).toBe(false);
  expect(s.launches).toHaveLength(2);
});

test('run: concurrent calls launch once; the second gets alreadyRunning', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await setupRun({ result: async () => { await gate; return { ok: true, epicId: 'epic-conc' }; } });
  const p1 = s.run({});
  const p2 = s.run({});
  await new Promise((r) => setTimeout(r, 20));
  release();
  const [a, b] = await Promise.all([p1, p2]);
  expect(s.launches).toHaveLength(1);
  expect([a.body.alreadyRunning, b.body.alreadyRunning].sort()).toEqual([false, true]);
  expect(b.body.epicId).toBe('epic-conc');
});

test('run: launch failures are 503 with no audit event', async () => {
  const s = await setupRun({ result: { ok: false, reason: 'no-window', error: 'Session Manager window is not open' } });
  const r = await s.run({});
  expect(r.status).toBe(503);
  expect(r.body).toEqual({ ok: false, error: 'Session Manager window is not open' });
  expect(runEvents(s.macro.id)).toEqual([]);

  const t = await setupRun({ result: { ok: false, reason: 'timeout', error: 'x' } });
  const rt = await t.run({});
  expect(rt.status).toBe(503);
  expect(rt.body.error).toMatch(/may still start.*Sessions queue/);
  expect(runEvents(t.macro.id)).toEqual([]);
});

test('run: on a real localAdminHttp server, a POST without the Bearer token is refused', async () => {
  const { createAdminHttp, TOKEN_PATH } = require('../lib/feedback-remote/localAdminHttp.cjs');
  const prev = process.env.SM_ADMIN_TOKEN_PATH;
  const tokenPath = path.join(path.dirname(TOKEN_PATH), `admin-api.macro-run-test-${process.pid}.json`);
  process.env.SM_ADMIN_TOKEN_PATH = tokenPath;
  const s = await setupRun();
  const admin = createAdminHttp();
  const { deps, launches } = makeRunDeps();
  registerAdminRoute(admin, deps, { filePath: s.filePath });
  const { port, token } = await admin.start();
  const post = (auth) => new Promise((resolve, reject) => {
    const payload = JSON.stringify({ cwd: s.cwd, id: s.macro.id });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/admin/macros/run', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(payload);
  });
  try {
    expect(await post(undefined)).toBe(401);
    expect(await post('wrong-token')).toBe(401);
    expect(launches).toEqual([]);
    expect(await post(token)).toBe(200);
    expect(launches).toHaveLength(1);
  } finally {
    await admin.stop();
    fs.rmSync(tokenPath, { force: true });
    if (prev === undefined) delete process.env.SM_ADMIN_TOKEN_PATH;
    else process.env.SM_ADMIN_TOKEN_PATH = prev;
  }
});

// --- POST /admin/macros/run with externalRef ---------------------------------

const { recordExternalRef, lookupExternalRef } = require('../lib/epic/externalRefIndex.cjs');

test('run+externalRef: an invalid value is a 400 and launches nothing', async () => {
  const s = await setupRun();
  for (const externalRef of [5, '', '   ', 'has space', 'x'.repeat(201), { a: 1 }, ['a']]) {
    const r = await s.run({ externalRef });
    expect(r.status, JSON.stringify(externalRef).slice(0, 40)).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/externalRef/);
  }
  expect(s.launches).toEqual([]);
  expect(runEvents(s.macro.id)).toEqual([]);
});

test('run+externalRef: first call launches with the ref, records it, audits it, returns it', async () => {
  const s = await setupRun();
  const r = await s.run({ externalRef: '  2026-11-21  ' });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true, epicId: r.body.epicId, alreadyRunning: false, externalRef: '2026-11-21' });
  expect(s.launches).toHaveLength(1);
  expect(s.launches[0]).toMatchObject({ cwd: s.realCwd, macroId: s.macro.id, via: 'script', externalRef: '2026-11-21' });
  const entry = await lookupExternalRef({ cwd: s.realCwd, externalRef: '2026-11-21' });
  expect(entry).toMatchObject({ epicId: r.body.epicId, producer: 'new-epic-ui', macroId: s.macro.id });
  const ev = runEvents(s.macro.id);
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ epicId: r.body.epicId, alreadyRunning: false, externalRef: '2026-11-21' });
});

test('run+externalRef: a repeat call returns the existing Epic, launches nothing, no audit row', async () => {
  let busyId = null;
  const s = await setupRun({ busy: (id) => id === busyId });
  const first = await s.run({ externalRef: 'day-1' });
  expect(first.status).toBe(200);
  const second = await s.run({ externalRef: 'day-1' });
  expect(second.status).toBe(200);
  expect(second.body).toEqual({ ok: true, epicId: first.body.epicId, existing: true, alreadyRunning: false, externalRef: 'day-1' });
  busyId = first.body.epicId;
  const third = await s.run({ externalRef: 'day-1' });
  expect(third.body).toEqual({ ok: true, epicId: first.body.epicId, existing: true, alreadyRunning: true, externalRef: 'day-1' });
  // Still found after the Epic completed and left the active index.
  writeIndex(s.realCwd, {});
  const fourth = await s.run({ externalRef: 'day-1' });
  expect(fourth.body.epicId).toBe(first.body.epicId);
  expect(fourth.body.existing).toBe(true);
  expect(s.launches).toHaveLength(1);
  expect(runEvents(s.macro.id)).toHaveLength(1);
});

test('run+externalRef: an index entry from another producer or macro is a 409', async () => {
  const s = await setupRun();
  await recordExternalRef({ cwd: s.realCwd, externalRef: 'from-feedback', epicId: 'epic-fb', producer: 'cross-project-feedback' });
  const a = await s.run({ externalRef: 'from-feedback' });
  expect(a.status).toBe(409);
  expect(a.body.ok).toBe(false);
  await recordExternalRef({ cwd: s.realCwd, externalRef: 'other-macro', epicId: 'epic-om', producer: 'new-epic-ui', macroId: 'some-other-macro' });
  const b = await s.run({ externalRef: 'other-macro' });
  expect(b.status).toBe(409);
  expect(s.launches).toEqual([]);
  expect(runEvents(s.macro.id)).toEqual([]);
});

test('run+externalRef: a new ref starts a session even while another Epic of the macro is busy', async () => {
  const s = await setupRun({ busy: (id) => id === 'epic-busy' });
  writeIndex(s.realCwd, {
    'epic-busy': { id: 'epic-busy', status: 'active', source: { producer: 'new-epic-ui', macroId: s.macro.id } },
  });
  const r = await s.run({ externalRef: 'day-2' });
  expect(r.status).toBe(200);
  expect(r.body.alreadyRunning).toBe(false);
  expect(r.body.epicId).not.toBe('epic-busy');
  expect(s.launches).toHaveLength(1);
  // A ref-less call still gets the macro-wide shortcut.
  const plain = await s.run({});
  expect(plain.body).toEqual({ ok: true, epicId: 'epic-busy', alreadyRunning: true });
  // And a just-started ref run does not block a different ref.
  const other = await s.run({ externalRef: 'day-3' });
  expect(other.body.alreadyRunning).toBe(false);
  expect(s.launches).toHaveLength(2);
});

test('run+externalRef: concurrent calls with the same ref share one launch', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await setupRun({ result: async () => { await gate; return { ok: true, epicId: 'epic-ref-conc' }; } });
  const p1 = s.run({ externalRef: 'same' });
  const p2 = s.run({ externalRef: 'same' });
  await new Promise((r) => setTimeout(r, 20));
  release();
  const [a, b] = await Promise.all([p1, p2]);
  expect(s.launches).toHaveLength(1);
  expect(a.body.epicId).toBe('epic-ref-conc');
  expect(b.body.epicId).toBe('epic-ref-conc');
  expect([a.body.existing === true, b.body.existing === true].sort()).toEqual([false, true]);
  expect(runEvents(s.macro.id)).toHaveLength(1);
});

test('run+externalRef: a launch failure is a 503, records nothing and writes no audit row', async () => {
  const s = await setupRun({ result: { ok: false, reason: 'no-window', error: 'Session Manager window is not open' } });
  const r = await s.run({ externalRef: 'fail-1' });
  expect(r.status).toBe(503);
  expect(await lookupExternalRef({ cwd: s.realCwd, externalRef: 'fail-1' })).toBeNull();
  expect(runEvents(s.macro.id)).toEqual([]);
});

function setupRunWithRecorder(recorder) {
  return (async () => {
    const s = await setupRun();
    const adminHttp = makeFakeAdminHttp();
    const { launches, deps } = makeRunDeps();
    registerAdminRoute(adminHttp, { ...deps, recordExternalRef: recorder }, { filePath: s.filePath });
    const run = (body) => adminHttp.call('POST', '/admin/macros/run', { body: { cwd: s.cwd, id: s.macro.id, ...body } });
    return { ...s, launches, run };
  })();
}

test('run+externalRef: a record that fails once is retried; 200 without externalRefRecorded', async () => {
  let calls = 0;
  const s = await setupRunWithRecorder(async (args) => {
    calls += 1;
    if (calls === 1) throw new Error('disk hiccup');
    return recordExternalRef(args);
  });
  const r = await s.run({ externalRef: 'retry-ok' });
  expect(r.status).toBe(200);
  expect(calls).toBe(2);
  expect(r.body).toEqual({ ok: true, epicId: r.body.epicId, alreadyRunning: false, externalRef: 'retry-ok' });
  expect(await lookupExternalRef({ cwd: s.realCwd, externalRef: 'retry-ok' })).toMatchObject({ epicId: r.body.epicId });
});

test('run+externalRef: a record that fails twice still answers 200 with externalRefRecorded: false', async () => {
  let calls = 0;
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  let r;
  let s;
  try {
    s = await setupRunWithRecorder(async () => { calls += 1; throw new Error('disk full'); });
    r = await s.run({ externalRef: 'retry-fail' });
  } finally {
    console.warn = origWarn;
  }
  expect(r.status).toBe(200);
  expect(calls).toBe(2);
  expect(r.body).toEqual({ ok: true, epicId: r.body.epicId, alreadyRunning: false, externalRef: 'retry-fail', externalRefRecorded: false });
  expect(s.launches).toHaveLength(1);
  expect(warns.some((w) => /recordExternalRef/.test(w) && /disk full/.test(w))).toBe(true);
});

// --- surface 'project-video' (one project's own Video tool) -----------------

const VIDEO_JOB = { estimateMinutes: 20, repoPaths: ['web/videos'], review: true };

test('project-video save stores voiceId; a sessions save with voiceId is refused 400', async () => {
  humanLedger._resetForTests();
  const { cwd, adminHttp } = await setupDelete();
  const origin = 'sess-pv-voice';
  humanLedger.recordHumanPrompt(origin, PH_TEXT);
  const res = await adminHttp.call('POST', '/admin/macros/save', {
    body: {
      cwd, ...MAC, label: 'Voiced video', surface: 'project-video', job: VIDEO_JOB, voiceId: 'narrator-1',
      humanRequestQuote: PH_QUOTE, originClaudeSessionId: origin,
    },
  });
  expect(res.status).toBe(200);
  expect(res.body.macro.voiceId).toBe('narrator-1');
  const bad = await adminHttp.call('POST', '/admin/macros/save', { body: { cwd, ...MAC, label: 'Plain', voiceId: 'narrator-1' } });
  expect(bad.status).toBe(400);
  expect(bad.body.error).toContain('voiceId is allowed only');
});

test('project-video create with a verified quote stores projects [cwd] and job; a caller projects value is ignored', async () => {
  humanLedger._resetForTests();
  const { cwd, adminHttp, getChangedCount } = await setupDelete();
  const origin = 'sess-pv-ok';
  humanLedger.recordHumanPrompt(origin, PH_TEXT);
  const res = await adminHttp.call('POST', '/admin/macros/save', {
    body: {
      cwd, ...MAC, label: 'Short video', surface: 'project-video', job: VIDEO_JOB, projects: ['*'],
      humanRequestQuote: PH_QUOTE, originClaudeSessionId: origin,
    },
  });
  expect(res.status).toBe(200);
  expect(res.body.macro).toMatchObject({ surface: 'project-video', projects: [fs.realpathSync(cwd)], job: VIDEO_JOB });
  const ev = saveEvents(res.body.macro.id);
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ surface: 'project-video', projects: [fs.realpathSync(cwd)], humanRequestQuote: PH_QUOTE });
  expect(getChangedCount()).toBe(1);
  humanLedger._resetForTests();
});

test('project-video save without a verified Project Home quote is a 400; no write, onChanged or audit', async () => {
  humanLedger._resetForTests();
  const { cwd, adminHttp, getChangedCount } = await setupDelete();
  const origin = 'sess-pv-refuse';
  humanLedger.recordHumanPrompt(origin, 'keep this for this project only');
  for (const extra of [
    {},
    { humanRequestQuote: PH_QUOTE },
    { humanRequestQuote: PH_QUOTE, originClaudeSessionId: origin },
    { humanRequestQuote: 'keep this for this project only', originClaudeSessionId: origin },
  ]) {
    const res = await adminHttp.call('POST', '/admin/macros/save', {
      body: { cwd, ...MAC, label: 'PvRefused', surface: 'project-video', job: VIDEO_JOB, ...extra },
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('Project Home');
  }
  expect(getChangedCount()).toBe(0);
  const list = await adminHttp.call('GET', '/admin/macros', { query: { cwd } });
  expect(list.body.macros.map((m) => m.label)).not.toContain('PvRefused');
  humanLedger._resetForTests();
});

test("project-video tool is listed (with surface and job) only in its own project", async () => {
  humanLedger._resetForTests();
  const { cwd, adminHttp } = await setupDelete();
  const other = await mkProjectCwd();
  const origin = 'sess-pv-list';
  humanLedger.recordHumanPrompt(origin, PH_TEXT);
  const res = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, ...MAC, label: 'Mine', surface: 'project-video', job: VIDEO_JOB, humanRequestQuote: PH_QUOTE, originClaudeSessionId: origin },
  });
  expect(res.status).toBe(200);
  const own = await adminHttp.call('GET', '/admin/macros', { query: { cwd } });
  expect(own.body.macros.find((m) => m.id === res.body.macro.id)).toMatchObject({ surface: 'project-video', job: VIDEO_JOB });
  const foreign = await adminHttp.call('GET', '/admin/macros', { query: { cwd: other } });
  expect(foreign.body.macros.map((m) => m.id)).not.toContain(res.body.macro.id);
  humanLedger._resetForTests();
});

test('project-video move: this project\'s macro moves in place keeping its id; foreign, multi-project, * and built-in are refused', async () => {
  humanLedger._resetForTests();
  const { cwd, filePath, adminHttp } = await setupDelete();
  const other = await mkProjectCwd();
  const origin = 'sess-pv-move';
  humanLedger.recordHumanPrompt(origin, PH_TEXT);
  const verified = { humanRequestQuote: PH_QUOTE, originClaudeSessionId: origin };

  const plain = await adminHttp.call('POST', '/admin/macros/save', { body: { cwd, ...MAC, label: 'ToMove' } });
  const id = plain.body.macro.id;
  const moved = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, id, ...MAC, label: 'ToMove', surface: 'project-video', job: VIDEO_JOB, ...verified },
  });
  expect(moved.status).toBe(200);
  expect(moved.body.macro).toMatchObject({ id, surface: 'project-video', projects: [fs.realpathSync(cwd)], job: VIDEO_JOB });
  const relabel = await adminHttp.call('POST', '/admin/macros/save', { body: { cwd, id, ...MAC, label: 'Moved', ...verified } });
  expect(relabel.status).toBe(200);
  expect(relabel.body.macro).toMatchObject({ id, label: 'Moved', surface: 'project-video', job: VIDEO_JOB });
  const all = (await macroLib.listMacros({ filePath })).filter((m) => m.label === 'Moved' || m.label === 'ToMove');
  expect(all).toHaveLength(1);

  const foreign = await macroLib.saveMacro({ ...MAC, label: 'Foreign', projects: [fs.realpathSync(other)] }, { filePath });
  const multi = await macroLib.saveMacro({ ...MAC, label: 'Multi', projects: [fs.realpathSync(cwd), fs.realpathSync(other)] }, { filePath });
  const star = await macroLib.saveMacro({ ...MAC, label: 'Star', projects: ['*'] }, { filePath });
  for (const [mid, msg] of [[foreign.id, 'not visible'], [multi.id, null], [star.id, null], ['builtin-x', 'built-in']]) {
    const res = await adminHttp.call('POST', '/admin/macros/save', {
      body: { cwd, id: mid, ...MAC, surface: 'project-video', job: VIDEO_JOB, ...verified },
    });
    expect(res.status).toBe(400);
    if (msg) expect(res.body.error).toContain(msg);
  }
  const after = await macroLib.listMacros({ filePath });
  for (const mid of [foreign.id, multi.id, star.id]) {
    expect(after.find((m) => m.id === mid).surface).toBe('sessions');
  }
  humanLedger._resetForTests();
});

// --- project-video save: the persona must be able to run the tool ----------

const { checkProjectVideoToolRunnable: realRunnableCheck } = require('../lib/persona-macro/projectVideoToolCheck.cjs');

function writePersona(cwd, name, tools) {
  const dir = path.join(cwd, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const toolsLine = tools ? `tools: ${tools}\n` : '';
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: test persona\nmodel: sonnet\n${toolsLine}---\nBody.\n`);
}

async function pvSave(adminHttp, cwd, origin, extra) {
  return adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, ...MAC, surface: 'project-video', job: VIDEO_JOB, humanRequestQuote: PH_QUOTE, originClaudeSessionId: origin, ...extra },
  });
}

test('project-video save is refused (400, helper error, no write/onChanged/audit) for an unresolvable persona and a scoped persona without the MCP tools', async () => {
  humanLedger._resetForTests();
  const calls = [];
  const check = async (input) => { calls.push(input); return realRunnableCheck(input); };
  const { cwd, adminHttp, getChangedCount } = await setupDelete({ checkProjectVideoToolRunnable: check });
  const origin = 'sess-pv-runnable-refuse';
  humanLedger.recordHumanPrompt(origin, PH_TEXT);
  writePersona(cwd, 'pv-scoped', 'Read, Bash');

  const missing = await pvSave(adminHttp, cwd, origin, { label: 'PvNoPersona', agentName: 'pv-no-such-persona-zz' });
  expect(missing.status).toBe(400);
  expect(missing.body.error).toContain('A Project Video tool runs as a scheduled job');

  const scoped = await pvSave(adminHttp, cwd, origin, { label: 'PvScoped', agentName: 'pv-scoped' });
  expect(scoped.status).toBe(400);
  expect(scoped.body.error).toContain('mcp__session-manager-scheduler__project_video_write');
  expect(scoped.body.error).toContain('mcp__session-manager-scheduler__project_video_review_write');

  expect(calls[0]).toMatchObject({ cwd: fs.realpathSync(cwd), agentName: 'pv-no-such-persona-zz', job: VIDEO_JOB });
  expect(getChangedCount()).toBe(0);
  const list = await adminHttp.call('GET', '/admin/macros', { query: { cwd } });
  const labels = list.body.macros.map((m) => m.label);
  expect(labels).not.toContain('PvNoPersona');
  expect(labels).not.toContain('PvScoped');
  humanLedger._resetForTests();
});

test('project-video save succeeds when the persona can run it; an update keeping the stored job is checked too', async () => {
  humanLedger._resetForTests();
  const calls = [];
  const check = async (input) => { calls.push(input); return realRunnableCheck(input); };
  const { cwd, adminHttp, getChangedCount } = await setupDelete({ checkProjectVideoToolRunnable: check });
  const origin = 'sess-pv-runnable-ok';
  humanLedger.recordHumanPrompt(origin, PH_TEXT);
  writePersona(cwd, 'pv-good', 'Read, mcp__session-manager-scheduler__project_video_write, mcp__session-manager-scheduler__project_video_review_write');
  writePersona(cwd, 'pv-scoped', 'Read');

  const ok = await pvSave(adminHttp, cwd, origin, { label: 'PvGood', agentName: 'pv-good' });
  expect(ok.status).toBe(200);
  expect(ok.body.macro).toMatchObject({ surface: 'project-video', agentName: 'pv-good', job: VIDEO_JOB });
  expect(getChangedCount()).toBe(1);

  // Update without job/surface: the stored job is kept, so the new persona is still checked.
  const id = ok.body.macro.id;
  const upd = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, id, ...MAC, label: 'PvGood', agentName: 'pv-scoped', humanRequestQuote: PH_QUOTE, originClaudeSessionId: origin },
  });
  expect(upd.status).toBe(400);
  expect(upd.body.error).toContain('project_video_write');
  expect(calls[calls.length - 1]).toMatchObject({ agentName: 'pv-scoped', job: VIDEO_JOB });
  expect(getChangedCount()).toBe(1);
  humanLedger._resetForTests();
});

test('a non-project-video save never runs the project-video check', async () => {
  let called = 0;
  const { cwd, adminHttp } = await setupDelete({ checkProjectVideoToolRunnable: async () => { called += 1; return { ok: false, error: 'no' }; } });
  const res = await adminHttp.call('POST', '/admin/macros/save', { body: { cwd, ...MAC, label: 'Plain' } });
  expect(res.status).toBe(200);
  expect(called).toBe(0);
});

// --- usage hold ('pause above') on script presses ---------------------------

const HELD = { reason: 'utilization', window: 'five_hour', percent: 97, threshold: 95, resetsAt: '2026-11-24T23:00:00.000Z', detail: 'five_hour at 97% >= 95%' };

test('run: a usage hold is 429 usage_held, starts no session, writes no audit row', async () => {
  const s = await setupRun({ usageHold: () => HELD });
  const r = await s.run({});
  expect(r.status).toBe(429);
  expect(r.body).toMatchObject({
    ok: false,
    error: 'usage_held',
    hold: { reason: 'utilization', window: 'five_hour', percent: 97, threshold: 95, resetsAt: HELD.resetsAt },
    detail: HELD.detail,
  });
  expect(s.launches).toEqual([]);
  expect(runEvents(s.macro.id)).toEqual([]);
});

test('run+externalRef: a usage hold is 429 usage_held and records nothing', async () => {
  const s = await setupRun({ usageHold: () => HELD });
  const r = await s.run({ externalRef: 'held-1' });
  expect(r.status).toBe(429);
  expect(r.body.error).toBe('usage_held');
  expect(s.launches).toEqual([]);
  expect(await lookupExternalRef({ cwd: s.realCwd, externalRef: 'held-1' })).toBeNull();
});

test('run: a throwing usage-hold read is 503 usage_hold_error and starts no session', async () => {
  const s = await setupRun({ usageHold: () => { throw new Error('boom'); } });
  const r = await s.run({});
  expect(r.status).toBe(503);
  expect(r.body).toMatchObject({ ok: false, error: 'usage_hold_error' });
  expect(s.launches).toEqual([]);
  const t = await setupRun({ usageHold: () => { throw new Error('boom'); } });
  const rt = await t.run({ externalRef: 'held-err' });
  expect(rt.status).toBe(503);
  expect(rt.body.error).toBe('usage_hold_error');
  expect(t.launches).toEqual([]);
});

test('run: validation and consent refusals win over a hold (checked first)', async () => {
  const s = await setupRun({ usageHold: () => HELD }, { scriptStart: false });
  const r = await s.run({});
  expect(r.status).toBe(400);
  expect(s.launches).toEqual([]);
});

test('run: usageHold () => null leaves the success path unchanged', async () => {
  const s = await setupRun({ usageHold: () => null });
  const r = await s.run({});
  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(true);
  expect(s.launches).toHaveLength(1);
});

// --- startedBy + caller on script launches ----------------------------------

test('run: payload startedBy carries the caller; audit event includes caller', async () => {
  const s = await setupRun();
  const caller = { pipeline: 'demo-video', runId: 'r1', attempt: 2 };
  const r = await s.run({ caller });
  expect(r.status).toBe(200);
  expect(s.launches[0].startedBy).toEqual({ kind: 'script', route: '/admin/macros/run', caller });
  expect(runEvents(s.macro.id)[0].scriptCaller).toEqual(caller);
});

test('run: payload startedBy without caller has no caller key', async () => {
  const s = await setupRun();
  const r = await s.run({});
  expect(r.status).toBe(200);
  expect(s.launches[0].startedBy).toEqual({ kind: 'script', route: '/admin/macros/run' });
  expect(runEvents(s.macro.id)[0].scriptCaller).toBeUndefined();
});

test('run: deps.startedByFromRequest is used', async () => {
  const s = await setupRun();
  const adminHttp = makeFakeAdminHttp();
  const { launches, deps } = makeRunDeps();
  const seen = [];
  registerAdminRoute(adminHttp, {
    ...deps,
    startedByFromRequest: async (a) => { seen.push(a); return { kind: 'script', route: 'x', fromEpicId: 'e9' }; },
  }, { filePath: s.filePath });
  const r = await adminHttp.call('POST', '/admin/macros/run', { body: { cwd: s.cwd, id: s.macro.id, caller: { step: 'a' } } });
  expect(r.status).toBe(200);
  expect(seen[0]).toMatchObject({ route: '/admin/macros/run', caller: { step: 'a' } });
  expect(launches[0].startedBy).toEqual({ kind: 'script', route: 'x', fromEpicId: 'e9' });
});

test('run+externalRef: startedBy rides in the payload, producer stays new-epic-ui', async () => {
  const s = await setupRun();
  const caller = { pipeline: 'p' };
  const r = await s.run({ externalRef: 'sb-1', caller });
  expect(r.status).toBe(200);
  expect(s.launches[0].startedBy).toMatchObject({ kind: 'script', caller });
  expect(await lookupExternalRef({ cwd: s.realCwd, externalRef: 'sb-1' })).toMatchObject({ epicId: r.body.epicId, producer: 'new-epic-ui' });
  expect(runEvents(s.macro.id)[0].scriptCaller).toEqual(caller);
});

test('run: invalid caller is a 400 with no launch', async () => {
  const s = await setupRun();
  for (const caller of [{ bogus: 1 }, 'str', { attempt: -1 }, { pipeline: 5 }]) {
    const r = await s.run({ caller });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^caller/);
  }
  const r2 = await s.run({ caller: { bogus: 1 }, externalRef: 'sb-2' });
  expect(r2.status).toBe(400);
  expect(s.launches).toHaveLength(0);
});
