/**
 * memoryConsolidation.test.cjs — the weekly memory keep/move/drop Task
 * (lib/tasks/memoryConsolidation.cjs). All IO injected.
 *
 * Run: timeout 300 npx vitest run src/main/lib/tasks/__tests__/memoryConsolidation.test.cjs
 */
'use strict';

import { test, expect, beforeEach } from 'vitest';
const mc = require('../memoryConsolidation.cjs');
const fs = require('node:fs');
const path = require('node:path');

const CWD = '/tmp/sm-mc-project';
const NOW = Date.parse('2026-11-23T12:00:00Z');
const DAY = 86_400_000;

beforeEach(() => mc._resetForTests());

function harness({ switchOn = true, lastStartedAt = null, lastStatus = 'ok', overBudget = false } = {}) {
  const posts = [];
  const listCalls = [];
  const inputCalls = [];
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
    listTranscripts: (o) => { inputCalls.push(['transcripts', o]); return { transcripts: [{ path: '/home/x/.claude/projects/p/s1.jsonl' }], truncated: 2 }; },
    collectLessons: (o) => { inputCalls.push(['lessons', o]); return { lessons: [{ slug: 'prd-1', source: 'dev-lead', lines: ['always X'] }] }; },
    steeringPath: () => '/tmp/sm-mc-project/session-manager-operations/md-network/steering.md',
    adminPost: async (p, body) => {
      posts.push({ path: p, body });
      if (p === '/admin/tasks') {
        return { status: 200, body: { ok: true, taskId: 't-1', status: 'ok', envelope: { result: 'x\n<<<PROPOSAL\n# record\n- Totals: adds 1, merges 2, removals 3\n| c1 | verify | old_note.md | drop | a, b | 2 |\nPROPOSAL>>>\n' } } };
      }
      return { status: 200, body: { ok: true, item: { id: body.id } } };
    },
  };
  return { deps, posts, listCalls, inputCalls };
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
  expect(task.agent).toBe('md-network-curator');
  expect(task.timeoutSec).toBe(3600);
  expect(task.runtime.tools).toEqual(['Read', 'Grep', 'Glob', 'Agent']);
  expect(task.runtime.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Agent']);
  expect(task.prompt).toContain('old_note.md');
  const ny = h.posts[1].body;
  expect(ny.title).toContain('1 adds, 2 merges, 3 removals');
  expect(ny.why).toContain("Review MD network");
  expect(ny.why).toContain("'Weekly consolidation'");
  expect(ny.why).toContain('t-1');
  expect(ny.cwd).toBe(CWD);
  // the cadence window is 7 days
  expect(Date.parse(h.listCalls[0].o.since)).toBe(NOW - 7 * DAY);
});

test('runtime tools are read-only: no Bash, Edit or Write', () => {
  expect(mc.READ_ONLY_TOOLS).toEqual(['Read', 'Grep', 'Glob', 'Agent']);
  for (const bad of ['Bash', 'Edit', 'Write']) expect(mc.READ_ONLY_TOOLS).not.toContain(bad);
});

test('the seeded persona resolves to Fable at max effort', () => {
  const md = fs.readFileSync(path.join(__dirname, '../../../../seed/agents', mc.AGENT + '.md'), 'utf8');
  expect(md).toMatch(/^model: fable$/m);
  expect(md).toMatch(/^effort: max$/m);
});

test('first run: prompt names the 7-day window, transcripts, lessons, memory, stale, budget and steering', async () => {
  const h = harness();
  const r = await mc.maybeStartConsolidation({ cwd: CWD, now: NOW, deps: h.deps });
  await r.done;
  const p = h.posts[0].body.prompt;
  expect(p).toContain(new Date(NOW - 7 * DAY).toISOString());
  expect(p).toContain(new Date(NOW).toISOString());
  expect(p).toContain('/home/x/.claude/projects/p/s1.jsonl');
  expect(p).toContain('+2 more');
  expect(p).toContain('prd-1');
  expect(p).toContain('always X');
  expect(p).toContain('/tmp/mem');
  expect(p).toContain('old_note.md');
  expect(p).toContain('MEMORY.md index');
  expect(p).toContain('steering.md');
  expect(p).toContain('weekly-consolidation.md');
  expect(p).toContain('<<<PROPOSAL');
  expect(h.inputCalls[0][1]).toMatchObject({ cwd: CWD, sinceMs: NOW - 7 * DAY, untilMs: NOW });
});

test('the window starts at the previous counted run', async () => {
  const prev = NOW - 8 * DAY;
  const h = harness({ lastStartedAt: new Date(prev).toISOString() });
  const r = await mc.maybeStartConsolidation({ cwd: CWD, now: NOW, deps: h.deps });
  await r.done;
  expect(h.inputCalls[0][1].sinceMs).toBe(prev);
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

test('prompt carries the no-delete rule, read-only tools and the record for one Needs you item', () => {
  const p = mc.buildConsolidationPrompt({ cwd: CWD, memoryDir: '/tmp/mem', candidates: [] });
  expect(p).toContain(mc.NO_DELETE_RULE);
  expect(p).toMatch(/Do NOT delete/);
  expect(p).toMatch(/edit/);
  expect(p).toMatch(/ONE "Needs you" item/);
  expect(p).toMatch(/Weekly consolidation/);
  expect(p).toContain('Steering file: none.');
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
  expect(mc.NOT_RUN_STATUSES).toEqual(['usage_held', 'usage_hold_error', 'slot_timeout', 'too_many_waiting']);
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
