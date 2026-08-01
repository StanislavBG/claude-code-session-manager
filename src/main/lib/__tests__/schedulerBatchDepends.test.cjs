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
