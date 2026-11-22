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
  res.writeHead = (s) => { res.status = s; };
  res.end = (b) => { res.body = JSON.parse(b); };
  return res;
}

let cwd;
let home;
let switchOn;
let handlers;
let n;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskread-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskread-home-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  ledger._resetForTests();
  switchOn = true;
  n = 0;
  handlers = new Map();
  registerAdminRoute({ registerRoute: (m, u, h) => { handlers.set(`${m} ${u}`, h); } }, {
    resolveProjectRoot: (c) => (c.startsWith(cwd) ? cwd : c),
    taskSwitch: { isTaskSwitchOn: () => switchOn },
    costOfUsage: (model, b) => ({ costUsd: (b.inputTokens + b.outputTokens) / 1000 }),
    randomUUID: () => `t-${++n}`,
  });
});
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
