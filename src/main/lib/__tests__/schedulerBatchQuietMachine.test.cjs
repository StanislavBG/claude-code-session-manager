'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerBatchQuietMachine.test.cjs
//
// Pure-logic coverage for the `quietMachine: true` exclusive lease (PRD
// 1107): dispatched only when zero other jobs are running machine-wide,
// blocks every other dispatch while its lease is held, degrades (dispatches
// anyway) once it has waited past the configurable interval, and never
// touches the ordinary dispatch path for a PRD that doesn't opt in.

const assert = require('node:assert/strict');
const { pickNextBatch } = require('../schedulerBatch.cjs');

const CWD_A = '/home/user/Projects/project-a';
const CWD_B = '/home/user/Projects/project-b';

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

const ORIGINAL_WAIT_ENV = process.env.SM_QUIET_MACHINE_WAIT_MINUTES;
afterEach(() => {
  if (ORIGINAL_WAIT_ENV === undefined) delete process.env.SM_QUIET_MACHINE_WAIT_MINUTES;
  else process.env.SM_QUIET_MACHINE_WAIT_MINUTES = ORIGINAL_WAIT_ENV;
});

test('a quietMachine job dispatches alone when the machine is idle, even with ordinary work also pending', () => {
  const jobs = [
    job('101-quiet', 'pending', CWD_A, { quietMachine: true, createdAt: new Date().toISOString() }),
    job('102-ordinary', 'pending', CWD_A, { createdAt: new Date().toISOString() }),
    job('201-other', 'pending', CWD_B, { createdAt: new Date().toISOString() }),
  ];
  const { batch } = pickNextBatch(jobs, new Set(), 5, { leaseHeld: false, machineInUse: 0, now: Date.now() });
  assert.deepEqual(batch.map((j) => j.slug), ['101-quiet']);
  assert.equal(batch[0].quietLeaseDegraded, false);
});

test('a quietMachine job does NOT dispatch while another job is running machine-wide, and ordinary jobs dispatch unaffected', () => {
  const jobs = [
    job('101-quiet', 'pending', CWD_A, { quietMachine: true, createdAt: new Date().toISOString() }),
    job('201-other', 'pending', CWD_B, { createdAt: new Date().toISOString() }),
  ];
  const { batch } = pickNextBatch(jobs, new Set(), 5, { leaseHeld: false, machineInUse: 1, now: Date.now() });
  assert.deepEqual(batch.map((j) => j.slug), ['201-other']);
});

test('leaseHeld blocks EVERY project from dispatching, not just the quiet job\'s own project', () => {
  const jobs = [
    job('101-quiet', 'running', CWD_A, { quietMachine: true }),
    job('201-other', 'pending', CWD_B, { createdAt: new Date().toISOString() }),
  ];
  const { batch, reason } = pickNextBatch(jobs, new Set(['101-quiet']), 5, { leaseHeld: true, machineInUse: 1, now: Date.now() });
  assert.deepEqual(batch, []);
  assert.match(reason, /quiet-machine/);
});

test('a quietMachine job blocked by dependsOn is skipped even when the machine is idle', () => {
  const jobs = [
    job('100-dep', 'pending', CWD_A, { createdAt: new Date().toISOString() }),
    job('101-quiet', 'pending', CWD_A, { quietMachine: true, dependsOn: ['100-dep'], createdAt: new Date().toISOString() }),
  ];
  const { batch } = pickNextBatch(jobs, new Set(), 5, { leaseHeld: false, machineInUse: 0, now: Date.now() });
  // The quiet job is blocked by its dep; the dep itself is an ordinary job
  // and dispatches normally.
  assert.deepEqual(batch.map((j) => j.slug), ['100-dep']);
});

test('a quietMachine job waiting under the configured interval stays held while the machine is busy', () => {
  process.env.SM_QUIET_MACHINE_WAIT_MINUTES = '30';
  const now = Date.now();
  const queuedAt = new Date(now - 10 * 60_000).toISOString(); // waited 10m
  const jobs = [
    job('101-quiet', 'pending', CWD_A, { quietMachine: true, createdAt: queuedAt }),
  ];
  const { batch } = pickNextBatch(jobs, new Set(), 5, { leaseHeld: false, machineInUse: 1, now });
  assert.deepEqual(batch, []);
});

test('a quietMachine job past the configured wait interval dispatches anyway, marked degraded', () => {
  process.env.SM_QUIET_MACHINE_WAIT_MINUTES = '30';
  const now = Date.now();
  const queuedAt = new Date(now - 31 * 60_000).toISOString(); // waited 31m
  const jobs = [
    job('101-quiet', 'pending', CWD_A, { quietMachine: true, createdAt: queuedAt }),
  ];
  const { batch } = pickNextBatch(jobs, new Set(), 5, { leaseHeld: false, machineInUse: 1, now });
  assert.deepEqual(batch.map((j) => j.slug), ['101-quiet']);
  assert.equal(batch[0].quietLeaseDegraded, true);
});

test('ordinary dispatch path is unchanged when no quietMachine job is present (no quietOpts passed at all)', () => {
  const jobs = [
    job('101-a', 'pending', CWD_A),
    job('102-b', 'pending', CWD_A),
    job('201-a', 'pending', CWD_B),
  ];
  const { batch } = pickNextBatch(jobs, new Set(), 5);
  assert.deepEqual(
    batch.map((j) => j.slug).sort(),
    ['101-a', '102-b', '201-a'],
  );
});
