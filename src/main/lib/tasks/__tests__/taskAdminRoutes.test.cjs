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
  res.headers = null;
  res.writableLength = 0;
  res.chunks = [];
  res.writeHead = (s, h) => { res.status = s; res.headers = h || null; };
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true; };
  res.end = (b) => { if (b !== undefined) res.body = JSON.parse(b); res.writableEnded = true; };
  /** Every NDJSON line written with write(), parsed. */
  res.lines = () => res.chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
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
  const calls = { order: [], starts: [], ends: [], waits: [], runs: [], args: [], released: [], stamped: [], audits: [] };
  const deps = {
    resolveProjectRoot: (c) => c,
    syncInteractiveReserve: () => { calls.order.push('sync'); return false; },
    taskSwitch: { isTaskSwitchOn: () => { calls.order.push('switch'); return true; } },
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
    usageHold: () => null,
    appendAuditEvent: (kind, fields) => { calls.audits.push({ kind, ...fields }); },
    ...over,
  };
  const handlers = new Map();
  registerAdminRoute({ registerRoute: (m, u, h) => { handlers.set(`${m} ${u}`, h); } }, deps);
  const handler = handlers.get('POST /admin/tasks');
  const call = async (body, { res = fakeRes(), req = fakeReq(body) } = {}) => {
    await handler(req, res);
    return res;
  };
  const callImport = async (body, { res = fakeRes(), req = fakeReq(body) } = {}) => {
    await handlers.get('POST /admin/tasks/import')(req, res);
    return res;
  };
  return { calls, call, callImport, deps };
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
      base({ runtime: { disallowedTools: ['WebFetch(domain:localhost'] } }),
      base({ runtime: { disallowedTools: [''] } }),
      base({ runtime: { disallowedTools: ['   '] } }),
      base({ runtime: { disallowedTools: ['a\nb'] } }),
      base({ runtime: { disallowedTools: ['WebFetch)x('] } }),
      base({ runtime: { disallowedTools: ['(domain:x)'] } }),
      base({ runtime: { disallowedTools: ['WebFetch(a)b'] } }),
      base({ runtime: { disallowedTools: ['x'.repeat(501)] } }),
      base({ runtime: { disallowedTools: Array.from({ length: 51 }, (_, i) => `Tool${i}`) } }),
      base({ runtime: { disallowedTools: 'Bash' } }),
      base({ runtime: { disallowedTools: ['--mcp-config', '/x.json'] } }),
      base({ runtime: { disallowedTools: ['WebFetch(domain:localhost)', '--settings'] } }),
      base({ runtime: { disallowedTools: [' -x'] } }),
      base({ runtime: { disallowedTools: ['-p'] } }),
      base({ runtime: { appendSystemPrompt: 'x'.repeat(100 * 1024 + 1) } }),
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

  test('disallowedTools + appendSystemPrompt reach buildTaskArgs unchanged', async () => {
    const disallowedTools = ['WebFetch(domain:localhost)', 'WebFetch(domain:127.0.0.1)', 'Bash(git push:*)', 'Write'];
    const appendSystemPrompt = 'Never fetch localhost.\nBe brief.';
    const res = await s.call(base({ runtime: { disallowedTools, appendSystemPrompt, systemPrompt: 'SYS' } }));
    expect(res.status).toBe(200);
    const a = s.calls.args[0];
    expect(a.runtime.disallowedTools).toEqual(disallowedTools);
    expect(a.runtime.appendSystemPrompt).toBe(appendSystemPrompt);
    expect(a.runtime.systemPrompt).toBe('SYS');
  });

  test('an unbalanced deny rule answers 400 with no ledger start line', async () => {
    const res = await s.call(base({ runtime: { disallowedTools: ['Bash', 'WebFetch(domain:localhost'] } }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(s.calls.starts).toHaveLength(0);
    expect(s.calls.args).toHaveLength(0);
    expect(s.calls.runs).toHaveLength(0);
  });

  test("a deny rule not starting with a letter answers 400 with no ledger start line (flag injection)", async () => {
    for (const disallowedTools of [['--mcp-config', '/x.json'], ['WebFetch(domain:localhost)', '--settings'], [' -x'], ['-p']]) {
      const res = await s.call(base({ runtime: { disallowedTools } }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    }
    expect(s.calls.starts).toHaveLength(0);
    expect(s.calls.args).toHaveLength(0);
    expect(s.calls.runs).toHaveLength(0);
  });

  test("Kiln's localhost deny rules still reach buildTaskArgs unchanged", async () => {
    const disallowedTools = ['WebFetch(domain:localhost)', 'WebFetch(domain:127.0.0.1)'];
    const res = await s.call(base({ runtime: { disallowedTools } }));
    expect(res.status).toBe(200);
    expect(s.calls.args[0].runtime.disallowedTools).toEqual(disallowedTools);
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

describe('POST /admin/tasks stream:true', () => {
  const sbase = (over = {}) => base({ stream: true, ...over });

  test('without stream (or stream:false) the reply is plain JSON', async () => {
    const s = setup();
    const res = await s.call(base({ stream: false }));
    expect(res.status).toBe(200);
    expect(res.chunks).toHaveLength(0);
    expect(res.body).toMatchObject({ ok: true, taskId: 'task-1' });
    expect(res.body).not.toHaveProperty('droppedLines');
  });

  test('400 when stream is not a boolean', async () => {
    const s = setup();
    const res = await s.call(base({ stream: 'yes' }));
    expect(res.status).toBe(400);
  });

  test('refusals before the start line keep their status and JSON body (403, 404)', async () => {
    let s = setup({ taskSwitch: { isTaskSwitchOn: () => false } });
    let res = await s.call(sbase());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'tasks_disabled' });
    expect(res.chunks).toHaveLength(0);
    s = setup({ resolveInfo: async () => ({ personaFound: false }) });
    res = await s.call(sbase());
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false, error: 'unknown_agent' });
    expect(res.chunks).toHaveLength(0);
  });

  test('started line is written before the slot is granted; then running, stdout lines in order, result', async () => {
    let grant;
    const s = setup({
      sessionSlots: {
        waitForSlot: () => new Promise((r) => { grant = r; }),
        stampPid: () => {}, release: () => {},
      },
      runTask: async (o) => {
        o.onStdoutLine('{"type":"system","subtype":"init"}');
        o.onStdoutLine('plain text');
        o.onStdoutLine('[1,2]');
        o.onStdoutLine('{"type":"assistant","message":{}}');
        return okRun();
      },
    });
    const res = fakeRes();
    const p = s.call(null, { req: fakeReq(sbase()), res });
    await new Promise((r) => setTimeout(r, 20));
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/x-ndjson');
    expect(res.writableEnded).toBe(false);
    const first = res.lines();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: 'sm_task_started', taskId: 'task-1', model: 'claude-haiku-4-5', effort: 'low', sessionId: null });
    expect(typeof first[0].startedAt).toBe('string');
    expect(Object.keys(first[0]).sort()).toEqual(['effort', 'model', 'sessionId', 'startedAt', 'taskId', 'type']);
    grant('tok');
    await p;
    const lines = res.lines();
    expect(lines.map((l) => l.type)).toEqual(['sm_task_started', 'sm_task_running', 'system', 'sm_task_stdout', 'sm_task_stdout', 'assistant', 'sm_task_result']);
    expect(typeof lines[1].slotWaitMs).toBe('number');
    expect(lines[2]).toEqual({ type: 'system', subtype: 'init' });
    expect(lines[3]).toEqual({ type: 'sm_task_stdout', text: 'plain text' });
    expect(lines[4]).toEqual({ type: 'sm_task_stdout', text: '[1,2]' });
    expect(res.writableEnded).toBe(true);
    expect(res.body).toBe(null);

    // The result line = the non-stream 200 reply's keys + droppedLines.
    const plain = await setup().call(base());
    const result = lines[6];
    const { type, droppedLines, ...rest } = result;
    expect(droppedLines).toBe(0);
    expect(Object.keys(rest).sort()).toEqual(Object.keys(plain.body).sort());
    expect(rest).toMatchObject({ ok: true, taskId: 'task-1', status: 'ok', costUsd: 0.5 });
    expect(s.calls.ends).toHaveLength(1);
    const raw = res.chunks.join('');
    expect(raw).not.toMatch(/stderrTail/);
  });

  test('onStdoutLine is passed in every mode (live registry); a non-stream run writes no NDJSON', async () => {
    let seen;
    const s = setup({
      runTask: async (o) => { seen = o; o.onStdoutLine('{"n":1}'); o.onStdoutLine('text'); return okRun(); },
    });
    const res = await s.call(base());
    expect(typeof seen.onStdoutLine).toBe('function');
    expect(res.chunks).toEqual([]);
    expect(res.body).toMatchObject({ ok: true, status: 'ok' });
  });

  test('slot_timeout after the start line ends with an error result line and a ledger end line', async () => {
    const s = setup({ sessionSlots: { waitForSlot: async () => null, stampPid: () => {}, release: () => {} } });
    const res = await s.call(sbase());
    expect(res.status).toBe(200);
    const lines = res.lines();
    expect(lines.map((l) => l.type)).toEqual(['sm_task_started', 'sm_task_result']);
    expect(lines[1]).toMatchObject({ type: 'sm_task_result', ok: false, error: 'slot_timeout', taskId: 'task-1' });
    expect(typeof lines[1].slotWaitMs).toBe('number');
    expect(s.calls.ends[0].status).toBe('slot_timeout');
    expect(s.calls.runs).toHaveLength(0);
    expect(res.writableEnded).toBe(true);
  });

  test('a close during the run aborts it (caller_gone) even after the 200 head was written', async () => {
    const s = setup({
      runTask: (o) => new Promise((resolve) => {
        o.signal.addEventListener('abort', () => resolve(okRun({ status: 'caller_gone', usage: null, envelope: null, stdout: '' })));
      }),
    });
    const req = fakeReq(sbase());
    const res = fakeRes();
    const p = s.call(null, { req, res });
    await new Promise((r) => setTimeout(r, 20));
    expect(res.status).toBe(200);
    res.destroyed = true;
    res.emit('close');
    await p;
    expect(s.calls.ends[0].status).toBe('caller_gone');
    expect(res.lines().map((l) => l.type)).toEqual(['sm_task_started', 'sm_task_running']);
  });

  test('a close during the slot wait aborts it (caller_gone)', async () => {
    const s = setup({
      sessionSlots: {
        waitForSlot: (owner, o) => new Promise((resolve) => { o.signal.addEventListener('abort', () => resolve(null)); }),
        release: () => {}, stampPid: () => {},
      },
    });
    const req = fakeReq(sbase());
    const res = fakeRes();
    const p = s.call(null, { req, res });
    await new Promise((r) => setTimeout(r, 20));
    req.emit('close');
    await p;
    expect(s.calls.runs).toHaveLength(0);
    expect(s.calls.ends[0].status).toBe('caller_gone');
  });

  test('lines are skipped and counted while writableLength exceeds 8 MiB', async () => {
    let res;
    const s = setup({
      runTask: async (o) => {
        o.onStdoutLine('{"n":1}');
        res.writableLength = 8 * 1024 * 1024 + 1;
        o.onStdoutLine('{"n":2}');
        o.onStdoutLine('text 3');
        res.writableLength = 0;
        o.onStdoutLine('{"n":4}');
        return okRun();
      },
    });
    res = fakeRes();
    await s.call(null, { req: fakeReq(sbase()), res });
    const lines = res.lines();
    expect(lines.filter((l) => 'n' in l).map((l) => l.n)).toEqual([1, 4]);
    expect(lines[lines.length - 1]).toMatchObject({ type: 'sm_task_result', droppedLines: 2 });
  });
});

describe('held interactive slot re-sync from the switch file', () => {
  test('POST /admin/tasks syncs once, before the switch check', async () => {
    const s = setup();
    const res = await s.call(base());
    expect(res.status).toBe(200);
    expect(s.calls.order).toEqual(['sync', 'switch']);
  });

  test('syncs before a 403 tasks_disabled too', async () => {
    const order = [];
    const s = setup({
      syncInteractiveReserve: () => { order.push('sync'); return false; },
      taskSwitch: { isTaskSwitchOn: () => { order.push('switch'); return false; } },
    });
    const res = await s.call(base());
    expect(res.status).toBe(403);
    expect(order).toEqual(['sync', 'switch']);
  });

  test('a 400 body never reaches the sync', async () => {
    const s = setup();
    const res = await s.call(base({ prompt: '' }));
    expect(res.status).toBe(400);
    expect(s.calls.order).toEqual([]);
  });

  test('a throwing sync still yields the normal response', async () => {
    const s = setup({ syncInteractiveReserve: () => { throw new Error('boom'); } });
    const res = await s.call(base());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const s2 = setup({
      syncInteractiveReserve: () => { throw new Error('boom'); },
      taskSwitch: { isTaskSwitchOn: () => false },
    });
    const res2 = await s2.call(base());
    expect(res2.status).toBe(403);
    expect(res2.body.error).toBe('tasks_disabled');
  });

  test('POST /admin/tasks/import syncs once before the switch check, also before a 403', async () => {
    const order = [];
    const s = setup({
      syncInteractiveReserve: () => { order.push('sync'); return false; },
      taskSwitch: { isTaskSwitchOn: () => { order.push('switch'); return false; } },
    });
    const res = await s.callImport({ cwd: PROJ, records: [] });
    // records: [] fails the schema (1-100) → never reaches the sync
    expect(res.status).toBe(400);
    expect(order).toEqual([]);
    const res2 = await s.callImport({ cwd: PROJ, records: [{}] });
    if (res2.status === 400) throw new Error('import body unexpectedly invalid: ' + JSON.stringify(res2.body));
    expect(res2.status).toBe(403);
    expect(order).toEqual(['sync', 'switch']);
  });

  test('import: a throwing sync still yields the normal 403', async () => {
    const s = setup({
      syncInteractiveReserve: () => { throw new Error('boom'); },
      taskSwitch: { isTaskSwitchOn: () => false },
    });
    const res = await s.callImport({ cwd: PROJ, records: [{}] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tasks_disabled');
  });

  test('real sync: switch file on → reserve on after one POST; file off → reserve off even on a 403', async () => {
    const slots = require('../../scheduler/sessionSlots.cjs');
    slots.__resetForTests();
    let fileOn = true;
    const fakeSwitch = { isTaskSwitchOn: () => fileOn, anyTaskSwitchOn: () => fileOn };
    // Same body as taskSwitch.syncInteractiveReserve, over a fake switch store.
    const sync = () => slots.setInteractiveReserve(fakeSwitch.anyTaskSwitchOn()) === true;
    const s = setup({ taskSwitch: fakeSwitch, syncInteractiveReserve: sync });
    expect(slots.snapshot().reserve).toBe(0);
    expect((await s.call(base())).status).toBe(200);
    expect(slots.snapshot().reserve).toBe(1);
    fileOn = false;
    const res = await s.call(base());
    expect(res.status).toBe(403);
    expect(slots.snapshot().reserve).toBe(0);
    slots.__resetForTests();
  });
});

describe('usage hold', () => {
  const HOLD = {
    reason: 'utilization-held', window: 'seven_day', percent: 93, threshold: 90,
    resetsAt: '2026-11-27T10:00:00.000Z', detail: 'seven_day window at 93% ≥ 90%, resets 2026-11-27T10:00:00.000Z',
  };
  const holdShape = { reason: HOLD.reason, window: HOLD.window, percent: HOLD.percent, threshold: HOLD.threshold, resetsAt: HOLD.resetsAt };

  test('a hold gives 429 usage_held, with no start line, wait or run (JSON)', async () => {
    const s = setup({ usageHold: () => HOLD });
    const res = await s.call(base());
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ ok: false, error: 'usage_held', hold: holdShape, detail: HOLD.detail });
    expect(res.body.hint).toMatch(/resetsAt/);
    expect(res.body.hint).toMatch(/GET \/admin\/usage-hold/);
    expect(s.calls.starts).toHaveLength(0);
    expect(s.calls.waits).toHaveLength(0);
    expect(s.calls.runs).toHaveLength(0);
    expect(s.calls.ends).toHaveLength(0);
  });

  test('a hold gives the same 429 JSON in stream mode, with no NDJSON head', async () => {
    const s = setup({ usageHold: () => HOLD });
    const res = await s.call(base({ stream: true }));
    expect(res.status).toBe(429);
    expect(res.headers && res.headers['Content-Type']).not.toBe('application/x-ndjson');
    expect(res.chunks).toHaveLength(0);
    expect(res.body).toMatchObject({ ok: false, error: 'usage_held', hold: holdShape });
    expect(s.calls.starts).toHaveLength(0);
    expect(s.calls.waits).toHaveLength(0);
    expect(s.calls.runs).toHaveLength(0);
  });

  test("usageHold: () => null leaves the ok path unchanged", async () => {
    const a = await setup().call(base());
    const b = await setup({ usageHold: () => null }).call(base());
    expect(b.status).toBe(200);
    // slotWaitMs is measured wall-clock; every other field must match exactly.
    const { slotWaitMs: wa, ...restA } = a.body;
    const { slotWaitMs: wb, ...restB } = b.body;
    expect(restB).toEqual(restA);
    expect(typeof wb).toBe(typeof wa);
  });

  test("priority: 'interactive' is refused the same way", async () => {
    const s = setup({ usageHold: () => HOLD });
    const res = await s.call(base({ priority: 'interactive' }));
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('usage_held');
    expect(s.calls.starts).toHaveLength(0);
    expect(s.calls.runs).toHaveLength(0);
  });

  test('a throwing usageHold gives 503 usage_hold_error before any ledger line', async () => {
    const s = setup({ usageHold: () => { throw new Error('reading broke'); } });
    const res = await s.call(base());
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, error: 'usage_hold_error' });
    expect(res.body.details).toMatch(/reading broke/);
    expect(s.calls.starts).toHaveLength(0);
    expect(s.calls.waits).toHaveLength(0);
    expect(s.calls.runs).toHaveLength(0);
  });

  const heldAfterWait = (over = {}) => {
    let reads = 0;
    return setup({ usageHold: () => (++reads >= 2 ? HOLD : null), ...over });
  };

  test('a hold that appears after the slot wait ends usage_held, releases the token, never runs (JSON)', async () => {
    const s = heldAfterWait();
    const res = await s.call(base());
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ ok: false, error: 'usage_held', hold: holdShape, taskId: 'task-1' });
    expect(typeof res.body.slotWaitMs).toBe('number');
    expect(s.calls.starts).toHaveLength(1);
    expect(s.calls.waits).toHaveLength(1);
    expect(s.calls.released).toEqual(['tok']);
    expect(s.calls.runs).toHaveLength(0);
    expect(s.calls.ends).toHaveLength(1);
    expect(s.calls.ends[0]).toMatchObject({ taskId: 'task-1', status: 'usage_held' });
    expect(typeof s.calls.ends[0].slotWaitMs).toBe('number');
  });

  test('a hold that appears after the slot wait ends with an sm_task_result line (stream)', async () => {
    const s = heldAfterWait();
    const res = await s.call(base({ stream: true }));
    expect(res.status).toBe(200);
    const lines = res.lines();
    expect(lines[0].type).toBe('sm_task_started');
    expect(lines.some((l) => l.type === 'sm_task_running')).toBe(false);
    const last = lines[lines.length - 1];
    expect(last).toMatchObject({ type: 'sm_task_result', ok: false, error: 'usage_held', taskId: 'task-1', hold: holdShape, detail: HOLD.detail });
    expect(typeof last.slotWaitMs).toBe('number');
    expect(s.calls.released).toEqual(['tok']);
    expect(s.calls.runs).toHaveLength(0);
    expect(s.calls.ends[0].status).toBe('usage_held');
  });

  const throwsAfterWait = () => {
    let reads = 0;
    return setup({ usageHold: () => { if (++reads >= 2) throw new Error('late'); return null; } });
  };

  test('a throw on the slot-grant re-read answers 503 usage_hold_error, ends usage_held, nothing spawned (JSON)', async () => {
    const s = throwsAfterWait();
    const res = await s.call(base());
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, error: 'usage_hold_error', taskId: 'task-1', details: 'late' });
    expect(typeof res.body.slotWaitMs).toBe('number');
    expect(res.body.hold).toBeUndefined();
    expect(s.calls.released).toEqual(['tok']);
    expect(s.calls.runs).toHaveLength(0);
    expect(s.calls.ends).toHaveLength(1);
    expect(s.calls.ends[0]).toMatchObject({ taskId: 'task-1', status: 'usage_held' });
    expect(typeof s.calls.ends[0].slotWaitMs).toBe('number');
  });

  test('a throw on the slot-grant re-read ends with an sm_task_result usage_hold_error line (stream)', async () => {
    const s = throwsAfterWait();
    const res = await s.call(base({ stream: true }));
    expect(res.status).toBe(200);
    const lines = res.lines();
    expect(lines[0].type).toBe('sm_task_started');
    expect(lines.some((l) => l.type === 'sm_task_running')).toBe(false);
    const last = lines[lines.length - 1];
    expect(last).toMatchObject({ type: 'sm_task_result', ok: false, error: 'usage_hold_error', taskId: 'task-1', details: 'late' });
    expect(typeof last.slotWaitMs).toBe('number');
    expect(last.hold).toBeUndefined();
    expect(s.calls.released).toEqual(['tok']);
    expect(s.calls.runs).toHaveLength(0);
    expect(s.calls.ends[0].status).toBe('usage_held');
  });

  test('two refusals under one hold append one audit event; a clear re-arms it', async () => {
    let hold = HOLD;
    const s = setup({ usageHold: () => hold });
    await s.call(base());
    await s.call(base());
    expect(s.calls.audits).toEqual([{ kind: 'task_usage_held', cwd: PROJ, ...holdShape }]);
    hold = null;
    expect((await s.call(base())).status).toBe(200);
    hold = HOLD;
    await s.call(base());
    expect(s.calls.audits).toHaveLength(2);
  });
});
