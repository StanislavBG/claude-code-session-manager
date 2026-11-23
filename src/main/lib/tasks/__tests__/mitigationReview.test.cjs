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
  let state = lastSeen === undefined ? {} : { [CWD]: { model: lastSeen, seenAt: '2026-11-01T00:00:00Z' } };
  const deps = {
    isTaskSwitchOn: () => switchOn,
    readRegistry: () => REGISTRY,
    resolveDefaultExecutorModel: async () => current,
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
  return { deps, posts, writes, getState: () => state };
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
