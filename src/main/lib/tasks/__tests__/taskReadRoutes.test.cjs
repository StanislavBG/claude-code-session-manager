/**
 * taskReadRoutes.test.cjs — GET /admin/tasks, GET /admin/task and
 * POST /admin/tasks/import (lib/tasks/taskAdminRoutes.cjs) over the REAL
 * Task ledger in a tmp project; switch, project root and pricing injected.
 *
 * Run: timeout 300 npx vitest run src/main/lib/tasks/__tests__/taskReadRoutes.test.cjs
 */
'use strict';

import { test, expect, describe, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ledger = require('../taskLedger.cjs');
const { registerAdminRoute, TASK_FIELDS } = require('../taskAdminRoutes.cjs');

const SID = '11111111-2222-4333-8444-555555555555';

function fakeReq(body) {
  const req = new EventEmitter();
  req.setTimeout = () => {};
  req.destroy = () => {};
  setImmediate(() => {
    req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function fakeRes() {
  const res = new EventEmitter();
  res.status = null;
  res.body = null;
  res.writableEnded = false;
  res.destroyed = false;
  res.writableLength = 0;
  res.chunks = [];
  res.setTimeout = () => {};
  res.writeHead = (s) => { res.status = s; };
  res.write = (c) => { res.chunks.push(String(c)); return true; };
  res.end = (b) => { if (b !== undefined) res.body = JSON.parse(b); res.writableEnded = true; };
  return res;
}

let cwd;
let home;
let switchOn;
let handlers;
let n;
/** Test-controlled slot grant + run (POST /admin/tasks harness for the live registry). */
let slotGate;
let runImpl;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskread-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskread-home-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  ledger._resetForTests();
  switchOn = true;
  n = 0;
  handlers = new Map();
  slotGate = Promise.resolve('tok');
  runImpl = async () => okRun();
  registerAdminRoute({ registerRoute: (m, u, h) => { handlers.set(`${m} ${u}`, h); } }, liveDeps({
    resolveProjectRoot: (c) => (c.startsWith(cwd) ? cwd : c),
    taskSwitch: { isTaskSwitchOn: () => switchOn },
    costOfUsage: (model, b) => ({ costUsd: (b.inputTokens + b.outputTokens) / 1000 }),
    randomUUID: () => `t-${++n}`,
  }));
});

function okRun(over = {}) {
  return {
    status: 'ok', exitCode: 0, signal: null, stdout: 'final\n', stderrTail: '', envelope: null, usage: null,
    modelUsage: null, cliCostUsd: null, numTurns: 1, sessionId: null, durationMs: 5, quota: null, ...over,
  };
}

/** Deps that let POST /admin/tasks run without a spawn or real slots. */
function liveDeps(over) {
  return {
    resolveInfo: async () => ({ personaFound: true, resolvedModelId: 'claude-haiku-4-5', personaEffort: 'low' }),
    sessionSlots: { waitForSlot: () => slotGate, stampPid: () => {}, release: () => {} },
    runTask: (o) => runImpl(o),
    buildTaskArgs: () => ['-p'],
    buildTaskEnv: () => ({}),
    ...over,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Start a POST /admin/tasks run that stays live until finish() is called.
 * `running` resolves with runTask's options once the run has started.
 */
function startLive(h = handlers, body = {}) {
  const started = deferred();
  const gate = deferred();
  runImpl = async (o) => { started.resolve(o); await gate.promise; return okRun(); };
  const res = fakeRes();
  const done = h.get('POST /admin/tasks')(
    fakeReq({ cwd, agent: 'dev-lead', missionId: 'm', prompt: 'p', ...body }), res,
  );
  return { running: started.promise, finish: () => { gate.resolve(); return done; }, res };
}
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

async function get(route, params) {
  const res = fakeRes();
  await handlers.get(`GET ${route}`)({}, res, new URLSearchParams(params));
  return res;
}
async function importRecords(body) {
  const res = fakeRes();
  await handlers.get('POST /admin/tasks/import')(fakeReq(body), res);
  return res;
}

const rec = (importId, over = {}) => ({
  importId, model: 'claude-haiku-4-5', missionId: 'burrow-draft', startedAt: '2026-11-20T10:00:00.000Z',
  durationMs: 1500, status: 'ok', prompt: `prompt ${importId}`, output: `output ${importId}`, ...over,
});

async function seed() {
  const now = Date.now();
  for (let i = 0; i < 3; i += 1) {
    await ledger.appendTaskStart(cwd, {
      taskId: `sm-${i}`, startedAt: new Date(now - (i + 1) * 60000).toISOString(), agent: i === 0 ? 'dev-lead' : 'writer',
      missionId: 'm', model: 'claude-haiku-4-5', effort: 'low', timeoutSec: 600,
      caller: { pipeline: i === 2 ? 'other' : 'burrow', runId: `r${i}`, step: 'draft' }, prompt: `secret prompt ${i}`,
    });
    await ledger.appendTaskEnd(cwd, { taskId: `sm-${i}`, status: i === 1 ? 'error' : 'ok', output: 'secret out', stderrTail: 'err' });
  }
}

describe('GET /admin/tasks', () => {
  test('400 for a missing cwd or one that is not a project root', async () => {
    expect((await get('/admin/tasks', {})).status).toBe(400);
    const sub = path.join(cwd, 'sub');
    const res = await get('/admin/tasks', { cwd: sub });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect((await get('/admin/tasks', { cwd, limit: 'x' })).status).toBe(400);
  });

  test('filters, pagination, no text fields, exactly TASK_FIELDS; works with the switch off', async () => {
    await seed();
    switchOn = false;
    let res = await get('/admin/tasks', { cwd });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, total: 3, hasMore: false });
    expect(res.body.tasks.map((t) => t.taskId)).toEqual(['sm-0', 'sm-1', 'sm-2']);
    for (const t of res.body.tasks) {
      expect(Object.keys(t)).toEqual([...TASK_FIELDS]);
      expect(JSON.stringify(t)).not.toMatch(/secret/);
      expect(t.source).toBe('sm');
    }

    expect((await get('/admin/tasks', { cwd, pipeline: 'burrow' })).body.total).toBe(2);
    expect((await get('/admin/tasks', { cwd, runId: 'r2' })).body.tasks.map((t) => t.taskId)).toEqual(['sm-2']);
    expect((await get('/admin/tasks', { cwd, step: 'draft' })).body.total).toBe(3);
    expect((await get('/admin/tasks', { cwd, agent: 'dev-lead' })).body.tasks.map((t) => t.taskId)).toEqual(['sm-0']);
    expect((await get('/admin/tasks', { cwd, status: 'error' })).body.tasks.map((t) => t.taskId)).toEqual(['sm-1']);
    expect((await get('/admin/tasks', { cwd, source: 'direct' })).body.total).toBe(0);
    const cut = new Date(Date.now() - 90000).toISOString();
    expect((await get('/admin/tasks', { cwd, since: cut })).body.tasks.map((t) => t.taskId)).toEqual(['sm-0']);
    expect((await get('/admin/tasks', { cwd, until: cut })).body.tasks.map((t) => t.taskId)).toEqual(['sm-1', 'sm-2']);

    res = await get('/admin/tasks', { cwd, limit: '2' });
    expect(res.body).toMatchObject({ total: 3, hasMore: true });
    expect(res.body.tasks.map((t) => t.taskId)).toEqual(['sm-0', 'sm-1']);
    res = await get('/admin/tasks', { cwd, limit: '2', offset: '2' });
    expect(res.body).toMatchObject({ total: 3, hasMore: false });
    expect(res.body.tasks.map((t) => t.taskId)).toEqual(['sm-2']);
  });
});

describe('GET /admin/task', () => {
  test('returns the task with prompt, output, stderrTail and envelope; 404 unknown_task', async () => {
    await seed();
    switchOn = false;
    const res = await get('/admin/task', { cwd, id: 'sm-1' });
    expect(res.status).toBe(200);
    expect(res.body.task).toMatchObject({
      taskId: 'sm-1', status: 'error', prompt: 'secret prompt 1', output: 'secret out', stderrTail: 'err', envelope: null,
    });
    const miss = await get('/admin/task', { cwd, id: 'nope' });
    expect(miss.status).toBe(404);
    expect(miss.body.error).toBe('unknown_task');
    expect((await get('/admin/task', { cwd })).status).toBe(400);
  });
});

describe('POST /admin/tasks/import', () => {
  test('403 tasks_disabled when the switch is off — nothing recorded', async () => {
    switchOn = false;
    const res = await importRecords({ cwd, records: [rec('a')] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tasks_disabled');
    expect((await ledger.listTasks(cwd)).total).toBe(0);
  });

  test('400 for an empty or oversized batch and a non-root cwd', async () => {
    expect((await importRecords({ cwd, records: [] })).status).toBe(400);
    expect((await importRecords({ cwd, records: Array.from({ length: 101 }, (_, i) => rec(`r${i}`)) })).status).toBe(400);
    expect((await importRecords({ cwd: path.join(cwd, 'x'), records: [rec('a')] })).status).toBe(400);
  });

  test('records source direct, recomputes costUsd from usage, rejects a bad record beside good ones', async () => {
    const res = await importRecords({
      cwd,
      records: [
        rec('a', { usage: { input_tokens: 1000, output_tokens: 1000 }, costUsd: 9, caller: { pipeline: 'burrow', runId: 'x' } }),
        rec('bad', { startedAt: 'yesterday' }),
        rec('b', { status: 'weird' }),
        rec('c', { agent: 'writer', costUsd: 0.25 }),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, imported: 2, alreadyImported: 0 });
    expect(res.body.rejected.map((r) => r.index)).toEqual([1, 2]);
    expect(res.body.rejected[0].error).toMatch(/startedAt/);

    const list = await get('/admin/tasks', { cwd, source: 'direct' });
    expect(list.body.total).toBe(2);
    const a = list.body.tasks.find((t) => t.importId === 'a');
    expect(a).toMatchObject({ source: 'direct', status: 'ok', costUsd: 2, cliCostUsd: 9, caller: { pipeline: 'burrow', runId: 'x' } });
    expect(a.endedAt).toBe('2026-11-20T10:00:01.500Z');
    const c = list.body.tasks.find((t) => t.importId === 'c');
    expect(c).toMatchObject({ agent: 'writer', costUsd: 0.25 });
    const detail = await get('/admin/task', { cwd, id: a.taskId });
    expect(detail.body.task).toMatchObject({ source: 'direct', prompt: 'prompt a', output: 'output a' });
  });

  test('idempotent by importId — across calls and within one batch', async () => {
    let res = await importRecords({ cwd, records: [rec('a'), rec('a')] });
    expect(res.body).toMatchObject({ imported: 1, alreadyImported: 1, rejected: [] });
    res = await importRecords({ cwd, records: [rec('a'), rec('b')] });
    expect(res.body).toMatchObject({ imported: 1, alreadyImported: 1, rejected: [] });
    expect((await ledger.listTasks(cwd)).total).toBe(2);
  });

  test('a persisted import carries its sessionId (History skips it); persisted without sessionId is rejected', async () => {
    const res = await importRecords({
      cwd, records: [rec('p', { sessionId: SID, persisted: true }), rec('q', { persisted: true })],
    });
    expect(res.body.imported).toBe(1);
    expect(res.body.rejected).toEqual([{ index: 1, error: expect.stringMatching(/sessionId/) }]);
    const [t] = (await get('/admin/tasks', { cwd })).body.tasks;
    expect(t).toMatchObject({ source: 'direct', sessionId: SID, persisted: true });
    expect([...(await ledger.listPersistedSessionIds(cwd))]).toEqual([SID]);
  });
});

describe('GET /admin/task — live output of a Task this app is running', () => {
  test('during the slot wait: running, slotAcquired false, output empty', async () => {
    const slot = deferred();
    slotGate = slot.promise;
    const run = startLive();
    await new Promise((r) => setTimeout(r, 20));
    const res = await get('/admin/task', { cwd, id: 't-1' });
    expect(res.status).toBe(200);
    expect(res.body.task).toMatchObject({
      taskId: 't-1', status: 'running', phase: 'running', output: '', outputTruncated: false,
      live: { slotAcquired: false, outputEnd: 0, outputCapped: false },
    });
    slot.resolve('tok');
    await run.running;
    await run.finish();
  });

  test('complete lines with a cursor; after pages from it; finished Task reads live null', async () => {
    const run = startLive();
    const o = await run.running;
    o.onStdoutLine('{"type":"system"}');
    o.onStdoutLine('héllo');
    let res = await get('/admin/task', { cwd, id: 't-1' });
    const first = '{"type":"system"}\nhéllo\n';
    expect(res.body.task).toMatchObject({
      status: 'running', output: first, outputTruncated: false,
      live: { slotAcquired: true, outputEnd: Buffer.byteLength(first), outputCapped: false },
    });
    const cursor = res.body.task.live.outputEnd;
    res = await get('/admin/task', { cwd, id: 't-1', after: String(cursor) });
    expect(res.body.task.output).toBe('');
    expect(res.body.task.live.outputEnd).toBe(cursor);
    o.onStdoutLine('third');
    res = await get('/admin/task', { cwd, id: 't-1', after: String(cursor) });
    expect(res.body.task).toMatchObject({ output: 'third\n', live: { outputEnd: cursor + 6 } });
    // An offset inside a line rounds forward to the next line start.
    res = await get('/admin/task', { cwd, id: 't-1', after: '3' });
    expect(res.body.task.output).toBe('héllo\nthird\n');
    // The list reads it as running too.
    const list = await get('/admin/tasks', { cwd });
    expect(list.body.tasks.find((t) => t.taskId === 't-1')).toMatchObject({ status: 'running', phase: 'running' });

    await run.finish();
    res = await get('/admin/task', { cwd, id: 't-1' });
    expect(res.body.task).toMatchObject({ status: 'ok', output: 'final\n', live: null });
  });

  test('a page is at most 1 MiB cut at a line boundary; outputTruncated while more remain', async () => {
    const run = startLive();
    const o = await run.running;
    const big = 'a'.repeat(600 * 1024);
    o.onStdoutLine(big);
    o.onStdoutLine(big);
    o.onStdoutLine(big);
    o.onStdoutLine('tail');
    let res = await get('/admin/task', { cwd, id: 't-1' });
    expect(res.body.task.output).toBe(`${big}\n`);
    expect(res.body.task.outputTruncated).toBe(true);
    expect(res.body.task.live.outputEnd).toBe(big.length + 1);
    res = await get('/admin/task', { cwd, id: 't-1', after: String(res.body.task.live.outputEnd) });
    expect(res.body.task.output).toBe(`${big}\n`);
    expect(res.body.task.outputTruncated).toBe(true);
    res = await get('/admin/task', { cwd, id: 't-1', after: String(res.body.task.live.outputEnd) });
    expect(res.body.task.output).toBe(`${big}\ntail\n`);
    expect(res.body.task).toMatchObject({ outputTruncated: false, live: { outputEnd: 3 * (big.length + 1) + 5 } });
    await run.finish();
  });

  test('capture stops at MAX_STDOUT_BYTES and sets outputCapped', async () => {
    const { MAX_STDOUT_BYTES } = require('../taskRun.cjs');
    const run = startLive();
    const o = await run.running;
    const line = 'x'.repeat(1024 * 1024 - 1);
    const count = MAX_STDOUT_BYTES / (1024 * 1024);
    for (let i = 0; i < count + 2; i += 1) o.onStdoutLine(line);
    const res = await get('/admin/task', { cwd, id: 't-1', after: String(MAX_STDOUT_BYTES - 1024 * 1024) });
    expect(res.body.task).toMatchObject({
      outputTruncated: false, live: { outputEnd: MAX_STDOUT_BYTES, outputCapped: true },
    });
    expect(res.body.task.output).toBe(`${line}\n`);
    await run.finish();
  });

  test('a stream-mode run fills the same registry and still writes its NDJSON lines', async () => {
    const run = startLive(handlers, { stream: true });
    const o = await run.running;
    o.onStdoutLine('plain');
    const res = await get('/admin/task', { cwd, id: 't-1' });
    expect(res.body.task.output).toBe('plain\n');
    await run.finish();
    const lines = run.res.chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['sm_task_started', 'sm_task_running', 'sm_task_stdout', 'sm_task_result']);
  });

  test('a live Task under another project root is not read from the registry', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskread-other-'));
    try {
      const run = startLive();
      const o = await run.running;
      o.onStdoutLine('x');
      const res = await get('/admin/task', { cwd: other, id: 't-1' });
      expect(res.status).toBe(404);
      await run.finish();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test('a registry Task folds running before the status filter even when the ledger would say interrupted', async () => {
    let clock = Date.parse('2026-11-23T12:00:00.000Z');
    const h = new Map();
    registerAdminRoute({ registerRoute: (m, u, fn) => { h.set(`${m} ${u}`, fn); } }, liveDeps({
      resolveProjectRoot: (c) => c,
      taskSwitch: { isTaskSwitchOn: () => true },
      now: () => clock,
      randomUUID: () => 't-1',
    }));
    const getH = async (route, params) => {
      const res = fakeRes();
      await h.get(`GET ${route}`)({}, res, new URLSearchParams(params));
      return res;
    };
    const run = startLive(h, { timeoutSec: 60 });
    await run.running;
    clock += 2 * 3600 * 1000; // far past start + timeout + grace: the bare fold says interrupted
    const running = await getH('/admin/tasks', { cwd, status: 'running' });
    expect(running.body).toMatchObject({ ok: true, total: 1, hasMore: false });
    expect(running.body.tasks.map((t) => [t.taskId, t.status])).toEqual([['t-1', 'running']]);
    const interrupted = await getH('/admin/tasks', { cwd, status: 'interrupted' });
    expect(interrupted.body).toMatchObject({ ok: true, tasks: [], total: 0, hasMore: false });
    const one = await getH('/admin/task', { cwd, id: 't-1' });
    expect(one.body.task).toMatchObject({ status: 'running', phase: 'running' });
    expect(one.body.task.live).not.toBeNull();
    await run.finish();
    const after = await getH('/admin/task', { cwd, id: 't-1' });
    expect(after.body.task).toMatchObject({ status: 'ok', live: null });
  });
});

describe('GET /admin/task ?after= on a finished Task', () => {
  test('slices the stored output by bytes, rounded forward to a line boundary; past the end gives ""', async () => {
    await ledger.appendTaskStart(cwd, {
      taskId: 'fin', startedAt: new Date().toISOString(), agent: 'a', missionId: 'm', model: 'claude-haiku-4-5',
      effort: 'low', timeoutSec: 600, caller: {}, prompt: 'p',
    });
    await ledger.appendTaskEnd(cwd, { taskId: 'fin', status: 'ok', output: 'line1\nline2\nline3\n' });
    const out = async (after) => (await get('/admin/task', { cwd, id: 'fin', ...(after === undefined ? {} : { after }) })).body.task;
    expect(await out()).toMatchObject({ output: 'line1\nline2\nline3\n', live: null });
    expect((await out('0')).output).toBe('line1\nline2\nline3\n');
    expect((await out('6')).output).toBe('line2\nline3\n');
    expect((await out('3')).output).toBe('line2\nline3\n');
    expect((await out('17')).output).toBe('');
    expect((await out('18')).output).toBe('');
    expect((await out('1000')).output).toBe('');
  });

  test('a non-integer or negative after is 400 invalid_request', async () => {
    for (const after of ['x', '-1', '1.5', '']) {
      const res = await get('/admin/task', { cwd, id: 'sm-0', after });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    }
  });
});
