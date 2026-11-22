/**
 * taskAdminRoutes.test.cjs — POST /admin/tasks (lib/tasks/taskAdminRoutes.cjs)
 * with every collaborator injected: no spawn, no real slots, no real ledger.
 *
 * Run: timeout 300 npx vitest run src/main/lib/tasks/__tests__/taskAdminRoutes.test.cjs
 */
'use strict';

import { test, expect, describe, beforeEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { registerAdminRoute } = require('../taskAdminRoutes.cjs');

const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskroute-'));
fs.writeFileSync(path.join(PROJ, 'mcp.json'), '{}');
const SID = '11111111-2222-4333-8444-555555555555';
const SID2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';

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
  res.setTimeout = () => {};
  res.writeHead = (s) => { res.status = s; };
  res.end = (b) => { res.body = JSON.parse(b); res.writableEnded = true; };
  return res;
}

function okRun(over = {}) {
  return {
    status: 'ok', exitCode: 0, signal: null, stdout: '{"result":"hi"}', stderrTail: '',
    envelope: { result: 'hi', session_id: 'env-sid' },
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: null, cliCostUsd: 0.01, numTurns: 1, sessionId: 'env-sid', durationMs: 42,
    quota: { rateLimited: false, resetsAt: null }, ...over,
  };
}

function setup(over = {}) {
  const calls = { starts: [], ends: [], waits: [], runs: [], args: [], released: [], stamped: [] };
  const deps = {
    resolveProjectRoot: (c) => c,
    taskSwitch: { isTaskSwitchOn: () => true },
    resolveInfo: async () => ({ personaFound: true, resolvedModelId: 'claude-haiku-4-5', personaEffort: 'low' }),
    sessionSlots: {
      waitForSlot: async (owner, opts) => { calls.waits.push({ owner, ...opts }); return 'tok'; },
      stampPid: (t, p) => calls.stamped.push([t, p]),
      release: (t) => calls.released.push(t),
    },
    runTask: async (o) => { calls.runs.push(o); if (o.onSpawn) o.onSpawn(1234); return okRun(); },
    buildTaskArgs: (o) => { calls.args.push(o); return ['-p']; },
    buildTaskEnv: () => ({}),
    ledger: {
      appendTaskStart: async (cwd, row) => { calls.starts.push(row); },
      appendTaskEnd: async (cwd, row) => { calls.ends.push(row); },
    },
    costOfUsage: () => ({ costUsd: 0.5 }),
    randomUUID: () => 'task-1',
    ...over,
  };
  let handler;
  registerAdminRoute({ registerRoute: (m, u, h) => { if (`${m} ${u}` === 'POST /admin/tasks') handler = h; } }, deps);
  const call = async (body, { res = fakeRes(), req = fakeReq(body) } = {}) => {
    await handler(req, res);
    return res;
  };
  return { calls, call, deps };
}

const base = (over = {}) => ({ cwd: PROJ, agent: 'dev-lead', missionId: 'm-1', prompt: 'hello', ...over });

describe('POST /admin/tasks', () => {
  let s;
  beforeEach(() => { s = setup(); });

  test('403 when the human switch is off — no spawn, no ledger line', async () => {
    s = setup({ taskSwitch: { isTaskSwitchOn: () => false } });
    const res = await s.call(base());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'tasks_disabled' });
    expect(res.body.hint).toMatch(/Scheduler/);
    expect(res.body.hint).toMatch(/Tasks/);
    expect(s.calls.runs).toHaveLength(0);
    expect(s.calls.starts).toHaveLength(0);
  });

  test('400 invalid_request on schema failures', async () => {
    for (const body of [
      base({ prompt: '' }),
      base({ extra: 1 }),
      base({ timeoutSec: 0 }),
      base({ runtime: { maxTurns: 500 } }),
      base({ runtime: { sessionId: 'not-a-uuid' } }),
      base({ runtime: { cwd: 'relative' } }),
      base({ runtime: { systemPrompt: 'x'.repeat(100 * 1024 + 1) } }),
      base({ missionId: 'x'.repeat(201) }),
    ]) {
      const res = await s.call(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(res.body.details).toBeTruthy();
    }
    expect((await s.call('{nope')).status).toBe(400);
    expect(s.calls.starts).toHaveLength(0);
  });

  test('400 for sessionId+resume and resume+persistSession:false', async () => {
    let res = await s.call(base({ runtime: { sessionId: SID, resume: SID2 } }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    res = await s.call(base({ runtime: { resume: SID, persistSession: false } }));
    expect(res.status).toBe(400);
  });

  test('400 mcp_config_missing for a relative path that does not resolve', async () => {
    let res = await s.call(base({ runtime: { mcpConfig: ['missing.json'] } }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('mcp_config_missing');
    res = await s.call(base({ runtime: { mcpConfig: ['mcp.json'] } }));
    expect(res.status).toBe(200);
  });

  test('404 unknown_agent', async () => {
    s = setup({ resolveInfo: async () => ({ personaFound: false }) });
    const res = await s.call(base());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_agent');
  });

  test('422 model_unresolved and effort_unresolved', async () => {
    s = setup({ resolveInfo: async () => ({ personaFound: true, resolvedModelId: null, personaEffort: 'low' }) });
    let res = await s.call(base());
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('model_unresolved');
    s = setup({ resolveInfo: async () => ({ personaFound: true, resolvedModelId: 'inherit', personaEffort: 'low' }) });
    expect((await s.call(base())).body.error).toBe('model_unresolved');
    s = setup({ resolveInfo: async () => ({ personaFound: true, resolvedModelId: 'claude-x', personaEffort: null }) });
    res = await s.call(base());
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('effort_unresolved');
    expect(s.calls.starts).toHaveLength(0);
  });

  test('409 session_busy for a resume of a session a running Task holds', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let n = 0;
    s = setup({
      randomUUID: () => `task-${++n}`,
      runTask: async () => { await gate; return okRun(); },
    });
    const first = s.call(base({ runtime: { sessionId: SID, persistSession: true } }));
    await new Promise((r) => setTimeout(r, 20));
    const second = await s.call(base({ runtime: { resume: SID } }));
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('session_busy');
    release();
    expect((await first).status).toBe(200);
    // Released after the first finished.
    expect((await s.call(base({ runtime: { resume: SID } }))).status).toBe(200);
  });

  test('slot_timeout: no spawn, end line with status slot_timeout', async () => {
    s = setup({ sessionSlots: { waitForSlot: async () => null, release: () => {}, stampPid: () => {} } });
    const res = await s.call(base());
    expect(res.body).toMatchObject({ ok: false, error: 'slot_timeout', taskId: 'task-1' });
    expect(s.calls.runs).toHaveLength(0);
    expect(s.calls.starts).toHaveLength(1);
    expect(s.calls.ends[0].status).toBe('slot_timeout');
  });

  test('429 too_many_waiting', async () => {
    const err = Object.assign(new Error('full'), { code: 'too_many_waiting' });
    s = setup({ sessionSlots: { waitForSlot: async () => { throw err; }, release: () => {}, stampPid: () => {} } });
    const res = await s.call(base());
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('too_many_waiting');
    expect(s.calls.runs).toHaveLength(0);
    expect(s.calls.ends[0].status).toBe('too_many_waiting');
  });

  test('empty tool arrays reach buildTaskArgs unchanged; skipPermissions maps to the argv flag name', async () => {
    const res = await s.call(base({ runtime: { allowedTools: [], tools: [], skipPermissions: true } }));
    expect(res.status).toBe(200);
    const a = s.calls.args[0];
    expect(a.runtime.allowedTools).toEqual([]);
    expect(a.runtime.tools).toEqual([]);
    expect(a.runtime.dangerouslySkipPermissions).toBe(true);
    expect(a).toMatchObject({ model: 'claude-haiku-4-5', effort: 'low', projectCwd: PROJ });
  });

  test('persistSession without a sessionId records persisted true with sessionId = taskId', async () => {
    const res = await s.call(base({ runtime: { persistSession: true } }));
    expect(res.status).toBe(200);
    expect(s.calls.starts[0]).toMatchObject({ persisted: true, sessionId: 'task-1' });
    expect(s.calls.args[0].runtime.sessionId).toBe('task-1');
    expect(res.body.sessionId).toBe('task-1');
  });

  test('ok path: start before wait, end with usage + cost, 200 shape, batch lane by default', async () => {
    const order = [];
    s = setup({
      ledger: {
        appendTaskStart: async (c, row) => { order.push('start'); s.calls.starts.push(row); },
        appendTaskEnd: async (c, row) => { order.push('end'); s.calls.ends.push(row); },
      },
      sessionSlots: {
        waitForSlot: async (owner, o) => { order.push('wait'); s.calls.waits.push({ owner, ...o }); return 'tok'; },
        stampPid: (t, p) => s.calls.stamped.push([t, p]),
        release: (t) => s.calls.released.push(t),
      },
    });
    const res = await s.call(base({ caller: { pipeline: 'burrow', runId: 'r1', step: 'distill', attempt: 1 } }));
    expect(order).toEqual(['start', 'wait', 'end']);
    expect(s.calls.waits[0]).toMatchObject({ owner: 'task:task-1', lane: 'task-batch', timeoutMs: 120000 });
    expect(s.calls.waits[0].signal).toBeTruthy();
    expect(s.calls.stamped).toEqual([['tok', 1234]]);
    expect(s.calls.released).toEqual(['tok']);
    expect(s.calls.starts[0]).toMatchObject({ taskId: 'task-1', agent: 'dev-lead', missionId: 'm-1', prompt: 'hello', persisted: false, sessionId: null, caller: { pipeline: 'burrow' } });
    expect(s.calls.ends[0]).toMatchObject({ taskId: 'task-1', status: 'ok', costUsd: 0.5, usage: { input_tokens: 10 }, output: '{"result":"hi"}' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true, taskId: 'task-1', status: 'ok', stdout: '{"result":"hi"}', costUsd: 0.5, cliCostUsd: 0.01,
      durationMs: 42, exitCode: 0, model: 'claude-haiku-4-5', effort: 'low', usage: { output_tokens: 5 },
      quota: { rateLimited: false, resetsAt: null },
    });
    expect(typeof res.body.slotWaitMs).toBe('number');
    expect(s.calls.runs[0].timeoutMs).toBe(600000);
    expect(s.calls.runs[0].cwd).toBe(PROJ);
  });

  test('interactive priority uses lane task-interactive; text callers get textStdoutFor', async () => {
    const res = await s.call(base({ priority: 'interactive', runtime: { outputFormat: 'text' } }));
    expect(s.calls.waits[0].lane).toBe('task-interactive');
    expect(res.body.stdout).toBe('hi\n');
  });

  test('caller disconnect aborts the run (caller_gone)', async () => {
    s = setup({
      runTask: (o) => new Promise((resolve) => {
        o.signal.addEventListener('abort', () => resolve(okRun({ status: 'caller_gone', usage: null, envelope: null, stdout: '' })));
      }),
    });
    const req = fakeReq(base());
    const res = fakeRes();
    const p = s.call(null, { req, res });
    await new Promise((r) => setTimeout(r, 20));
    res.destroyed = true;
    req.emit('close');
    await p;
    expect(s.calls.ends[0].status).toBe('caller_gone');
    expect(res.status).toBe(null);
  });

  test('caller disconnect during the slot wait ends caller_gone with no spawn', async () => {
    s = setup({
      sessionSlots: {
        waitForSlot: (owner, o) => new Promise((resolve) => { o.signal.addEventListener('abort', () => resolve(null)); }),
        release: () => {}, stampPid: () => {},
      },
    });
    const req = fakeReq(base());
    const res = fakeRes();
    const p = s.call(null, { req, res });
    await new Promise((r) => setTimeout(r, 20));
    res.emit('close');
    await p;
    expect(s.calls.runs).toHaveLength(0);
    expect(s.calls.ends[0].status).toBe('caller_gone');
  });
});
