/**
 * mitigationReview.test.cjs — the model-mitigations review Task
 * (lib/tasks/mitigationReview.cjs). All IO injected.
 *
 * Run: timeout 300 npx vitest run src/main/lib/tasks/__tests__/mitigationReview.test.cjs
 */
'use strict';

import { test, expect, beforeEach } from 'vitest';
const mr = require('../mitigationReview.cjs');

const CWD = '/tmp/sm-mr-project';
const NOW = Date.parse('2026-11-23T12:00:00Z');

const REGISTRY = [
  '# Model mitigations — registry',
  '',
  '| id | behavior | model | observed | location | needle |',
  '| --- | --- | --- | --- | --- | --- |',
  '| MM-1 | Backgrounds a review agent. | Claude Sonnet | 2026-10-01 | `a/standards.md` | `no next turn` |',
  '| MM-4 | Retyping base64 corrupts it. | Claude Opus | 2026-10-09 | `src/seed/agents/demo.md` | `shipped silent` |',
  '',
].join('\n');

beforeEach(() => mr._resetForTests());

function harness({ switchOn = true, lastSeen = undefined, current = 'claude-sonnet-5-1' } = {}) {
  const posts = [];
  const writes = [];
  const resolveCalls = [];
  let state = lastSeen === undefined ? {} : { [CWD]: { model: lastSeen, seenAt: '2026-11-01T00:00:00Z' } };
  const deps = {
    usageHold: () => null,
    isTaskSwitchOn: () => switchOn,
    readRegistry: () => REGISTRY,
    resolveDefaultExecutorModel: async (cwd) => { resolveCalls.push(cwd); return current; },
    readState: () => state,
    writeState: (s) => { writes.push(JSON.parse(JSON.stringify(s))); state = s; },
    adminPost: async (p, body) => {
      posts.push({ path: p, body });
      if (p === '/admin/tasks') {
        return { status: 200, body: { ok: true, status: 'ok', taskId: 'task-1', envelope: { result: '<<<PROPOSAL\n| MM-1 | remove | gone |\nPROPOSAL>>>' } } };
      }
      return { status: 200, body: { ok: true, item: { id: body.id } } };
    },
  };
  return { deps, posts, writes, resolveCalls, getState: () => state };
}

test('no change → no Task', async () => {
  const h = harness({ lastSeen: 'claude-sonnet-5-1', current: 'claude-sonnet-5-1' });
  const r = await mr.maybeStartMitigationReview({ cwd: CWD, now: NOW, deps: h.deps });
  expect(r).toMatchObject({ started: false, reason: 'unchanged' });
  expect(h.posts).toEqual([]);
});

test('first sighting records the model and starts no Task', async () => {
  const h = harness({ lastSeen: undefined, current: 'claude-sonnet-5-1' });
  const r = await mr.maybeStartMitigationReview({ cwd: CWD, now: NOW, deps: h.deps });
  expect(r).toMatchObject({ started: false, reason: 'first_seen' });
  expect(h.posts).toEqual([]);
  expect(h.getState()[CWD].model).toBe('claude-sonnet-5-1');
});

test('change → one Task listing every registry row, then one Needs-you item', async () => {
  const h = harness({ lastSeen: 'claude-sonnet-4-6', current: 'claude-sonnet-5-1' });
  const r = await mr.maybeStartMitigationReview({ cwd: CWD, now: NOW, deps: h.deps });
  expect(r).toMatchObject({ started: true, from: 'claude-sonnet-4-6', to: 'claude-sonnet-5-1' });
  const out = await r.done;
  expect(out.ok).toBe(true);

  const tasks = h.posts.filter((p) => p.path === '/admin/tasks');
  expect(tasks).toHaveLength(1);
  const t = tasks[0].body;
  expect(t.agent).toBe('dev-lead'); // the Task route pins --model from this persona
  expect(t.caller.pipeline).toBe(mr.PIPELINE);
  expect(t.prompt).toContain('MM-1');
  expect(t.prompt).toContain('MM-4');
  expect(t.prompt).toContain('claude-sonnet-4-6');
  expect(t.prompt).toContain('claude-sonnet-5-1');
  expect(t.runtime.tools).toEqual(['Read', 'Grep', 'Glob']);

  const needs = h.posts.filter((p) => p.path === '/admin/needs-you');
  expect(needs).toHaveLength(1);
  expect(needs[0].body.why).toContain('MM-1');
  expect(h.getState()[CWD].model).toBe('claude-sonnet-5-1');

  // Same model next tick → nothing new.
  const again = await mr.maybeStartMitigationReview({ cwd: CWD, now: NOW + 1000, deps: h.deps });
  expect(again.started).toBe(false);
  expect(h.posts.filter((p) => p.path === '/admin/tasks')).toHaveLength(1);
});

test('switch off → no Task and the last-seen model is left untouched', async () => {
  const h = harness({ switchOn: false, lastSeen: 'claude-sonnet-4-6', current: 'claude-sonnet-5-1' });
  const r = await mr.maybeStartMitigationReview({ cwd: CWD, now: NOW, deps: h.deps });
  expect(r).toMatchObject({ started: false, reason: 'switch_off' });
  expect(h.posts).toEqual([]);
  expect(h.writes).toEqual([]);
});

test('parseRegistryRows reads every MM row', () => {
  const rows = mr.parseRegistryRows(REGISTRY);
  expect(rows.map((r) => r.id)).toEqual(['MM-1', 'MM-4']);
  expect(rows[0].location).toBe('a/standards.md');
  expect(rows[1].needle).toBe('shipped silent');
});

test('concreteModelFor picks the newest id of an alias family', () => {
  const ids = ['claude-sonnet-4-5-20250929', 'claude-sonnet-5-1', 'claude-sonnet-5', 'claude-opus-5-5'];
  expect(mr.concreteModelFor('sonnet', ids)).toBe('claude-sonnet-5-1');
  expect(mr.concreteModelFor('claude-opus-5-5', ids)).toBe('claude-opus-5-5');
  expect(mr.concreteModelFor('haiku', ids)).toBe('haiku');
});

test('model change under the usage hold: nothing resolved, written or started; cleared → review starts', async () => {
  const h = harness({ lastSeen: 'claude-sonnet-4-6', current: 'claude-sonnet-5-1' });
  const hold = { reason: 'usage_hold', pct: 97 };
  h.deps.usageHold = () => hold;
  const r = await mr.maybeStartMitigationReview({ cwd: CWD, now: NOW, deps: h.deps });
  expect(r).toEqual({ started: false, reason: 'usage_held', hold });
  expect(h.resolveCalls).toEqual([]);
  expect(h.writes).toEqual([]);
  expect(h.posts).toEqual([]);

  h.deps.usageHold = () => null;
  const ok = await mr.maybeStartMitigationReview({ cwd: CWD, now: NOW + 1000, deps: h.deps });
  expect(ok).toMatchObject({ started: true, from: 'claude-sonnet-4-6', to: 'claude-sonnet-5-1' });
  await ok.done;
  expect(h.posts.filter((p) => p.path === '/admin/tasks')).toHaveLength(1);
});

test('first sighting under the hold is not recorded', async () => {
  const h = harness({ lastSeen: undefined });
  h.deps.usageHold = () => ({ reason: 'usage_hold' });
  const r = await mr.maybeStartMitigationReview({ cwd: CWD, now: NOW, deps: h.deps });
  expect(r.reason).toBe('usage_held');
  expect(h.writes).toEqual([]);
  expect(h.getState()).toEqual({});
});

test('a usageHold throw ends in reason error and starts nothing', async () => {
  const h = harness({ lastSeen: 'claude-sonnet-4-6' });
  h.deps.usageHold = () => { throw new Error('boom'); };
  const r = await mr.maybeStartMitigationReview({ cwd: CWD, now: NOW, deps: h.deps });
  expect(r).toMatchObject({ started: false, reason: 'error' });
  expect(h.posts).toEqual([]);
  expect(h.writes).toEqual([]);
});

test('429 usage_held answer restores the previous model; the next call reviews again', async () => {
  const h = harness({ lastSeen: 'claude-sonnet-4-6', current: 'claude-sonnet-5-1' });
  const before = h.getState()[CWD];
  const okPost = h.deps.adminPost;
  h.deps.adminPost = async (p, body) => {
    h.posts.push({ path: p, body });
    return { status: 429, body: { ok: false, error: 'usage_held' } };
  };
  const r = await mr.maybeStartMitigationReview({ cwd: CWD, now: NOW, deps: h.deps });
  expect(r.started).toBe(true);
  const out = await r.done;
  expect(out).toMatchObject({ ok: false, error: 'usage_held' });
  expect(h.getState()[CWD]).toEqual(before);
  expect(h.posts.filter((p) => p.path === '/admin/needs-you')).toHaveLength(0);

  h.posts.length = 0;
  h.deps.adminPost = okPost;
  const again = await mr.maybeStartMitigationReview({ cwd: CWD, now: NOW + 3600_000, deps: h.deps });
  expect(again).toMatchObject({ started: true, from: 'claude-sonnet-4-6', to: 'claude-sonnet-5-1' });
  expect((await again.done).ok).toBe(true);
  expect(h.getState()[CWD].model).toBe('claude-sonnet-5-1');
});

test('503 slot_timeout leaves a newer entry another writer stored', async () => {
  const h = harness({ lastSeen: 'claude-sonnet-4-6', current: 'claude-sonnet-5-1' });
  h.deps.adminPost = async () => {
    h.deps.writeState({ [CWD]: { model: 'claude-sonnet-6', seenAt: 'x' } });
    return { status: 503, body: { error: 'slot_timeout' } };
  };
  const r = await mr.maybeStartMitigationReview({ cwd: CWD, now: NOW, deps: h.deps });
  const out = await r.done;
  expect(out.error).toBe('slot_timeout');
  expect(h.getState()[CWD].model).toBe('claude-sonnet-6');
});
