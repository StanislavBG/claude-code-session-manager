'use strict';
// Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerBatchFairness.test.cjs
//
// PRDs 1086 + 1087 — cross-project fairness and starvation escalation.
// pickNextBatch used to order projects by their lowest pending parallelGroup.
// NN numbers are allocated PER PROJECT and only grow, so that compared
// unrelated sequences: on 2026-09-01 social-signals-trader (8 pending, lowest
// NN 3887) got zero starts for 3.5 h while starry-night-ships (lowest NN 158)
// took every freed slot. These tests pin the replacement contract: fewest
// running first, oldest pending as tiebreak, cwd last, and ROUND-ROBIN slot
// hand-out — plus the escalation that makes any regression visible.
const assert = require('node:assert/strict');
const {
  pickNextBatch, enqueueTimestamp, findStarvedProjects,
} = require('../schedulerBatch.cjs');

const A = '/home/user/Projects/starry-night-ships';
const B = '/home/user/Projects/social-signals-trader';
const C = '/home/user/Projects/burrow';
const D = '/home/user/Projects/sigma';

function job(slug, status, cwd, extra = {}) {
  return {
    slug,
    status,
    cwd,
    parallelGroup: Number(String(slug).match(/^(\d+)-/)?.[1] ?? 99),
    dependsOn: [],
    ...extra,
  };
}
const ORIGINAL_CAP_ENV = process.env.SM_PROJECT_JOB_CAP;
afterEach(() => {
  if (ORIGINAL_CAP_ENV === undefined) delete process.env.SM_PROJECT_JOB_CAP;
  else process.env.SM_PROJECT_JOB_CAP = ORIGINAL_CAP_ENV;
});

// ─── the reported bug ───────────────────────────────────────────────────────

test('a project with high NN numbers is never starved behind a project with low ones (freeSlots=1, repeated ticks)', () => {
  delete process.env.SM_PROJECT_JOB_CAP;
  const jobs = [];
  for (let n = 158; n <= 172; n++) jobs.push(job(`${n}-a`, 'pending', A));
  for (let n = 3887; n <= 3941; n++) jobs.push(job(`${n}-b`, 'pending', B));
  const running = new Set();
  const dispatched = [];
  for (let tick = 0; tick < 2; tick++) {
    const { batch } = pickNextBatch(jobs, running, 1);
    assert.equal(batch.length, 1, `tick ${tick} should dispatch exactly one job`);
    const picked = batch[0];
    dispatched.push(picked);
    // simulate the picked job going to running
    const row = jobs.find((j) => j.slug === picked.slug);
    row.status = 'running';
    running.add(row.slug);
  }
  assert.ok(dispatched.some((j) => j.cwd === B), `B must get a start within 2 ticks, got ${dispatched.map((j) => j.slug)}`);
  assert.ok(dispatched.some((j) => j.cwd === A), 'A still gets its start too');
});

// ─── round-robin ────────────────────────────────────────────────────────────

test('round-robin: 4 projects x 3 eligible, freeSlots=4 -> exactly one job from each project', () => {
  delete process.env.SM_PROJECT_JOB_CAP;
  const jobs = [];
  for (const [i, cwd] of [A, B, C, D].entries()) {
    for (let k = 1; k <= 3; k++) jobs.push(job(`${(i + 1) * 100 + k}-${k}`, 'pending', cwd));
  }
  const { batch } = pickNextBatch(jobs, new Set(), 4);
  assert.equal(batch.length, 4);
  assert.deepEqual(new Set(batch.map((j) => j.cwd)), new Set([A, B, C, D]));
});

test('round-robin keeps cycling: 2 projects x 3 eligible, freeSlots=4, cap 2 -> 2 from each, not 3+1', () => {
  process.env.SM_PROJECT_JOB_CAP = '2';
  const jobs = [
    job('101-a', 'pending', A), job('102-a', 'pending', A), job('103-a', 'pending', A),
    job('201-b', 'pending', B), job('202-b', 'pending', B), job('203-b', 'pending', B),
  ];
  const { batch } = pickNextBatch(jobs, new Set(), 4);
  assert.equal(batch.length, 4);
  assert.equal(batch.filter((j) => j.cwd === A).length, 2);
  assert.equal(batch.filter((j) => j.cwd === B).length, 2);
});

test('the per-project cap holds ACROSS passes (a project already at cap is offered nothing more this tick)', () => {
  process.env.SM_PROJECT_JOB_CAP = '2';
  const jobs = [
    job('101-a', 'pending', A), job('102-a', 'pending', A), job('103-a', 'pending', A), job('104-a', 'pending', A),
  ];
  const { batch } = pickNextBatch(jobs, new Set(), 5);
  assert.deepEqual(batch.map((j) => j.slug), ['101-a', '102-a']);
});

test('within a project, parallelGroup ascending is still the priority hint', () => {
  delete process.env.SM_PROJECT_JOB_CAP;
  const jobs = [job('105-a', 'pending', A), job('101-a', 'pending', A)];
  const { batch } = pickNextBatch(jobs, new Set(), 1);
  assert.equal(batch[0].slug, '101-a');
});

// ─── ordering keys ──────────────────────────────────────────────────────────

test('fewest running first: a project already running 1 job sorts behind one running 0, even with the older pending job', () => {
  delete process.env.SM_PROJECT_JOB_CAP;
  const jobs = [
    job('100-a-running', 'running', A),
    job('101-a', 'pending', A, { queuedAt: '2026-09-01T00:00:00Z' }), // older
    job('900-b', 'pending', B, { queuedAt: '2026-09-01T01:00:00Z' }), // newer, but B runs nothing
  ];
  const { batch } = pickNextBatch(jobs, new Set(['100-a-running']), 1);
  assert.equal(batch[0].slug, '900-b');
});

test('tiebreak on the oldest pending enqueue time when running counts are equal', () => {
  delete process.env.SM_PROJECT_JOB_CAP;
  const jobs = [
    job('101-a', 'pending', A, { queuedAt: '2026-09-01T01:00:00Z' }),
    job('900-b', 'pending', B, { queuedAt: '2026-09-01T00:00:00Z' }), // older -> first
  ];
  assert.equal(pickNextBatch(jobs, new Set(), 1).batch[0].slug, '900-b');
});

test('unprovable ages sort LAST, and the final tiebreak is the cwd string', () => {
  delete process.env.SM_PROJECT_JOB_CAP;
  const jobs = [
    job('101-a', 'pending', A), // no timestamp
    job('900-b', 'pending', B, { queuedAt: '2026-09-01T00:00:00Z' }),
  ];
  assert.equal(pickNextBatch(jobs, new Set(), 1).batch[0].slug, '900-b');
  // Both unprovable -> the lexicographically smaller cwd wins: '.../burrow' (C) < '.../starry-night-ships' (A).
  const tie = [job('900-b', 'pending', A), job('101-a', 'pending', C)];
  assert.equal(pickNextBatch(tie, new Set(), 1).batch[0].slug, '101-a');
});

test('holds are aggregated once per slug across passes and reason is non-null only for an empty batch', () => {
  delete process.env.SM_PROJECT_JOB_CAP;
  const jobs = [
    job('100-dep', 'failed', A),
    job('101-a', 'pending', A, { dependsOn: ['100-dep'] }),
  ];
  const r = pickNextBatch(jobs, new Set(), 3);
  assert.equal(r.batch.length, 0);
  assert.match(r.reason, /failed dependencies/);
  assert.equal(r.holds.filter((h) => h.slug === '101-a').length, 1);
});

// ─── enqueueTimestamp ───────────────────────────────────────────────────────

test('enqueueTimestamp resolves createdAt -> queuedAt -> statusHistory(to pending) -> startedAt -> Infinity', () => {
  const t = (s) => Date.parse(s);
  assert.equal(enqueueTimestamp({ createdAt: '2026-01-01T00:00:00Z', queuedAt: '2026-02-01T00:00:00Z' }), t('2026-01-01T00:00:00Z'));
  assert.equal(enqueueTimestamp({ queuedAt: '2026-02-01T00:00:00Z' }), t('2026-02-01T00:00:00Z'));
  assert.equal(enqueueTimestamp({ statusHistory: [{ from: null, to: 'pending', at: '2026-03-01T00:00:00Z' }] }), t('2026-03-01T00:00:00Z'));
  assert.equal(enqueueTimestamp({ startedAt: '2026-04-01T00:00:00Z' }), t('2026-04-01T00:00:00Z'));
  assert.equal(enqueueTimestamp({}), Infinity);
  assert.equal(enqueueTimestamp({ queuedAt: 'garbage' }), Infinity);
  assert.equal(enqueueTimestamp(null), Infinity);
});

// ─── findStarvedProjects (PRD 1087) ────────────────────────────────────────

const NOW = Date.parse('2026-09-01T12:00:00Z');
const H = 60 * 60_000;

test('a genuinely starved project is reported with its oldest pending slug and age', () => {
  const jobs = [
    job('158-a', 'running', A),
    job('3887-b', 'pending', B, { queuedAt: new Date(NOW - 3 * H).toISOString() }),
    job('3888-b', 'pending', B, { queuedAt: new Date(NOW - 1 * H).toISOString() }),
  ];
  const out = findStarvedProjects(jobs, NOW, 45 * 60_000);
  assert.equal(out.length, 1);
  assert.equal(out[0].cwd, B);
  assert.equal(out[0].pendingCount, 2);
  assert.equal(out[0].oldestPendingSlug, '3887-b');
  assert.equal(out[0].ageMs, 3 * H);
});

test('NOT reported when no project at all is running (idle/paused machine)', () => {
  const jobs = [job('3887-b', 'pending', B, { queuedAt: new Date(NOW - 5 * H).toISOString() })];
  assert.deepEqual(findStarvedProjects(jobs, NOW, 45 * 60_000), []);
});

test('NOT reported when every pending job is younger than the threshold', () => {
  const jobs = [
    job('158-a', 'running', A),
    job('3887-b', 'pending', B, { queuedAt: new Date(NOW - 10 * 60_000).toISOString() }),
  ];
  assert.deepEqual(findStarvedProjects(jobs, NOW, 45 * 60_000), []);
});

test('NOT reported when the project has a running job of its own', () => {
  const jobs = [
    job('158-a', 'running', A),
    job('3880-b', 'running', B),
    job('3887-b', 'pending', B, { queuedAt: new Date(NOW - 5 * H).toISOString() }),
  ];
  assert.deepEqual(findStarvedProjects(jobs, NOW, 45 * 60_000), []);
});

test('NOT reported (but warned) when the pending rows carry no provable enqueue time', () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    const jobs = [job('158-a', 'running', A), job('3887-b', 'pending', B)];
    assert.deepEqual(findStarvedProjects(jobs, NOW, 45 * 60_000), []);
    assert.ok(warns.some((w) => w.includes(B) && w.includes('cannot prove age')));
  } finally {
    console.warn = orig;
  }
});
