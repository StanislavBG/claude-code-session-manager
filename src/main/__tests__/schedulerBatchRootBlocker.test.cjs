'use strict';

// PRD 1123 — a single row parked in `needs_review` (or `failed`/`skipped`)
// several dependsOn hops down used to read as generic starvation: the picker
// only ever named a held job's IMMEDIATE dep, which is very often just
// another `pending` row, not the actual cause. These tests pin the root-
// blocker walk: the reason must name the transitive ancestor that is itself
// not blocked by anything, plus the count of jobs held behind it and its
// status — and must terminate (not hang) on a dependsOn cycle.
//
// Run: timeout 120 npx vitest run src/main/__tests__/schedulerBatchRootBlocker.test.cjs

const assert = require('node:assert/strict');
const { pickForProject, DEFAULT_PROJECT_CWD } = require('../lib/schedulerBatch.cjs');

const CWD = DEFAULT_PROJECT_CWD;

function job(slug, status, extra = {}) {
  return { slug, status, cwd: CWD, dependsOn: [], ...extra };
}

test('a 3-deep chain rooted at a needs_review row names the ROOT, not the middle link', () => {
  const jobs = [
    job('100-root', 'needs_review'),
    job('101-middle', 'pending', { dependsOn: ['100-root'] }),
    job('102-leaf', 'pending', { dependsOn: ['101-middle'] }),
  ];
  const { batch, reason, holds } = pickForProject(jobs, new Set(), 3);
  assert.deepEqual(batch, []);
  assert.match(reason, /depends-gate/);
  // Names the root, not the immediate (middle) dep as the cause.
  assert.match(reason, /root blocker 100-root/);
  assert.match(reason, /needs_review/);
  assert.match(reason, /is a QUESTION awaiting a human/);
  // Both downstream jobs are counted as held behind the root.
  assert.match(reason, /holding 2 job\(s\)/);
  assert.match(reason, /101-middle/);
  assert.match(reason, /102-leaf/);

  const leafHold = holds.find((h) => h.slug === '102-leaf');
  assert.equal(leafHold.dep, '101-middle'); // immediate dep still recorded
  assert.equal(leafHold.rootSlug, '100-root'); // but the row also knows the root
  assert.equal(leafHold.rootStatus, 'needs_review');
});

test('the same 3-deep chain rooted at a FAILED row names the root, not the middle link', () => {
  const jobs = [
    job('200-root', 'failed'),
    job('201-middle', 'pending', { dependsOn: ['200-root'] }),
    job('202-leaf', 'pending', { dependsOn: ['201-middle'] }),
  ];
  const { batch, reason, holds } = pickForProject(jobs, new Set(), 3);
  assert.deepEqual(batch, []);
  assert.match(reason, /root blocker 200-root/);
  assert.match(reason, /\(failed\)/);
  assert.match(reason, /holding 1 job\(s\)/); // only 202-leaf: 201-middle is caught by the shallow failed-dep bucket
  assert.match(reason, /Reset or archive 200-root/);

  const leafHold = holds.find((h) => h.slug === '202-leaf');
  assert.equal(leafHold.rootSlug, '200-root');
  assert.equal(leafHold.rootStatus, 'failed');
  const middleHold = holds.find((h) => h.slug === '201-middle');
  assert.equal(middleHold.rootSlug, '200-root');
  assert.equal(middleHold.rootStatus, 'failed');
});

test('a 2-node dependsOn cycle is reported as its own reason, not a hang', () => {
  const jobs = [
    job('300-a', 'pending', { dependsOn: ['301-b'] }),
    job('301-b', 'pending', { dependsOn: ['300-a'] }),
  ];
  const start = Date.now();
  const { batch, reason } = pickForProject(jobs, new Set(), 3);
  assert.ok(Date.now() - start < 5000, 'must terminate quickly, not hang');
  assert.deepEqual(batch, []);
  assert.match(reason, /CYCLE/);
  assert.match(reason, /300-a/);
  assert.match(reason, /301-b/);
  // Reported exactly once, not once per member.
  assert.equal((reason.match(/CYCLE/g) || []).length, 1);
});

test('no false stall reported when the gate is not the reason the batch is empty (slots exhausted)', () => {
  const jobs = [job('400-a', 'pending'), job('401-b', 'pending')];
  const { batch, reason } = pickForProject(jobs, new Set(), 0);
  assert.deepEqual(batch, []);
  assert.match(reason, /no slots free/);
  assert.doesNotMatch(reason, /root blocker/);
});

test('no false stall reported when the gate is not the reason the batch is empty (project cap)', () => {
  const prevCap = process.env.SM_PROJECT_JOB_CAP;
  process.env.SM_PROJECT_JOB_CAP = '1';
  try {
    const jobs = [
      job('402-running', 'running'),
      job('403-pending', 'pending'),
    ];
    const { batch, reason } = pickForProject(jobs, new Set(['402-running']), 3);
    assert.deepEqual(batch, []);
    assert.match(reason, /project-cap/);
    assert.doesNotMatch(reason, /root blocker/);
  } finally {
    if (prevCap === undefined) delete process.env.SM_PROJECT_JOB_CAP;
    else process.env.SM_PROJECT_JOB_CAP = prevCap;
  }
});

test('a running/pending-rooted chain reports no stall reason (expected to clear on its own)', () => {
  const jobs = [
    job('500-root', 'running'),
    job('501-dependent', 'pending', { dependsOn: ['500-root'] }),
  ];
  const { batch, reason } = pickForProject(jobs, new Set(['500-root']), 3);
  assert.deepEqual(batch, []);
  assert.equal(reason, null);
});
