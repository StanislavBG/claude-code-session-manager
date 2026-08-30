'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerBatchDepends.test.cjs
//
// Regression coverage for dependsOn eligibility in pickForProject. The
// bare-slug cases below are the ones that shipped broken: a PRD's filename
// carries the auto-allocated `NN-` prefix, but `dependsOn:` is authored with
// the bare name (the author can't know the number the allocator will issue),
// so every such dep silently resolved to "no row -> already done" and the
// gate never held anything.

// vitest globals (test) — same convention as the other .cjs tests.
const assert = require('node:assert/strict');
const { pickForProject, DEFAULT_PROJECT_CWD } = require('../schedulerBatch.cjs');

const CWD = DEFAULT_PROJECT_CWD;

function job(slug, status, extra = {}) {
return {
  slug,
  status,
  cwd: CWD,
  parallelGroup: Number(String(slug).match(/^(\d+)-/)?.[1] ?? 99),
  dependsOn: [],
  ...extra,
};
}

function pick(jobs, running = new Set(), slots = 3) {
return pickForProject(jobs, running, slots);
}

test('holds a dependent whose bare-named dep is still running (NN- prefix stripped)', () => {
  const jobs = [
    job('873-leftnav-two-face-framework', 'running'),
    job('874-nav-face-project-home', 'pending', { dependsOn: ['leftnav-two-face-framework'] }),
  ];
  const { batch } = pick(jobs, new Set(['873-leftnav-two-face-framework']));
  assert.deepEqual(batch.map((j) => j.slug), []);
});

test('holds a dependent whose bare-named dep is still pending', () => {
  const jobs = [
    job('873-leftnav-two-face-framework', 'pending'),
    job('895-home-global-behavior-settings', 'pending', {
      dependsOn: ['leftnav-two-face-framework', 'nav-face-session-manager-config'],
    }),
    job('890-nav-face-session-manager-config', 'pending', {
      dependsOn: ['leftnav-two-face-framework'],
    }),
  ];
  const { batch } = pick(jobs);
  // Only the framework PRD (no deps) is eligible; both dependents are held.
  assert.deepEqual(batch.map((j) => j.slug), ['873-leftnav-two-face-framework']);
});

test('releases a dependent once its bare-named dep is completed', () => {
  const jobs = [
    job('873-leftnav-two-face-framework', 'completed'),
    job('874-nav-face-project-home', 'pending', { dependsOn: ['leftnav-two-face-framework'] }),
  ];
  const { batch } = pick(jobs);
  assert.deepEqual(batch.map((j) => j.slug), ['874-nav-face-project-home']);
});

test('still resolves an exact-slug dep (dep written WITH the NN- prefix)', () => {
  const jobs = [
    job('873-leftnav-two-face-framework', 'pending'),
    job('874-nav-face-project-home', 'pending', {
      dependsOn: ['873-leftnav-two-face-framework'],
    }),
  ];
  const { batch } = pick(jobs);
  assert.deepEqual(batch.map((j) => j.slug), ['873-leftnav-two-face-framework']);
});

test('a dep with no row at all is treated as already done (archived/retired)', () => {
  const jobs = [
    job('874-nav-face-project-home', 'pending', { dependsOn: ['some-long-archived-prd'] }),
  ];
  const { batch } = pick(jobs);
  assert.deepEqual(batch.map((j) => j.slug), ['874-nav-face-project-home']);
});

test('a FAILED bare-named dep holds the dependent and reports an explicit reason', () => {
  const jobs = [
    job('873-leftnav-two-face-framework', 'failed'),
    job('874-nav-face-project-home', 'pending', { dependsOn: ['leftnav-two-face-framework'] }),
  ];
  const { batch, reason } = pick(jobs);
  assert.deepEqual(batch, []);
  assert.match(reason, /depends-gate/);
  assert.match(reason, /874-nav-face-project-home <- leftnav-two-face-framework/);
});

test('a SKIPPED (never-ran) bare-named dep holds the dependent and reports an explicit reason', () => {
  const jobs = [
    job('873-leftnav-two-face-framework', 'skipped'),
    job('874-nav-face-project-home', 'pending', { dependsOn: ['leftnav-two-face-framework'] }),
  ];
  const { batch, reason } = pick(jobs);
  assert.deepEqual(batch, []);
  assert.match(reason, /depends-gate/);
  assert.match(reason, /never-ran dependencies/);
  assert.match(reason, /874-nav-face-project-home <- leftnav-two-face-framework/);
});

// ---------------------------------------------------------------------------
// Parallelism regression coverage.
//
// `parallelGroup` used to gate batch membership: the picker fired at most one
// group per tick and held every higher group while a lower one was in flight.
// PRD 832 made the number strictly unique per PRD, so every group became a
// singleton and the batch was always exactly ONE job — measured max
// concurrency 1 across 25 recorded runs against a 5-slot pool. These tests
// pin the corrected contract: dependsOn is the only barrier, parallelGroup is
// a priority hint.
// ---------------------------------------------------------------------------

test('fires EVERY dependency-eligible job, not one per parallelGroup', () => {
  const jobs = [
    job('983-a', 'pending'),
    job('984-b', 'pending'),
    job('985-c', 'pending'),
    job('986-d', 'pending'),
  ];
  const { batch } = pick(jobs, new Set(), 5);
  // Pre-fix this returned exactly ['983-a'] — one singleton group.
  assert.deepEqual(batch.map((j) => j.slug), ['983-a', '984-b', '985-c', '986-d']);
});

test('a higher-numbered job is NOT held behind an in-flight lower-numbered one', () => {
  const jobs = [
    job('979-running', 'running'),
    job('988-independent', 'pending'),
  ];
  const { batch } = pick(jobs, new Set(['979-running']), 5);
  // Pre-fix: held by the running-gate ("g979 in flight, holding g988"), which
  // is how the fix for this very bug ended up stuck behind the bug.
  assert.deepEqual(batch.map((j) => j.slug), ['988-independent']);
});

test('dependency-blocked jobs are excluded while independent siblings fire together', () => {
  const jobs = [
    job('985-foundation', 'pending'),
    job('986-dependent', 'pending', { dependsOn: ['foundation'] }),
    job('987-independent', 'pending'),
  ];
  const { batch } = pick(jobs, new Set(), 5);
  assert.deepEqual(batch.map((j) => j.slug), ['985-foundation', '987-independent']);
});

test('a FAILED job holds its transitive dependents but not unrelated jobs', () => {
  const jobs = [
    job('980-broken', 'failed'),
    job('981-direct', 'pending', { dependsOn: ['broken'] }),
    job('982-transitive', 'pending', { dependsOn: ['direct'] }),
    job('983-unrelated', 'pending'),
  ];
  const { batch } = pick(jobs, new Set(), 5);
  // Pre-fix the cross-group failure gate held 983 too, purely for having a
  // higher number than the failure.
  assert.deepEqual(batch.map((j) => j.slug), ['983-unrelated']);
});

test('parallelGroup orders the batch when eligible jobs exceed free slots', () => {
  const jobs = [
    job('990-c', 'pending'),
    job('988-a', 'pending'),
    job('989-b', 'pending'),
  ];
  const { batch } = pick(jobs, new Set(), 2);
  assert.deepEqual(batch.map((j) => j.slug), ['988-a', '989-b']);
});

test('zero free slots holds everything with an explicit reason', () => {
  const jobs = [job('988-a', 'pending'), job('989-b', 'pending')];
  const { batch, reason } = pick(jobs, new Set(), 0);
  assert.deepEqual(batch, []);
  assert.match(reason, /no slots free/);
});

// ---------------------------------------------------------------------------
// Per-job hold records (PRD 990). The picker already knew exactly which dep
// held which row; it only ever reached console.log. These pin it as data.
// ---------------------------------------------------------------------------

test('reports a per-job hold record naming the blocking dep and its status', () => {
  const jobs = [
    job('985-foundation', 'pending'),
    job('986-dependent', 'pending', { dependsOn: ['foundation'] }),
  ];
  const { batch, holds } = pick(jobs, new Set(), 5);
  assert.deepEqual(batch.map((j) => j.slug), ['985-foundation']);
  assert.deepEqual(holds, [
    { slug: '986-dependent', dep: 'foundation', depStatus: 'pending' },
  ]);
});

test('hold record carries a running dep status', () => {
  const jobs = [
    job('985-foundation', 'running'),
    job('986-dependent', 'pending', { dependsOn: ['foundation'] }),
  ];
  const { holds } = pick(jobs, new Set(['985-foundation']), 5);
  assert.deepEqual(holds, [
    { slug: '986-dependent', dep: 'foundation', depStatus: 'running' },
  ]);
});

test('hold record carries a failed dep status alongside the depends-gate reason', () => {
  const jobs = [
    job('985-foundation', 'failed'),
    job('986-dependent', 'pending', { dependsOn: ['foundation'] }),
  ];
  const { batch, reason, holds } = pick(jobs, new Set(), 5);
  assert.deepEqual(batch, []);
  assert.match(reason, /depends-gate/);
  assert.deepEqual(holds, [
    { slug: '986-dependent', dep: 'foundation', depStatus: 'failed' },
  ]);
});

test('hold record carries a skipped dep status alongside the depends-gate reason', () => {
  const jobs = [
    job('985-foundation', 'skipped'),
    job('986-dependent', 'pending', { dependsOn: ['foundation'] }),
  ];
  const { batch, reason, holds } = pick(jobs, new Set(), 5);
  assert.deepEqual(batch, []);
  assert.match(reason, /depends-gate/);
  assert.match(reason, /never-ran dependencies/);
  assert.deepEqual(holds, [
    { slug: '986-dependent', dep: 'foundation', depStatus: 'skipped' },
  ]);
});

test('no holds when nothing is dependency-blocked', () => {
  const jobs = [job('988-a', 'pending'), job('989-b', 'pending')];
  const { batch, holds } = pick(jobs, new Set(), 5);
  assert.equal(batch.length, 2);
  assert.deepEqual(holds, []);
});

test('an idle queue reports no holds (empty must not read as blocked)', () => {
  const jobs = [job('988-a', 'completed')];
  const { batch, holds } = pick(jobs, new Set(), 5);
  assert.deepEqual(batch, []);
  assert.deepEqual(holds, []);
});
