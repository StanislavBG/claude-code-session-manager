/**
 * memoryConsolidation.test.cjs — the weekly memory keep/move/drop Task
 * (lib/tasks/memoryConsolidation.cjs). All IO injected.
 *
 * Run: timeout 300 npx vitest run src/main/lib/tasks/__tests__/memoryConsolidation.test.cjs
 */
'use strict';

import { test, expect, beforeEach } from 'vitest';
const mc = require('../memoryConsolidation.cjs');

const CWD = '/tmp/sm-mc-project';
const NOW = Date.parse('2026-11-23T12:00:00Z');
const DAY = 86_400_000;

beforeEach(() => mc._resetForTests());

function harness({ switchOn = true, lastStartedAt = null, lastStatus = 'ok', overBudget = false } = {}) {
  const posts = [];
  const listCalls = [];
  const deps = {
    usageHold: () => null,
    isTaskSwitchOn: () => switchOn,
    listTasks: async (cwd, o) => {
      listCalls.push({ cwd, o });
      const inWindow = lastStartedAt && Date.parse(lastStartedAt) >= Date.parse(o.since);
      return { tasks: inWindow ? [{ startedAt: lastStartedAt, status: lastStatus, caller: { pipeline: o.pipeline } }] : [] };
    },
    measureBudget: () => ({ dir: '/tmp/mem', bytes: overBudget ? 30000 : 1000, lines: overBudget ? 250 : 10, maxBytes: 25600, maxLines: 200, overBudget }),
    staleCandidates: async () => [{ name: 'old_note.md', ageDays: 120, inboundLinks: 0, reasons: ['90+ days old with no inbound links'], deadRefs: [] }],
    adminPost: async (p, body) => {
      posts.push({ path: p, body });
      if (p === '/admin/tasks') {
        return { status: 200, body: { ok: true, taskId: 't-1', status: 'ok', envelope: { result: 'x\n<<<PROPOSAL\n| old_note.md | drop | | stale |\nPROPOSAL>>>\n' } } };
      }
      return { status: 200, body: { ok: true, item: { id: body.id } } };
    },
  };
  return { deps, posts, listCalls };
}

test('switch off: nothing starts, nothing is posted', async () => {
  const h = harness({ switchOn: false });
  const r = await mc.maybeStartConsolidation({ cwd: CWD, now: NOW, deps: h.deps });
  expect(r).toEqual({ started: false, reason: 'switch_off' });
  expect(h.posts).toEqual([]);
  expect(h.listCalls).toEqual([]);
});

test('weekly cadence: first run starts via POST /admin/tasks and posts ONE Needs you item', async () => {
  const h = harness();
  const r = await mc.maybeStartConsolidation({ cwd: CWD, now: NOW, deps: h.deps });
  expect(r.started).toBe(true);
  expect(r.reason).toBe('weekly');
  const out = await r.done;
  expect(out.ok).toBe(true);
  expect(h.posts.map((p) => p.path)).toEqual(['/admin/tasks', '/admin/needs-you']);
  const task = h.posts[0].body;
  expect(task.caller.pipeline).toBe(mc.PIPELINE);
  expect(task.runtime.tools).toEqual(['Read', 'Grep', 'Glob']);
  expect(task.prompt).toContain('old_note.md');
  const ny = h.posts[1].body;
  expect(ny.why).toBe('| old_note.md | drop | | stale |');
  expect(ny.cwd).toBe(CWD);
  // the cadence window is 7 days
  expect(Date.parse(h.listCalls[0].o.since)).toBe(NOW - 7 * DAY);
});

test('weekly cadence: a run 3 days ago blocks; one 8 days ago does not', async () => {
  const recent = harness({ lastStartedAt: new Date(NOW - 3 * DAY).toISOString() });
  expect(await mc.maybeStartConsolidation({ cwd: CWD, now: NOW, deps: recent.deps })).toEqual({ started: false, reason: 'not_due' });
  expect(recent.posts).toEqual([]);

  const old = harness({ lastStartedAt: new Date(NOW - 8 * DAY).toISOString() });
  const r = await mc.maybeStartConsolidation({ cwd: CWD, now: NOW, deps: old.deps });
  expect(r.started).toBe(true);
  await r.done;
});

test('over budget starts early (inside the week), but not twice within 24 h', async () => {
  const early = harness({ overBudget: true, lastStartedAt: new Date(NOW - 2 * DAY).toISOString() });
  const r = await mc.maybeStartConsolidation({ cwd: CWD, now: NOW, deps: early.deps });
  expect(r.started).toBe(true);
  expect(r.reason).toBe('over_budget');
  await r.done;
  expect(early.posts[0].body.prompt).toContain('OVER BUDGET');

  const tooSoon = harness({ overBudget: true, lastStartedAt: new Date(NOW - 2 * 3600_000).toISOString() });
  expect((await mc.maybeStartConsolidation({ cwd: CWD, now: NOW, deps: tooSoon.deps })).started).toBe(false);
});

test('a second call while one is in flight does not start another', async () => {
  const h = harness();
  const a = await mc.maybeStartConsolidation({ cwd: CWD, now: NOW, deps: h.deps });
  const b = await mc.maybeStartConsolidation({ cwd: CWD, now: NOW, deps: h.deps });
  expect(a.started).toBe(true);
  expect(b).toEqual({ started: false, reason: 'in_flight' });
  await a.done;
});

test('prompt carries the no-delete rule, read-only tools and one keep/move/drop table for one Needs you item', () => {
  const p = mc.buildConsolidationPrompt({ cwd: CWD, memoryDir: '/tmp/mem', candidates: [] });
  expect(p).toContain(mc.NO_DELETE_RULE);
  expect(p).toMatch(/Do NOT delete/);
  expect(p).toMatch(/edit/);
  expect(p).toMatch(/ONE keep\/move\/drop table/);
  expect(p).toMatch(/ONE "Needs you" item/);
  expect(p).toMatch(/Drift check/);
});

test('a failed Task posts nothing to Needs you', async () => {
  const h = harness();
  h.deps.adminPost = async (p, body) => {
    h.posts.push({ path: p, body });
    return { status: 403, body: { ok: false, error: 'tasks_disabled' } };
  };
  const r = await mc.maybeStartConsolidation({ cwd: CWD, now: NOW, deps: h.deps });
  const out = await r.done;
  expect(out.ok).toBe(false);
  expect(h.posts.map((p) => p.path)).toEqual(['/admin/tasks']);
});

test('usage hold: nothing starts or posts; with the hold cleared the same call starts the Task', async () => {
  const h = harness();
  const hold = { reason: 'usage_hold', pct: 97 };
  h.deps.usageHold = () => hold;
  const r = await mc.maybeStartConsolidation({ cwd: CWD, now: NOW, deps: h.deps });
  expect(r).toEqual({ started: false, reason: 'usage_held', hold });
  expect(h.posts).toEqual([]);

  h.deps.usageHold = () => null;
  const ok = await mc.maybeStartConsolidation({ cwd: CWD, now: NOW, deps: h.deps });
  expect(ok.started).toBe(true);
  await ok.done;
  expect(h.posts[0].path).toBe('/admin/tasks');
});

test('a usageHold throw ends in reason error and starts nothing', async () => {
  const h = harness();
  h.deps.usageHold = () => { throw new Error('boom'); };
  const r = await mc.maybeStartConsolidation({ cwd: CWD, now: NOW, deps: h.deps });
  expect(r).toMatchObject({ started: false, reason: 'error' });
  expect(h.posts).toEqual([]);
});

test('NOT_RUN_STATUSES is frozen and lists the never-ran statuses', () => {
  expect(mc.NOT_RUN_STATUSES).toEqual(['usage_held', 'slot_timeout', 'too_many_waiting']);
  expect(Object.isFrozen(mc.NOT_RUN_STATUSES)).toBe(true);
});

test.each(['usage_held', 'slot_timeout'])('a week whose only Task has status %s is still due', async (status) => {
  const h = harness({ lastStartedAt: new Date(NOW - 2 * DAY).toISOString(), lastStatus: status });
  const r = await mc.maybeStartConsolidation({ cwd: CWD, now: NOW, deps: h.deps });
  expect(r.started).toBe(true);
  expect(r.reason).toBe('weekly');
  await r.done;
  expect(h.listCalls[0].o.limit).toBeGreaterThan(1);
});
