'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerBatchLaunchHold.test.cjs
//
// The launch circuit breaker (lib/launchFailure.cjs, issue #11) hands the
// picker a Map of slug → hold reason. A held row must be invisible to every
// pick — it must NOT shadow a pickable sibling behind it, must not make a
// project a round-robin candidate on its own, and must not be offered as a
// quiet-machine job — while still surfacing as a per-row hold for the UI.

const assert = require('node:assert/strict');
const { pickForProject, pickNextBatch, DEFAULT_PROJECT_CWD } = require('../schedulerBatch.cjs');
const { computeLaunchHolds } = require('../../scheduler.cjs');
const lf = require('../launchFailure.cjs');

const CWD = DEFAULT_PROJECT_CWD;

function job(slug, status = 'pending', extra = {}) {
  return {
    slug,
    status,
    cwd: CWD,
    parallelGroup: Number(String(slug).match(/^(\d+)-/)?.[1] ?? 99),
    dependsOn: [],
    createdAt: '2026-09-02T18:00:00.000Z',
    ...extra,
  };
}

test('pickForProject: a held row is skipped and the sibling behind it is picked', () => {
  const jobs = [job('10-blocked'), job('11-free')];
  const held = new Map([['10-blocked', 'launch blocked (model_config_rejected) — re-probe in 5 min']]);
  const r = pickForProject(jobs, new Set(), 1, held);
  assert.deepEqual(r.batch.map((j) => j.slug), ['11-free']);
  const hold = r.holds.find((h) => h.slug === '10-blocked');
  assert.ok(hold, 'held row surfaces as a hold record');
  assert.equal(hold.dep, null);
  assert.match(hold.reason, /launch blocked/);
});

test('pickForProject: every pending row held → empty batch, holds still reported, no dep reason invented', () => {
  const jobs = [job('10-a'), job('11-b')];
  const held = new Map([['10-a', 'launch blocked'], ['11-b', 'launch blocked']]);
  const r = pickForProject(jobs, new Set(), 3, held);
  assert.equal(r.batch.length, 0);
  assert.equal(r.reason, null);
  assert.deepEqual(r.holds.map((h) => h.slug).sort(), ['10-a', '11-b']);
});

test('pickForProject: a held row still counts as a blocking dependency for its dependents', () => {
  const jobs = [job('10-base'), job('11-child', 'pending', { dependsOn: ['10-base'] })];
  const held = new Map([['10-base', 'launch blocked']]);
  const r = pickForProject(jobs, new Set(), 3, held);
  assert.equal(r.batch.length, 0, 'the child must not run ahead of its held dependency');
  const childHold = r.holds.find((h) => h.slug === '11-child');
  assert.equal(childHold.dep, '10-base');
});

test('pickNextBatch: heldSlugs option threads through; a project with only held rows is not a candidate', () => {
  const other = '/tmp/other-project';
  const jobs = [job('10-held'), job('20-other', 'pending', { cwd: other })];
  const held = new Map([['10-held', 'launch blocked (auth_failed)']]);
  const r = pickNextBatch(jobs, new Set(), 2, { heldSlugs: held, now: Date.parse('2026-09-02T18:05:00Z') });
  assert.deepEqual(r.batch.map((j) => j.slug), ['20-other']);
  assert.ok(r.holds.some((h) => h.slug === '10-held' && /auth_failed/.test(h.reason)));
});

test('pickNextBatch: a held quiet-machine row is never dispatched exclusively', () => {
  const jobs = [job('10-quiet', 'pending', { quietMachine: true }), job('11-plain')];
  const held = new Map([['10-quiet', 'launch blocked']]);
  const r = pickNextBatch(jobs, new Set(), 1, { heldSlugs: held, machineInUse: 0 });
  assert.deepEqual(r.batch.map((j) => j.slug), ['11-plain']);
});

test('pickNextBatch: nothing pickable at all → empty batch with holds, not a crash', () => {
  const jobs = [job('10-held')];
  const r = pickNextBatch(jobs, new Set(), 2, { heldSlugs: new Map([['10-held', 'launch blocked']]) });
  assert.equal(r.batch.length, 0);
  assert.equal(r.holds[0].slug, '10-held');
});

// ─── computeLaunchHolds (scheduler.cjs) ─────────────────────────────────────

const T0 = Date.parse('2026-09-02T18:00:00Z');

test('computeLaunchHolds: no blocks → empty map without probing the CLI', async () => {
  const held = await computeLaunchHolds({ jobs: [job('10-a')], launchBlocks: {} }, { now: T0, claudeVersion: 'v1' });
  assert.equal(held.size, 0);
});

test('computeLaunchHolds: inside backoff every pending row of the blocked persona is held; other personas run', async () => {
  const block = lf.armLaunchBlock(null, { kind: 'model_config_rejected', message: 'm', now: T0, claudeVersion: 'v1' });
  const state = {
    jobs: [job('10-a', 'pending', { agentType: 'dev-lead' }), job('11-b', 'pending', { agentType: 'dev-lead' }), job('12-c', 'pending', { agentType: 'architect' }), job('13-done', 'completed', { agentType: 'dev-lead' })],
    launchBlocks: { 'dev-lead': block },
  };
  const held = await computeLaunchHolds(state, { now: T0 + 1000, claudeVersion: 'v1' });
  assert.deepEqual([...held.keys()].sort(), ['10-a', '11-b']);
  assert.match(held.get('10-a'), /launch blocked \(model_config_rejected\)/);
});

test('computeLaunchHolds: after backoff exactly ONE row per persona is released as the probe', async () => {
  const block = lf.armLaunchBlock(null, { kind: 'api_overloaded', message: 'm', now: T0, claudeVersion: 'v1' });
  const state = {
    jobs: [job('10-a', 'pending', { agentType: 'dev-lead' }), job('11-b', 'pending', { agentType: 'dev-lead' })],
    launchBlocks: { 'dev-lead': block },
  };
  const held = await computeLaunchHolds(state, { now: Date.parse(block.until) + 1, claudeVersion: 'v1' });
  assert.deepEqual([...held.keys()], ['11-b']);
  assert.match(held.get('11-b'), /waiting for this tick's probe/);
});

test('computeLaunchHolds: a CLI version change releases everything', async () => {
  const block = lf.armLaunchBlock(null, { kind: 'model_config_rejected', message: 'm', now: T0, claudeVersion: 'v1' });
  const state = { jobs: [job('10-a', 'pending', { agentType: 'dev-lead' })], launchBlocks: { 'dev-lead': block } };
  const held = await computeLaunchHolds(state, { now: T0 + 1, claudeVersion: 'v2' });
  assert.equal(held.size, 0);
});

test('computeLaunchHolds: rows with no agentType are keyed as default', async () => {
  const block = lf.armLaunchBlock(null, { kind: 'auth_failed', message: 'm', now: T0, claudeVersion: 'v1' });
  const state = { jobs: [job('10-a')], launchBlocks: { default: block } };
  const held = await computeLaunchHolds(state, { now: T0 + 1, claudeVersion: 'v1' });
  assert.ok(held.has('10-a'));
});
